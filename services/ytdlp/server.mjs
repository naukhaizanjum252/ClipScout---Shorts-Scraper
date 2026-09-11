/**
 * A yt-dlp runner, over HTTP, for hosts that cannot spawn one.
 *
 * WHY THIS EXISTS. `lib/platform/ytdlp.ts` spawns `yt-dlp` as a child process.
 * That works anywhere the binary is on PATH and does not work on Vercel, whose
 * runtime has no yt-dlp and no way to install one. YouTube discovery is
 * ENTIRELY keyless yt-dlp — the YouTube Data API key only hydrates rows that
 * yt-dlp already found, it cannot enumerate — so on Vercel, YouTube returned
 * "`yt-dlp` is not installed or not on PATH" and nothing else. Erik's call,
 * 2026-09-05: build the runner rather than buy a vendor's YouTube endpoint.
 *
 * WHAT IT IS. One POST endpoint that runs yt-dlp and returns its stdout
 * verbatim, so that `makeRemoteYtDlpRunner` in lib/platform/ytdlp-remote.ts
 * satisfies the same `YtDlpRunner` type as the local spawn. Nothing downstream
 * — not the YouTube adapter, not the TikTok adapter, not the run — knows which
 * one it got.
 *
 * ---------------------------------------------------------------------------
 * THE SECURITY MODEL, WHICH IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * This service takes an argv array from the network and hands it to a process.
 * Stated that plainly, it is a remote code execution endpoint unless something
 * stops it, and yt-dlp has flags that make that literal: `--exec` runs a shell
 * command per download, `--load-info-json` reads a local file, `-o` writes one,
 * `--cookies` reads the host's cookie jar.
 *
 * SO THE ARGV IS NOT FILTERED, IT IS REBUILT. The request is matched against
 * the three command shapes the application actually issues; if it matches, this
 * file constructs a FRESH argv from the extracted values and runs that. The
 * caller's array is never passed to spawn. An allowlist of flags would have
 * been the obvious approach and it is weaker: it has to anticipate every
 * dangerous flag, including the ones a future yt-dlp release adds, and it fails
 * open on the ones nobody thought of. This fails closed on everything that is
 * not one of three known commands.
 *
 * The three shapes, which are all of them — verified against every call site in
 * lib/platform/ on 2026-09-05:
 *
 *   1. --flat-playlist -J --no-warnings --playlist-end <N> <TARGET>
 *   2. --no-warnings --no-playlist -f best[ext=mp4]/best --print urls <URL>
 *   3. --version
 *
 * ON TOP OF THAT:
 *   - a bearer token, compared in constant time, required on every request;
 *   - <TARGET> must be an https URL on a known platform host, or the literal
 *     `tiktokuser:<handle>` form yt-dlp uses for TikTok profiles;
 *   - <N> is clamped, so a caller cannot ask for a 100,000-entry walk;
 *   - stdout is capped and the process is killed on timeout.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST, said plainly: anyone holding the token
 * can make this host fetch from YouTube and TikTok as fast as it will go. The
 * token is the whole boundary. Treat it like the API keys it sits beside.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT WILL ACTUALLY BITE, AND IT IS NOT SECURITY
 * ---------------------------------------------------------------------------
 *
 * YouTube blocks datacentre IPs. A yt-dlp walk that works from a laptop very
 * often returns "Sign in to confirm you're not a bot" from a cloud host, and
 * that is a property of where this runs rather than of this code. It is the
 * reason this file reports upstream refusals as 502 with yt-dlp's own stderr
 * attached rather than flattening them into an empty list: an operator has to
 * be able to tell "YouTube refused this host" from "this channel posted
 * nothing". If it happens, the fixes are a residential proxy or cookies from a
 * signed-in session. COOKIES ARE NOW WIRED — see YTDLP_COOKIES_FILE below. A
 * proxy is not, and would be the next thing to build if cookies stop being
 * enough.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A secret kept in a FILE BESIDE THIS ONE, not in the unit.
 *
 * The token already works this way and the reason generalises: a value written
 * into the systemd unit shows up in \`systemctl cat\` and in the journal, and
 * editing that unit needs root — so rotating a credential would need root too.
 * Read from a file, rotating any of these is one line as the service's own
 * user, and the only thing needing root is the restart.
 *
 * The environment still wins when it is set, because a container deployment
 * (see the Dockerfile) has no such directory and passes -e instead.
 */
function secretBeside(name) {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8").trim() || null;
  } catch {
    // Absent is the ordinary case and not an error: most deployments of this
    // service need neither a proxy nor a cookie jar.
    return null;
  }
}

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Interface to bind.
 *
 * Defaults to all interfaces because in a container that is the only thing that
 * works — the platform's proxy reaches the container from outside. Behind a
 * reverse proxy on a shared host, set HOST=127.0.0.1 so the ONLY way in is
 * through nginx and its TLS. Without that, this listens on the box's public IP
 * over plain http and the bearer token — which is the only thing standing in
 * front of a process spawner — crosses the network in cleartext.
 */
const HOST = process.env.HOST ?? "0.0.0.0";
const TOKEN = (process.env.YTDLP_SERVICE_TOKEN ?? "").trim();
const BINARY = process.env.YTDLP_BINARY ?? "yt-dlp";

/**
 * A cookies.txt on THIS HOST, added to every fetching command, or null.
 *
 * ---------------------------------------------------------------------------
 * THE PATH IS THE SERVER'S AND THE CALLER CANNOT NAME IT
 * ---------------------------------------------------------------------------
 *
 * \`--cookies <path>\` reads a file off this host, which is why the matcher
 * refuses it from a caller and will go on refusing it — a token holder who
 * could name the path could read /etc/anything through yt-dlp's error messages.
 * Cookies are still the documented fix for the block this service exists to
 * survive, so they are supplied the only way that is safe: from an environment
 * variable set by whoever deployed the container, appended AFTER the argv has
 * been rebuilt, to a command this file constructed out of its own literals.
 *
 * NOT VALIDATED AS A PATH, DELIBERATELY. Whether the file exists, is readable
 * and is a cookie jar is yt-dlp's question, and yt-dlp answers it in a sentence
 * the app now puts on screen. A check here would be a second, worse copy of
 * that answer.
 */
const COOKIES_FILE =
  (process.env.YTDLP_COOKIES_FILE ?? "").trim() ||
  // A PATH here, not the jar itself — unlike the proxy, whose whole value is
  // the URL. \`cookies.txt\` beside this file is the conventional place; yt-dlp
  // also REWRITES the jar it is given as YouTube rotates it, so this path has
  // to stay writable by the service or the session slowly goes stale.
  (secretBeside("cookies-path") ?? null);

/**
 * A proxy to dial through, or null. The other half of the same answer.
 *
 * THIS IS THE LEVER THAT NEEDS NO ACCOUNT. A cookie jar is a signed-in session
 * somebody had to create; a residential proxy is an address, and it is the only
 * one of the two that needs no human step ever. It is also affordable on a
 * per-gigabyte service precisely because of what this container does NOT do:
 * both commands it runs are metadata — a listing and a --print that implies
 * --simulate — so the proxy carries JSON, never video.
 *
 * NEVER LOGGED. The URL usually carries a password, this service returns
 * yt-dlp's stderr to its caller, and the app now puts that on a screen.
 * \`scrubProxy\` is applied to every error body below.
 */
const PROXY = (process.env.YTDLP_PROXY ?? "").trim() || secretBeside("proxy");

/**
 * bgutil's \`generate_once.js\`, which mints a proof-of-origin token per video.
 *
 * SCRIPT MODE, NOT THE HTTP SERVER, and that is the reason this needed no root
 * to install: the provider's recommended deployment is a second daemon on
 * :4416, which would have meant a second systemd unit. The script is invoked
 * per call by the plugin instead — slower per resolve, and nothing to keep
 * running, supervise, or restart.
 */
const POT_SCRIPT = (process.env.YTDLP_POT_SCRIPT ?? "").trim() || secretBeside("pot-script");

/** The proxy's password, and the whole URL, taken out of anything a caller sees. */
export function scrubProxy(text, proxy = PROXY) {
  if (!text || !proxy) return text;
  let password = null;
  try {
    password = new URL(proxy).password || null;
  } catch {
    password = null;
  }
  let out = String(text).split(proxy).join("[REDACTED]");
  if (password && password.length >= 4) out = out.split(password).join("[REDACTED]");
  return out;
}
const TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS ?? 180_000);

/** Hard ceiling on `--playlist-end`, whatever the caller asks for. */
const MAX_PLAYLIST_END = 200;

/** Cap on stdout, so a pathological response cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The format string the application asks for, matched exactly. */
const MEDIA_FORMAT = "best[ext=mp4]/best";

/**
 * Hosts a target URL may name.
 *
 * Not a general URL fetcher: this exists to read five platforms. Anything else
 * is refused, which also means an SSRF attempt at a cloud metadata endpoint
 * (169.254.169.254) never reaches spawn.
 */
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "tiktok.com",
  "www.tiktok.com",
  "vm.tiktok.com",
  "instagram.com",
  "www.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "fb.watch",
  "x.com",
  "twitter.com",
]);

/** `tiktokuser:<handle>` — yt-dlp's own extractor prefix for a TikTok profile. */
const TIKTOK_USER = /^tiktokuser:[A-Za-z0-9._-]{1,64}$/;

function hostAllowed(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

/** A target is either an allowed https URL or the TikTok profile form. */
function targetAllowed(value) {
  return TIKTOK_USER.test(value) || hostAllowed(value);
}

/**
 * Match the caller's argv against the three known commands and return a FRESH
 * argv, or null.
 *
 * Everything returned here is constructed from literals in this file plus
 * values that have been validated. The caller's array is not reused.
 */
export function planFor(argv) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return null;

  // 3. --version
  if (argv.length === 1 && argv[0] === "--version") return ["--version"];

  // 1. --flat-playlist -J --no-warnings --playlist-end <N> <TARGET>
  if (
    argv.length === 6 &&
    argv[0] === "--flat-playlist" &&
    argv[1] === "-J" &&
    argv[2] === "--no-warnings" &&
    argv[3] === "--playlist-end"
  ) {
    const requested = Number(argv[4]);
    if (!Number.isInteger(requested) || requested < 1) return null;
    if (!targetAllowed(argv[5])) return null;
    const end = Math.min(requested, MAX_PLAYLIST_END);
    return ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", String(end), argv[5]];
  }

  // 2. --no-warnings --no-playlist -f <FORMAT> --print urls <URL>
  //
  // `--print` implies `--simulate`, so this resolves a link and never fetches a
  // byte of media. Rebuilding it here keeps that true regardless of what the
  // caller sent.
  if (
    argv.length === 7 &&
    argv[0] === "--no-warnings" &&
    argv[1] === "--no-playlist" &&
    argv[2] === "-f" &&
    argv[3] === MEDIA_FORMAT &&
    argv[4] === "--print" &&
    argv[5] === "urls"
  ) {
    if (!hostAllowed(argv[6])) return null;
    return ["--no-warnings", "--no-playlist", "-f", MEDIA_FORMAT, "--print", "urls", argv[6]];
  }

  return null;
}

/**
 * What THIS HOST adds to a plan that fetches: its proxy, its cookie jar.
 *
 * SEPARATE FROM \`planFor\` ON PURPOSE. \`planFor\` is the security boundary and
 * its tests assert exact argv shapes; folding environment variables into it
 * would make those tests depend on the environment they run in, which is how a
 * boundary stops being checkable. This runs after it, on a plan already built
 * from literals, and adds values the CALLER cannot supply — which is the whole
 * reason \`--cookies\` and \`--proxy\` are safe here and refused from the network.
 *
 * \`--version\` is left alone: it makes no request, and the probe that asks "is
 * yt-dlp here" must not be able to fail because of a cookie file or a proxy
 * that is down.
 */
export function withHostArgs(
  plan,
  { cookiesFile = COOKIES_FILE, proxy = PROXY, potScript = POT_SCRIPT } = {},
) {
  if (!plan) return plan;
  if (plan.length === 1 && plan[0] === "--version") return plan;
  const prefix = [];
  if (proxy) prefix.push("--proxy", proxy);
  if (cookiesFile) prefix.push("--cookies", cookiesFile);
  // THE PROOF-OF-ORIGIN TOKEN, WITHOUT WHICH THE MEDIA CDN REFUSES.
  //
  // Measured 2026-09-08: through the proxy, the player API answered and every
  // media URL it produced came back 403. That is a second gate, and it is the
  // one a POT provider exists for. With this pointed at bgutil's
  // \`generate_once.js\` the same box downloaded a merged 720p file in 24s.
  //
  // A host value like the other two: it names a script ON THIS MACHINE, so a
  // caller must never be able to supply it.
  if (potScript) {
    prefix.push("--extractor-args", "youtubepot-bgutilscript:script_path=" + potScript);
  }
  return prefix.length > 0 ? [...prefix, ...plan] : plan;
}

/** Constant-time bearer check. Length is compared first, without leaking via ===. */
function authorised(header) {
  if (!TOKEN) return false;
  const presented = (header ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function runYtDlp(args) {
  return new Promise((resolve) => {
    const child = spawn(BINARY, args, { windowsHide: true });
    let out = "";
    let err = "";
    let bytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      // Bounded: stderr is only ever shown in an error body.
      if (err.length < 8192) err += chunk;
    });

    child.on("error", (cause) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        status: cause.code === "ENOENT" ? 500 : 502,
        message:
          cause.code === "ENOENT"
            ? `\`${BINARY}\` is not installed on this service`
            : `could not run \`${BINARY}\`: ${cause.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, status: 504, message: `yt-dlp exceeded ${TIMEOUT_MS}ms or its output cap` });
        return;
      }
      if (code !== 0) {
        // 502, WITH STDERR. The caller has to be able to tell "YouTube refused
        // this host" from "this channel posted nothing"; flattening upstream
        // refusals into an empty list is the one failure this whole codebase
        // refuses to ship.
        resolve({ ok: false, status: 502, message: `yt-dlp exited ${code}`, stderr: err.trim().slice(0, 4000) });
        return;
      }
      resolve({ ok: true, stdout: out });
    });
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

// ===========================================================================
// GET /file — the bytes themselves
// ===========================================================================
//
// WHY THIS EXISTS AT ALL, GIVEN THAT THIS SERVICE WAS BUILT NOT TO FETCH MEDIA
//
// The original design resolved a link and handed it to the operator, and the
// comment on `mediaUrlArgs` still says --print implies --simulate so no byte of
// media is ever fetched. That was right while the link was usable. It is not.
//
// MEASURED 2026-09-08. Every googlevideo URL carries a signed `ip=` parameter
// and is refused from any other address:
//
//   same URL, from a different IP:          HTTP 403, 0 bytes
//   same URL, through the originating exit: HTTP 206, 200001 bytes
//
// Once the resolve has to run through a proxy — and it does, because YouTube
// gates the player API by address — the URL it produces is bound to the
// proxy's exit and is useless to the person who asked for it. A link nobody
// can open is not a deliverable. So the fetch moves here, where the address
// that resolved it is the address that can use it.
//
// NOTHING IS KEPT. The file lands in a private temp directory, is streamed
// out, and is removed in a `finally` that runs on success, on error and on a
// client that hangs up. This service re-hosts nothing.
//
// WHY GET AND A SIGNATURE RATHER THAN THE BEARER TOKEN. A browser has to be
// able to follow this link, and the bearer token is the only thing standing in
// front of a process spawner — it may not go near a page. So the application,
// which already holds the token, signs a short-lived URL with it; this route
// verifies the signature and never sees a secret it did not already have. The
// token authenticates the APPLICATION, and the signature authorises ONE video
// for a few minutes.

/** How many downloads may be in flight. Erik's number, 2026-09-08. */
const MAX_CONCURRENT_DOWNLOADS = 4;

/** A signed link is good for this long. Long enough to click, short enough to leak safely. */
const SIGNATURE_TTL_SECONDS = 600;

/** Refuse a file bigger than this rather than stream it forever. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** A download gets longer than a resolve, because it moves the whole file. */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS ?? 600_000);

/**
 * The format to fetch.
 *
 * H.264 FIRST, DELIBERATELY. The box's own test produced AV1 at 720p, which is
 * correct and modern and will not play in several things an operator is likely
 * to drop it into. `avc1` is the codec everything opens. The ladder falls back
 * to whatever exists rather than failing, because a playable file that is not
 * ideal beats a refusal.
 *
 * The muxed progressive format is NOT used even when offered: measured the same
 * day, itag 18 came back 403 from the media CDN while the DASH streams were
 * served. So this merges, which is why ffmpeg has to be on the host.
 */
const DOWNLOAD_FORMAT =
  "bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/" +
  "bestvideo[height<=720]+bestaudio/best";

let downloadsInFlight = 0;

/** The signature the application mints and this route checks. */
export function downloadSignature(videoUrl, expiresAt, token = TOKEN) {
  return createHmac("sha256", token).update(`${videoUrl}\n${expiresAt}`).digest("hex");
}

/** Constant-time comparison of two hex signatures of the same length. */
function signatureMatches(presented, expected) {
  const a = Buffer.from(String(presented ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Run yt-dlp until a file exists in `dir`, and return its path.
 *
 * The argv is REBUILT here from this file's own literals plus one validated
 * URL, exactly as `planFor` does for the other route. The caller supplies a
 * video address and nothing else — not a format, not an output template, not a
 * flag.
 */
function fetchToDirectory(videoUrl, dir) {
  return new Promise((resolve) => {
    const args = [
      ...withHostArgs(["--no-warnings", "--no-playlist"]),
      "-f",
      DOWNLOAD_FORMAT,
      "--merge-output-format",
      "mp4",
      // The static builds live beside yt-dlp itself. Without this the merge
      // fails on a box that has no system ffmpeg, which is the ordinary case.
      "--ffmpeg-location",
      dirname(BINARY),
      "-o",
      join(dir, "%(id)s.%(ext)s"),
      videoUrl,
    ];

    const child = spawn(BINARY, args, { windowsHide: true });
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      if (err.length < 8192) err += chunk;
    });

    child.on("error", (cause) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 500, message: `could not run \`${BINARY}\`: ${cause.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, status: 504, message: `the download exceeded ${DOWNLOAD_TIMEOUT_MS}ms` });
        return;
      }
      if (code !== 0) {
        const last = scrubProxy(err.trim().split("\n").pop() ?? "");
        resolve({ ok: false, status: 502, message: `yt-dlp exited ${code}: ${last.slice(0, 400)}` });
        return;
      }
      let files;
      try {
        files = readdirSync(dir).filter((f) => !f.endsWith(".part"));
      } catch (cause) {
        resolve({ ok: false, status: 500, message: `could not read the download: ${cause.message}` });
        return;
      }
      if (files.length !== 1) {
        // Zero means yt-dlp said it succeeded and produced nothing; more than
        // one means the merge did not happen and handing back either half
        // would be handing back a file with no sound.
        resolve({
          ok: false,
          status: 502,
          message: `expected one merged file and found ${files.length}`,
        });
        return;
      }
      resolve({ ok: true, path: join(dir, files[0]), name: files[0] });
    });
  });
}

async function handleDownload(req, res, url) {
  const videoUrl = url.searchParams.get("u") ?? "";
  const expiresAt = Number(url.searchParams.get("exp"));
  const presented = url.searchParams.get("sig") ?? "";

  if (!TOKEN) {
    send(res, 500, { error: "this service has no token configured, so it can verify nothing" });
    return;
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 < Date.now()) {
    send(res, 403, { error: "this link has expired. Press the download control again." });
    return;
  }
  if (!signatureMatches(presented, downloadSignature(videoUrl, expiresAt))) {
    send(res, 403, { error: "this link is not signed for this service" });
    return;
  }
  // CHECKED EVEN THOUGH IT IS SIGNED. The signature proves the application
  // asked; it does not prove the application asked for something sane, and a
  // bug there must not become a fetch of an arbitrary host from this box.
  if (!hostAllowed(videoUrl)) {
    send(res, 400, { error: "refused: not a video address this service reads" });
    return;
  }
  if (downloadsInFlight >= MAX_CONCURRENT_DOWNLOADS) {
    res.setHeader("retry-after", "20");
    send(res, 503, {
      error: `this service downloads ${MAX_CONCURRENT_DOWNLOADS} files at a time and is busy. Try again shortly.`,
    });
    return;
  }

  downloadsInFlight += 1;
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "ytdlp-"));
    const got = await fetchToDirectory(videoUrl, dir);
    if (!got.ok) {
      send(res, got.status, { error: got.message });
      return;
    }

    const { size } = statSync(got.path);
    if (size > MAX_FILE_BYTES) {
      send(res, 413, { error: `the file is ${size} bytes, over this service's ceiling` });
      return;
    }

    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(size),
      // The filename is yt-dlp's own `%(id)s.mp4`, so it is a platform id and
      // an extension — never anything a caller chose.
      "content-disposition": `attachment; filename="${got.name}"`,
      "cache-control": "no-store",
    });

    await new Promise((done) => {
      const stream = createReadStream(got.path);
      stream.on("error", () => {
        res.destroy();
        done();
      });
      // A client that hangs up mid-file must not leave the read running, and
      // must still reach the cleanup below.
      res.on("close", () => {
        stream.destroy();
        done();
      });
      stream.on("end", done);
      stream.pipe(res);
    });
  } catch (cause) {
    if (!res.headersSent) send(res, 500, { error: `the download failed: ${cause.message}` });
  } finally {
    // NOTHING IS KEPT. Success, failure, timeout, or a browser that closed the
    // tab halfway — this runs, and this service goes back to holding no media.
    downloadsInFlight -= 1;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (cause) {
        console.error(`[ytdlp] a temp directory could not be removed: ${cause.message}`);
      }
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, service: "ytdlp", tokenConfigured: TOKEN.length >= 16 });
    return;
  }

  if (req.method === "GET" && (req.url ?? "").startsWith("/file?")) {
    // No bearer check here on purpose — see the block above \`handleDownload\`.
    // A browser follows this link, and the token may not go near a page. The
    // signature is the authorisation, and it covers one video for ten minutes.
    handleDownload(req, res, new URL(req.url, "http://localhost"));
    return;
  }

  if (req.method !== "POST" || req.url !== "/run") {
    send(res, 404, { error: "POST /run, GET /file, or GET /health" });
    return;
  }

  if (!authorised(req.headers.authorization)) {
    // Deliberately says nothing about whether a token is configured here.
    send(res, 401, { error: "unauthorised" });
    return;
  }

  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      tooBig = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooBig) return;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, { error: "body must be JSON" });
      return;
    }

    const plan = planFor(body?.args);
    if (!plan) {
      send(res, 400, {
        error:
          "refused: the argv did not match one of the three commands this service runs. " +
          "It rebuilds a known command rather than filtering flags, so anything else is refused.",
      });
      return;
    }

    const result = await runYtDlp(withHostArgs(plan));
    if (!result.ok) {
      // Scrubbed on the way out. The proxy URL carries a password, yt-dlp
      // quotes the URL it dialled, and the app puts this body on a screen.
      send(res, result.status, {
        error: scrubProxy(result.message),
        stderr: scrubProxy(result.stderr),
      });
      return;
    }
    send(res, 200, { stdout: result.stdout });
  });
});

// Only listen when run as a program, so the matcher can be unit-tested.
if (process.env.NODE_ENV !== "test") {
  if (TOKEN.length < 16) {
    // Refuses to start rather than starting open. An unauthenticated yt-dlp
    // runner on a public host is somebody else's free scraping infrastructure.
    console.error(
      "YTDLP_SERVICE_TOKEN is unset or shorter than 16 characters. Refusing to start: " +
        "this endpoint spawns processes and the token is the only thing in front of it.",
    );
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`yt-dlp service listening on ${HOST}:${PORT}`);
  });
}

export { server };
