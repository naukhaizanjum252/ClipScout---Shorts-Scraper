/**
 * The ONE place a tunable number lives.
 *
 * Plan l35-shorts-scraper-2026-004, Phase 0 acceptance:
 *
 *   "Grep proves no hardcoded daily-quota constant outside config; the number
 *    comes from the recording."
 *
 * So `dailyQuotaUnits()` has NO DEFAULT. Every published figure about YouTube
 * Data API v3's daily allowance is a documentation figure about somebody else's
 * project, and this tool is not allowed to quote one as though we had measured
 * ours. Unset reads back as `null`, and every caller has to say out loud what it
 * does when the answer is "nobody has told us".
 *
 * `shortMaxSeconds()` is the opposite case: it HAS a default, because the client
 * gave it to us in as many words on 2026-09-01 — "2 minutes max is length". It
 * is still config and not a literal, because YouTube's own Shorts ceiling has
 * moved before and will move again.
 *
 * `minViews()` is the same case as the ceiling, from the same kind of source:
 * Erik named 500,000 himself on 2026-09-02. So it has a default, and the
 * comment on it says whose sentence it is. That is the rule this whole file
 * turns on — A NUMBER MAY HAVE A DEFAULT WHEN SOMEBODY WITH THE AUTHORITY TO
 * SET IT SAID IT OUT LOUD, AND NOT WHEN IT WAS READ OFF SOMEBODY ELSE'S
 * DOCUMENTATION. Every default here cites a person and a date; anything that
 * cannot is `null` and the caller has to cope.
 */

/** Thrown when config is asked for a number nobody has supplied. */
export class MissingConfigError extends Error {
  constructor(
    readonly key: string,
    hint: string,
  ) {
    super(`${key} is not set. ${hint}`);
    this.name = "MissingConfigError";
  }
}

/** Source of environment values. Injectable so tests never touch process.env. */
export type Env = Record<string, string | undefined>;

function readInt(env: Env, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new MissingConfigError(key, `Expected a whole number of units, got ${JSON.stringify(raw)}.`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new MissingConfigError(key, `Expected a positive whole number, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

/**
 * The Shorts ceiling in seconds.
 *
 * SOURCE: Luka, Discord #shorts, 2026-09-01, asked directly for the longest a
 * Short can be — "2 minutes max is length".
 *
 * Must equal `shorts_scraper.short_max_seconds()` in the core migration under
 * supabase/migrations/. tests/config-agreement.test.ts fails if they drift,
 * because a ceiling that disagrees between the filter and the generated column
 * silently produces two different inventories and neither one looks wrong.
 */
export const SHORT_MAX_SECONDS_DEFAULT = 120;

export function shortMaxSeconds(env: Env = process.env): number {
  return readInt(env, "SHORT_MAX_SECONDS") ?? SHORT_MAX_SECONDS_DEFAULT;
}

/**
 * The view threshold. A short under this is not in the product.
 *
 * SOURCE: Erik, 2026-09-02, describing the whole tool in one sentence — "come
 * back with shorts over 500k views categorized by platform, AXE the rest."
 *
 * It HAS a default for the same reason the Shorts ceiling does: the person who
 * decides said the number himself. It is still config and not a literal,
 * because "what counts as big" is a judgement that moves with the client and
 * the platform mix, and the day Luka wants 200k this must be one environment
 * variable rather than a grep.
 *
 * IT IS DELIBERATELY ONE NUMBER FOR ALL FIVE PLATFORMS. A per-platform
 * threshold is a tempting idea — a million views on YouTube is not a million on
 * X — but nobody has told us what those numbers are, and inventing four of them
 * would put a business judgement in a config file under the cover of a default.
 * When Erik gives per-platform figures they belong here, cited the same way.
 *
 * ZERO IS REJECTED, not treated as "no threshold". `MIN_VIEWS=0` is a request
 * to turn the product's one promise off, and it is far more likely to be a
 * misread env file than an intention. Deleting the filter is a code change, and
 * it should look like one.
 */
export const MIN_VIEWS_DEFAULT = 500_000;

export function minViews(env: Env = process.env): number {
  return readInt(env, "MIN_VIEWS") ?? MIN_VIEWS_DEFAULT;
}

/**
 * A daily YouTube Data API v3 unit allowance, as a DEVELOPMENT fallback.
 *
 * QUOTA IS PER GOOGLE CLOUD PROJECT, AND EVERY OPERATOR BRINGS THEIR OWN. So
 * the real figure lives per credential, on `api_credentials.daily_quota_units`,
 * where the operator who owns that project records what their console says. A
 * single environment variable cannot be right for more than one of them.
 *
 * This function is the laptop case, and it still has NO DEFAULT: `null` means
 * nobody has read a figure off any console, and callers must handle it. There
 * is no fallback on purpose — a daily-quota number that is not a measurement is
 * exactly what this repo refuses to hold.
 */
export function dailyQuotaUnits(env: Env = process.env): number | null {
  return readInt(env, "YOUTUBE_DAILY_QUOTA_UNITS");
}

/**
 * The same number, but for a caller that genuinely cannot proceed without it
 * (the quota calibration run). Throws rather than guessing.
 */
export function requireDailyQuotaUnits(env: Env = process.env): number {
  const n = dailyQuotaUnits(env);
  if (n === null) {
    throw new MissingConfigError(
      "YOUTUBE_DAILY_QUOTA_UNITS",
      "Read it off Google Cloud console -> APIs & Services -> YouTube Data API v3 -> Quotas " +
        "for the project whose key is in YOUTUBE_API_KEY, and put it in .env.local. " +
        "This tool will not assume a figure it has not been told.",
    );
  }
  return n;
}

/**
 * Which source adapter is in play. THE ONE PLACE THIS IS DECIDED.
 *
 * `ytdlp` is the default, and that is a deliberate choice rather than a
 * convenience: the whole seeded path then runs today, on any machine, with no
 * key, no Google Cloud project and no `.env` file at all. `api` is selected
 * only when somebody says so AND a credential exists.
 *
 * Nothing outside `lib/source/select.ts` may branch on this value. An ingest
 * that asks which adapter it has is an ingest that grows two behaviours.
 */
export function sourceAdapterName(env: Env = process.env): "ytdlp" | "api" {
  const raw = env.SOURCE_ADAPTER?.trim().toLowerCase();
  if (!raw) return "ytdlp";
  if (raw === "ytdlp" || raw === "api") return raw;
  throw new MissingConfigError("SOURCE_ADAPTER", `Expected "ytdlp" or "api", got ${JSON.stringify(raw)}.`);
}

/**
 * The development-fallback API key.
 *
 * IN PRODUCTION THIS IS NOT WHERE THE KEY COMES FROM. Every operator supplies
 * their own key through the settings page; it is stored per-tenant, encrypted
 * at rest, and leased for one outbound call at a time
 * (lib/credentials/). This variable exists so a developer can poke at the API
 * on a laptop, and `resolveCredentialStore()` refuses to use it in production.
 *
 * The reason is not tidiness. A key in a shared environment variable is one
 * Google Cloud project, one billing account and one set of terms-of-service
 * exposure carrying every operator's traffic — and it would be whoever deployed
 * the app, not whoever is using it.
 */
export function developmentYoutubeApiKey(env: Env = process.env): string | null {
  const raw = env.YOUTUBE_API_KEY?.trim();
  return raw ? raw : null;
}
/**
 * What this deployment pays its proxy, in US dollars per gigabyte.
 *
 * NO DEFAULT, AND THE RULE AT THE TOP OF THIS FILE IS WHY. Every published
 * per-gigabyte figure is a price on somebody else's invoice — providers quote
 * $1 to $7 for the same product and the rate falls with volume — and nobody
 * with the authority to set it has said what this deployment pays. Unset reads
 * back as null, and the screen says "priced in bandwidth, not in money" rather
 * than quoting a number this repo made up.
 *
 * It is a rate and not a whole number, so it does not go through `readInt`.
 */
export function proxyUsdPerGb(env: Env = process.env): number | null {
  const raw = env.YTDLP_PROXY_USD_PER_GB?.trim();
  if (!raw) return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new MissingConfigError(
      "YTDLP_PROXY_USD_PER_GB",
      `Expected a price per gigabyte in dollars, like 3.50, got ${JSON.stringify(raw)}.`,
    );
  }
  const rate = Number.parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new MissingConfigError(
      "YTDLP_PROXY_USD_PER_GB",
      `Expected a price above zero, got ${JSON.stringify(raw)}. A free proxy is not priced here; leave it unset.`,
    );
  }
  return rate;
}

/**
 * WHAT ONE DOWNLOADED SHORT COSTS IN PROXY BANDWIDTH, MEASURED.
 *
 * Two files fetched through the live service on 2026-09-08, both 720p H.264
 * with AAC audio, merged:
 *
 *   i7jX9SR0bfw   1:36   19,071,177 bytes
 *   y5nmwuu6RX0   1:12   19,174,282 bytes
 *
 * NOT PROPORTIONAL TO LENGTH, which is why this is a flat figure and not a rate
 * per second: the shorter clip was very slightly the larger file. Bitrate is the
 * variable and duration is not, so a per-second estimate would be a worse guess
 * dressed as a better one.
 *
 * It is an ESTIMATE and every surface that renders it says so. The application
 * never sees the real size — the browser fetches the file from the service
 * directly, which is the whole point of the signed link — so this is the only
 * figure available before the fact, and there is no after-the-fact correction
 * to be had.
 */
export const BYTES_PER_DOWNLOAD_ESTIMATE = 19_100_000;

/**
 * WHAT ONE SEED'S LISTING WALK PULLS THROUGH THE PROXY, MEASURED.
 *
 * Two fetches of the same uploads playlist through the live gateway,
 * 2026-09-08: 2,105,716 and 2,090,576 bytes. yt-dlp asks for continuations on
 * top of that on a deep walk, so this is a floor rather than a ceiling, and
 * every surface that renders it says "about".
 *
 * It is the number that makes a READ quotable at all. Before the proxy a
 * keyless YouTube run cost nothing and the screen said so; now it moves
 * somebody's per-gigabyte allowance, and a run that reports no price would be
 * the same lie the metering brand exists to prevent.
 */
export const BYTES_PER_LISTING_WALK_ESTIMATE = 2_100_000;

/** A gigabyte, as the proxy vendors bill it. */
export const BYTES_PER_GB = 1_000_000_000;

/** What `count` downloads would cost at this deployment's rate, or null. */
export function downloadUsdMicros(count: number, env: Env = process.env): number | null {
  return bandwidthUsdMicros(count * BYTES_PER_DOWNLOAD_ESTIMATE, env);
}

/** What a number of BYTES through the proxy costs, or null when unpriced. */
export function bandwidthUsdMicros(bytes: number, env: Env = process.env): number | null {
  const rate = proxyUsdPerGb(env);
  if (rate === null) return null;
  return Math.round((bytes / BYTES_PER_GB) * rate * 1_000_000);
}
