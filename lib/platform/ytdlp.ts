/**
 * yt-dlp — the shared plumbing for every platform that can be read without a key.
 *
 * Two adapters use this file (YouTube and TikTok) and the rest cannot, which is
 * exactly why it lives here rather than inside one of them. Moved from
 * lib/source/ytdlp.ts when that channel-shaped seam was folded into
 * lib/platform/; the process handling below is the same code, because it was
 * already right and rewriting a working `spawn` wrapper is how a working
 * `spawn` wrapper stops working.
 *
 * THREE THINGS CHANGED IN THE MOVE, ALL DELIBERATE
 *
 * 1. The runner returns STDOUT, not parsed JSON. `--print urls` — the whole
 *    mechanism behind `downloadUrl()` — does not emit JSON, and a runner that
 *    can only produce JSON forces a second, near-identical spawn wrapper to
 *    exist beside it. `ytDlpJson()` does the parse for the callers that want it.
 *
 * 2. There is no `videoIdFromWatchUrl` fallback any more. It read `?v=` out of a
 *    URL, which is a YouTube fact living in shared code — the precise mistake
 *    lib/platform/types.ts is written to prevent. An entry with no `id` is
 *    skipped instead: identity is (platform, platform_video_id) and there is no
 *    row without one.
 *
 * 3. `requireReadableCounts()` exists. See below — it is the honesty rule made
 *    mechanical, and it is the most important function in this file.
 *
 * WHAT `--flat-playlist` ACTUALLY CARRIES, RECORDED RATHER THAN REMEMBERED
 *
 * fixtures/ytdlp-uploads-137.json  — a YouTube uploads playlist. Every entry has
 *   `id`, `title`, `duration`, `view_count`, `url`, `channel_id` and thumbnails,
 *   and every one of 137 has `timestamp: null`.
 * fixtures/ytdlp-shorts-tab-3.json — the same channel's /shorts TAB. Entries
 *   have `id`, `title`, `view_count` and `url` and NO `duration` at all.
 *
 * That difference decides which URL the YouTube adapter reads, and the reasoning
 * is in lib/platform/youtube.ts. It is recorded here because the fixtures are
 * the evidence and this is the file that parses them.
 */
import { spawn } from "node:child_process";

import type { LatestShortsQuery } from "./adapter";
import type { Platform, ShortRecord } from "./types";
import { markSafeToShow } from "../shorts/run";
import type { Env } from "../config";
import { scrub } from "../credentials/mask";

/** yt-dlp did not do what was asked. Carries the platform so a log line can say who. */
export class YtDlpError extends Error {
  constructor(
    readonly platform: Platform | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[yt-dlp${platform ? ` ${platform}` : ""}] ${message}`, options);
    this.name = "YtDlpError";
  }
}

/**
 * FIT TO PRINT — see `markSafeToShow` in lib/shorts/run.ts.
 *
 * Every message this class carries is one of two things: a sentence composed in
 * this repo for an operator to read, or yt-dlp's own last stderr line, quoted
 * through deliberately (`makeYtDlpRunner`) and truncated. Neither can carry a
 * credential — yt-dlp is spawned with a public post URL and no key, and the
 * remote runner names the SERVICE it could not reach and never its bearer token
 * (lib/platform/ytdlp-remote.ts).
 *
 * MEASURED, 2026-09-08, and that measurement is why this line exists.
 * `--print urls` on two rows this tool had just filed came back "Sign in to
 * confirm you're not a bot. Use --cookies-from-browser or --cookies for the
 * authentication" — a diagnosis naming its own fix. It went to a log file, and
 * the operator was told the adapter "has no way to get the file for this post",
 * which is not true and cannot be acted on. services/ytdlp/README.md already
 * promises this sentence reaches the screen; this is the mark that makes the
 * download path keep the promise the run path was already keeping.
 */
markSafeToShow(YtDlpError);

/**
 * Runs `yt-dlp` and returns its stdout verbatim. Injectable so no test ever
 * spawns a process or touches the network.
 */
export type YtDlpRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** Default per-invocation timeout, carried over from `tf/channels.py`. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The browsers yt-dlp can read a cookie jar out of, from its own `--help`.
 *
 * Checked rather than trusted because the value becomes an argv element, and an
 * unknown name fails INSIDE yt-dlp, late, with a message about browsers when
 * the actual mistake was a typo in an environment variable.
 */
const COOKIE_BROWSERS = [
  "brave",
  "chrome",
  "chromium",
  "edge",
  "firefox",
  "opera",
  "safari",
  "vivaldi",
  "whale",
] as const;

/**
 * The cookie flags every fetching yt-dlp call carries, read from the
 * environment. Empty when this deployment has no cookies configured, which is a
 * normal state and the one every test runs in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ON THE RUNNER AND NOT IN THE ARGS
 * ---------------------------------------------------------------------------
 *
 * The remote runner sends its argv to services/ytdlp, which does not FILTER the
 * argv — it matches it against the three commands this application issues and
 * rebuilds a fresh one. A cookie flag added in `mediaUrlArgs` or in an adapter's
 * playlist walk would therefore be refused with a 400 by the very deployment
 * that most needs cookies. So the flags live in the LOCAL runner, the argv the
 * app sends stays exactly the three known shapes, and the service adds its own
 * `--cookies` from a path held on the host that no caller can name. Two
 * mechanisms, because there are two trust boundaries; one meaning, because both
 * read the same operator decision.
 *
 * MEASURED ON WINDOWS, 2026-09-08, and it is why the FILE is not merely the
 * server's option: `--cookies-from-browser chrome` answered "Could not copy
 * Chrome cookie database" with Chrome open, and edge answered "Failed to
 * decrypt with DPAPI" — app-bound encryption, which yt-dlp cannot read at all.
 * On this platform an exported cookies.txt is the mechanism that works, so both
 * are supported and neither is presented as the default.
 *
 * ONE OR THE OTHER, NEVER BOTH. yt-dlp refuses the pair itself, and it refuses
 * it per call, which would arrive as five broken platforms and no explanation.
 * This says it once, in a sentence naming both variables.
 */
export function ytDlpCookieArgs(env: Env = process.env): readonly string[] {
  const browser = env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const file = env.YTDLP_COOKIES_FILE?.trim();

  if (browser && file) {
    throw new YtDlpError(
      null,
      "YTDLP_COOKIES_FROM_BROWSER and YTDLP_COOKIES_FILE are both set. yt-dlp takes one cookie " +
        "source or the other, so this deployment has to say which: a browser profile on the " +
        "machine that runs yt-dlp, or a cookies.txt exported from a signed-in session.",
    );
  }

  if (file) return ["--cookies", file];
  if (!browser) return [];

  // BROWSER[+KEYRING][:PROFILE][::CONTAINER] — only the browser is checked. The
  // rest is passed as ONE argv element to a spawn with no shell, so it reaches
  // yt-dlp as typed and cannot become a second argument or a command.
  const name = browser.split(/[+:]/, 1)[0]?.toLowerCase() ?? "";
  if (!(COOKIE_BROWSERS as readonly string[]).includes(name)) {
    throw new YtDlpError(
      null,
      `YTDLP_COOKIES_FROM_BROWSER is ${JSON.stringify(browser)}, and yt-dlp reads cookies from ` +
        `${COOKIE_BROWSERS.join(", ")}. The form is BROWSER[+KEYRING][:PROFILE][::CONTAINER].`,
    );
  }
  return ["--cookies-from-browser", browser];
}

/**
 * The proxy schemes yt-dlp will actually dial, from its own `--proxy` docs.
 *
 * A residential proxy is the ONE lever here that needs no account, no signed-in
 * session and no human step per run, which is why it is wired even though it is
 * the one that costs money. MEASURED 2026-09-08: with the IP gated, no client
 * (`web`, `mweb`, `tv`, `tv_simply`, `android_vr`, `ios`, `web_embedded`), no
 * JS runtime and no working BgUtils PO token provider made any difference. The
 * refusal lands before a token is even requested, so it is the address asking,
 * not what it asks with.
 */
const PROXY_SCHEMES = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"] as const;

/**
 * The proxy every yt-dlp call dials through, or none.
 *
 * `YTDLP_PROXY` is a whole URL and usually carries a password —
 * `http://user:pass@gateway.provider.net:7000` is the ordinary shape a
 * residential provider hands out. That password must never reach a screen, and
 * with `YtDlpError` now marked fit to print it very nearly could: yt-dlp quotes
 * the URL it dialled in several of its own failures. `scrubProxy` below is the
 * other half of this function and is not optional.
 *
 * A RESOLVE MOVES ALMOST NO DATA, which is what makes this affordable on a
 * service billed by the gigabyte: `mediaUrlArgs` uses `--print`, which implies
 * `--simulate`. This tool resolves links and never fetches a byte of media —
 * see `firstMediaUrl`. The proxy carries metadata, not video.
 */
export function ytDlpProxyArgs(env: Env = process.env): readonly string[] {
  const raw = env.YTDLP_PROXY?.trim();
  if (!raw) return [];

  // ONE REFUSAL FOR BOTH WAYS OF GETTING IT WRONG, because they are not
  // actually two. `new URL("gateway.example.net:7000")` PARSES — it reads the
  // host AS the scheme — so a bare host:port, the single likeliest mistake
  // here, reached the "unsupported scheme" branch and was told its own hostname
  // was a protocol. Found by the test that meant to prove the other branch.
  const scheme = ((): string | null => {
    try {
      return new URL(raw).protocol;
    } catch {
      return null;
    }
  })();

  if (scheme === null || !(PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    // The scheme is the ONLY part of this value the message may repeat. The
    // rest of it is a password.
    const found = scheme === null ? "" : ` — it reads as ${JSON.stringify(scheme.replace(":", ""))}`;
    throw new YtDlpError(
      null,
      `YTDLP_PROXY is not a proxy address yt-dlp can dial${found}. It wants ` +
        `scheme://[user:pass@]host:port, where the scheme is one of ` +
        `${PROXY_SCHEMES.map((s) => s.replace(":", "")).join(", ")} — for example ` +
        "http://user:pass@gateway.example.net:7000 or socks5h://127.0.0.1:1080.",
    );
  }

  return ["--proxy", raw];
}

/**
 * The proxy's password, taken out of anything on its way to a person.
 *
 * yt-dlp echoes the proxy URL in its own connection errors, `YtDlpError` is fit
 * to print, and /admin/shorts is open on around forty screens at LookUp Media.
 * Those three facts together are why this exists. It strips the whole URL and
 * the password on its own, because an error can quote either.
 */
export function scrubProxy(message: string, env: Env = process.env): string {
  const raw = env.YTDLP_PROXY?.trim();
  if (!raw) return message;
  let password: string | null = null;
  try {
    password = new URL(raw).password || null;
  } catch {
    password = null;
  }
  return scrub(message, raw, password);
}

/**
 * Everything this host adds to a fetching call: its proxy, then its cookies.
 *
 * BOTH, NOT ONE OR THE OTHER. They answer different halves of the same refusal
 * — the proxy changes WHO is asking, the cookies change WHAT it is asking as —
 * and a deployment that has paid for both should not have to pick.
 */
export function defaultHostArgs(env: Env = process.env): readonly string[] {
  return [...ytDlpProxyArgs(env), ...ytDlpCookieArgs(env)];
}

/**
 * The argv one yt-dlp call actually runs with.
 *
 * `--version` GOES BARE. It makes no request, so it needs no cookies, and a
 * cookie jar this machine cannot open — a locked Chrome database, a DPAPI
 * failure — must not turn the probe that asks "is yt-dlp here" into a report
 * that yt-dlp is missing. The probe answers about the binary; every call that
 * actually fetches carries the credentials.
 *
 * Exported so the decision above is testable without spawning anything.
 */
export function withHostArgs(
  hostArgs: readonly string[],
  args: readonly string[],
): readonly string[] {
  if (args.length === 1 && args[0] === "--version") return [...args];
  return [...hostArgs, ...args];
}

export function makeYtDlpRunner(
  binary = "yt-dlp",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /**
   * The flags this HOST adds to every fetching call — its proxy, its cookies.
   * Injected in tests; read from the environment in every real deployment.
   */
  hostArgs: () => readonly string[] = defaultHostArgs,
): YtDlpRunner {
  // RESOLVED ONCE, HERE, AND A MISCONFIGURATION IS KEPT RATHER THAN THROWN.
  // Throwing would take out the registry that constructs every adapter, and the
  // page would report five platforms failing to build instead of one sentence
  // naming the two variables. Held as a reason, it comes back on the FIRST call
  // any adapter makes — including the version probe — so it lands where
  // `unavailableReason` puts it: on the platform card, in words.
  let resolvedHostArgs: readonly string[] = [];
  let configProblem: Error | null = null;
  try {
    resolvedHostArgs = hostArgs();
  } catch (cause) {
    configProblem = cause instanceof Error ? cause : new YtDlpError(null, String(cause));
  }

  return (args, signal) =>
    new Promise((resolve, reject) => {
      if (configProblem) {
        reject(configProblem);
        return;
      }

      const child = spawn(binary, [...withHostArgs(resolvedHostArgs, args)], {
        signal,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (out += d));
      child.stderr.on("data", (d: string) => (err += d.slice(0, 2000)));

      child.on("error", (cause: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new YtDlpError(
            null,
            cause.code === "ENOENT"
              ? `\`${binary}\` is not installed or not on PATH`
              : `could not run \`${binary}\`: ${cause.message}`,
            { cause },
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // The LAST stderr line is the one carrying yt-dlp's own diagnosis, and
          // it is quoted through to the operator unedited. That sentence is
          // frequently better than anything this repo could write — it is what
          // told us TikTok wants a numeric channel_id.
          // SCRUBBED FIRST. YtDlpError is fit to print, and yt-dlp quotes the
          // URL it dialled — password and all — in several of its own
          // connection failures.
          const last = scrubProxy(err.trim().split("\n").pop() ?? "");
          reject(new YtDlpError(null, `yt-dlp exited ${code}: ${last.slice(0, 400)}`));
          return;
        }
        resolve(out);
      });
    });
}

/** Run yt-dlp and parse its stdout as JSON. */
export async function ytDlpJson(
  run: YtDlpRunner,
  platform: Platform,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  let stdout: string;
  try {
    stdout = await run(args, signal);
  } catch (cause) {
    if (cause instanceof YtDlpError && cause.platform === null) {
      // Re-thrown so the message names the platform the operator was reading.
      throw new YtDlpError(platform, cause.message.replace(/^\[yt-dlp\]\s*/, ""), { cause });
    }
    throw cause;
  }
  try {
    return JSON.parse(stdout.trim() || "{}");
  } catch (cause) {
    throw new YtDlpError(platform, "yt-dlp produced output that is not JSON", { cause });
  }
}

/**
 * Is yt-dlp actually here? Returns its version, or null.
 *
 * `unavailableReason()` on every keyless adapter calls this, because "yt-dlp is
 * not installed" is a real, common and completely fixable reason a platform
 * cannot be read, and it must reach the operator as those words rather than as
 * an empty list.
 */
/**
 * Why this runner cannot be used, in its own words, or null if it can.
 *
 * SCAR, 2026-09-05. `unavailableReason()` used to call `ytDlpVersion()`, get
 * null, and report "`yt-dlp` is not installed or not on PATH. Install it". That
 * was a GUESS dressed as a diagnosis, and once a remote runner existed it
 * became a wrong one: with YTDLP_SERVICE_URL pointing at a service that was
 * down, the app told the operator to install yt-dlp — on Vercel, where
 * installing it is impossible and where the actual fix was three characters of
 * a URL. A wrong reason is worse than no reason, because it is actionable in
 * the wrong direction.
 *
 * Both runners already produce an accurate sentence: the local one says
 * "`yt-dlp` is not installed or not on PATH" on ENOENT, the remote one says
 * which service could not be reached and why. This propagates whichever one
 * actually happened instead of substituting a third.
 */
export async function ytDlpUnavailableReason(run: YtDlpRunner): Promise<string | null> {
  try {
    const out = await run(["--version"]);
    if (out.trim()) return null;
    return (
      "`yt-dlp --version` returned nothing at all, so whatever is answering for yt-dlp on this " +
      "deployment cannot be trusted to read a playlist either."
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return (
      `${detail}. yt-dlp is the whole of the keyless path for this platform — there is no API key ` +
      "that substitutes for it, because the official APIs hydrate rows rather than discover them. " +
      "Either install yt-dlp where this runs (https://github.com/yt-dlp/yt-dlp), or point " +
      "YTDLP_SERVICE_URL and YTDLP_SERVICE_TOKEN at a working services/ytdlp deployment."
    );
  }
}

export async function ytDlpVersion(run: YtDlpRunner): Promise<string | null> {
  try {
    const out = await run(["--version"]);
    const line = out.trim().split("\n")[0]?.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ pure part

/** A `--flat-playlist` entry, as far as anything here reads it. All optional. */
export interface FlatEntry {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  duration?: unknown;
  view_count?: unknown;
  like_count?: unknown;
  comment_count?: unknown;
  timestamp?: unknown;
  release_timestamp?: unknown;
  upload_date?: unknown;
  channel?: unknown;
  channel_id?: unknown;
  channel_url?: unknown;
  uploader?: unknown;
  uploader_id?: unknown;
  uploader_url?: unknown;
  thumbnails?: unknown;
  thumbnail?: unknown;
}

/** The playlist/channel wrapper yt-dlp puts those entries in. */
export interface FlatPlaylist {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  channel_id?: unknown;
  channel_url?: unknown;
  uploader?: unknown;
  uploader_id?: unknown;
  uploader_url?: unknown;
  entries?: unknown;
}

export interface FlatToShortsOptions {
  readonly platform: Platform;
  readonly playlist: FlatPlaylist;
  /** Goes into `discovered_by` on every row. Provenance, recorded not inferred. */
  readonly discoveredBy: string;
  /** ISO timestamp for `discovered_at`. Injected so tests are not clock-dependent. */
  readonly discoveredAt: string;
  /**
   * Which yt-dlp fields hold the creator's HANDLE, best first.
   *
   * This is per-platform and it has to be, so the adapter passes it rather than
   * this file guessing. YouTube puts the @handle in `uploader_id` and a display
   * name in `uploader`; TikTok is the other way round — `uploader` is the unique
   * @name and `uploader_id` is a numeric author id (verified in yt-dlp's own
   * `_parse_aweme_video_web`). One shared preference order would be wrong for
   * one of them, and silently: a numeric id in a handle column still looks like
   * data.
   */
  readonly handleFields?: readonly ["uploader_id" | "uploader", "uploader_id" | "uploader"];
  /**
   * The topic these entries were SEARCHED FOR, when they were.
   *
   * Omitted for every untargeted listing — a channel's uploads playlist, a
   * hashtag feed — and that omission becomes `topic_slug: null`, which means
   * "no subject was asked for" rather than "the subject is unknown". See
   * `ShortRecord.topic_slug`.
   */
  readonly topicSlug?: string | null;
}

/** How many entries the source actually returned, before anything was dropped. */
export function entryCount(playlist: FlatPlaylist): number {
  return Array.isArray(playlist.entries) ? playlist.entries.length : 0;
}

/**
 * `--flat-playlist` JSON -> `ShortRecord[]`. Pure, so it is tested against
 * recorded output and never against the network.
 *
 * NOTHING IS FILTERED HERE. Not by duration, not by views. This function
 * translates; the adapter decides. Two reasons: a filter that runs inside the
 * translation cannot be told apart from a source that returned nothing, and a
 * filter applied per-platform is a filter that can disagree per-platform.
 *
 * Two kinds of entry are dropped, and both are dropped because there is
 * literally no row to make:
 *   - no `id`      — identity is (platform, platform_video_id).
 *   - no `url`     — `ShortRecord.url` is the link that persists and the one
 *                    thing the operator is promised. A row without it is a
 *                    result nobody can open.
 * `entryCount()` is exported so a caller can see that entries WERE returned and
 * still produced no rows, which is a different fact from an empty source.
 */
export function shortsFromFlatPlaylist(options: FlatToShortsOptions): ShortRecord[] {
  const { platform, playlist, discoveredBy, discoveredAt } = options;
  const [firstHandleField, secondHandleField] = options.handleFields ?? ["uploader_id", "uploader"];
  const entries = Array.isArray(playlist.entries) ? (playlist.entries as FlatEntry[]) : [];
  const out: ShortRecord[] = [];

  for (const entry of entries) {
    const id = str(entry.id);
    const url = str(entry.url);
    if (!id || !url) continue;

    out.push({
      platform,
      platform_video_id: id,
      url,
      title: str(entry.title),
      creator_handle: handle(
        str(entry[firstHandleField]) ??
          str(entry[secondHandleField]) ??
          str(playlist[firstHandleField]) ??
          str(playlist[secondHandleField]),
      ),
      creator_id: str(entry.channel_id) ?? str(playlist.channel_id),
      creator_url:
        str(entry.channel_url) ??
        str(entry.uploader_url) ??
        str(playlist.channel_url) ??
        str(playlist.uploader_url),
      duration_seconds: seconds(entry.duration),
      view_count: int(entry.view_count),
      like_count: int(entry.like_count),
      comment_count: int(entry.comment_count),
      published_at: publishedAt(entry),
      thumbnail_url: bestThumbnail(entry),
      discovered_at: discoveredAt,
      discovered_by: discoveredBy,
      topic_slug: options.topicSlug ?? null,
    });
  }

  return out;
}

/**
 * THE HONESTY RULE, MADE MECHANICAL.
 *
 * The product's promise is "shorts over N views, at or under M seconds". Both
 * halves of that need a number from the source. If a source hands back rows and
 * not one of them carries a view count, then every row fails the threshold —
 * and the adapter returns `[]`, which on screen is indistinguishable from
 * "nothing on this platform went over 500,000 views today".
 *
 * That is the exact confusion this repo forbids, and it is not hypothetical: it
 * is what happens the day an extractor starts returning a listing without
 * `view_count`, which extractors do, silently, on their own schedule. So this
 * throws instead. An unreadable platform is an error; an empty platform is a
 * result; they must never arrive as the same value.
 *
 * It only fires when entries were actually returned. A source that legitimately
 * had nothing to list produces zero entries and zero rows, and that IS an empty
 * result.
 */
export function requireReadableCounts(
  platform: Platform,
  entriesSeen: number,
  records: readonly ShortRecord[],
  source: string,
): void {
  if (entriesSeen === 0) return;
  if (records.length === 0) {
    throw new YtDlpError(
      platform,
      `${source} returned ${entriesSeen} entries and not one of them had both an id and a URL. ` +
        "That is an unreadable listing, not an empty one — the extractor's output shape has " +
        "changed. Refusing to report it as 'no shorts found'.",
    );
  }
  if (records.every((r) => r.view_count === null)) {
    throw new YtDlpError(
      platform,
      `${source} returned ${records.length} entries and not one carried a view count. ` +
        "The view threshold cannot be applied, so every row would be dropped and the platform " +
        "would look empty when it is actually unreadable. Refusing to report it as 'no shorts found'.",
    );
  }
  if (records.every((r) => r.duration_seconds === null)) {
    throw new YtDlpError(
      platform,
      `${source} returned ${records.length} entries and not one carried a duration. ` +
        "Duration is the only thing that defines a Short, so every row would be dropped and the " +
        "platform would look empty when it is actually unreadable. Refusing to report it as " +
        "'no shorts found'.",
    );
  }
}

/**
 * The product's promise and the operator's length window, applied to one record.
 *
 * It lives here because the two keyless adapters share it and duplicating a
 * threshold is how two platforms end up with two thresholds. It is NOT the only
 * place the filter runs: the caller applies it again to the merged list,
 * deliberately, because the threshold is the product's promise and it may not
 * depend on five different sources each being trusted to honour it.
 *
 * NULL IS NOT ZERO AND NOT "PROBABLY FINE". A video that has not been shown to
 * be under the ceiling is not a Short — the source did not say, and this repo
 * does not fill in what a source did not say. Same for the view count.
 */
export function matchesQuery(record: ShortRecord, query: LatestShortsQuery): boolean {
  if (record.duration_seconds === null || record.duration_seconds > query.maxDurationSeconds) return false;
  // The length floor, inclusive, exactly as `judge` in lib/shorts/run.ts reads
  // it. A zero floor excludes nothing, which is why the ordinary run does not
  // notice this line.
  if (record.duration_seconds < query.minDurationSeconds) return false;
  if (record.view_count === null || record.view_count < query.minViews) return false;
  return true;
}

// --------------------------------------------------------------- direct media

/**
 * The format selector used when resolving a direct media URL.
 *
 * A SINGLE progressive file on purpose. yt-dlp's default picks the best video
 * and the best audio SEPARATELY, and `--print urls` then emits two lines that
 * only a muxer can put back together. One line that a browser can open is what
 * the operator was promised; `best[ext=mp4]/best` is the ordinary way to ask
 * for it, with the bare `best` as the fallback for a platform that has no mp4.
 */
export const MEDIA_FORMAT = "best[ext=mp4]/best";

/** The args that print a media URL without downloading anything. */
export function mediaUrlArgs(postUrl: string): readonly string[] {
  // `--print` implies `--simulate`, so no byte of media is ever fetched. This
  // tool resolves a link; it does not download or re-host media.
  return ["--no-warnings", "--no-playlist", "-f", MEDIA_FORMAT, "--print", "urls", postUrl];
}

/**
 * First media URL out of `--print urls` output, or null.
 *
 * NEVER STORE WHAT THIS RETURNS. Measured on this machine 2026-09-04 against
 * https://www.youtube.com/shorts/5mU6SRS2Bxo: the returned googlevideo URL
 * carried `expire=1788536513` against a request stamped 1788514913 — a life of
 * exactly 21,600 seconds, six hours. A table of six-hour URLs is a table of
 * dead links that still look alive, and nothing about such a row says it has
 * rotted until somebody clicks it. The canonical post URL is what persists.
 */
export function firstMediaUrl(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * One post's direct media URL, or null when yt-dlp ran and had none to give.
 *
 * ---------------------------------------------------------------------------
 * NULL AND A THROW ARE DIFFERENT ANSWERS, AND THE DIFFERENCE IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * Both adapters that resolve media through yt-dlp used to spell this inline, as
 * `try { firstMediaUrl(await run(...)) } catch { return null }`, under a comment
 * saying that a refusal for one video is a fact about that video. The comment
 * was right and the code did not implement it: `catch` cannot tell
 * "members-only" from "this IP is being asked to prove it is not a bot", and
 * null on this seam has a documented meaning — THIS ADAPTER HAS NO WAY TO GET
 * YOU THE FILE (lib/platform/adapter.ts). So every failure, whatever it was,
 * reached the page as a statement about the adapter's capabilities, which is
 * the one thing none of them was.
 *
 * SCAR, 2026-09-08. Two YouTube rows, filed by a run that had just worked, both
 * refused. yt-dlp's reason was "Sign in to confirm you're not a bot. Use
 * --cookies-from-browser or --cookies for the authentication" — the block
 * services/ytdlp/README.md warns about, arriving from a laptop rather than a
 * datacentre and naming its own fix. What the operator saw was "The YouTube
 * adapter has no way to get the file for this post." Re-measured minutes later,
 * a video that HAD resolved was refused the same way, which settles what it is:
 * a gate on the IP, not a property of any video.
 *
 * So a failure is thrown, carrying yt-dlp's own sentence, and null is left
 * meaning only what it says: yt-dlp succeeded and printed no URL.
 */
export async function resolveMediaUrl(
  run: YtDlpRunner,
  platform: Platform,
  postUrl: string,
  signal?: AbortSignal,
  /** Injected in tests. Whether this deployment has an address it can change. */
  rotating: (env?: Env) => boolean = hasRotatingProxy,
): Promise<string | null> {
  // ONE RETRY, AND ONLY BEHIND A PROXY. MEASURED 2026-09-08: five consecutive
  // resolves through Decodo's rotating gateway, one refused with the bot check
  // and passed immediately on a second attempt. That is what a rotating
  // residential pool is — a fresh exit IP per request, drawn from a pool where
  // some addresses are themselves already gated. One in five is not a rounding
  // error on a button that resolves two hundred rows.
  //
  // WHY THIS DOES NOT CONTRADICT lib/platform/ytdlp-remote.ts, which says in as
  // many words that a runner must not quietly retry. That rule is about the
  // LISTING: a retried walk turns "YouTube refused this host" into a slow
  // success or, worse, a silent empty list, and this whole repo is built on
  // never letting a failure look like an absence. A media resolve cannot be
  // mistaken for an absence — it answers with a URL or with a refusal a person
  // reads — so the ambiguity that rule protects against does not exist here.
  //
  // WITHOUT A PROXY IT DOES NOT RETRY, because then the second attempt is the
  // same machine asking the same gate the same question, and the only thing it
  // buys is that the operator waits twice as long to read the same sentence.
  const attempts = rotating() ? 2 : 1;
  let last: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return firstMediaUrl(await run(mediaUrlArgs(postUrl), signal));
    } catch (cause) {
      last = cause;
      // A caller that gave up is not asking again on its behalf.
      if (signal?.aborted) break;
    }
  }

  // Named for the operator, exactly as `ytDlpJson` does it: the runner does
  // not know which platform it was pointed at, and "yt-dlp exited 1" with no
  // platform on it is a sentence nobody can place on a five-platform page.
  if (last instanceof YtDlpError && last.platform === null) {
    throw new YtDlpError(platform, last.message.replace(/^\[yt-dlp\]\s*/, ""), { cause: last });
  }
  throw last;
}

/**
 * Does this deployment have an address that a second attempt might change?
 *
 * Deliberately does not validate the URL — `ytDlpProxyArgs` does that, loudly,
 * and a second opinion here would be a second place to keep in step.
 *
 * TWO WAYS TO BE TRUE, AND THE SECOND IS THE DEPLOYMENT THAT MATTERS. On a
 * machine that spawns yt-dlp, the proxy is this process's own variable. On
 * Vercel there is no yt-dlp to spawn: the runner is the remote service, and the
 * proxy belongs to THAT host, because that is where the request egresses. So
 * the variable this function was first written to read is deliberately absent
 * from exactly the deployment the retry was measured to need — and setting it
 * there would be actively wrong, because the app would then put `--proxy` into
 * an argv the service's matcher refuses.
 *
 * A configured remote service therefore counts. It is an inference and not a
 * fact — that host may have no proxy either — and the cost of being wrong is
 * one extra metadata call on a resolve that had already failed. The cost of the
 * opposite mistake is a fifth of an export reading as "no file for this post".
 */
export function hasRotatingProxy(env: Env = process.env): boolean {
  if (env.YTDLP_PROXY?.trim()) return true;
  // Half a remote service is not a runner and not an address: a URL with no
  // token cannot authenticate. Same rule, same reason, as `remoteYtDlpFromEnv`.
  return Boolean(env.YTDLP_SERVICE_URL?.trim() && env.YTDLP_SERVICE_TOKEN?.trim());
}

// -------------------------------------------------------------------- helpers

function publishedAt(e: FlatEntry): string | null {
  const ts = int(e.timestamp) ?? int(e.release_timestamp);
  if (ts !== null) return new Date(ts * 1000).toISOString();
  const day = str(e.upload_date);
  if (day && /^\d{8}$/.test(day)) {
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
  }
  // Never manufactured from position in the listing. Order is known; date is not.
  return null;
}

function bestThumbnail(e: FlatEntry): string | null {
  const direct = str(e.thumbnail);
  if (direct) return direct;
  if (!Array.isArray(e.thumbnails)) return null;
  let best: { url: string; width: number } | null = null;
  for (const t of e.thumbnails as Array<{ url?: unknown; width?: unknown }>) {
    const url = str(t?.url);
    if (!url) continue;
    const width = int(t?.width) ?? 0;
    if (!best || width > best.width) best = { url, width };
  }
  return best?.url ?? null;
}

/** `@name` -> `name`. Anything else is passed through as the source said it. */
function handle(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("@") ? value.slice(1) || null : value;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function int(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function seconds(v: unknown): number | null {
  // Zero is not a duration. On YouTube it is a live broadcast with no known
  // end, and admitting it would make the cheapest possible Short in the list.
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v);
}
