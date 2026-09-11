/**
 * Can this deployment actually get a video file? One command, one answer.
 *
 *   pnpm exec tsx verify/ytdlp.ts --selftest   offline; no yt-dlp, no network
 *   pnpm exec tsx verify/ytdlp.ts --check      the real chain, end to end
 *   pnpm exec tsx verify/ytdlp.ts --check --url https://www.youtube.com/watch?v=...
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-08 the /admin/shorts download button reported that the YouTube
 * adapter "has no way to get the file for this post". It had a way. YouTube was
 * refusing this machine's IP with "Sign in to confirm you're not a bot", a
 * sentence naming its own fix, and `catch { return null }` had thrown it away.
 * The lie is fixed in lib/platform/ytdlp.ts; this file is the other half — the
 * thing that answers "is it working NOW" without opening a browser, pressing a
 * button on a row somebody has to find first, and reading a table cell.
 *
 * IT EXERCISES THE REAL RUNNER, not a copy of its arguments. `makeYtDlpRunner`
 * is what production spawns, `ytDlpProxyArgs` and `ytDlpCookieArgs` are what
 * production reads the environment with, and `resolveMediaUrl` is the function
 * the download button reaches. A checker that rebuilt any of those would be
 * checking itself. That was the exact failure this repo has a scar for: 746
 * green tests over an X adapter the application never constructed.
 *
 * WHAT IT WILL NOT DO: fetch a byte of media. `mediaUrlArgs` uses `--print`,
 * which implies `--simulate`, and that is the same reason a proxy is affordable
 * here — this tool resolves links and never downloads video.
 *
 * NOTHING SECRET IS PRINTED. The proxy URL usually carries a password, so it is
 * reported as configured-or-not and its scheme, never its value, and every
 * message out of yt-dlp goes through `scrubProxy` on the way to the terminal.
 */
import {
  makeYtDlpRunner,
  mediaUrlArgs,
  resolveMediaUrl,
  scrubProxy,
  withHostArgs,
  ytDlpCookieArgs,
  ytDlpProxyArgs,
  ytDlpVersion,
  YtDlpError,
} from "../lib/platform/ytdlp";
import { remoteYtDlpFromEnv, makeRemoteYtDlpRunner } from "../lib/platform/ytdlp-remote";
import type { YtDlpRunner } from "../lib/platform/ytdlp";

/**
 * A video to resolve. Any public YouTube video does — the question is whether
 * THIS deployment is allowed to ask, not whether the video exists.
 *
 * The default is one of the two rows that produced the report above, so a green
 * run here is a direct answer about the failure that started this.
 */
const DEFAULT_URL = "https://www.youtube.com/watch?v=i7jX9SR0bfw";

function urlFrom(argv: readonly string[]): string {
  const i = argv.indexOf("--url");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : DEFAULT_URL;
}

/** Says WHETHER a proxy is set and what kind. Never says what it is. */
function describeProxy(): string {
  const raw = process.env.YTDLP_PROXY?.trim();
  if (!raw) return "none (YTDLP_PROXY unset)";
  try {
    // The scheme and the port are not secrets. The host, user and password are
    // treated as though they were, because on a shared provider they identify
    // the account being billed.
    const { protocol } = new URL(raw);
    return `configured, ${protocol.replace(":", "")}`;
  } catch {
    return "configured, but not a URL — --check will say so";
  }
}

function describeCookies(): string {
  const file = process.env.YTDLP_COOKIES_FILE?.trim();
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (file && browser) return "BOTH set — that is refused, see --check";
  if (file) return `file (${file})`;
  if (browser) return `browser (${browser})`;
  return "none";
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

async function check(argv: readonly string[]): Promise<number> {
  const url = urlFrom(argv);
  const remote = remoteYtDlpFromEnv();

  console.log("yt-dlp reachability check");
  console.log("-".repeat(72));
  console.log(`  runner      ${remote ? `remote service at ${remote.url}` : "local spawn"}`);
  console.log(`  proxy       ${describeProxy()}`);
  console.log(`  cookies     ${describeCookies()}`);
  console.log(`  video       ${url}`);
  console.log("");

  // The configuration is read through the same functions the runner uses, so a
  // refusal here is the refusal production would get, in the same words.
  try {
    ytDlpProxyArgs();
    ytDlpCookieArgs();
  } catch (cause) {
    console.log("FAILED — this deployment's configuration is refused before anything runs.");
    console.log("");
    console.log(`  ${cause instanceof Error ? cause.message : String(cause)}`);
    console.log("");
    console.log("Nothing was asked of YouTube. Fix the variable named above and run this again.");
    return 1;
  }

  const run: YtDlpRunner = remote ? makeRemoteYtDlpRunner(remote) : makeYtDlpRunner();

  // 1. IS YT-DLP THERE AT ALL. Deliberately first and deliberately separate:
  //    "yt-dlp is missing" and "YouTube refused us" are different problems with
  //    different fixes, and a check that could not tell them apart would be the
  //    same mistake this file exists to correct.
  const version = await ytDlpVersion(run);
  if (version === null) {
    console.log("FAILED — no yt-dlp answered.");
    console.log("");
    console.log(
      remote
        ? "  The service could not be reached, or it is not running. Nothing here is a\n" +
            "  statement about YouTube."
        : "  Install it (https://github.com/yt-dlp/yt-dlp), or point YTDLP_SERVICE_URL and\n" +
            "  YTDLP_SERVICE_TOKEN at a services/ytdlp deployment.",
    );
    return 1;
  }
  console.log(`  [ok] yt-dlp answered: ${version}`);

  // Shown, because "which flags did it actually run with" is the first question
  // of any argument about whether the proxy is in use. Values are redacted.
  const flags = withHostArgs(
    [...ytDlpProxyArgs(), ...ytDlpCookieArgs()],
    mediaUrlArgs(url),
  ).slice(0, -1);
  console.log(`  [ok] the resolve will run: ${scrubProxy(flags.join(" "))} <url>`);

  // 2. THE THING THE BUTTON DOES. Not a listing — a listing kept working on the
  //    day the downloads stopped, which is exactly why it is not the test.
  let resolved: string | null;
  try {
    resolved = await resolveMediaUrl(run, "youtube", url);
  } catch (cause) {
    const said = cause instanceof Error ? scrubProxy(cause.message) : String(cause);
    console.log("");
    console.log("FAILED — yt-dlp was asked for the file and refused. Its words:");
    console.log("");
    console.log(`  ${said}`);
    console.log("");
    if (/not a bot|sign in|consent|429|too many requests/i.test(said)) {
      console.log("That is the block, not a broken build. Two things answer it:");
      console.log("");
      console.log("  YTDLP_PROXY   an address YouTube has not gated. No account, nothing to");
      console.log("                renew. A resolve is metadata, so the gigabytes are cheap.");
      console.log("  YTDLP_COOKIES_FILE   a cookies.txt from a signed-in throwaway account.");
      console.log("                Someone has to sign in once — OAuth is gone — and it expires.");
      console.log("");
      console.log("Set one, run this again. On the remote runner, set it ON THE SERVICE.");
    }
    return 1;
  }

  if (resolved === null) {
    console.log("");
    console.log("FAILED — yt-dlp ran, succeeded, and printed no URL for this video.");
    console.log("  That is a fact about this video, not about the deployment. Try --url");
    console.log("  with another one before believing anything is broken.");
    return 1;
  }

  // The URL itself is not printed. It is a signed, six-hour googlevideo link;
  // pasting one into a terminal log is how a link that looks alive outlives the
  // session it belongs to. Its shape is enough to prove the chain worked.
  const host = (() => {
    try {
      return new URL(resolved).host;
    } catch {
      return "an address that will not parse";
    }
  })();
  console.log(`  [ok] a media URL came back, from ${host}`);
  console.log("");
  console.log("PASSED — this deployment can get video files. The download button works.");
  return 0;
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

/**
 * Offline. Proves the checker's own reading of the environment, so a green
 * `--check` on a laptop is not the only evidence this file is right.
 */
async function selftest(): Promise<number> {
  const failures: string[] = [];
  const is = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${label}: expected ${e}, got ${a}`);
  };

  is("no cookies configured", ytDlpCookieArgs({}), []);
  is("no proxy configured", ytDlpProxyArgs({}), []);
  is("a cookie file", ytDlpCookieArgs({ YTDLP_COOKIES_FILE: "/jar.txt" }), ["--cookies", "/jar.txt"]);
  is("a proxy", ytDlpProxyArgs({ YTDLP_PROXY: "socks5h://127.0.0.1:1080" }), [
    "--proxy",
    "socks5h://127.0.0.1:1080",
  ]);
  is("the version probe stays bare", withHostArgs(["--proxy", "x"], ["--version"]), ["--version"]);

  // The two refusals, because a misconfiguration that reached yt-dlp would be
  // reported as YouTube's fault.
  for (const [label, env] of [
    ["both cookie sources", { YTDLP_COOKIES_FILE: "/a", YTDLP_COOKIES_FROM_BROWSER: "firefox" }],
    ["an unknown browser", { YTDLP_COOKIES_FROM_BROWSER: "netscape" }],
  ] as const) {
    try {
      ytDlpCookieArgs(env);
      failures.push(`${label}: was accepted and should not have been`);
    } catch (cause) {
      if (!(cause instanceof YtDlpError)) failures.push(`${label}: threw the wrong kind of error`);
    }
  }
  try {
    ytDlpProxyArgs({ YTDLP_PROXY: "gateway.example.net:7000" });
    failures.push("a bare host:port proxy: was accepted and should not have been");
  } catch {
    // Expected. `new URL` parses that string by reading the host as a scheme,
    // which is why it is the case worth asserting.
  }

  // The password must not be printable, and this is the assertion that says so.
  const proxy = "http://user:s3cr3t-password@gateway.example.net:7000";
  const scrubbed = scrubProxy(`could not connect to ${proxy}`, { YTDLP_PROXY: proxy });
  if (/s3cr3t/.test(scrubbed)) failures.push("scrubProxy: the password survived");

  if (failures.length > 0) {
    console.log("SELFTEST FAILED");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log("SELFTEST PASSED — the configuration reader agrees with itself, offline.");
  return 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();
  if (argv.includes("--check")) return check(argv);
  console.log("Usage:");
  console.log("  pnpm exec tsx verify/ytdlp.ts --selftest   offline, no yt-dlp, no network");
  console.log("  pnpm exec tsx verify/ytdlp.ts --check      the real chain, end to end");
  console.log("  pnpm exec tsx verify/ytdlp.ts --check --url <a youtube url>");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    console.error("verify/ytdlp.ts fell over:", cause);
    process.exit(1);
  },
);
