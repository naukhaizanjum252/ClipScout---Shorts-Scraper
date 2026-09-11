/**
 * A `YtDlpRunner` that calls the service in services/ytdlp instead of spawning.
 *
 * WHY. `makeYtDlpRunner` spawns a child process, which works anywhere the
 * binary is on PATH and does not work on Vercel — no yt-dlp, no way to install
 * one. YouTube discovery is ENTIRELY keyless yt-dlp (the Data API key only
 * hydrates rows it already found; it cannot enumerate), so on Vercel YouTube
 * reported "`yt-dlp` is not installed or not on PATH" and returned nothing.
 * Erik's call, 2026-09-05: build the runner rather than buy a vendor endpoint.
 *
 * THE SEAM WAS ALREADY THERE, which is the only reason this is a small file.
 * `YtDlpRunner` is `(args, signal?) => Promise<string>` returning stdout
 * verbatim. Nothing downstream — not the YouTube adapter, not TikTok, not the
 * run, not `ytDlpVersion` — knows or can tell which implementation it holds.
 * That is the point: the honesty rules about unavailability, the version probe,
 * the media-URL resolution all keep working unchanged.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: interpret, retry, or repair. A remote
 * runner that quietly retried would turn "YouTube refused this host" into a
 * slow success or a silent empty list, and the whole adapter layer is built on
 * the opposite rule — an adapter that cannot read THROWS rather than returning
 * `[]`. So every failure here becomes a `YtDlpError` carrying what the service
 * said, and `lib/shorts/run.ts` files the platform as unavailable with a reason
 * a person can act on.
 */
import { createHmac } from "node:crypto";

import { YtDlpError, type YtDlpRunner } from "./ytdlp";

export interface RemoteYtDlpOptions {
  /** Base URL of the service, e.g. https://ytdlp.example.com — no trailing /run. */
  readonly url: string;
  /** The bearer token the service requires. */
  readonly token: string;
  /**
   * Per-call ceiling. Generous by default: a flat-playlist walk of a large
   * channel legitimately takes tens of seconds, and the service applies its own
   * timeout underneath this one.
   */
  readonly timeoutMs?: number;
  /** Injectable so tests never touch the network. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_REMOTE_TIMEOUT_MS = 190_000;

/**
 * A runner backed by the HTTP service.
 *
 * The argv is sent as-is. The SERVICE does not filter it — it matches it
 * against the three commands this application issues and rebuilds a fresh argv
 * from the validated parts, refusing anything else. That check lives there
 * rather than here on purpose: this file runs inside the app, and a check that
 * only runs in the caller protects nothing once the token is known.
 */
export function makeRemoteYtDlpRunner(options: RemoteYtDlpOptions): YtDlpRunner {
  const base = options.url.replace(/\/+$/, "");
  const endpoint = `${base}/run`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return async (args, signal) => {
    // Two independent reasons to stop: the caller's signal and our own ceiling.
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ args: [...args] }),
        signal: abort,
      });
    } catch (cause) {
      // The service being unreachable is the most likely failure in production
      // and the one an operator can actually fix, so it says so in as many
      // words rather than surfacing a bare TypeError from fetch.
      throw new YtDlpError(
        null,
        `the yt-dlp service at ${base} could not be reached: ${(cause as Error).message}`,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await readError(response);
      throw new YtDlpError(
        null,
        `the yt-dlp service at ${base} answered ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    const body = (await response.json().catch(() => null)) as { stdout?: unknown } | null;
    if (typeof body?.stdout !== "string") {
      throw new YtDlpError(
        null,
        `the yt-dlp service at ${base} returned a body with no stdout string`,
      );
    }
    return body.stdout;
  };
}

/**
 * The service's own words, when it has any.
 *
 * yt-dlp's stderr is carried through deliberately. "Sign in to confirm you're
 * not a bot" is the single most likely thing a datacentre-hosted runner will
 * hit, and an operator who cannot see that line has no way to distinguish it
 * from a channel that posted nothing.
 */
async function readError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown; stderr?: unknown };
    const parts = [body.error, body.stderr].filter((p): p is string => typeof p === "string" && p !== "");
    return parts.length > 0 ? parts.join(" — ").slice(0, 600) : null;
  } catch {
    return null;
  }
}

/**
 * Read the service's configuration out of the environment, or null.
 *
 * BOTH OR NEITHER. A URL without a token cannot authenticate and a token
 * without a URL has nowhere to go; either alone is a misconfiguration that
 * would otherwise fall back to spawning a binary that is not there, and report
 * the wrong reason. Null means "use the local spawn", which is correct on a
 * developer machine and correct in CI.
 */
export function remoteYtDlpFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RemoteYtDlpOptions | null {
  const url = env.YTDLP_SERVICE_URL?.trim();
  const token = env.YTDLP_SERVICE_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}
/**
 * A link the OPERATOR'S BROWSER can follow, pointing at the service's /file.
 *
 * ---------------------------------------------------------------------------
 * WHY A DOWNLOAD LINK AND NOT THE MEDIA URL ANY MORE
 * ---------------------------------------------------------------------------
 *
 * MEASURED 2026-09-08. Every googlevideo URL carries a signed `ip=` parameter
 * and is refused from any other address:
 *
 *   the same URL, from a different IP:          HTTP 403, 0 bytes
 *   the same URL, through the originating exit: HTTP 206, 200001 bytes
 *
 * The resolve has to run through a proxy, because YouTube gates the player API
 * by address. So the URL it produces is bound to the PROXY's exit and is
 * useless to the person who pressed the button — which is exactly what the
 * operator saw: "Open the video file" led to `Access to
 * rr4---sn-vgqsrned.googlevideo.com was denied`.
 *
 * The bytes therefore have to come from the machine that resolved them. This
 * mints a link to the service's /file route, which fetches through the same
 * proxy, streams the file out, and deletes it.
 *
 * THE BEARER TOKEN DOES NOT GO IN IT. That token is the only thing standing in
 * front of a process spawner and may never reach a page. It is used as an HMAC
 * KEY instead: the signature proves this application asked, covers ONE video,
 * and expires. A person holding the link can download that one video for ten
 * minutes and can do nothing else with it.
 */
export function signedDownloadUrl(
  videoUrl: string,
  options: RemoteYtDlpOptions,
  now: () => number = Date.now,
  ttlSeconds = 600,
): string {
  const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
  // The exact string services/ytdlp/server.mjs signs. The two must agree
  // character for character, so the shape is stated once in each file and
  // asserted against a recorded pair in the tests.
  const signature = createHmac("sha256", options.token)
    .update(`${videoUrl}\n${expiresAt}`)
    .digest("hex");

  const base = options.url.replace(/\/+$/, "");
  const query = new URLSearchParams({
    u: videoUrl,
    exp: String(expiresAt),
    sig: signature,
  });
  return `${base}/file?${query.toString()}`;
}
