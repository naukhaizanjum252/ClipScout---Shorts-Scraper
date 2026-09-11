/**
 * THE ONE PLACE THAT SPEAKS GRAPH API. Instagram and Facebook both go through
 * here so that four decisions are made once instead of twice.
 *
 * NOTHING IN THIS FILE HAS EVER BEEN RUN AGAINST META. There is no Meta token
 * on this machine. Every field name, error code, URL shape and formula below
 * was READ from developers.facebook.com on 2026-09-04 and each one carries the
 * page it came from. "Documented" and "working" are different words and this
 * file is only entitled to the first. The first real token is the experiment;
 * until then nobody may say this works.
 *
 * ---------------------------------------------------------------- THE VERSION
 *
 * AN UNPINNED GRAPH API SILENTLY CHANGES UNDER YOU. A versionless path resolves
 * to whatever default version Meta has rolled the app forward to, so field sets
 * and behaviour move without a deploy and the first symptom is a field that
 * stopped arriving. Every URL this file builds carries an explicit version.
 *
 * IT IS PINNED TO v25.0 AND NOT TO THE NEWEST. The changelog
 * (https://developers.facebook.com/docs/graph-api/changelog, read 2026-09-04)
 * lists v26.0 as latest, introduced 2026-07-29, with an "available until" of
 * TBD; v25.0 was introduced 2026-02-18 and is available until 2028-07-29. Two
 * reasons for the older one, in order of weight:
 *
 *   1. IT IS THE VERSION THE EVIDENCE CAME FROM. The Instagram Business
 *      Discovery reference and the Page Videos reference were both serving
 *      v25.0 examples on the day their field lists were copied into
 *      instagram.ts and facebook.ts. Pinning the version those lists were read
 *      against means the code and its citations agree. Pinning v26.0 would be
 *      claiming more than was checked.
 *   2. IT HAS A PUBLISHED EXPIRY A PERSON CAN DIARISE — 2028-07-29. A pin whose
 *      end date is "TBD" is a pin nobody revisits until it breaks.
 *
 * WHEN THIS IS BUMPED, re-read both reference pages first and re-check the two
 * facts the adapters lean on: that Instagram media still has no duration field,
 * and that GET on the Facebook Page `videos` edge is still unsupported. Bumping
 * the constant is one line; bumping it without re-reading is how a silent field
 * change becomes a silently wrong inventory.
 *
 * ------------------------------------------------------------------ THE TOKEN
 *
 * It goes on the query string because that is the form Meta documents. That
 * means the URL is radioactive: it may not be logged, may not be put in an
 * error, may not be echoed. `graphUrl()` therefore builds the URL WITHOUT the
 * token and `requestUrl()` is the only function that adds it — so anything that
 * formats a URL for a human is holding the safe one by construction. Every
 * message that could have been built from a response body goes through `scrub`
 * (lib/credentials/mask.ts) with the token as an argument on the way out, which
 * is the same safety net the YouTube client uses, for the same reason: Meta's
 * error bodies quote the request back.
 *
 * ------------------------------------------------------------- THE RATE LIMIT
 *
 * Meta publishes a formula, not a number
 * (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/, read
 * 2026-09-04): Platform rate limits for applications are
 *
 *     "Calls within one hour = 200 * Number of Users"
 *
 * For a single-operator internal tool the smallest sensible reading of that is
 * one user, so 200 calls an hour, and that is the default ceiling here.
 *
 * THAT DEFAULT IS A SELF-IMPOSED FLOOR, NOT A MEASUREMENT, AND IT IS NOT THE
 * ONLY LIMIT IN PLAY. The same page carries Business Use Case limits that apply
 * to exactly the two endpoints these adapters use and are shaped completely
 * differently — "Calls within 24 hours = 4800 * Number of Impressions" for the
 * Instagram Platform, and "Calls within 24 hours = 4800 * Number of Engaged
 * Users" for Pages. Both multiply by a quantity a brand-new internal app has
 * very little of, so the real ceiling may be far below 200/hour and this class
 * cannot compute it. What CAN be known is what Meta itself reports back: the
 * `X-App-Usage` and `X-Business-Use-Case-Usage` response headers, parsed here
 * and returned with every call so a caller can show the true percentage rather
 * than our guess.
 *
 * THE BUDGET STOPS THE CALL BEFORE IT GOES OUT, exactly like the YouTube
 * client's, and for the same reason: hitting a ceiling on purpose is a clean,
 * explainable stop, and discovering it by being throttled mid-run is a partial
 * result nobody can interpret. It never sleeps and never retries — a run that
 * silently stalls for an hour is worse than one that says why it stopped.
 *
 * ONE BUDGET PER PROCESS IS THE RIGHT SHAPE AND IS NOT THE DEFAULT. Each
 * adapter builds its own if none is handed in, so an Instagram run and a
 * Facebook run can together issue 400 calls in an hour against one app's
 * allowance. The fix is for the registry to construct one `MetaCallBudget` and
 * pass it to both adapters; that is a caller's change, recorded here so it is
 * not discovered as a surprise.
 */
import { scrub } from "../credentials/mask";
import { markSafeToShow } from "../shorts/run";
import type { Platform } from "./types";

// -------------------------------------------------------------------- the API

/** Graph API host. Source: every request sample on developers.facebook.com. */
export const GRAPH_HOST = "https://graph.facebook.com";

/** The pinned version. See the header before changing it. */
export const GRAPH_VERSION = "v25.0";

/**
 * When Meta stops serving `GRAPH_VERSION`. From the changelog, read 2026-09-04.
 * Exported so a status line can say how long the pin has left rather than
 * leaving it as a comment nobody greps.
 */
export const GRAPH_VERSION_AVAILABLE_UNTIL = "2028-07-29";

// ------------------------------------------------------------------ the token

/**
 * Where a token comes from.
 *
 * A function is allowed because the real source is
 * `CredentialStore.lease(provider)`, which is async and must be called at the
 * moment of use rather than at construction — a token cached in a constructor
 * is a token that outlives its rotation. A plain string is allowed because
 * tests and one-off scripts should not have to write a closure.
 */
export type MetaTokenSource = string | (() => string | null | Promise<string | null>);

/** Resolve a token source to a token, or null when there is none. */
export async function resolveMetaToken(
  source: MetaTokenSource | null | undefined,
): Promise<string | null> {
  if (source == null) return null;
  const raw = typeof source === "function" ? await source() : source;
  const token = raw?.trim();
  return token ? token : null;
}

// ------------------------------------------------------------------ the usage

/**
 * What Meta says about our consumption, read back off the response.
 *
 * These headers are the ONLY authoritative numbers available — the local budget
 * is a guess at somebody else's formula. Nulls are honest: a header that was
 * absent or unparseable is not zero usage.
 */
export interface MetaUsage {
  /** `X-App-Usage.call_count`, a percentage of the app's allowance. */
  readonly appCallCountPct: number | null;
  /** `X-App-Usage.total_time`, a percentage. */
  readonly appTotalTimePct: number | null;
  /** `X-App-Usage.total_cputime`, a percentage. */
  readonly appCpuTimePct: number | null;
  /**
   * The highest `call_count` across every business use case in
   * `X-Business-Use-Case-Usage`. One number because a caller wants "how close
   * are we", and the worst case is the answer to that.
   */
  readonly businessCallCountPct: number | null;
  /**
   * Seconds until access returns, from any BUC entry's
   * `estimated_time_to_regain_access`. Non-null means we are throttled NOW.
   */
  readonly estimatedTimeToRegainAccessMinutes: number | null;
}

const NO_USAGE: MetaUsage = {
  appCallCountPct: null,
  appTotalTimePct: null,
  appCpuTimePct: null,
  businessCallCountPct: null,
  estimatedTimeToRegainAccessMinutes: null,
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse the two usage headers.
 *
 * Deliberately total: any header that is missing, empty or not JSON produces
 * nulls rather than throwing. A malformed usage header is a reporting problem
 * and must never be allowed to fail a call whose body arrived intact.
 *
 * Field names from
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ read
 * 2026-09-04: X-App-Usage carries `call_count`, `total_cputime`, `total_time`;
 * X-Business-Use-Case-Usage carries `business-id`, `call_count`,
 * `estimated_time_to_regain_access`, `total_cputime`, `total_time`, `type`,
 * `ads_api_access_tier`.
 */
export function parseMetaUsage(headers: Headers | null | undefined): MetaUsage {
  if (!headers) return NO_USAGE;

  let app: Record<string, unknown> = {};
  try {
    const raw = headers.get("x-app-usage");
    if (raw) app = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    app = {};
  }

  let businessCallCountPct: number | null = null;
  let regain: number | null = null;
  try {
    const raw = headers.get("x-business-use-case-usage");
    if (raw) {
      // Shape is { "<business-id>": [ { ...usage } ] }.
      for (const entries of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as Array<Record<string, unknown>>) {
          const calls = numberOrNull(entry?.call_count);
          if (calls !== null) businessCallCountPct = Math.max(businessCallCountPct ?? 0, calls);
          const wait = numberOrNull(entry?.estimated_time_to_regain_access);
          if (wait !== null && wait > 0) regain = Math.max(regain ?? 0, wait);
        }
      }
    }
  } catch {
    businessCallCountPct = null;
    regain = null;
  }

  return {
    appCallCountPct: numberOrNull(app.call_count),
    appTotalTimePct: numberOrNull(app.total_time),
    appCpuTimePct: numberOrNull(app.total_cputime),
    businessCallCountPct,
    estimatedTimeToRegainAccessMinutes: regain,
  };
}

// ----------------------------------------------------------------- the budget

/**
 * The default hourly ceiling: `200 * 1 user`, the smallest sensible reading of
 * Meta's Platform formula for a tool one person runs. Not a measurement.
 */
export const DEFAULT_CALLS_PER_HOUR = 200;

/** Thrown BEFORE a request goes out, when the local hourly ceiling is spent. */
export class MetaBudgetError extends Error {
  constructor(
    readonly platform: Platform,
    readonly spent: number,
    readonly ceiling: number,
  ) {
    super(
      `Meta call budget exhausted: ${spent}/${ceiling} calls already made in the last hour, so no ` +
        "request was sent. Meta's published Platform limit is \"Calls within one hour = 200 * " +
        'Number of Users", which for a one-operator tool reads as 200; this ceiling is that ' +
        "reading, not a measurement. Wait for the hour to roll, or raise the ceiling if this app " +
        "genuinely serves more users.",
    );
    this.name = "MetaBudgetError";
  }
}

/**
 * A rolling one-hour call counter that refuses rather than sleeps.
 *
 * Rolling and not fixed-window: a fixed window lets 400 calls through across a
 * boundary, which is the exact failure the ceiling exists to prevent. It holds
 * one timestamp per call, which for a 200-call ceiling is 200 numbers.
 *
 * IT IS PER PROCESS AND PER INSTANCE. It knows nothing about other deployments,
 * other machines, or the same app being used by a second tool. It is a brake,
 * not a guarantee — the guarantee, such as it is, is `X-App-Usage`.
 */
export class MetaCallBudget {
  private readonly calls: number[] = [];

  constructor(
    readonly ceiling: number = DEFAULT_CALLS_PER_HOUR,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      throw new RangeError(`Meta call ceiling must be a positive integer, got ${ceiling}`);
    }
  }

  /** Calls made in the last hour. */
  spent(): number {
    this.evict();
    return this.calls.length;
  }

  /** Charge one call, or throw. Called immediately before the request. */
  take(platform: Platform): void {
    this.evict();
    if (this.calls.length >= this.ceiling) {
      throw new MetaBudgetError(platform, this.calls.length, this.ceiling);
    }
    this.calls.push(this.now());
  }

  private evict(): void {
    const cutoff = this.now() - 3_600_000;
    while (this.calls.length > 0 && (this.calls[0] as number) <= cutoff) this.calls.shift();
  }
}

// ------------------------------------------------------------------ the error

/**
 * Meta's error envelope, verbatim from
 * https://developers.facebook.com/docs/graph-api/guides/error-handling/ read
 * 2026-09-04.
 */
export interface MetaErrorEnvelope {
  readonly message?: string;
  readonly type?: string;
  readonly code?: number;
  readonly error_subcode?: number;
  readonly error_user_title?: string;
  readonly error_user_msg?: string;
  readonly fbtrace_id?: string;
}

/**
 * A Graph API call that came back with an error, mapped to something an
 * operator can act on.
 *
 * The code and subcode are kept as fields as well as being folded into the
 * message, because the difference between "your token expired" (190/463) and
 * "your app does not have this permission" (10 or 200-299) is the difference
 * between clicking refresh and starting an App Review, and a caller may want to
 * branch on that without parsing prose.
 */
export class MetaApiError extends Error {
  constructor(
    readonly platform: Platform,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly type: string | null,
    readonly fbtraceId: string | null,
    readonly guidance: string | null,
    detail: string,
  ) {
    const bits = [
      `HTTP ${status}`,
      code === null ? null : `code ${code}`,
      subcode === null ? null : `subcode ${subcode}`,
      type,
    ].filter(Boolean);
    super(
      `Meta Graph API refused (${bits.join(", ")}): ${detail}` +
        (guidance ? ` — ${guidance}` : "") +
        (fbtraceId ? ` [fbtrace_id ${fbtraceId}]` : ""),
    );
    this.name = "MetaApiError";
  }
}

/**
 * A listing that came back in a shape we cannot read, as distinct from a
 * listing that was genuinely empty.
 *
 * Same distinction `requireReadableCounts` draws for the yt-dlp adapters
 * (lib/platform/ytdlp.ts) and the same reason: `[]` on the screen is
 * indistinguishable from "nothing on this platform cleared 500,000 views", so a
 * source whose output shape changed must throw rather than come back empty.
 */
export class MetaUnreadableError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "MetaUnreadableError";
  }
}

/**
 * WHICH OF THESE A PERSON ACTUALLY SEES ON /admin/shorts.
 *
 * SCAR, 2026-09-08. Neither of these was marked, so the three Meta adapters'
 * most carefully-written sentences went only to a log file. Every one of them
 * ends by saying what it is refusing to do — Instagram's "Business Discovery
 * for @x answered without a business_discovery block … it is not being reported
 * as 'no shorts found'", Facebook's "not one carried an attachments field …
 * Refusing to report it as 'no shorts found'", Threads' "not one carried a
 * media_type" — and each names its own likely cause and fix. Those are the
 * sentences the honesty rule exists to put in front of somebody, and the page
 * was showing "the thrown message is in this deployment's server log" instead.
 *
 * WHY THESE TWO AND NOT `MetaApiError`. The rule these are safe under is the
 * one lib/platform/scrapecreators.ts states: a message composed HERE, out of
 * this repo's own words and its own counts, is fit to print; a message carrying
 * an unbounded string from somebody else's system is not. `MetaUnreadableError`
 * is composed entirely by the adapter that threw it. `MetaBudgetError` is
 * composed entirely here from two integers and never touches the network at
 * all. `MetaApiError` carries Meta's own `error_user_msg`/`message` — scrubbed
 * of the token, but still somebody else's text quoting the request back — so it
 * stays unmarked, exactly as `ScrapeCreatorsError` does for the same reason.
 */
markSafeToShow(MetaUnreadableError);
markSafeToShow(MetaBudgetError);

/**
 * What to DO about a given code/subcode, in a sentence.
 *
 * Every entry is from the error-handling reference read 2026-09-04. Codes not
 * listed there are not invented here — an unmapped code produces a null and the
 * operator reads Meta's own `message`, which is better than a guess dressed up
 * as advice.
 *
 * The subcodes are checked FIRST because they are the specific answer: 190 on
 * its own says "get a new token", 190/460 says "the password changed, which is
 * why", and only one of those tells somebody what actually happened.
 */
export function metaGuidance(code: number | null, subcode: number | null): string | null {
  switch (subcode) {
    case 458:
      return "the app is not installed for this user; they need to authorise it again";
    case 459:
      return "the user is checkpointed and must log in at facebook.com to clear it";
    case 460:
      return "the password changed, which invalidated this token; sign in again and re-issue it";
    case 463:
      return "this token has expired; issue a new one (a long-lived Page token still expires)";
    case 464:
      return "the user is unconfirmed and must log in at facebook.com";
    case 467:
      return "this token has been revoked or is otherwise invalid; issue a new one";
    case 492:
      return "the user does not have the required role on this Page; grant them a Page task or use a token from someone who has one";
    default:
      break;
  }

  if (code === null) return null;
  if (code >= 200 && code <= 299) {
    return "a permission is missing or was revoked; this is App Review territory, not a config typo";
  }
  switch (code) {
    case 1:
    case 2:
      return "Meta reports a temporary problem on their side; wait and try again";
    case 3:
      return "this app cannot call that method — a capability or permission it has not been granted";
    case 4:
      return "the app has made too many calls this hour; the run must slow down or stop";
    case 10:
      return "permission denied — the app was never granted it, or it was removed";
    case 17:
      return "this user has made too many calls this hour; the run must slow down or stop";
    case 102:
      return "the session or token is invalid; issue a new token";
    case 190:
      return "the access token has expired, been revoked, or was never valid; issue a new one";
    case 341:
      return "an application limit was reached; wait and try again";
    case 368:
      return "this app or account is temporarily blocked for a policy violation; Meta must be dealt with directly";
    default:
      return null;
  }
}

// ------------------------------------------------------------------ the fetch

/**
 * A Graph API URL WITHOUT the token, safe to log and safe to put in an error.
 *
 * Kept separate from `requestUrl` so that no code path can accidentally hold
 * the dangerous one. Params with a null or undefined value are dropped rather
 * than sent as the string "null", which Meta would take literally.
 */
export function graphUrl(
  path: string,
  params: Readonly<Record<string, string | number | null | undefined>> = {},
  options: { readonly apiBase?: string; readonly version?: string } = {},
): string {
  const base = (options.apiBase ?? GRAPH_HOST).replace(/\/+$/, "");
  const version = options.version ?? GRAPH_VERSION;
  const url = new URL(`${base}/${version}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export interface MetaGetOptions {
  /** Which adapter is calling. Only used to label errors. */
  readonly platform: Platform;
  /** Node path, e.g. `17841405309211844` or `1234567890/posts`. */
  readonly path: string;
  readonly params?: Readonly<Record<string, string | number | null | undefined>>;
  /** Plaintext token. Never logged; see the header. */
  readonly token: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly version?: string;
  readonly budget?: MetaCallBudget;
  readonly timeoutMs?: number;
}

export interface MetaResponse<T> {
  readonly body: T;
  readonly usage: MetaUsage;
  /** The URL WITHOUT the token, so a caller may log it. */
  readonly safeUrl: string;
}

/** 30 seconds. A Graph read that has not answered by then is not going to. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One GET against the Graph API.
 *
 * NO RETRIES. Meta's own guidance for codes 1, 2 and 341 is "wait and retry",
 * and a retry loop buried in a client is how one throttled call becomes four
 * and the app's hourly allowance disappears into a spin. The error says what it
 * was; the decision to try again belongs to whoever can see the whole run.
 */
export async function metaGet<T>(options: MetaGetOptions): Promise<MetaResponse<T>> {
  const { platform, token } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const safeUrl = graphUrl(options.path, options.params, options);

  options.budget?.take(platform);

  const url = new URL(safeUrl);
  url.searchParams.set("access_token", token);

  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    // A transport failure. Scrubbed anyway: a fetch error can quote the URL it
    // was given, and the URL it was given carried the token.
    throw new MetaApiError(
      platform,
      0,
      null,
      null,
      null,
      null,
      null,
      safe(`could not reach ${safeUrl}: ${cause instanceof Error ? cause.message : String(cause)}`, token),
    );
  }

  const usage = parseMetaUsage(response.headers);
  const text = await response.text();

  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const envelope = (parsed as { error?: MetaErrorEnvelope } | null)?.error;
  if (envelope || !response.ok) {
    const code = typeof envelope?.code === "number" ? envelope.code : null;
    const subcode = typeof envelope?.error_subcode === "number" ? envelope.error_subcode : null;
    const detail = envelope?.error_user_msg ?? envelope?.message ?? text.slice(0, 400) ?? "no body";
    throw new MetaApiError(
      platform,
      response.status,
      code,
      subcode,
      envelope?.type ?? null,
      envelope?.fbtrace_id ?? null,
      metaGuidance(code, subcode),
      safe(detail, token),
    );
  }

  if (parsed === null) {
    throw new MetaApiError(
      platform,
      response.status,
      null,
      null,
      null,
      null,
      null,
      `${safeUrl} answered with a ${response.status} carrying no readable JSON. That is not an ` +
        "empty result — it is an unreadable one, and it is not being reported as 'nothing found'.",
    );
  }

  return { body: parsed as T, usage, safeUrl };
}

/**
 * The last thing between an error message and a person.
 *
 * Reuses lib/credentials/mask's `scrub`, which removes the token verbatim AND
 * strips any `access_token=` query parameter wholesale — the second half
 * matters because Meta echoes request URLs back in error bodies.
 */
function safe(message: string, token: string): string {
  return scrub(message, token);
}

// ------------------------------------------------------------------ the paging

/** The envelope every Graph edge returns a list in. */
export interface MetaEdge<T> {
  readonly data?: readonly T[];
  readonly paging?: {
    readonly cursors?: { readonly before?: string; readonly after?: string };
    readonly next?: string;
    readonly previous?: string;
  };
}

/**
 * Rows out of an edge envelope, or an empty array.
 *
 * Callers must NOT read an empty array here as "nothing to report" without
 * first checking that the request itself succeeded — that is what
 * `MetaUnreadableError` is for at the adapter level.
 */
export function edgeRows<T>(edge: MetaEdge<T> | null | undefined): readonly T[] {
  return Array.isArray(edge?.data) ? (edge.data as readonly T[]) : [];
}
