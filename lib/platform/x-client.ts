/**
 * X API v2 over HTTP — the only file in this repo that talks to X, and the only
 * one that knows what a request to X costs.
 *
 * WHY THIS IS A SEPARATE FILE FROM lib/platform/x.ts
 *
 * The adapter's job is to turn X's vocabulary into a `ShortRecord`. This file's
 * job is money. X bills PER RESOURCE RETURNED, which means the cost of a run is
 * decided by how many Posts a query happens to match — not by how many requests
 * we send — and that is a completely different thing to reason about from field
 * mapping. Keeping them in one file is how a query change quietly becomes a
 * billing change nobody reviewed.
 *
 * DOCUMENTATION READ, 2026-09-04. Every number and field name below is from one
 * of these, fetched on that date. Nothing here is recalled.
 *
 *   https://docs.x.com/x-api/posts/recent-search          (OpenAPI, GET /2/tweets/search/recent)
 *   https://docs.x.com/x-api/posts/recent-search-counts   (OpenAPI, GET /2/tweets/counts/recent)
 *   https://docs.x.com/x-api/posts/post-lookup-by-post-id (OpenAPI, GET /2/tweets/{id})
 *   https://docs.x.com/x-api/fundamentals/data-dictionary (the Media object)
 *   https://docs.x.com/x-api/fundamentals/fields          (the fields parameters)
 *   https://docs.x.com/x-api/fundamentals/expansions      (expansion -> includes mapping)
 *   https://docs.x.com/x-api/fundamentals/rate-limits     (per-endpoint limits)
 *   https://docs.x.com/x-api/posts/search/integrate/operators   (the operator list)
 *   https://docs.x.com/x-api/posts/search/integrate/build-a-query
 *   https://docs.x.com/x-api/getting-started/pricing      (the price table)
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST X. There is no API key on this
 * machine. Everything below is written from those documents and tested against
 * fixtures built from the documented response shapes, which proves the parser
 * and proves nothing whatever about the API. See the test file's header.
 *
 * ------------------------------------------------------------------ the money
 *
 * From the pricing page, "Read operations — charged per resource returned in
 * the response": Posts: Read is $0.005 per resource and User: Read is $0.010
 * per resource. From the same page's per-request table: Counts: Recent is
 * $0.005 per REQUEST. Pay-per-usage is capped at 3,000,000 Post reads per
 * monthly billing cycle.
 *
 * SO A SEARCH THAT RETURNS 100 POSTS COSTS 50 CENTS, and a query that starts
 * matching ten times as much costs ten times as much with no code change. That
 * is the risk this file is built around: `XSpend` counts resources as they come
 * back and `estimateUsd` turns them into a range.
 *
 * IT IS A RANGE AND NOT A NUMBER, AND THE GAP IS AN HONEST UNKNOWN. The price
 * table says reads are charged "per resource returned in the response". A search
 * with `expansions=author_id` returns User objects in `includes.users`. The
 * documentation does not say anywhere we could find whether an expanded User in
 * `includes` is billed as a User: Read. So `estimateUsd` reports `low` (Posts
 * and Counts only) and `high` (plus every User object at $0.010), the two
 * differ by exactly the unanswered question, and THE FIRST REAL BILL SETTLES IT.
 * Reporting a single figure would mean picking one of those answers and hoping.
 *
 * The price table also carries a "Media Metadata — $0.005 per request" line. It
 * sits in the per-request WRITE table, and this build never writes media
 * metadata, so nothing here charges it. Whether expanded Media objects in
 * `includes.media` are billed is, like the User question, not stated; if they
 * are, the true figure is above `high`. That is written down rather than
 * assumed away.
 *
 * ------------------------------------------------ the field-parameter problem
 *
 * X's own documentation contradicts itself about what the Post fields parameter
 * is called, and this is load-bearing because getting it wrong loses every
 * metric on the response.
 *
 *   The OpenAPI spec for GET /2/tweets/search/recent names the parameter
 *   `post.fields` (components.parameters.PostFieldsParameter.name).
 *
 *   Every worked example on the Fields page and in the query guide uses
 *   `tweet.fields` — including copy-pasteable curl commands.
 *
 * We default to `tweet.fields`, because a broken curl example on the front
 * documentation page is a louder failure than a stale name in a generated spec,
 * and because the same page pair disagrees the same way about the counts
 * response (`post_count` in the spec, `tweet_count` historically) — a rename in
 * progress. THE DEFAULT IS A JUDGEMENT AND IT IS MARKED AS ONE; it is
 * overridable, and there are two safety nets:
 *
 *   REJECTED  — a 400 naming the field parameter retries ONCE with the other
 *               name, for free. A rejected request returns no resources, and
 *               reads are billed per resource returned, so a 400 costs nothing.
 *   IGNORED   — if the first page comes back with no `public_metrics` on any
 *               Post, the parameter was accepted and dropped. That case is NOT
 *               retried, because retrying it costs another page of Post reads to
 *               guess a parameter name. It throws, naming the one-line fix.
 *
 * The first real run answers this permanently, and the answer belongs in this
 * comment when it arrives.
 *
 * ------------------------------------------------------- what a run costs, out
 *
 * THIS FILE IMPLEMENTS THE MONEY CONTRACT IN lib/shorts/run.ts, and it is the
 * right file to implement it in for the reason at the top: the price table is
 * here, and a second place that multiplies a row count by a remembered rate is
 * a second place that can drift from an invoice. `XClient` carries the brand
 * `METERS_ITS_OWN_SPEND` and answers `accountForLastRun()`; `XMeteredAdapter`
 * at the bottom is the one-line join that carries that answer out through an
 * adapter, because `lib/shorts/run.ts` is handed adapters and never clients.
 *
 * SCAR, 2026-09-04. Before today nothing in the tree implemented that contract
 * at all. `run.ts` detected it by duck typing, found nothing, and reported an
 * empty spend list — so the admin screen's "Spent" figure was structurally
 * always an em dash on the only platform in this product that charges per row.
 * A run costing four dollars and a run costing nothing looked identical, with
 * every test green underneath. See the scar on `METERS_ITS_OWN_SPEND`.
 */
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import type { ShortRecord } from "./types";
import {
  markSafeToShow,
  METERS_ITS_OWN_SPEND,
  type AccountingAdapter,
  type RunAccount,
  type SpendForecast,
  type UsdMicros,
} from "../shorts/run";

// ---------------------------------------------------------------- price table
// All four from https://docs.x.com/x-api/getting-started/pricing, 2026-09-04.

/** Posts: Read. Charged per Post RESOURCE RETURNED, not per request. */
export const USD_PER_POST_READ = 0.005;
/** User: Read. Whether an EXPANDED user in `includes` counts is not documented. */
export const USD_PER_USER_READ = 0.01;
/** Counts: Recent. Charged per REQUEST — it is cheap, it is not free. */
export const USD_PER_COUNTS_RECENT_REQUEST = 0.005;
/**
 * Pay-per-usage ceiling per monthly billing cycle.
 *
 * ENFORCED, as of 2026-09-04, and only when this client is given a ledger —
 * see `XSpendLedger`. It read "Not enforced here — reported" until a review
 * pointed out that nothing anywhere read it: the only ceiling in the code was
 * per-run and per-client-instance, so an operator pressing the button forty
 * times in an afternoon had forty separate caps and no monthly one. A constant
 * nothing consults is a comment with a number in it.
 */
export const MONTHLY_POST_READ_CAP = 3_000_000;

/**
 * The same three prices as INTEGER MILLIONTHS OF A DOLLAR.
 *
 * Derived from the dollar figures above rather than typed twice, so the price
 * table stays one table. Integers because `RunAccount` sums them and $0.005
 * cannot be held in cents — see the note on `UsdMicros` in lib/shorts/run.ts,
 * which is the same argument from the other end.
 */
export const MICROS_PER_POST_READ: UsdMicros = Math.round(USD_PER_POST_READ * 1_000_000);
export const MICROS_PER_USER_READ: UsdMicros = Math.round(USD_PER_USER_READ * 1_000_000);
export const MICROS_PER_COUNTS_REQUEST: UsdMicros = Math.round(
  USD_PER_COUNTS_RECENT_REQUEST * 1_000_000,
);

// ------------------------------------------------------- documented API limits
// All from the OpenAPI specs and https://docs.x.com/x-api/fundamentals/rate-limits

export const X_API_BASE = "https://api.x.com";
/** `max_results` on recent search: minimum 10, maximum 100, default 10. */
export const SEARCH_MIN_RESULTS = 10;
export const SEARCH_MAX_RESULTS = 100;
/** Self-serve query length for recent search and recent counts. Enterprise is 4096. */
export const SEARCH_MAX_QUERY_CHARS = 512;
/** `start_time` "must be within the last 7 days" on recent search. */
export const RECENT_WINDOW_HOURS = 168;
/**
 * Seconds shaved off a computed `start_time`.
 *
 * A window of exactly 168 hours is exactly the documented edge, and the request
 * takes measurable time to reach X. Asking for the boundary is asking to be
 * rejected by a second or two of clock drift on somebody else's server.
 */
const START_TIME_SAFETY_SECONDS = 60;

/** Which spelling of the Post fields parameter to send. See the header. */
export type XPostFieldsParam = "tweet.fields" | "post.fields";

// --------------------------------------------------------------------- errors

/**
 * Anything X said no to. Carries the status and, when X sent one, the RFC-7807
 * problem `type` and `detail` — X's own words, which are far better than ours.
 *
 * The bearer token travels in an Authorization header and is never interpolated
 * into a URL or a message. There is a test asserting it does not appear.
 */
export class XApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly problemType: string | null,
    detail: string,
  ) {
    super(detail);
    this.name = "XApiError";
  }
}

/** 401 or 403. Two different problems with two different fixes — see `message`. */
export class XCredentialError extends XApiError {
  constructor(endpoint: string, status: number, problemType: string | null, detail: string) {
    super(endpoint, status, problemType, detail);
    this.name = "XCredentialError";
  }
}

/**
 * 429. NOT retried in-process: the recent-search window is 15 minutes and
 * sleeping through one inside a web request turns a slow page into a hung one.
 * `resetAt` is `x-rate-limit-reset` (unix seconds) so a caller can say when.
 */
export class XRateLimitError extends XApiError {
  constructor(
    endpoint: string,
    readonly resetAt: Date | null,
    detail: string,
  ) {
    super(endpoint, 429, null, detail);
    this.name = "XRateLimitError";
  }
}

/** The query itself is wrong — rejected locally before spending, or by X's 400. */
export class XQueryError extends Error {
  constructor(
    readonly problems: readonly string[],
    readonly query: string,
  ) {
    super(`This X search query cannot be used:\n- ${problems.join("\n- ")}`);
    this.name = "XQueryError";
  }
}

/**
 * A run stopped BEFORE spending, because it would have retrieved more billable
 * Posts than the operator authorised. No request was sent for the posts this
 * describes.
 */
export class XSpendCapError extends Error {
  constructor(
    readonly wouldRetrieve: number,
    readonly capPosts: number,
    detail: string,
  ) {
    super(detail);
    this.name = "XSpendCapError";
  }
}

/**
 * A run stopped because the MONTHLY billing cycle's Post-read ceiling would be
 * crossed. Nothing was sent for the posts this describes.
 *
 * Separate from `XSpendCapError` because the two are fixed by different things
 * and on different timescales. A per-run cap is raised by editing one setting
 * and pressing the button again; a monthly cap is not raised at all — it is
 * waited out, or X's pay-per-usage ceiling is renegotiated. Collapsing them
 * would send an operator to the wrong setting with the right complaint.
 */
export class XMonthlyCapError extends Error {
  constructor(
    /** Post reads this cycle has already been billed for, per the ledger. */
    readonly spentThisCycle: number,
    /** The most this run could add. */
    readonly wouldAdd: number,
    readonly capPosts: number,
    /** Which cycle, as the ledger keys it. */
    readonly cycle: string,
    detail: string,
  ) {
    super(detail);
    this.name = "XMonthlyCapError";
  }
}

// ---------------------------------------------------- the cross-run ledger
//
// WHY A PORT AND NOT A TABLE NAME.
//
// This is the only file that talks to X and it is going to stay that way: a
// module that both composed X's queries and wrote to Postgres would be two
// jobs with one blast radius. So the client depends on an interface with two
// methods, and whoever wires the run decides whether that is a database, a
// file, or nothing at all.
//
// WHAT "NOTHING AT ALL" MEANS, SAID OUT LOUD RATHER THAN IMPLIED. A client with
// no ledger cannot know what earlier runs cost, so it CANNOT enforce a monthly
// ceiling, and it says so in `accountForLastRun()`'s note and in
// `monthlyEnforcement`. It does not quietly behave as though the month were
// empty and the cap were holding. That is the same rule as everywhere else
// here: "not measured" and "measured at zero" may not look the same.

/**
 * What one monthly billing cycle has already been billed for.
 *
 * COUNTS, NOT MONEY, and Post reads specifically. X's pay-per-usage ceiling is
 * quoted as 3,000,000 Post reads per cycle, not as a dollar figure, so counting
 * dollars here would mean converting to the unit the cap is expressed in every
 * time it is checked — and being wrong about the rate would move the ceiling.
 * Counts requests are billed per request and are not subject to this ceiling,
 * so they are deliberately not in it.
 */
export interface XSpendLedger {
  /** Post reads already billed in `cycle`. 0 for a cycle nothing has spent in. */
  postReadsIn(cycle: string): Promise<number>;
  /**
   * Add `posts` to `cycle` and return the cycle's new total.
   *
   * Called AFTER the response is in hand, because X bills for resources
   * returned — a request that returned nothing was not billed for posts. It
   * must be additive and it must survive the process, or it is not a ledger.
   */
  recordPostReads(cycle: string, posts: number): Promise<number>;
}

/**
 * A ledger that remembers nothing beyond this process.
 *
 * USEFUL IN A TEST AND IN A ONE-SHOT SCRIPT, AND A LIE IN A WEB SERVER: a
 * serverless deployment is many processes and each one would start the month
 * again. It is exported so that a caller who genuinely has no durable store
 * makes that choice by name, in code, where a reviewer can see it — rather than
 * by passing nothing and inheriting a monthly cap that silently does not exist.
 */
export class InMemoryXSpendLedger implements XSpendLedger {
  private readonly cycles = new Map<string, number>();

  async postReadsIn(cycle: string): Promise<number> {
    return this.cycles.get(cycle) ?? 0;
  }

  async recordPostReads(cycle: string, posts: number): Promise<number> {
    const total = (this.cycles.get(cycle) ?? 0) + Math.max(0, posts);
    this.cycles.set(cycle, total);
    return total;
  }
}

/**
 * Which billing cycle a moment falls in, as `YYYY-MM` in UTC.
 *
 * AN APPROXIMATION, AND THE INACCURACY IS NAMED HERE RATHER THAN DISCOVERED. X
 * documents the ceiling as "per monthly billing cycle" and a billing cycle
 * starts on the day an account started paying, which is not the first of the
 * month and is not a fact this code has. A UTC calendar month is therefore the
 * closest honest guess: it is stable, it is the same key in every process, and
 * it errs by counting a cycle boundary in the wrong place at most once a month.
 * The day somebody knows the real cycle start, this function is where it goes
 * and nothing else has to move.
 */
export function billingCycle(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * X accepted the field parameter and then ignored it. See the header's IGNORED
 * case; the message names the one-line fix, which is why it has its own type
 * and is marked fit to print.
 */
export class XFieldsIgnoredError extends XApiError {
  constructor(endpoint: string, detail: string) {
    super(endpoint, 200, null, detail);
    this.name = "XFieldsIgnoredError";
  }
}

// ------------------------------------------------- which of these a person sees
//
// /admin/shorts prints a thrown message only when the class that composed it
// says the message was written for a person. The default is the log, and the
// default has not moved — see `SAFE_TO_SHOW` in lib/shorts/run.ts for the leak
// that rule exists to prevent.
//
// EVERY CLASS NAMED BELOW COMPOSES ITS OWN SENTENCE IN THIS FILE, and this file
// never puts the bearer token in a URL — it travels in an Authorization header,
// and x.test.ts asserts it does not appear in a request URL. What these
// messages DO quote is X's own RFC-7807 `detail`, the operator's own search
// query, and figures out of the price table, none of which is a secret and all
// of which is exactly what somebody needs in order to fix the thing.
//
// `XApiError` ITSELF IS DELIBERATELY NOT MARKED. It is the catch-all for every
// status this file does not recognise, so its `detail` is whatever an unknown
// future endpoint said — an unbounded string from someone else's system, which
// is precisely the shape the log rule was written for. Its two subclasses that
// DO have a known, composed message are marked individually.
markSafeToShow(XQueryError);
markSafeToShow(XSpendCapError);
markSafeToShow(XMonthlyCapError);
markSafeToShow(XRateLimitError);
markSafeToShow(XCredentialError);
markSafeToShow(XFieldsIgnoredError);

// ------------------------------------------------------------ query validation

/**
 * Operators that CANNOT stand alone, verbatim from the operators reference.
 *
 * X rejects a query built only from these with a 400 — "using these operators
 * alone would match an extremely high volume of Posts". Catching it here turns
 * a round trip into a local sentence. A rejected request is free, so this is
 * about the operator's afternoon rather than about money.
 */
const CONJUNCTION_ONLY = /^-?(is:[a-z_]+|has:[a-z_]+|lang:[A-Za-z-]+)$/;

/** Boolean glue, which is not a standalone operator either. */
const GLUE = /^(OR|AND|\(|\))$/i;

/**
 * Web-search operator names that are NOT valid in the API.
 *
 * From the operators reference, verbatim: "The equivalent operators on X web
 * search are named `min_faves:` and `min_retweets:`. Those names are not valid
 * in the X API and will be rejected with a 400 error. Use `min_likes:` and
 * `min_reposts:` instead."
 *
 * `has:videos` is in here for the same reason at one remove: it is what people
 * write from memory and it is not in the operator list at all. The list has
 * `has:media` (photo, GIF or video) and `has:video_link` (native X videos).
 */
const WRONG_OPERATORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmin_faves:/i, "`min_faves:` is X web search, not the API. Use `min_likes:`."],
  [/\bmin_retweets:/i, "`min_retweets:` is X web search, not the API. Use `min_reposts:`."],
  [
    /\bhas:videos\b/i,
    "`has:videos` is not an operator. The list has `has:media` (photo, GIF or video) and " +
      "`has:video_link` (native X videos) — for this tool you want `has:video_link`.",
  ],
];

/**
 * Everything wrong with a query, as sentences. Empty means nothing found wrong.
 *
 * IT CANNOT PROVE A QUERY IS GOOD and does not try. It catches the three
 * mistakes the documentation names explicitly, plus the length ceiling. A query
 * that passes here can still be rejected by X, and that 400 is surfaced with
 * X's own `detail` rather than reworded.
 */
export function queryProblems(query: string, maxChars = SEARCH_MAX_QUERY_CHARS): string[] {
  const problems: string[] = [];
  const trimmed = query.trim();

  if (!trimmed) {
    problems.push("It is empty. `query` is required and has a minimum length of 1.");
    return problems;
  }
  if (trimmed.length > maxChars) {
    problems.push(
      `It is ${trimmed.length} characters. Recent search allows ${maxChars} on a self-serve ` +
        "access level (4,096 on Enterprise), and the whole string counts.",
    );
  }
  for (const [pattern, sentence] of WRONG_OPERATORS) {
    if (pattern.test(trimmed)) problems.push(sentence);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const everyTokenNeedsCompany = tokens.every((t) => CONJUNCTION_ONLY.test(t) || GLUE.test(t));
  if (everyTokenNeedsCompany) {
    problems.push(
      "Every operator in it is conjunction-required (`is:`, `has:`, `lang:`), and X rejects a " +
        "query made only of those. Add a standalone operator — a keyword, a #hashtag, a " +
        "`from:`, or `min_likes:` — which is also what stops it matching the whole platform.",
    );
  }
  return problems;
}

/** Throw unless the query is usable. Called before anything is paid for. */
export function assertUsableQuery(query: string, maxChars = SEARCH_MAX_QUERY_CHARS): void {
  const problems = queryProblems(query, maxChars);
  if (problems.length > 0) throw new XQueryError(problems, query);
}

// ------------------------------------------------------------------- the wire
// Response shapes, transcribed from the OpenAPI specs and the data dictionary.
// Everything is optional because X omits a field it has no value for: "Missing
// fields in responses mean the value is null or empty" (the Fields page).

export interface XMediaVariant {
  readonly bit_rate?: number;
  readonly content_type?: string;
  readonly url?: string;
}

export interface XMedia {
  readonly media_key?: string;
  /** "animated_gif" | "photo" | "video" per the data dictionary. */
  readonly type?: string;
  readonly url?: string;
  /** "Available when type is video." Milliseconds. */
  readonly duration_ms?: number;
  readonly height?: number;
  readonly width?: number;
  readonly preview_image_url?: string;
  /** The one field the whole X leg rests on. See lib/platform/x.ts. */
  readonly public_metrics?: { readonly view_count?: number };
  readonly variants?: readonly XMediaVariant[];
}

export interface XUser {
  readonly id?: string;
  readonly username?: string;
  readonly name?: string;
}

export interface XPost {
  readonly id?: string;
  readonly text?: string;
  readonly created_at?: string;
  readonly author_id?: string;
  readonly lang?: string;
  readonly attachments?: { readonly media_keys?: readonly string[] };
  readonly public_metrics?: {
    readonly retweet_count?: number;
    readonly reply_count?: number;
    readonly like_count?: number;
    readonly quote_count?: number;
    readonly bookmark_count?: number;
    readonly impression_count?: number;
  };
}

interface XIncludes {
  readonly media?: readonly XMedia[];
  readonly users?: readonly XUser[];
}

interface XSearchBody {
  readonly data?: readonly XPost[];
  readonly includes?: XIncludes;
  readonly meta?: { readonly next_token?: string; readonly result_count?: number };
}

interface XLookupBody {
  readonly data?: XPost;
  readonly includes?: XIncludes;
}

/**
 * The counts response, spelled BOTH WAYS on purpose.
 *
 * The current OpenAPI spec says `post_count` and `meta.total_post_count`. The
 * field was `tweet_count` / `total_tweet_count` for the endpoint's whole life
 * before the rename, and the rest of X's documentation still mixes the two
 * vocabularies (`includes.tweets`, `tweet.fields`). Reading both costs one `??`
 * and removes an entire class of "the probe said zero" failure.
 */
interface XCountsBody {
  readonly data?: ReadonlyArray<{
    readonly start?: string;
    readonly end?: string;
    readonly post_count?: number;
    readonly tweet_count?: number;
  }>;
  readonly meta?: {
    readonly total_post_count?: number;
    readonly total_tweet_count?: number;
    readonly next_token?: string;
  };
}

// ---------------------------------------------------------------- the ledger

/** Billable resources this client has caused to come back. Counts, not money. */
export interface XSpend {
  /** Post resources returned across every response. $0.005 each. */
  readonly postReads: number;
  /** User resources returned in `includes.users`. Billing UNCONFIRMED. */
  readonly userReads: number;
  /** Requests to /2/tweets/counts/recent. $0.005 each, per request. */
  readonly countsRequests: number;
  /** Every HTTP request issued, including ones that returned nothing. */
  readonly requests: number;
}

/**
 * What the ledger cost, as a RANGE.
 *
 * `low` is what is certain: Post reads and Counts requests, both priced per the
 * table. `high` adds every returned User object at $0.010, which is the price
 * for a User read if an expanded user counts as one. The gap is the unanswered
 * question in this file's header and not a rounding allowance.
 */
export function estimateUsd(spend: XSpend): { readonly low: number; readonly high: number } {
  const low = spend.postReads * USD_PER_POST_READ + spend.countsRequests * USD_PER_COUNTS_RECENT_REQUEST;
  return { low, high: low + spend.userReads * USD_PER_USER_READ };
}

/** "$0.50" / "$0.50–$0.80". For a log line or a status row. */
export function formatSpend(spend: XSpend): string {
  const { low, high } = estimateUsd(spend);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return low === high ? usd(low) : `${usd(low)}–${usd(high)}`;
}

/**
 * The certain half of the ledger, in integer micro-dollars.
 *
 * `RunAccount.spend` is ONE number and this range has two, so one of them has
 * to be the figure and the other has to be words. THE FIGURE IS THE LOW ONE —
 * the Post reads and Counts requests, both priced in X's table by the unit this
 * counts — and the note that goes with it states the upper bound and what the
 * gap is. Reporting `high` would put a charge on the screen that may not exist;
 * reporting `low` and saying nothing would hide one that may. Saying `low` and
 * naming `high` in the same breath is the only version of this that is true.
 */
export function spendMicros(spend: XSpend): UsdMicros {
  return spend.postReads * MICROS_PER_POST_READ + spend.countsRequests * MICROS_PER_COUNTS_REQUEST;
}

/** The unconfirmed half: every expanded User object, if those bill. */
export function unconfirmedUserMicros(spend: XSpend): UsdMicros {
  return spend.userReads * MICROS_PER_USER_READ;
}

// ---------------------------------------------------------------- the client

export interface XClientOptions {
  /** App-only Bearer token. Sent as `Authorization: Bearer …`, never in a URL. */
  readonly bearerToken: string;
  /** Injected in tests so nothing reaches the network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  /** See the header. Default `tweet.fields`, and it is a judgement call. */
  readonly postFieldsParam?: XPostFieldsParam;
  /** Attempts for 5xx only. 429 is never retried in-process. Default 3. */
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /**
   * Where Post reads already billed this cycle are counted, ACROSS RUNS.
   *
   * Absent means the monthly ceiling is not enforced and this client says so
   * rather than pretending — see `XSpendLedger` and `monthlyEnforcement`.
   * Optional rather than required because a required argument would have
   * pushed every existing caller into passing `new InMemoryXSpendLedger()`,
   * which is a ledger that forgets, dressed up as one that does not.
   */
  readonly ledger?: XSpendLedger | null;
  /**
   * The cycle ceiling in Post reads. Defaults to X's published 3,000,000.
   *
   * Lowerable, because the published figure is X's limit and not an operator's
   * budget, and the number a client actually wants to be stopped at is usually
   * far below the number that stops them anyway.
   */
  readonly monthlyPostReadCap?: number;
}

export interface XSearchOptions {
  readonly query: string;
  /**
   * HARD CEILING on Post resources this call may cause to be returned.
   *
   * Not a target and not a page size: it is the number the bill is computed
   * from. Pagination is sized so the total billed never exceeds it — see
   * `pageSizeFor`.
   */
  readonly maxPosts: number;
  /** RFC-3339, within the last 7 days. Omitted means X's full recent window. */
  readonly startTime?: string;
}

export interface XSearchResult {
  readonly posts: readonly XPost[];
  /** media_key -> media, merged across pages. */
  readonly media: ReadonlyMap<string, XMedia>;
  /** author id -> user, merged across pages. */
  readonly users: ReadonlyMap<string, XUser>;
  readonly pages: number;
  /** True when X had more and we stopped because of `maxPosts`. */
  readonly truncatedByCap: boolean;
}

/**
 * How many results to ask for on one page, given how many we may still buy.
 *
 * `max_results` has a documented MINIMUM OF 10. So a run with 4 posts left in
 * its budget cannot ask for 4 — it must ask for 10 and may be billed for 10.
 * That is a real over-spend of up to 9 Post reads (4.5 cents) and the cap check
 * accounts for it in `worstCaseBilledPosts` rather than discovering it on the
 * invoice.
 */
export function pageSizeFor(remaining: number): number {
  return Math.min(SEARCH_MAX_RESULTS, Math.max(SEARCH_MIN_RESULTS, remaining));
}

/**
 * The most Post reads a search for `maxPosts` can actually be billed for.
 *
 * Full pages of 100 until fewer than 100 remain, then one page of at least 10.
 * So asking for 105 bills up to 110 and asking for 4 bills up to 10 — the
 * overshoot is at most 9 Posts, because a remainder of 10 or more is requested
 * exactly. Nine Posts is 4.5 cents, which is small and is not nothing, and a cap
 * check against `maxPosts` alone would authorise it without anybody agreeing.
 */
export function worstCaseBilledPosts(maxPosts: number): number {
  if (maxPosts <= 0) return 0;
  const wholePages = Math.floor(maxPosts / SEARCH_MAX_RESULTS);
  const remainder = maxPosts % SEARCH_MAX_RESULTS;
  if (remainder === 0) return maxPosts;
  return wholePages * SEARCH_MAX_RESULTS + pageSizeFor(remainder);
}

/** RFC-3339 with no milliseconds, which is the form X's own examples use. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * `start_time` for a window of `hours` ending now, or null for no window.
 *
 * Clamped to the documented 7 days and pulled back a further minute — asking
 * for exactly the boundary is asking to be rejected by clock drift.
 */
export function startTimeFor(hours: number | null, now: Date): string | null {
  if (hours === null) return null;
  const clamped = Math.min(hours, RECENT_WINDOW_HOURS);
  const ms = clamped * 3_600_000 - START_TIME_SAFETY_SECONDS * 1000;
  return rfc3339(new Date(now.getTime() - ms));
}

export class XClient {
  /**
   * THE BRAND. See `METERS_ITS_OWN_SPEND` in lib/shorts/run.ts.
   *
   * On the client rather than on the adapter because this is the object that
   * counts billable resources as they arrive and holds the price table. The
   * adapter maps X's vocabulary onto a `ShortRecord`; it has no business
   * knowing what a Post read costs, and a second copy of that figure is a
   * second thing that can disagree with an invoice.
   */
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  private readonly bearerToken: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly ledger: XSpendLedger | null;
  private readonly monthlyCap: number;

  private fieldsParam: XPostFieldsParam;
  private fieldsParamFlipped = false;

  private postReads = 0;
  private userReads = 0;
  private countsRequests = 0;
  private requests = 0;

  /**
   * The ledger as it stood at the last `accountForLastRun()`.
   *
   * Kept so that accounting reports a DELTA. The contract is "what the last
   * `latestShorts()` call cost", and a client that lived across two runs would
   * otherwise bill the first run's posts to the second one as well — every
   * figure correct on its own and the sum twice the invoice.
   */
  private accounted: XSpend = { postReads: 0, userReads: 0, countsRequests: 0, requests: 0 };

  /** Cycle total after the most recent ledger write, for the account's note. */
  private cycleTotal: number | null = null;

  constructor(options: XClientOptions) {
    if (!options.bearerToken?.trim()) {
      throw new XCredentialError(
        "(construction)",
        401,
        null,
        "XClient was constructed without a bearer token. Nothing was sent.",
      );
    }
    this.bearerToken = options.bearerToken.trim();
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? X_API_BASE;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowMs = options.now ?? (() => Date.now());
    this.fieldsParam = options.postFieldsParam ?? "tweet.fields";
    this.ledger = options.ledger ?? null;
    this.monthlyCap = options.monthlyPostReadCap ?? MONTHLY_POST_READ_CAP;
  }

  get spend(): XSpend {
    return {
      postReads: this.postReads,
      userReads: this.userReads,
      countsRequests: this.countsRequests,
      requests: this.requests,
    };
  }

  /** Which spelling ended up working. Worth logging on the first real run. */
  get postFieldsParam(): XPostFieldsParam {
    return this.fieldsParam;
  }

  /**
   * Whether the monthly ceiling is actually being held, and by what.
   *
   * A VALUE RATHER THAN A COMMENT, because "the cap is enforced" was a claim
   * this file used to make in prose while nothing checked it. A caller can now
   * ask, and the account's note says the answer where an operator will read it.
   */
  get monthlyEnforcement(): "enforced" | "not-enforced" {
    return this.ledger ? "enforced" : "not-enforced";
  }

  /** The cycle key this client is currently billing into. */
  get currentCycle(): string {
    return billingCycle(new Date(this.nowMs()));
  }

  // ------------------------------------------------------ the money contract

  /**
   * What this client has billed since the last time it was asked.
   *
   * Null ONLY when nothing was sent at all — a run where X was unavailable and
   * no request left the process. It is deliberately NOT null for a run that
   * sent requests and was billed nothing, because "we asked and it cost
   * nothing" and "nobody asked" are different facts and this is the seam that
   * carries the difference to the screen.
   *
   * `truncation` is always null and that is a statement about how this leg
   * behaves, not a gap. X either completes the read or refuses it: the per-run
   * cap, the monthly cap, a 429 and a counts/search disagreement all THROW,
   * because a partial page of a metered search is a slice of an unknown whole
   * and lib/platform/x.ts will not hand one back as though it were an answer.
   * The day a truncating path exists, it reports itself here.
   */
  accountForLastRun(): RunAccount | null {
    const now = this.spend;
    const delta: XSpend = {
      postReads: now.postReads - this.accounted.postReads,
      userReads: now.userReads - this.accounted.userReads,
      countsRequests: now.countsRequests - this.accounted.countsRequests,
      requests: now.requests - this.accounted.requests,
    };
    this.accounted = now;
    if (delta.requests === 0) return null;
    return { spend: { usdMicros: spendMicros(delta), note: this.noteFor(delta) }, truncation: null };
  }

  /**
   * The sentence that goes with the figure, composed for a person.
   *
   * It says four things and each one is here because leaving it out would let
   * the number be read as something it is not: what was billed and at what
   * rate; the unconfirmed User-read gap that makes the figure a floor; and
   * whether the monthly ceiling is being held at all.
   */
  private noteFor(delta: XSpend): string {
    const usd = (micros: UsdMicros) => `$${(micros / 1_000_000).toFixed(4)}`;
    const parts = [
      `${delta.postReads.toLocaleString("en-US")} Post reads at $${USD_PER_POST_READ.toFixed(3)} ` +
        `and ${delta.countsRequests.toLocaleString("en-US")} counts requests at ` +
        `$${USD_PER_COUNTS_RECENT_REQUEST.toFixed(3)}, billed per resource returned.`,
    ];

    const unconfirmed = unconfirmedUserMicros(delta);
    if (unconfirmed > 0) {
      parts.push(
        `This run also brought back ${delta.userReads.toLocaleString("en-US")} expanded User ` +
          "objects. X's price table does not say whether an expanded user in `includes` is " +
          `billed as a User read, so if it is, add up to ${usd(unconfirmed)} — the figure above ` +
          "is what is certain, not a total.",
      );
    }

    if (this.ledger && this.cycleTotal !== null) {
      parts.push(
        `${this.cycleTotal.toLocaleString("en-US")} of ${this.monthlyCap.toLocaleString("en-US")} ` +
          `Post reads used in cycle ${this.currentCycle}.`,
      );
    } else {
      parts.push(
        "No spend ledger is wired, so the " +
          `${this.monthlyCap.toLocaleString("en-US")}-Post monthly ceiling is NOT being enforced ` +
          "across runs — each run only knows its own cap.",
      );
    }

    return parts.join(" ");
  }

  /**
   * How many Posts the query WOULD match, before paying per Post to find out.
   *
   * $0.005 for the request against $0.005 for every single Post a search would
   * return. Two things come out of it, and both are worth a half-cent:
   *
   *   ZERO   the search is guaranteed to return nothing, so it is not issued at
   *          all. That turns "we found nothing" from an inference into a fact
   *          the endpoint stated, for a half-cent instead of nothing at all.
   *   VOLUME the caller can refuse to sample 100 posts out of 400,000, which is
   *          not discovery, it is a lottery with a bill attached.
   */
  async countRecent(query: string, startTime?: string): Promise<number> {
    assertUsableQuery(query);
    this.countsRequests += 1;
    const body = await this.get<XCountsBody>("/2/tweets/counts/recent", {
      query,
      granularity: "day",
      start_time: startTime,
    });
    const total = body.meta?.total_post_count ?? body.meta?.total_tweet_count;
    if (typeof total === "number") return total;
    // No meta total: sum the buckets. Both spellings, for the reason on XCountsBody.
    return (body.data ?? []).reduce((sum, b) => sum + (b.post_count ?? b.tweet_count ?? 0), 0);
  }

  /**
   * Recent search, paginated, stopping at `maxPosts` billable Posts.
   *
   * ONE RESPONSE CARRIES EVERYTHING THE PRODUCT NEEDS. The expansions and media
   * fields below bring back the view count, the duration and the playable
   * variants alongside the Post, so there is no second hop to a downloader to
   * find out how long a video is or how many times it was watched. That is the
   * single thing that makes X different from the other four platforms here.
   */
  async searchRecent(options: XSearchOptions): Promise<XSearchResult> {
    assertUsableQuery(options.query);
    // BEFORE A SINGLE REQUEST. The cheque is refused, not bounced.
    await this.assertCycleHasRoom(options.maxPosts);

    const posts: XPost[] = [];
    const media = new Map<string, XMedia>();
    const users = new Map<string, XUser>();
    let nextToken: string | undefined;
    let pages = 0;
    let more = false;

    while (posts.length < options.maxPosts) {
      const remaining = options.maxPosts - posts.length;
      const body = await this.searchPage(options, pageSizeFor(remaining), nextToken);
      pages += 1;

      const data = body.data ?? [];
      // Billed for every resource RETURNED, including ones sliced off below.
      this.postReads += data.length;
      const returnedUsers = body.includes?.users ?? [];
      this.userReads += returnedUsers.length;
      // WRITTEN AFTER THE RESPONSE, PER PAGE. Per page rather than per run
      // because a run that throws on page three has still been billed for
      // pages one and two, and a ledger that only records complete runs
      // undercounts exactly the runs that went wrong.
      await this.recordCycleSpend(data.length);

      if (pages === 1) this.assertFieldsWereHonoured(data);

      for (const m of body.includes?.media ?? []) {
        if (m.media_key) media.set(m.media_key, m);
      }
      for (const u of returnedUsers) {
        if (u.id) users.set(u.id, u);
      }
      for (const p of data.slice(0, remaining)) posts.push(p);

      nextToken = body.meta?.next_token;
      if (!nextToken || data.length === 0) break;
      more = true;
    }

    return {
      posts,
      media,
      users,
      pages,
      truncatedByCap: more && posts.length >= options.maxPosts && nextToken !== undefined,
    };
  }

  /**
   * One Post by id, with its media. Costs ONE Post read ($0.005).
   *
   * Only used to resolve a playable file on demand, because a `ShortRecord` does
   * not carry variants and must not — see `downloadUrl` on the adapter seam for
   * why a media URL is never stored.
   */
  async lookupPost(id: string): Promise<{ post: XPost | null; media: ReadonlyMap<string, XMedia> }> {
    const body = await this.get<XLookupBody>(`/2/tweets/${encodeURIComponent(id)}`, {
      [this.fieldsParam]: POST_FIELDS,
      expansions: "attachments.media_keys",
      "media.fields": MEDIA_FIELDS,
    });
    if (body.data) {
      this.postReads += 1;
      // One Post read, billed and ledgered like any other. A file resolved on
      // demand is a smaller charge than a search and it is the same charge.
      await this.recordCycleSpend(1);
    }
    const media = new Map<string, XMedia>();
    for (const m of body.includes?.media ?? []) {
      if (m.media_key) media.set(m.media_key, m);
    }
    return { post: body.data ?? null, media };
  }

  // ------------------------------------------------------------------ private

  /**
   * Refuse the run if this billing cycle cannot afford its WORST CASE.
   *
   * CHECKED AGAINST `worstCaseBilledPosts` AND NOT AGAINST `maxPosts`, for the
   * same reason the per-run cap is: recent search has a documented minimum
   * `max_results` of 10, so a run with four posts left in its budget is billed
   * for ten. Checking the optimistic figure would authorise an overshoot
   * nobody agreed to, one page at a time, at the end of every month.
   *
   * A CLIENT WITH NO LEDGER PASSES THIS UNCONDITIONALLY, and does not pretend
   * otherwise: it has no way to know what the cycle has already spent, and
   * inventing zero would be a ceiling that reports itself as holding while
   * holding nothing.
   */
  private async assertCycleHasRoom(maxPosts: number): Promise<void> {
    if (!this.ledger) return;
    const cycle = this.currentCycle;
    const already = await this.ledger.postReadsIn(cycle);
    this.cycleTotal = already;
    const worst = worstCaseBilledPosts(maxPosts);
    if (already + worst <= this.monthlyCap) return;

    throw new XMonthlyCapError(
      already,
      worst,
      this.monthlyCap,
      cycle,
      `This X billing cycle (${cycle}) has already been billed for ` +
        `${already.toLocaleString("en-US")} Post reads, and this run could add up to ` +
        `${worst.toLocaleString("en-US")} more, which would cross the ` +
        `${this.monthlyCap.toLocaleString("en-US")}-Post ceiling. Nothing was sent, so nothing ` +
        "was charged for it. A monthly ceiling is not raised by editing a per-run setting: " +
        "either wait for the cycle to turn over, lower what each run asks for, or change the " +
        "ceiling deliberately in the knowledge that X charges " +
        `$${USD_PER_POST_READ.toFixed(3)} for every Post beyond it.`,
    );
  }

  /**
   * Add what a response was billed for to the cycle, and refuse to continue if
   * that put the cycle over.
   *
   * The second half matters because the pre-flight check above is a snapshot: a
   * second run in another process can spend between the check and the request.
   * The money in that case is already gone — the posts came back and were
   * billed — so this throws to stop the NEXT page rather than to undo the last
   * one, and says so.
   */
  private async recordCycleSpend(posts: number): Promise<void> {
    if (!this.ledger || posts <= 0) return;
    const cycle = this.currentCycle;
    const total = await this.ledger.recordPostReads(cycle, posts);
    this.cycleTotal = total;
    if (total <= this.monthlyCap) return;

    throw new XMonthlyCapError(
      total,
      posts,
      this.monthlyCap,
      cycle,
      `This X billing cycle (${cycle}) is now at ${total.toLocaleString("en-US")} Post reads, ` +
        `past the ${this.monthlyCap.toLocaleString("en-US")}-Post ceiling. The ` +
        `${posts.toLocaleString("en-US")} posts in the page that crossed it were returned and ` +
        "have been billed — the ceiling was checked before this run started and something else " +
        "spent against the same cycle in between. The run stops here rather than paying for " +
        "another page, and the rows it had are not returned, because a slice of a metered " +
        "search presented as an answer is the failure this whole leg is built to avoid.",
    );
  }

  private async searchPage(
    options: XSearchOptions,
    pageSize: number,
    nextToken: string | undefined,
  ): Promise<XSearchBody> {
    const params = () => ({
      query: options.query,
      max_results: String(pageSize),
      start_time: options.startTime,
      next_token: nextToken,
      [this.fieldsParam]: POST_FIELDS,
      expansions: "attachments.media_keys,author_id",
      "media.fields": MEDIA_FIELDS,
      "user.fields": USER_FIELDS,
    });

    try {
      return await this.get<XSearchBody>("/2/tweets/search/recent", params());
    } catch (cause) {
      if (!this.shouldFlipFieldsParam(cause)) throw cause;
      // Free: a 400 returns no resources and reads are billed per resource.
      this.fieldsParam = this.fieldsParam === "tweet.fields" ? "post.fields" : "tweet.fields";
      this.fieldsParamFlipped = true;
      return await this.get<XSearchBody>("/2/tweets/search/recent", params());
    }
  }

  /** A 400 that blames the field parameter, and only one flip per client. */
  private shouldFlipFieldsParam(cause: unknown): boolean {
    if (this.fieldsParamFlipped) return false;
    if (!(cause instanceof XApiError) || cause.status !== 400) return false;
    return /tweet\.fields|post\.fields/i.test(cause.message);
  }

  /**
   * The IGNORED case from the header: X accepted the field parameter and sent
   * nothing back for it. Every Post arrives with `id` and `text` and no metrics.
   *
   * NOT RETRIED. A retry here costs a whole page of Post reads to guess a
   * parameter name, and guessing with somebody's money is the thing the cap
   * exists to stop. It throws with the one-line fix instead.
   */
  private assertFieldsWereHonoured(data: readonly XPost[]): void {
    if (data.length === 0) return;
    if (data.some((p) => p.public_metrics !== undefined || p.created_at !== undefined)) return;
    throw new XFieldsIgnoredError(
      "/2/tweets/search/recent",
      `X returned ${data.length} Posts and not one carried public_metrics or created_at, which ` +
        `means it accepted \`${this.fieldsParam}\` and ignored it. X's own documentation ` +
        "disagrees with itself about that parameter's name — the OpenAPI spec says " +
        "`post.fields`, the worked examples say `tweet.fields`. Set X_POST_FIELDS_PARAM to " +
        `\`${this.fieldsParam === "tweet.fields" ? "post.fields" : "tweet.fields"}\` and run again. ` +
        "This was not retried automatically because a retry costs another page of Post reads.",
    );
  }

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    let lastServerError: XApiError | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      this.requests += 1;
      const response = await this.doFetch(url.toString(), {
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          accept: "application/json",
          "user-agent": "shorts-scraper/0.1",
        },
      });

      if (response.ok) return (await readJson(response)) as T;

      const body = await readJson(response);
      const problem = problemOf(body);
      const detail = problem.detail ?? `${response.status} from ${path}`;

      if (response.status === 401) {
        throw new XCredentialError(
          path,
          401,
          problem.type,
          "X rejected the bearer token (401). The key saved for X is wrong, was revoked, or was " +
            `pasted with a stray character. X said: ${detail}`,
        );
      }
      if (response.status === 403) {
        throw new XCredentialError(
          path,
          403,
          problem.type,
          `X accepted the token and refused the request (403) for ${path}. That is an ACCESS ` +
            "LEVEL problem, not a bad key: the project this token belongs to is not entitled to " +
            `this endpoint or field. X said: ${detail}`,
        );
      }
      if (response.status === 429) {
        const resetAt = rateLimitReset(response);
        throw new XRateLimitError(
          path,
          resetAt,
          `X rate-limited ${path} (429). Recent search allows 450 requests per 15 minutes per ` +
            "app and Post counts 300 per 15 minutes" +
            (resetAt ? `; the window resets at ${resetAt.toISOString()}` : "") +
            ". No posts were returned, so nothing was billed for this request.",
        );
      }
      if (response.status === 402) {
        throw new XApiError(
          path,
          402,
          problem.type,
          `X returned 402 Payment Required for ${path}. X's API pays per resource returned from ` +
            "credits bought in the Developer Console, so the likely cause is that the credit " +
            "balance is exhausted — but this build has not seen X document a 402, so that is an " +
            `inference and not a quotation. X said: ${detail}`,
        );
      }
      if (response.status >= 500) {
        lastServerError = new XApiError(path, response.status, problem.type, `X server error: ${detail}`);
        await this.sleep(Math.min(2 ** attempt, 8) * 1000);
        continue;
      }

      throw new XApiError(
        path,
        response.status,
        problem.type,
        `X refused ${path} with ${response.status}` +
          (problem.parameter ? ` (parameter \`${problem.parameter}\`)` : "") +
          `: ${detail}`,
      );
    }

    throw (
      lastServerError ??
      new XApiError(path, 0, null, `X did not respond to ${path} after ${this.maxAttempts} attempts.`)
    );
  }
}

// -------------------------------------------------------- requested field sets

/**
 * What we ask for on the Post, and why each one is on the list.
 *
 *   created_at      the publish date, which is half of "latest"
 *   author_id       the creator, and the only id that survives a handle change
 *   public_metrics  likes and replies. NOT the view count — see below
 *   attachments     the media_keys that link a Post to its video
 *   lang            so an operator can see what a `lang:` filter actually caught
 *
 * `impression_count` ARRIVES INSIDE public_metrics AND IS NOT USED AS A VIEW
 * COUNT. An impression is the post appearing on a timeline; a view is somebody
 * playing the video. Substituting one for the other would put a much larger
 * number in the column the 500,000 threshold reads, and every row would clear a
 * bar it never actually cleared. The view count comes from the MEDIA object or
 * it stays null.
 */
const POST_FIELDS = "created_at,author_id,public_metrics,attachments,lang";

/**
 * What we ask for on the Media, which is where the product's two hard
 * requirements live.
 *
 *   duration_ms     "Available when type is video" — the only thing that makes
 *                   something a Short, and the reason X can be filtered at all
 *   public_metrics  `{ view_count }`, documented as PUBLIC engagement metrics,
 *                   as against non_public_/organic_/promoted_metrics which all
 *                   say "Requires user context authentication"
 *   variants        the playable files, so `downloadUrl` needs no downloader
 *   preview_image_url, type, media_key  thumbnail, video-vs-photo, the join key
 */
const MEDIA_FIELDS = "duration_ms,public_metrics,variants,preview_image_url,type,media_key,width,height";

/** Just enough to name and link the creator. Nothing about followers. */
const USER_FIELDS = "username,name";

// -------------------------------------------------------------------- helpers

/**
 * The highest-bitrate progressive MP4 in a media object's variants, or null.
 *
 * MP4 ONLY, DELIBERATELY. The variants array also carries an HLS manifest
 * (`application/x-mpegURL`), which has no `bit_rate` and which a browser cannot
 * save as a file — handing an operator a manifest when they asked for the video
 * is the same broken promise as handing them a dead link.
 *
 * ON EXPIRY, WHICH IS THE THING THAT MATTERS FOR STORING ONE. The example
 * variant URL in X's data dictionary is
 * `https://video.twimg.com/ext_tw_video/1527322141724532740/pu/vid/320x568/lnBaR2hCqE-R_90a.mp4?tag=12`
 * — no signature, no expiry parameter, nothing that looks time-limited, unlike
 * the `expire=`-stamped googlevideo URLs this repo measured at six hours for
 * YouTube. THAT IS AN OBSERVATION ABOUT ONE DOCUMENTED EXAMPLE AND NOT A
 * MEASUREMENT. It is not enough to justify storing one: the adapter seam
 * resolves media URLs on demand and never persists them, and X is not being
 * made the exception on the strength of a URL in a table.
 */
export function bestMp4Variant(media: XMedia | undefined): string | null {
  if (!media?.variants) return null;
  let best: XMediaVariant | null = null;
  for (const v of media.variants) {
    if (!v.url || v.content_type !== "video/mp4") continue;
    if (!best || (v.bit_rate ?? 0) > (best.bit_rate ?? 0)) best = v;
  }
  return best?.url ?? null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * X's RFC-7807 problem details, from wherever this response put them.
 *
 * The OpenAPI spec has `errors: [Problem]` with `type`, `title`, `detail` and
 * sometimes `parameter`. Some responses put a single problem at the top level
 * instead. Both are read, because the alternative is losing X's own explanation
 * of what is wrong with the query and replacing it with our guess.
 */
function problemOf(body: unknown): {
  type: string | null;
  detail: string | null;
  parameter: string | null;
} {
  const record = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(record.errors) ? (record.errors as Array<Record<string, unknown>>) : [];
  const first = list[0] ?? record;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const detail = str(first.detail) ?? str(first.title) ?? str(first.message) ?? str(record.detail);
  const parameter = str(first.parameter) ?? str((first.parameters as Record<string, unknown>)?.["query"]);
  return { type: str(first.type), detail, parameter };
}

/** `x-rate-limit-reset` is unix SECONDS, per the rate-limits page. */
function rateLimitReset(response: Response): Date | null {
  const raw = response.headers?.get?.("x-rate-limit-reset");
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

// ---------------------------------------------------------------------------
// The join: an X adapter that reports what it charged
// ---------------------------------------------------------------------------

/**
 * AN X ADAPTER THAT ANSWERS THE MONEY CONTRACT, BY DELEGATING TO THE CLIENT.
 *
 * WHY A WRAPPER AND NOT A METHOD ON `XAdapter`. The two halves of X live in two
 * files on purpose — lib/platform/x.ts turns X's vocabulary into a
 * `ShortRecord`, this file knows what a request costs — and the reason given at
 * the top of both is that keeping them together is how a query change quietly
 * becomes a billing change nobody reviewed. The reporting seam follows the same
 * split: the object that counted the billable resources is the object that says
 * what they cost, and the adapter is wrapped rather than taught a price table.
 *
 * WHAT IT IS FOR, PLAINLY. `lib/shorts/run.ts` is handed ADAPTERS and never
 * clients, so an `XClient` that meters itself perfectly reports nothing at all
 * unless something carries its answer out through an adapter. This is that
 * something, and it is one line at the point where the registry builds X:
 *
 *     x: (w) => meterWithX(new XAdapter({ ...xConfigFor(w.options), client: w.xClient }), w.xClient)
 *
 * `meterWithX` returns the adapter UNCHANGED when there is no client, because
 * an X with no key spends nothing, reports nothing, and must not appear in a
 * spend list as a zero.
 *
 * IT IS `implements AccountingAdapter`, so the compiler holds both halves of
 * the contract: drop the brand or drop the method and this file stops building.
 * That is the whole point of the brand — see the scar on `METERS_ITS_OWN_SPEND`
 * in lib/shorts/run.ts for the version of this seam that had neither, and
 * reported an empty spend list for a platform billing $0.005 a row.
 */
export interface XMeteredAdapterOptions {
  /** The configured search query, for pricing a run before making it. */
  readonly query?: string | null;
  /** The per-run Post ceiling, so a forecast prices what will actually be asked for. */
  readonly maxPostsPerRun?: number | null;
  /** The search window in hours, matching the adapter's. Null is X's own 7 days. */
  readonly windowHours?: number | null;
  readonly now?: () => Date;
}

export class XMeteredAdapter implements AccountingAdapter {
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  private readonly now: () => Date;

  constructor(
    private readonly inner: PlatformAdapter,
    private readonly client: XClient,
    private readonly options: XMeteredAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get platform() {
    return this.inner.platform;
  }

  describe(): string {
    return this.inner.describe();
  }

  unavailableReason(): Promise<string | null> {
    return this.inner.unavailableReason();
  }

  latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    return this.inner.latestShorts(query);
  }

  downloadUrl(short: ShortRecord): Promise<string | null> {
    return this.inner.downloadUrl(short);
  }

  accountForLastRun(): RunAccount | null {
    return this.client.accountForLastRun();
  }

  /**
   * What a run would cost, WITHOUT making it — and it costs $0.005 to ask.
   *
   * `/2/tweets/counts/recent` reports how many Posts a query matches without
   * returning them, which is the only cheap question X answers about a run's
   * size. The figure quoted is the SMALLER of what the query matches and what
   * the per-run cap authorises, because that is what would actually be
   * retrieved — quoting the match count would forecast a run this adapter would
   * refuse to make.
   *
   * A null figure with a sentence, never a zero, whenever the probe cannot be
   * made: a forecast of $0.00 for a run nobody has priced is the one number on
   * that panel an operator would act on without reading.
   */
  async forecastSpend(query: LatestShortsQuery): Promise<SpendForecast> {
    const search = this.options.query?.trim();
    if (!search) {
      return {
        usdMicros: null,
        note:
          "X has no search query configured, so there is nothing to price. What a run costs here " +
          "is decided by what the query matches, and this tool will not invent one.",
      };
    }
    const cap = this.options.maxPostsPerRun ?? null;
    if (cap === null || !Number.isSafeInteger(cap) || cap <= 0) {
      return {
        usdMicros: null,
        note:
          "X has no usable per-run post cap configured, so the size of a run is undecided and " +
          "cannot be priced. Set X_MAX_POSTS_PER_RUN.",
      };
    }

    const startTime = startTimeFor(this.options.windowHours ?? null, this.now()) ?? undefined;
    const matched = await this.client.countRecent(search, startTime);
    const retrievable = Math.min(matched, query.limit, cap);
    const billed = worstCaseBilledPosts(retrievable);
    const micros = billed * MICROS_PER_POST_READ + MICROS_PER_COUNTS_REQUEST;

    return {
      usdMicros: micros,
      note:
        `This query matches ${matched.toLocaleString("en-US")} posts in the window; a run would ` +
        `retrieve ${retrievable.toLocaleString("en-US")} of them and be billed for ` +
        `${billed.toLocaleString("en-US")} Post reads at $${USD_PER_POST_READ.toFixed(3)}, plus ` +
        `the $${USD_PER_COUNTS_RECENT_REQUEST.toFixed(3)} counts request this estimate just ` +
        `made. Recent search has a minimum page size of ${SEARCH_MIN_RESULTS}, which is why the ` +
        "billed figure can exceed the retrieved one. Expanded User objects are not in this " +
        "figure because X's price table does not say whether they are billed.",
    };
  }
}

/**
 * Wrap an X adapter so its client's spend reaches the report. Unchanged when
 * there is no client, because an unconfigured X charges nothing and must not
 * appear in a spend list at all — see `report.spend`, where a missing platform
 * means "did not report a price" and never "was free".
 */
export function meterWithX(
  adapter: PlatformAdapter,
  client: XClient | null,
  options: XMeteredAdapterOptions = {},
): PlatformAdapter {
  return client ? new XMeteredAdapter(adapter, client, options) : adapter;
}
