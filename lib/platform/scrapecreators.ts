/**
 * SCRAPECREATORS — the third-party reader for TikTok, Instagram and Facebook,
 * dropped into the `ProviderClient` seam that lib/platform/unavailable.ts was
 * written to receive.
 *
 * WHY THIS FILE EXISTS
 *
 * Erik, 2026-09-04: "We are going with ScrapeCreators." He was shown Bright
 * Data as the more reliable option and ScrapeCreators as roughly eight times
 * cheaper for the same rows, with the durability tradeoff stated, and he chose
 * the cheap one. That decision is made and this file does not relitigate it. It
 * does, however, have to be built so the two things that were traded away
 * cannot hurt anybody quietly, and that is most of what is unusual below.
 *
 * ===========================================================================
 * NOTHING IN THIS FILE HAS EVER BEEN RUN AGAINST SCRAPECREATORS
 * ===========================================================================
 *
 * THERE IS NO SCRAPECREATORS KEY ON THIS MACHINE. Not one request has been
 * issued. Every path, parameter, field name, status code and price below was
 * READ from docs.scrapecreators.com or scrapecreators.com on 2026-09-04 and
 * carries the URL it came from, in the same style as lib/platform/meta-client.ts
 * and lib/platform/x-client.ts. "Documented" and "working" are different words
 * and this file is only entitled to the first. The first real key is the
 * experiment. Until then nobody may say this works.
 *
 * ------------------------------------------------------------------- THE API
 *
 * Host, and the key header — https://docs.scrapecreators.com/introduction,
 * read 2026-09-04, verbatim: "You'll need to include your API key in the
 * `x-api-key` header with every request to our REST API endpoints." The host
 * `https://api.scrapecreators.com` is the one every curl sample on the endpoint
 * pages uses.
 *
 * IT IS A PLAIN SYNCHRONOUS REST API. One GET, one JSON body, one page of
 * results. There is no trigger/poll/snapshot cycle to build machinery for, which
 * is the single largest simplification the vendor choice bought us, and it is
 * why this file is a request/response client and nothing more.
 *
 * IT BILLS PER REQUEST, NOT PER ROW — scrapecreators.com pricing, read
 * 2026-09-04, verbatim: "1 credit === 1 request (for most endpoints). A few use
 * more." That is the whole reason the meaningful ceiling in this file is
 * `maxRequests` and not a row count. A cap on records would be a cap on
 * something nobody is charged for.
 *
 * ============================================================================
 * THE TWO RISKS THIS VENDOR CARRIES, AND WHERE EACH ONE IS ANSWERED IN CODE
 * ============================================================================
 *
 * 1. DURABILITY, PARTICULARLY INSTAGRAM. The vendor's own public status page
 *    shows Instagram is its most frequently broken platform; the most recent
 *    incident, 25-26 August 2026, was an Instagram reels endpoint migrating to
 *    a new data source. So this leg WILL break periodically, and the failure
 *    mode that matters is not a 500 — it is a 200 carrying a body this parser
 *    no longer recognises. `assertRecognisedShape` and `assertSomethingParsed`
 *    exist for exactly that: a 200 whose results array is ABSENT is a shape
 *    change and throws, while a results array that is present and EMPTY is a
 *    real answer and returns []. Those two are one keystroke apart in a parser
 *    and a universe apart on the screen.
 *
 * 2. FACEBOOK VIEW COUNTS ARE NOT TRUSTWORTHY, so this file refuses to publish
 *    one as a measurement. See `FACEBOOK_VIEW_COUNT_CAVEAT` — it is the longest
 *    comment in the file because it is the one place a wrong decision here puts
 *    a false number in front of a client.
 *
 * -------------------------------------------------- WHAT WAS CHECKED, AND NOT
 *
 * CHECKED, and the reason it is called out: `video.duration` ON TIKTOK IS IN
 * MILLISECONDS AND THE DOCS NEVER SAY SO. Two endpoint pages were read for a
 * literal value rather than a description, because a description was not
 * available and a guess here is silent and total:
 *
 *   https://docs.scrapecreators.com/v3/tiktok/profile/videos  `video.duration`
 *     = 89131, alongside `create_time` = 1739470683.
 *   https://docs.scrapecreators.com/v1/tiktok/search/hashtag  `video.duration`
 *     = 10703, alongside `added_sound_music_info.duration` = 10.
 *
 * 89131 and 10703 are 89 seconds and 10.7 seconds. Read as seconds they are 24
 * hours and 3 hours, which TikTok does not host. The second page settles it
 * outright: the sound attached to that same post is 10 units long in a field
 * that must be seconds, and 10703/10 is a thousand. So `video.duration` is
 * milliseconds and `TIKTOK_DURATION_IS_MILLISECONDS` divides by 1000.
 *
 * THIS IS THE FAILURE THAT WOULD HAVE BEEN INVISIBLE. Read as seconds, every
 * TikTok arrives at 10,000-90,000 seconds, every one of them fails the
 * 120-second Shorts ceiling, and `lib/shorts/run.ts` files the entire platform
 * under `dropped.tooLong` — a run that read TikTok correctly, paid for it, and
 * reported nothing, with a drop reason that reads as a legitimate result.
 *
 * NOT the same unit, and each verified separately by a literal:
 *   Instagram `media.video_duration` = 76.783 — SECONDS, fractional
 *     (https://docs.scrapecreators.com/v1/instagram/user/reels/).
 *   Facebook `play_time_in_ms` — MILLISECONDS, and the field says so
 *     (https://docs.scrapecreators.com/v1/facebook/profile/reels).
 *
 * NOT CHECKED, and therefore not written: the query parameters of
 * `/v1/tiktok/search/hashtag`. The path is documented and its response shape is
 * documented; the parameter that carries the hashtag is not shown on the page.
 * So this file does not guess one — see `TikTokHashtagSource`, which makes the
 * parameter name operator-supplied configuration. An invented parameter name
 * would come back as a 400 or, worse, as a successful call for the wrong thing.
 *
 * ============================================================================
 * HOW THIS FILE IS REACHED, WHICH IS THE THING THAT WAS MISSING
 * ============================================================================
 *
 * A previous round shipped this client with ZERO production call sites: one
 * class definition, a thorough test file, and nothing in the tree that built
 * it. A reviewer moved this file out of the tree entirely and the suite stayed
 * green with tsc exiting 0. The units were right and the seam did not exist.
 *
 * THE SEAM IS lib/platform/registry.ts. It leases the `scrapecreators`
 * credential, builds ONE `ScrapeCreatorsClient` from it, reads what to ask each
 * platform for out of the environment, and constructs one
 * `ScrapeCreatorsProvider` per platform that has something to ask — which it
 * then hands to `TikTokAdapter`, `InstagramAdapter` and `FacebookAdapter` in
 * their provider slot. Three exports carry that: `ScrapeCreatorsClient`,
 * `ScrapeCreatorsProvider` and `PlatformSource`. NO WIRING FACADE IS ADDED HERE
 * ON TOP OF THEM: a second way to build the same objects that nothing calls is
 * the exact defect this paragraph is about, and it would be indistinguishable
 * from progress.
 *
 * ---------------------------------------------------- WHAT THIS DOES NOT READ
 *
 * X is not here. X stays on the official API (lib/platform/x-client.ts), which
 * returns view count, duration and the video URL in one response and is the one
 * leg with no terms problem. YouTube is not here either; it is keyless via
 * yt-dlp and needs no vendor. Adding either to this file would be paying for
 * something we already have.
 */
import type { LatestShortsQuery } from "./adapter";
import type { CaveatedShortRecord } from "./caveat";
import type { Platform, ShortRecord } from "./types";
import { SEARCHES_KEYWORDS, type KeywordSearchingProvider } from "./unavailable";
import { scrub } from "../credentials/mask";
import {
  markSafeToShow,
  METERS_ITS_OWN_SPEND,
  type RunAccount,
  type SpendAccountant,
  type Truncation,
  type UsdMicros,
} from "../shorts/run";

// ---------------------------------------------------------------------------
// The API, as documented
// ---------------------------------------------------------------------------

/** Every curl sample on docs.scrapecreators.com, read 2026-09-04. */
export const SCRAPECREATORS_BASE = "https://api.scrapecreators.com";

/**
 * Verbatim from https://docs.scrapecreators.com/introduction, 2026-09-04.
 *
 * A HEADER AND NOT A QUERY PARAMETER, which is the good case: the key never
 * enters a URL, so a URL in an error message or a log line is safe by
 * construction. `scrub` is still applied to every composed message, because a
 * vendor's error body is somebody else's string and may quote anything.
 */
export const API_KEY_HEADER = "x-api-key";

/**
 * The endpoint paths, each beside the page it was read from on 2026-09-04.
 *
 * CONSTANTS AND NOT INLINE STRINGS, so that the error a broken endpoint throws
 * can name the path and the operator can paste it into the docs URL and see for
 * themselves what changed. A path spelled twice is a path that can be corrected
 * once.
 */
export const ENDPOINTS = {
  /** https://docs.scrapecreators.com/v1/tiktok/get-trending-feed */
  tiktokTrending: "/v1/tiktok/get-trending-feed",
  /** https://docs.scrapecreators.com/v1/tiktok/search/keyword */
  tiktokKeyword: "/v1/tiktok/search/keyword",
  /** https://docs.scrapecreators.com/v1/tiktok/search/hashtag — parameters NOT documented. */
  tiktokHashtag: "/v1/tiktok/search/hashtag",
  /** https://docs.scrapecreators.com/v1/instagram/user/reels/ */
  instagramUserReels: "/v1/instagram/user/reels",
  /** https://docs.scrapecreators.com/v2/instagram/reels/search */
  instagramReelSearch: "/v2/instagram/reels/search",
  /** https://docs.scrapecreators.com/v1/facebook/profile/reels */
  facebookProfileReels: "/v1/facebook/profile/reels",
  /**
   * https://docs.scrapecreators.com/v1/account/credit-balance — read 2026-09-05.
   *
   * IT COSTS A CREDIT TO ASK WHAT THE BALANCE IS. Their own page says "1 credit
   * per request" for this route, the same as every scraping route, and that one
   * fact decides how the whole feature above it is shaped: nothing polls this on
   * a timer. A thirty-second poll is 2,880 credits a day, which at the Freelance
   * tier is about $5.41 a day to watch a number that only changes when a run
   * happens.
   *
   * Documented response, verbatim from that page:
   *
   *   { "success": true, "credits_remaining": 1000000,
   *     "credits_charged": 1, "creditCount": 333 }
   *
   * `creditCount` IS READ, BUT ONLY AS A FALLBACK. On 2026-09-09 the live
   * endpoint stopped sending `credits_remaining` and returned `creditCount` as
   * the balance — confirmed by its own `message`, "You have 25100 credits
   * remaining", on an account of 25,000. So the reader is
   * `credits_remaining ?? creditCount`: when the vendor sends the documented
   * field it wins, so the old example above still reads as 1,000,000 and not
   * 333; when the vendor sends only `creditCount`, as the live API now does,
   * that is the balance. Both are surfaced as the same fact — how many credits
   * are left — never as "credits bought", which the vendor publishes nowhere.
   */
  accountCreditBalance: "/v1/account/credit-balance",
} as const;

export type EndpointPath = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

// ---------------------------------------------------------------------------
// The price table
// ---------------------------------------------------------------------------

/**
 * Credits, priced from scrapecreators.com, read 2026-09-04.
 *
 * Three published tiers, all one-off purchases, all with credits that do not
 * expire and no subscription:
 *
 *   Free        100 credits, plus "Up to 7,000 bonus credits to claim"
 *   Freelance   $47   for  25,000 credits  — "$1.88 / 1k requests"
 *   Business    $497  for 500,000 credits  — "$0.99 / 1k requests"
 *
 * MICRO-DOLLARS PER CREDIT, INTEGER, for the reason `UsdMicros` gives in
 * lib/shorts/run.ts: these are summed, and $0.00188 cannot be held in cents.
 * $1.88 per 1,000 credits is 1,880 micro-dollars per credit exactly, with no
 * rounding anywhere.
 *
 * THE DEFAULT IS THE FREELANCE RATE BECAUSE THAT IS THE TIER ERIK WAS QUOTED —
 * $47 for 25,000 credits. An operator on the Business tier is paying half as
 * much per credit, and a spend note computed at the wrong tier is a wrong
 * invoice figure on a screen, so the rate is an option and the note this client
 * composes always states which rate it used. It never guesses the tier from the
 * balance.
 */
export const MICROS_PER_CREDIT_FREELANCE: UsdMicros = 1_880;
export const MICROS_PER_CREDIT_BUSINESS: UsdMicros = 990;

/**
 * What one request costs when the response does not say.
 *
 * From scrapecreators.com, verbatim: "1 credit === 1 request (for most
 * endpoints). A few use more." Every endpoint this file calls documents "1
 * credit per request" on its own page, so this is the right default — but it is
 * a DEFAULT AND NOT A MEASUREMENT, and the responses carry `credits_charged`,
 * which is the vendor's own figure. This client prefers the vendor's number
 * every time and only falls back to this one when the body did not carry it,
 * counting the two separately so the note can say which is which. "A few use
 * more" is precisely the sentence that makes an assumed 1 dangerous to state as
 * a fact.
 */
export const ASSUMED_CREDITS_PER_REQUEST = 1;

/** TikTok's `video.duration` is milliseconds. See the file header for the proof. */
export const TIKTOK_DURATION_IS_MILLISECONDS = true;

// ---------------------------------------------------------------------------
// The Facebook view-count caveat
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * WHY A FACEBOOK ROW ARRIVES WITH `view_count: null` EVEN THOUGH THE VENDOR
 * SENT A NUMBER
 * ===========================================================================
 *
 * WHAT IS KNOWN. `/v1/facebook/profile/reels` returns `view_count` as a plain
 * integer — the docs' own example shows `"view_count": 900`. A local yt-dlp
 * probe on this machine, 2026-09-04, returned 408 views for a reel whose public
 * badge read 9.8K. That is an undercount of roughly twenty-four times, measured
 * once, on one reel, with a different tool.
 *
 * WHAT IS NOT KNOWN, AND THIS FILE SAYS SO RATHER THAN ROUNDING IT UP.
 * https://docs.scrapecreators.com/v1/facebook/profile/reels was re-read on
 * 2026-09-04 looking specifically for a documented caveat on this field, and
 * THERE IS NONE on that page: no note, no warning, no description attached to
 * `view_count`. The brief for this work said the vendor documents the defect in
 * its own API docs; on the page this file actually calls, it does not. So the
 * caveat below rests on the local probe and on the general knowledge that
 * Facebook's public badge and its API figures disagree — not on a vendor
 * admission. Recording that distinction is the point: a caveat sourced from a
 * document that does not say it is a caveat nobody can re-check.
 *
 * WHY THAT IS STILL ENOUGH TO REFUSE THE NUMBER. The product's promise is
 * "shorts over 500,000 views". A number that may be an order of magnitude wrong
 * cannot answer that question in either direction, and `lib/shorts/run.ts`'s
 * `judge()` compares `short.view_count` against `minViews` unconditionally —
 * it has no way to know one platform's number is softer than another's, and
 * giving it one would mean a per-platform branch in the one place this repo
 * keeps platform-neutral. So the honesty is applied HERE, at the boundary,
 * where the fact lives.
 *
 * WHAT HAPPENS TO A FACEBOOK ROW AS A RESULT, end to end, because this is a
 * real consequence and not a gesture:
 *
 *   `view_count: null` -> `judge()` cannot evaluate the threshold -> the row is
 *   `unverified` with `unproven: ["views"]` -> it appears in
 *   `report.unverified`, which the page shows as "could not be judged" rather
 *   than dropping it -> and it is NOT persisted, because run.ts writes only
 *   `all`. So a doubtful number never becomes a stored fact, and the row still
 *   does not vanish. Both halves of the honesty rule, from one null.
 *
 * WHAT WAS DELIBERATELY NOT DONE. The tempting move is to treat the vendor's
 * figure as a LOWER BOUND — it undercounts, so a reel the vendor scores at
 * 900,000 is surely over 500,000 — and keep those rows. That was rejected. "It
 * undercounts" is itself the unverified claim; one probe on one reel is n=1 and
 * says nothing about direction in general, and a lower-bound rule would promote
 * rows into the kept, persisted, client-facing list on the strength of it. The
 * vendor's figure is preserved verbatim in `reportedValue` so an operator can
 * make that call themselves, with their eyes open, looking at the number.
 *
 * THE ROW CARRIES THE CAVEAT SO THE UI CAN PRINT IT. `ShortRecord` is a shared
 * shape and this is a fact about one platform, so nothing is added to it —
 * see the standing rule in lib/platform/types.ts about per-platform facts
 * living behind the per-platform seam. Instead a Facebook row is a
 * `CaveatedShortRecord`: structurally a `ShortRecord`, with one extra property
 * that only this file writes and only `measurementCaveat()` reads. The
 * database is unaffected either way — lib/shorts/supabase-store.ts builds its
 * payload from `SHORT_COLUMNS` and drops anything not on that list — and these
 * rows are not persisted at all.
 */
export const FACEBOOK_VIEWS_MULTIPLIER = 8;

/**
 * The note a corrected Facebook row carries.
 *
 * PER-ROW, like Instagram's and for the same reason: the reader's question is
 * "where did this number come from", and only the arithmetic answers it. Unlike
 * Instagram's, this one has a real vendor figure to name on the left-hand side,
 * which is worth showing — a reader who thinks the multiplier is wrong can see
 * exactly what it was applied to and redo it in their head.
 */
export function facebookCorrectedViewsNote(reported: number, corrected: number): string {
  return (
    `This view count is a CORRECTED ESTIMATE, not a measurement. ScrapeCreators' Facebook reels ` +
    `endpoint reported ${reported.toLocaleString("en-US")} views; this tool does not trust that ` +
    `figure and multiplied it by ${FACEBOOK_VIEWS_MULTIPLIER} to get ` +
    `${corrected.toLocaleString("en-US")}, which is the number compared against the 500,000 ` +
    `threshold. The multiplier is a configured guess. A local yt-dlp probe on 2026-09-04 read 408 ` +
    `views on a reel whose public badge said 9.8K — about twenty-four times apart — which is why ` +
    `the raw figure is distrusted, but that is one probe on one reel and it does not establish ` +
    `either the direction or the size of the correction applied here.`
  );
}

/**
 * SUPERSEDED 2026-09-08 BUT NOT DELETED. This sentence — "not trusted, and
 * deliberately not compared against the threshold" — described the behaviour
 * until Erik instructed the correction above. It is kept because the argument
 * in it is still the reason the raw number is distrusted; what changed is what
 * this tool does about it. Exported still, because the credentials and platform
 * copy quote it when explaining why Facebook's numbers carry a warning.
 */
export const FACEBOOK_VIEW_COUNT_CAVEAT =
  "Facebook's view count is not trusted here. A local yt-dlp probe on 2026-09-04 read 408 views " +
  "on a reel whose public badge said 9.8K — about twenty-four times low — and the ScrapeCreators " +
  "reels endpoint publishes no accuracy guarantee for the field. The number the vendor returned " +
  `is preserved beside every row so you can judge it yourself; what this tool compares against ` +
  `the threshold is that number multiplied by ${FACEBOOK_VIEWS_MULTIPLIER}, which is a configured ` +
  "guess and not a measurement.";

/**
 * INSTAGRAM KEYWORD SEARCH: VIEWS DERIVED FROM LIKES. ERIK'S CALL, 2026-09-08.
 *
 * `/v2/instagram/reels/search` publishes no view count of any kind, so every
 * row from the keyword sweep used to arrive with `view_count: null`, fail
 * `judge()` on the threshold it could not evaluate, and land in "could not be
 * judged" — visible, never kept, never saved. Erik's instruction is to stop
 * that by estimating: views = likes x LIKES_TO_VIEWS.
 *
 * THIS IS AN ESTIMATE AND THE CODE SAYS SO EVERYWHERE IT CAN. The derived
 * number goes into `view_count`, which means `judge()` compares it against
 * 500,000 and a row that clears it is kept, shown as a real result and written
 * to the database. That is the requested behaviour and it is the reason every
 * derived row also carries a `MeasurementCaveat` with `basis: "derived"`, so
 * the console can mark the figure rather than print it as measured.
 *
 * THE MULTIPLIER IS A GUESS AND IS DELIBERATELY EASY TO CHANGE. Four means a
 * 25% like-to-view rate. No source was consulted for it — it is the number
 * Erik gave — and it is a single exported constant precisely because the first
 * run against real data is what should set it. Compare a handful of these rows
 * against the same reels pulled through `/v1/instagram/user/reels`, which
 * carries a real `play_count`, and the honest multiplier falls out of the
 * arithmetic. Until somebody does that, treat every number this produces as
 * unverified.
 *
 * WHAT IS NOT DERIVED. A row whose `like_count` is absent stays `view_count:
 * null` and keeps going to "could not be judged". There is nothing to multiply,
 * and a zero would be a claim.
 */
export const INSTAGRAM_LIKES_TO_VIEWS = 4;

/**
 * The sentence a derived row carries, with its own arithmetic in it.
 *
 * PER-ROW RATHER THAN A CONSTANT, unlike Facebook's. The reader's question
 * about a derived figure is "where did this number come from", and the only
 * answer that settles it names the like count it came from and the multiplier
 * applied to it. A generic sentence would leave them doing the division.
 */
export function instagramDerivedViewsNote(likeCount: number, derived: number): string {
  return (
    `This view count is an ESTIMATE, not a measurement. ScrapeCreators' Instagram keyword search ` +
    `(${ENDPOINTS.instagramReelSearch}) publishes no view count at all, so this figure was ` +
    `computed here as ${likeCount.toLocaleString("en-US")} likes x ${INSTAGRAM_LIKES_TO_VIEWS} = ` +
    `${derived.toLocaleString("en-US")}. The multiplier is a configured guess, not a measured ` +
    `ratio, and it decides whether this row cleared the 500,000 threshold. The same reel pulled ` +
    `through ${ENDPOINTS.instagramUserReels} would carry a real play count; this one does not.`
  );
}

// The caveat vocabulary now lives in ./caveat.ts so the admin console can read
// it without importing this module. Re-exported here because this file is where
// every existing caller looks for it, and a moved symbol that breaks fourteen
// import sites is a refactor nobody thanks you for.
export {
  measurementCaveat,
  type CaveatBasis,
  type CaveatedField,
  type CaveatedShortRecord,
  type MeasurementCaveat,
} from "./caveat";

// ---------------------------------------------------------------------------
// Errors — one per thing an operator would do differently
// ---------------------------------------------------------------------------

/**
 * ANYTHING SCRAPECREATORS SAID NO TO, AND THE REASON EACH ONE HAS ITS OWN CLASS.
 *
 * The status table is verbatim from https://docs.scrapecreators.com/introduction,
 * read 2026-09-04:
 *
 *   200 Success
 *   400 Bad Request  - Invalid parameters or missing required fields
 *   401 Unauthorized - Invalid or missing API key
 *   402 Payment Required - Gotta purchase more credits
 *   403 Forbidden - The public source blocks this resource
 *   404 Not Found - We could not find the requested resource
 *   500 Server Error - Please try again later
 *
 * Six statuses, six different things a person does next: fix the query, fix the
 * key, buy credits, accept that this particular page is closed, fix the seed,
 * wait. A single "ScrapeCreators failed" would send every one of them to the
 * same wrong place. That is the whole design rule here and it is why there are
 * this many classes for one vendor.
 *
 * Two more that are not in the vendor's table and are the important ones:
 * `ScrapeCreatorsShapeError`, for a 200 whose body this parser no longer
 * recognises, and `ScrapeCreatorsRateLimitError`, for a 429 the docs say should
 * not happen.
 */
export class ScrapeCreatorsError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScrapeCreatorsError";
  }
}

/** No key at all. Thrown at construction, before anything is sent. */
export class ScrapeCreatorsNoKeyError extends ScrapeCreatorsError {
  constructor(message: string) {
    super("(construction)", 0, message);
    this.name = "ScrapeCreatorsNoKeyError";
  }
}

/** 401. The key is wrong, revoked, or pasted with a stray character. */
export class ScrapeCreatorsCredentialError extends ScrapeCreatorsError {
  constructor(endpoint: string, detail: string) {
    super(
      endpoint,
      401,
      "ScrapeCreators rejected the API key (401 Unauthorized). The key saved for this provider is " +
        "wrong, was revoked, or was pasted with a stray character. Check it at " +
        `https://app.scrapecreators.com and paste it again. ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsCredentialError";
  }
}

/**
 * 402. The credit balance is empty.
 *
 * ITS OWN CLASS AND NOT A COUSIN OF 401, because these two look identical from
 * a distance and are fixed by completely different actions — one is "the key is
 * wrong", the other is "the key is right and the account is out of money". An
 * operator sent to the wrong one of those wastes an afternoon.
 */
export class ScrapeCreatorsCreditsExhaustedError extends ScrapeCreatorsError {
  constructor(endpoint: string, detail: string) {
    super(
      endpoint,
      402,
      "ScrapeCreators is out of credits (402 Payment Required). The key is valid; the balance is " +
        "empty. Credits are bought outright and do not expire — $47 buys 25,000 at the Freelance " +
        "rate and $497 buys 500,000 at the Business rate (scrapecreators.com, read 2026-09-04). " +
        `Nothing further was read on this run. ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsCreditsExhaustedError";
  }
}

/**
 * 403. Documented as "The public source blocks this resource".
 *
 * NOT A KEY PROBLEM AND THIS IS THE POINT OF SEPARATING IT. A 403 here is
 * Instagram or Facebook blocking the vendor's fetch of one particular profile —
 * a private account, a geo-block, an age gate. The key is fine, the endpoint is
 * fine, and this specific seed is closed. Reported as a 401 it would send an
 * operator to rotate a perfectly good key.
 */
export class ScrapeCreatorsSourceBlockedError extends ScrapeCreatorsError {
  constructor(endpoint: string, readonly describedTarget: string, detail: string) {
    super(
      endpoint,
      403,
      `The public source blocked ScrapeCreators from reading ${describedTarget} (403 Forbidden). ` +
        "That is the platform refusing this particular profile or page — private, age-gated, or " +
        "geo-restricted — and NOT a problem with the API key or with the endpoint. Other seeds " +
        `on the same key will still work. ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsSourceBlockedError";
  }
}

/** 404. The seed itself is wrong: a handle that does not exist, a deleted page. */
export class ScrapeCreatorsNotFoundError extends ScrapeCreatorsError {
  constructor(endpoint: string, readonly describedTarget: string, detail: string) {
    super(
      endpoint,
      404,
      `ScrapeCreators could not find ${describedTarget} (404 Not Found). The seed is wrong or the ` +
        "account has been deleted or renamed. Fix the seed rather than the key — nothing else on " +
        `this run is affected. ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsNotFoundError";
  }
}

/** 400. Our request is malformed — a parameter name or value this code sent. */
export class ScrapeCreatorsRequestError extends ScrapeCreatorsError {
  constructor(endpoint: string, detail: string) {
    super(
      endpoint,
      400,
      `ScrapeCreators rejected the request to ${endpoint} as malformed (400 Bad Request). That is ` +
        "this tool's parameters, not your key and not your seed: either a required parameter was " +
        "missing or one of them has been renamed upstream. Compare against " +
        `https://docs.scrapecreators.com${endpoint} before changing anything else. ` +
        `ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsRequestError";
  }
}

/**
 * 429, which the documentation says should not happen.
 *
 * https://docs.scrapecreators.com/introduction, read 2026-09-04, verbatim:
 * "Scrape Creators does not enforce API rate limits. For now, we recommend
 * keeping usage below 500 concurrent requests." So a 429 is either that
 * recommendation becoming a rule, or something in front of the API throttling
 * us. Either way it is not a thing an operator fixes by buying credits, and it
 * is worth waiting out rather than retrying immediately — so it says that, and
 * it is never retried in-process.
 */
export class ScrapeCreatorsRateLimitError extends ScrapeCreatorsError {
  constructor(endpoint: string, readonly retryAfterSeconds: number | null, detail: string) {
    super(
      endpoint,
      429,
      `ScrapeCreators rate-limited this run (429) on ${endpoint}` +
        (retryAfterSeconds === null ? "" : `, asking us to wait ${retryAfterSeconds}s`) +
        ". Their documentation says they do not enforce rate limits and only recommend staying " +
        "under 500 concurrent requests, so this is either that recommendation becoming a rule or " +
        "something in front of their API throttling us. It was NOT retried here: sleeping inside " +
        "a run turns a slow page into a hung one. Run again in a few minutes. " +
        `ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsRateLimitError";
  }
}

/** 5xx, after the retries are spent. Theirs, transient, and worth trying again. */
export class ScrapeCreatorsUpstreamError extends ScrapeCreatorsError {
  constructor(endpoint: string, status: number, attempts: number, detail: string) {
    super(
      endpoint,
      status,
      `ScrapeCreators returned ${status} on ${endpoint} ${attempts} time${attempts === 1 ? "" : "s"} ` +
        "in a row. That is their server, not the key, not the seed and not this tool — their own " +
        'status table calls 500 "Please try again later". Nothing was read. Try the run again; if ' +
        "it persists, check https://status.scrapecreators.com before changing anything here. " +
        `ScrapeCreators said: ${detail}`,
    );
    this.name = "ScrapeCreatorsUpstreamError";
  }
}

/**
 * ===========================================================================
 * A 200 WHOSE BODY THIS PARSER NO LONGER RECOGNISES. THE INSTAGRAM CASE.
 * ===========================================================================
 *
 * This is the most important error class in the file and it is the one the
 * vendor's own status page predicts. Their most recent Instagram incident,
 * 25-26 August 2026, was a reels endpoint MIGRATING TO A NEW DATA SOURCE. A
 * migration does not usually produce a 500. It produces a perfectly healthy 200
 * whose body is shaped differently, and a parser that reaches for `items` and
 * finds nothing quietly returns [] — which the whole product then renders as
 * "Instagram had no shorts over 500,000 views today".
 *
 * That sentence is the exact failure lib/platform/adapter.ts's honesty rule was
 * written to prevent, and it is why an ABSENT results key and an EMPTY results
 * array are handled by two different code paths here. Present-and-empty is an
 * answer. Absent is a broken endpoint. So is a body that carried N items of
 * which this parser could make sense of none — that is a migration that kept
 * the envelope and changed the contents.
 *
 * The message names the endpoint, what was expected, and what actually arrived,
 * because the fix is to read the docs page and change a field name, and
 * whoever does that needs to know which one.
 */
export class ScrapeCreatorsShapeError extends ScrapeCreatorsError {
  constructor(
    endpoint: string,
    readonly platform: Platform,
    message: string,
  ) {
    super(endpoint, 200, message);
    this.name = "ScrapeCreatorsShapeError";
  }

  /** The results array is missing entirely. Never "no results". */
  static missingResults(
    endpoint: string,
    platform: Platform,
    expectedKey: string,
    body: unknown,
  ): ScrapeCreatorsShapeError {
    return new ScrapeCreatorsShapeError(
      endpoint,
      platform,
      `ScrapeCreators returned 200 from ${endpoint} but the body has no \`${expectedKey}\` array, ` +
        `so this endpoint's shape has changed. The keys it did send were: ${describeKeys(body)}. ` +
        "THIS IS NOT 'no results' — an empty `" +
        expectedKey +
        "` would be, and would have been reported as such. ScrapeCreators' status page shows " +
        "Instagram endpoints migrating to new data sources periodically (most recently 25-26 " +
        `August 2026). Re-read https://docs.scrapecreators.com${endpoint} and correct the field ` +
        "names in lib/platform/scrapecreators.ts. Nothing is being reported for this platform " +
        "until that is done, deliberately.",
    );
  }

  /** Items arrived and not one of them parsed. The envelope survived; the contents did not. */
  static nothingParsed(
    endpoint: string,
    platform: Platform,
    items: number,
    required: string,
  ): ScrapeCreatorsShapeError {
    return new ScrapeCreatorsShapeError(
      endpoint,
      platform,
      `ScrapeCreators returned ${items} item${items === 1 ? "" : "s"} from ${endpoint} and this ` +
        `parser could read ${required} from none of them. The envelope is intact and the ` +
        "contents have changed shape, which is what an upstream data-source migration looks " +
        `like. Re-read https://docs.scrapecreators.com${endpoint} and correct the field names. ` +
        "These rows are being refused rather than returned half-empty, because a row with no id " +
        "and no URL is not a short, it is a shape mismatch wearing one.",
    );
  }

  /** `success: false` on a 200. Their own envelope saying the call did not work. */
  static notSuccessful(endpoint: string, platform: Platform, body: unknown): ScrapeCreatorsShapeError {
    return new ScrapeCreatorsShapeError(
      endpoint,
      platform,
      `ScrapeCreators returned HTTP 200 from ${endpoint} with \`success: false\` in the body, ` +
        "which is the API saying the call did not work while the transport says it did. Treated " +
        `as a failure, never as an empty result. The body's keys were: ${describeKeys(body)}.`,
    );
  }
}

/**
 * The per-run request ceiling was reached BEFORE this request went out.
 *
 * Its own class, and thrown rather than returned, when it happens before the
 * first request of a source: a run that spent nothing and read nothing must not
 * look like a run that read nothing because there was nothing there. When the
 * cap is reached PART WAY through a source's pagination, the rows already paid
 * for are returned and the stop is reported as a `Truncation` instead — see
 * `ScrapeCreatorsProvider.latestShorts`.
 */
export class ScrapeCreatorsRequestCapError extends ScrapeCreatorsError {
  constructor(
    readonly used: number,
    readonly cap: number,
    endpoint: string,
  ) {
    super(
      endpoint,
      0,
      `This run's ScrapeCreators request budget is spent: ${used} of ${cap} requests used, and ` +
        `${endpoint} needs one more. Nothing was sent, so nothing was charged for it. ` +
        "ScrapeCreators bills PER REQUEST at 1 credit, not per row (scrapecreators.com, read " +
        "2026-09-04: \"1 credit === 1 request\"), so this ceiling is counted in requests and " +
        "raising it costs credits in direct proportion. Raise `maxRequests`, or seed fewer " +
        "sources per run.",
    );
    this.name = "ScrapeCreatorsRequestCapError";
  }
}

/** A source this client cannot build a request for, caught before spending anything. */
export class ScrapeCreatorsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeCreatorsSourceError";
  }
}

/**
 * WHICH OF THESE A PERSON ACTUALLY SEES ON /admin/shorts.
 *
 * The standing rule (see `SAFE_TO_SHOW` in lib/shorts/run.ts) is that a thrown
 * message goes to the log, because an exception from a metered API routinely
 * quotes the URL it was called with. THAT RULE IS SAFE TO RELAX HERE AND IT IS
 * WORTH SAYING WHY: this vendor takes its key in a header, so no URL this file
 * builds has ever contained the secret, and every message below is composed in
 * this file from a status code, an endpoint path, a seed the operator typed
 * themselves, and figures out of a published price table. Every one of them
 * also goes through `scrub` with the key as an argument on the way out, which
 * is the same belt-and-braces the Meta client uses.
 *
 * `ScrapeCreatorsError` itself is deliberately NOT marked: it is the catch-all
 * for statuses this file does not recognise, so its message carries whatever an
 * unknown future response said — an unbounded string from somebody else's
 * system, which is exactly the shape the log rule exists for.
 */
markSafeToShow(ScrapeCreatorsNoKeyError);
markSafeToShow(ScrapeCreatorsCredentialError);
markSafeToShow(ScrapeCreatorsCreditsExhaustedError);
markSafeToShow(ScrapeCreatorsSourceBlockedError);
markSafeToShow(ScrapeCreatorsNotFoundError);
markSafeToShow(ScrapeCreatorsRequestError);
markSafeToShow(ScrapeCreatorsRateLimitError);
markSafeToShow(ScrapeCreatorsUpstreamError);
markSafeToShow(ScrapeCreatorsShapeError);
markSafeToShow(ScrapeCreatorsRequestCapError);
markSafeToShow(ScrapeCreatorsSourceError);

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/**
 * Where the key comes from.
 *
 * Same shape as `MetaTokenSource` in lib/platform/meta-client.ts and for the
 * same reason: the real source is `CredentialStore.lease(...)`, which is async
 * and must be called at the moment of use — a key cached in a constructor is a
 * key that outlives its rotation. A plain string is allowed so a test or a
 * one-off script does not have to write a closure.
 */
export type ScrapeCreatorsKeySource = string | (() => string | null | Promise<string | null>);

/** Resolve a key source to a key, or null when there is none. */
export async function resolveScrapeCreatorsKey(
  source: ScrapeCreatorsKeySource | null | undefined,
): Promise<string | null> {
  if (source == null) return null;
  const raw = typeof source === "function" ? await source() : source;
  const key = raw?.trim();
  return key ? key : null;
}

// ---------------------------------------------------------------------------
// What one run may spend
// ---------------------------------------------------------------------------

/**
 * The per-run request ceiling, SHARED ACROSS ALL THREE PLATFORMS.
 *
 * ONE OBJECT AND NOT ONE PER ADAPTER, and this is a correction of a mistake
 * already recorded elsewhere in this repo: lib/platform/meta-client.ts's header
 * notes that each Meta adapter builds its own budget if none is handed in, "so
 * an Instagram run and a Facebook run can together issue 400 calls in an hour
 * against one app's allowance", and names the fix as the registry constructing
 * one and passing it to both. There is one ScrapeCreators credit balance and
 * three legs drawing on it, so the same mistake was available here and is not
 * being made: `ScrapeCreatorsClient` holds the counter and the three
 * `ScrapeCreatorsProvider`s share it.
 *
 * 40 is a starting figure and not a measurement. At 1 credit a request and
 * $1.88 per 1,000 credits, 40 requests is about 7.5 US cents a run — visible
 * enough that a runaway loop shows up on the balance the same day, small enough
 * that a normal run of a handful of seeds never touches it.
 */
export const DEFAULT_MAX_REQUESTS = 40;

/** Attempts for 5xx only. 429 and every 4xx are never retried. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** How many pages one source will walk before stopping, whatever the row count. */
export const DEFAULT_MAX_PAGES_PER_SOURCE = 5;

export interface ScrapeCreatorsClientOptions {
  /** The key. Sent in the `x-api-key` header, never in a URL. */
  readonly apiKey: ScrapeCreatorsKeySource;
  /** Injected in tests so nothing reaches the network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  /** Requests this client may issue, total, across every platform. */
  readonly maxRequests?: number;
  /** Attempts for 5xx. Default 3. */
  readonly maxAttempts?: number;
  /** Pages one source may walk. Default 5. */
  readonly maxPagesPerSource?: number;
  /** Micro-dollars per credit. Default is the Freelance rate; see the price table. */
  readonly creditPriceMicros?: UsdMicros;
  /** A label for the rate, printed in the spend note so nobody has to infer the tier. */
  readonly creditPriceLabel?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * READ THE ACCOUNT BALANCE. ONE REQUEST, ONE CREDIT, NO RUN INVOLVED.
 *
 * WHY THIS FUNCTION EXISTS AT ALL, rather than the caller building a client.
 * lib/platform/registry.test.ts asserts that NO module outside lib/platform
 * constructs a `ScrapeCreatorsClient`, because during a run a second client is a
 * second request meter drawing on one credit balance — the same mistake
 * lib/platform/meta-client.ts records having already been made once with the
 * Meta budget. The credentials action that wants a balance is exactly such an
 * outside module, so construction stays in here and the action calls this.
 *
 * A BALANCE READ IS NOT PART OF A RUN, which is why a fresh client is correct
 * here rather than a hazard: it is one deliberate request, made from a settings
 * page, with a ceiling of one so a 5xx retry storm cannot turn a balance check
 * into a bill. It shares no counter with a run because it is not one.
 *
 * IT COSTS A CREDIT AND EVERY CALLER MUST SAY SO. Their documentation prices
 * `/v1/account/credit-balance` at 1 credit per request, the same as a scraping
 * call. Nothing in this repo may call it on a timer; see the endpoint's own
 * note in `ENDPOINTS`.
 */
export async function readScrapeCreatorsCreditBalance(
  apiKey: ScrapeCreatorsKeySource,
  options: { readonly fetch?: typeof globalThis.fetch; readonly baseUrl?: string } = {},
): Promise<number> {
  const client = new ScrapeCreatorsClient({
    apiKey,
    // ONE. A balance check that retried its way through a 5xx would spend a
    // credit per attempt to answer a question about credits.
    maxRequests: 1,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
  });
  return client.creditBalance();
}

/** What this client has been billed for, as counts. Money is derived from it. */
export interface ScrapeCreatorsUsage {
  /** Requests actually sent, including ones that came back 4xx or 5xx. */
  readonly requests: number;
  /** Credits the VENDOR said it charged, summed from `credits_charged`. */
  readonly creditsCharged: number;
  /**
   * Credits we ASSUMED at 1 per request because the response did not carry
   * `credits_charged`. Counted apart from the vendor's own figure on purpose:
   * "1 credit === 1 request (for most endpoints). A few use more." An assumed
   * credit is our arithmetic, not their invoice, and the note says so.
   */
  readonly creditsAssumed: number;
  /** The last `credits_remaining` any response carried, or null if none did. */
  readonly creditsRemaining: number | null;
}

const NO_USAGE: ScrapeCreatorsUsage = {
  requests: 0,
  creditsCharged: 0,
  creditsAssumed: 0,
  creditsRemaining: null,
};

// ---------------------------------------------------------------------------
// Sources — what to ask each platform for
// ---------------------------------------------------------------------------

/**
 * TikTok discovery. THE ONLY PLATFORM HERE THAT CAN GENUINELY BE BROWSED.
 *
 * `trending` is the one that makes this vendor worth paying for: a real
 * regional trending feed, one request, one credit, no seeds. Nothing keyless
 * can do it — lib/platform/tiktok.ts records that yt-dlp's tag, sound and
 * effect extractors are all marked broken upstream and there is no trending
 * extractor at all.
 */
export type TikTokTrendingSource = {
  readonly kind: "trending";
  /** `region`, documented as required. Their example is "US". */
  readonly region: string;
};

export type TikTokKeywordSource = {
  readonly kind: "keyword";
  readonly keyword: string;
  readonly region?: string;
};

/**
 * Hashtag search, WITH THE PARAMETER NAME SUPPLIED BY THE OPERATOR.
 *
 * https://docs.scrapecreators.com/v1/tiktok/search/hashtag documents the path,
 * the credit cost and the response shape, and its curl sample carries no query
 * string at all — the page does not show what the hashtag parameter is called.
 * So this file does not guess. A guessed parameter name comes back as a 400 if
 * we are lucky and as a successful call for the wrong thing if we are not, and
 * both of those arrive at a first paid run looking exactly like a bad key.
 *
 * `paramName` is therefore required, and `unavailableReason`-style refusal is
 * handled by `assertUsableSource` before a single credit is spent.
 */
export type TikTokHashtagSource = {
  readonly kind: "hashtag";
  readonly hashtag: string;
  /**
   * The query parameter that carries the hashtag. NOT DOCUMENTED — read it off
   * the "Try it" panel at https://docs.scrapecreators.com/v1/tiktok/search/hashtag
   * and set it here.
   */
  readonly paramName: string;
  readonly region?: string;
};

/**
 * A TIKTOK SOURCE IS NOT A TIKTOK SEED, and the two cannot be derived from each
 * other.
 *
 * A TikTok seed is a sec_uid — `MS4wLjABAAAA` plus 64 characters, TikTok's
 * internal key for one creator and the only input yt-dlp's `tiktok:user`
 * extractor accepts (lib/platform/tiktok.ts records why). Every source above is
 * a region or a phrase. There is no function from one to the other, so nothing
 * in this repo may build one out of the other: the operator says what to ask
 * for, and lib/platform/registry.ts refuses in a sentence naming the two
 * environment variables when they have not. A default region here would be this
 * file deciding what somebody is looking for and charging them a credit for it.
 */
export type TikTokSource = TikTokTrendingSource | TikTokKeywordSource | TikTokHashtagSource;

/**
 * Instagram. SEEDED CREATORS FIRST, KEYWORD AS A SECONDARY SWEEP, and the
 * difference between them is not a preference — it is what each one returns.
 *
 * `creator` hits /v1/instagram/user/reels, which carries `play_count` and
 * `video_duration` and can therefore answer the product's question outright.
 * `keyword` hits /v2/instagram/reels/search, whose documented response has
 * `video_duration` and `like_count` and NO VIEW COUNT AT ALL. Rows from it
 * arrive with `view_count: null` and land in `report.unverified`. That is not a
 * defect in this code; it is what the endpoint publishes, and it is why keyword
 * is the sweep and creators are the spine.
 */
export type InstagramCreatorSource = {
  readonly kind: "creator";
  /** `handle`. Prefer `userId` alongside it — the docs say it is faster. */
  readonly handle?: string;
  /** `user_id`. Either this or `handle` must be present. */
  readonly userId?: string;
};

export type InstagramKeywordSource = {
  readonly kind: "keyword";
  /** `query`, documented as required. */
  readonly query: string;
  /** `date_posted`. The three documented windows, and nothing else. */
  readonly datePosted?: "last-week" | "last-month" | "last-year";
};

export type InstagramSource = InstagramCreatorSource | InstagramKeywordSource;

/**
 * Facebook. PAGE-SEEDED ONLY, because nobody sells Facebook Reels discovery —
 * this vendor included. There is no trending, keyword or hashtag endpoint for
 * Facebook video in their catalogue. You name the pages.
 */
export type FacebookSource = {
  readonly kind: "page";
  /** `url`, documented as required: a public Facebook page URL. */
  readonly url: string;
};

export type PlatformSource = TikTokSource | InstagramSource | FacebookSource;

// ---------------------------------------------------------------------------
// The HTTP core
// ---------------------------------------------------------------------------

/** One response, plus what it told us about money. */
interface Page {
  readonly body: Record<string, unknown>;
  readonly endpoint: string;
}

/**
 * THE ONE OBJECT THAT SPEAKS HTTP TO SCRAPECREATORS, HOLDS THE KEY, COUNTS THE
 * CREDITS AND CARRIES THE MONEY CONTRACT.
 *
 * The brand lives here rather than on an adapter for the same reason it lives
 * on `XClient` and not on `XAdapter`: this is the object that watches billable
 * requests go out and holds the price table. An adapter's job is to map a
 * vendor's vocabulary onto a `ShortRecord`; it has no business knowing what a
 * credit costs, and a second copy of that figure is a second thing that can
 * disagree with an invoice.
 *
 * See `METERS_ITS_OWN_SPEND` in lib/shorts/run.ts for the scar that made the
 * brand a symbol rather than a duck-typed method name: the previous round
 * shipped `report.spend` as structurally always empty, so a run costing several
 * dollars and a run costing nothing rendered identically, and every test stayed
 * green because "the adapter has no such method" and "the adapter reported no
 * spend" were the same value.
 */
export class ScrapeCreatorsClient implements SpendAccountant {
  /** THE BRAND. Declared, not guessed at. See the scar above. */
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  private readonly keySource: ScrapeCreatorsKeySource;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly creditPriceMicros: UsdMicros;
  private readonly creditPriceLabel: string;

  readonly maxRequests: number;
  readonly maxPagesPerSource: number;
  readonly now: () => Date;

  private requests = 0;
  private creditsCharged = 0;
  private creditsAssumed = 0;
  private creditsRemaining: number | null = null;

  /**
   * Usage as it stood at the last `accountForLastRun()`.
   *
   * Kept so accounting reports a DELTA. The contract is "what the last
   * `latestShorts()` call cost", and a client living across two runs would
   * otherwise bill the first run's credits to the second one as well — every
   * figure right on its own and the sum twice the invoice.
   */
  private accounted: ScrapeCreatorsUsage = NO_USAGE;

  /** Set when a source stopped early. Cleared by `accountForLastRun`. */
  private truncation: Truncation | null = null;

  /**
   * Media URLs seen on pages we already paid for, keyed `platform:id`.
   *
   * IN-PROCESS ONLY AND DELIBERATELY NOT PERSISTED. These URLs are signed and
   * expire in minutes to hours, and lib/platform/adapter.ts's `downloadUrl`
   * comment is explicit that storing one produces a table of dead links that
   * look alive. Keeping them for the life of the process means a download
   * clicked shortly after a run costs nothing extra; in a serverless
   * deployment, where the click lands in a different process, this WILL miss
   * and `downloadUrl` returns null, which the UI must render as "no file
   * available" rather than as a broken button. That is a real limitation and it
   * is stated here rather than discovered.
   */
  private readonly mediaUrls = new Map<string, string>();

  constructor(options: ScrapeCreatorsClientOptions) {
    if (typeof options.apiKey === "string" && !options.apiKey.trim()) {
      throw new ScrapeCreatorsNoKeyError(
        "ScrapeCreatorsClient was constructed with an empty API key. Nothing was sent. Paste the " +
          "key from https://app.scrapecreators.com on /admin/credentials; it is presented in the " +
          "`x-api-key` header on every request.",
      );
    }
    this.keySource = options.apiKey;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? SCRAPECREATORS_BASE;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxPagesPerSource = options.maxPagesPerSource ?? DEFAULT_MAX_PAGES_PER_SOURCE;
    this.creditPriceMicros = options.creditPriceMicros ?? MICROS_PER_CREDIT_FREELANCE;
    this.creditPriceLabel =
      options.creditPriceLabel ?? "the $47 / 25,000-credit Freelance rate, $1.88 per 1,000";
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
  }

  get usage(): ScrapeCreatorsUsage {
    return {
      requests: this.requests,
      creditsCharged: this.creditsCharged,
      creditsAssumed: this.creditsAssumed,
      creditsRemaining: this.creditsRemaining,
    };
  }

  /** Requests still available to this run. */
  get requestsRemaining(): number {
    return Math.max(0, this.maxRequests - this.requests);
  }

  /** Note that a source stopped short. The next account carries it. */
  reportTruncation(truncation: Truncation): void {
    // FIRST ONE WINS. The first stop is the one that changed the outcome; a
    // later source hitting the same spent budget is a consequence of it, not a
    // separate fact, and overwriting would report the least informative cause.
    this.truncation ??= truncation;
  }

  // ------------------------------------------------------- the money contract

  /**
   * What this client has billed since the last time it was asked.
   *
   * NULL ONLY WHEN NOTHING WAS SENT AT ALL — a run where the platform was
   * unavailable and no request left the process. It is deliberately NOT null
   * for a run that sent requests and was charged nothing, because "we asked and
   * it cost nothing" and "nobody asked" are different facts and this is the
   * seam that carries the difference to the screen. That distinction is the
   * entire content of the metering scar in lib/shorts/run.ts.
   */
  accountForLastRun(): RunAccount | null {
    const now = this.usage;
    const delta = {
      requests: now.requests - this.accounted.requests,
      creditsCharged: now.creditsCharged - this.accounted.creditsCharged,
      creditsAssumed: now.creditsAssumed - this.accounted.creditsAssumed,
    };
    const truncation = this.truncation;
    this.accounted = now;
    this.truncation = null;

    if (delta.requests === 0) return null;

    const credits = delta.creditsCharged + delta.creditsAssumed;
    return {
      spend: {
        usdMicros: credits * this.creditPriceMicros,
        note: this.noteFor(delta.requests, delta.creditsCharged, delta.creditsAssumed),
      },
      truncation,
    };
  }

  /**
   * The sentence beside the figure, written for a person.
   *
   * It says four things, and each is here because leaving it out lets the
   * number be read as something it is not: that billing is per REQUEST so the
   * row count is not the price; how many credits the vendor itself reported
   * against how many we had to assume; which price tier the dollars were
   * computed at; and what the balance was last seen at.
   */
  private noteFor(requests: number, charged: number, assumed: number): string {
    const parts = [
      `${requests.toLocaleString("en-US")} request${requests === 1 ? "" : "s"} to ScrapeCreators, ` +
        "billed per REQUEST and not per row.",
    ];
    if (charged > 0) {
      parts.push(
        `${charged.toLocaleString("en-US")} credit${charged === 1 ? "" : "s"} charged, as reported ` +
          "by the API in `credits_charged`.",
      );
    }
    if (assumed > 0) {
      parts.push(
        `${assumed.toLocaleString("en-US")} further credit${assumed === 1 ? "" : "s"} ASSUMED at ` +
          `${ASSUMED_CREDITS_PER_REQUEST} per request, because ${assumed === 1 ? "that response" : "those responses"} ` +
          'carried no `credits_charged`. Their pricing page says "1 credit === 1 request (for ' +
          'most endpoints). A few use more", so an assumed credit is our arithmetic and not ' +
          "their invoice.",
      );
    }
    parts.push(`Priced at ${this.creditPriceLabel}.`);
    parts.push(
      this.creditsRemaining === null
        ? "The API reported no credit balance, so how many are left is unknown from here."
        : `${this.creditsRemaining.toLocaleString("en-US")} credits remaining, per the last response.`,
    );
    return parts.join(" ");
  }

  // ------------------------------------------------------------- media cache

  /** Remember a media URL from a page already paid for. See `mediaUrls`. */
  rememberMediaUrl(platform: Platform, id: string, url: string | null): void {
    if (url) this.mediaUrls.set(`${platform}:${id}`, url);
  }

  /** A remembered media URL, or null. Null is a legitimate answer — see the seam. */
  recallMediaUrl(platform: Platform, id: string): string | null {
    return this.mediaUrls.get(`${platform}:${id}`) ?? null;
  }

  // --------------------------------------------------------------- the request

  /**
   * One GET, with the budget checked BEFORE the request goes out.
   *
   * The cheque is refused, not bounced: a cap enforced after the call has
   * already been billed is not a cap. `describedTarget` is the seed in the
   * operator's own words, so a 403 or 404 can name the thing that failed
   * without this function knowing what kind of thing it is.
   */
  async get(
    endpoint: EndpointPath,
    params: Record<string, string | undefined>,
    describedTarget: string,
  ): Promise<Page> {
    if (this.requestsRemaining <= 0) {
      throw new ScrapeCreatorsRequestCapError(this.requests, this.maxRequests, endpoint);
    }

    const key = await resolveScrapeCreatorsKey(this.keySource);
    if (!key) {
      throw new ScrapeCreatorsNoKeyError(
        "No ScrapeCreators API key is configured, so nothing was sent and nothing was charged. " +
          "TikTok, Instagram and Facebook all read through this one key. Add it on " +
          "/admin/credentials; credits are bought outright at scrapecreators.com and do not expire.",
      );
    }

    const url = new URL(endpoint, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    let lastStatus = 0;
    let lastDetail = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.requests += 1;
      const response = await this.doFetch(url.toString(), {
        headers: {
          [API_KEY_HEADER]: key,
          accept: "application/json",
          "user-agent": "shorts-scraper/0.1",
        },
      });

      const body = await readJson(response);
      const detail = scrub(detailOf(body, response.status), key);

      if (response.ok) {
        const record = (body ?? {}) as Record<string, unknown>;
        this.recordCredits(record);
        return { body: record, endpoint };
      }

      switch (response.status) {
        case 400:
          throw new ScrapeCreatorsRequestError(endpoint, detail);
        case 401:
          throw new ScrapeCreatorsCredentialError(endpoint, detail);
        case 402:
          throw new ScrapeCreatorsCreditsExhaustedError(endpoint, detail);
        case 403:
          throw new ScrapeCreatorsSourceBlockedError(endpoint, describedTarget, detail);
        case 404:
          throw new ScrapeCreatorsNotFoundError(endpoint, describedTarget, detail);
        case 429:
          throw new ScrapeCreatorsRateLimitError(endpoint, retryAfterOf(response), detail);
        default:
          break;
      }

      if (response.status < 500) {
        throw new ScrapeCreatorsError(
          endpoint,
          response.status,
          `ScrapeCreators returned ${response.status} from ${endpoint}, which is not a status their ` +
            `documentation describes. Nothing was parsed. Response: ${detail}`,
        );
      }

      // 5xx: theirs, and their own table says "Please try again later".
      lastStatus = response.status;
      lastDetail = detail;
      if (attempt < this.maxAttempts) {
        if (this.requestsRemaining <= 0) break;
        await this.sleep(250 * attempt);
      }
    }

    throw new ScrapeCreatorsUpstreamError(endpoint, lastStatus, this.maxAttempts, lastDetail);
  }

  /**
   * ASK THE VENDOR WHAT THE BALANCE IS. Costs one credit, every time.
   *
   * WHY THIS IS A METHOD AND NOT A POLLER. Every ordinary response already
   * carries `credits_remaining`, and `recordCredits` below banks it for free —
   * so after any run the balance is known at no extra cost, and that is the
   * number the page shows by default. This exists for the other case: an
   * operator who has just bought credits, or who has not run anything today,
   * and wants a fresh reading. One press, one credit, and the button says so.
   *
   * IT GOES THROUGH `get` LIKE EVERYTHING ELSE, which is what makes it obey the
   * request cap, the retry policy, the 402/401 mapping and the key scrubbing.
   * A bespoke fetch here would be a second, quieter path to the same vendor
   * with none of that — and the one that bills a card.
   */
  async creditBalance(): Promise<number> {
    const page = await this.get(ENDPOINTS.accountCreditBalance, {}, "the account credit balance");
    // `credits_remaining` first, `creditCount` second — the vendor's drift, seen
    // live on 2026-09-09: the endpoint dropped `credits_remaining` and returned
    // `creditCount` as the balance, confirmed by its own `message`. When both
    // are present the documented field wins, so the old example (creditCount 333
    // beside a balance of 1,000,000) still reads as 1,000,000. See the header.
    const remaining = finiteNumber(page.body.credits_remaining) ?? finiteNumber(page.body.creditCount);
    if (remaining === null) {
      // The call succeeded and NEITHER credit field an operator could act on is
      // in it. Returning 0 here would read as "you are out of credits", which is
      // a different and much more alarming claim than "they did not say".
      //
      // THE PRESS IS ALREADY PAID FOR, SO IT HAD BETTER SAY WHAT CAME BACK.
      // The shape of the reply travels with the complaint so one press buys the
      // diagnosis and not the shrug: `describeShape` prints field NAMES and
      // finite numbers only, never string values, which is why this needs no
      // `scrub` — a vendor that echoed the request back could otherwise walk the
      // key into an error message an admin page renders.
      throw new ScrapeCreatorsError(
        ENDPOINTS.accountCreditBalance,
        200,
        "ScrapeCreators accepted the request but returned neither `credits_remaining` nor a " +
          `usable \`creditCount\`, so the balance is unknown from here — and the credit for the ` +
          `call was still spent. ${describeShape(page.body)}`,
      );
    }
    return remaining;
  }

  /**
   * Bank what the response said about credits.
   *
   * `credits_charged` is preferred wherever it is a number, including ZERO —
   * a response that says it charged nothing is an observation, and substituting
   * our assumed 1 for it would inflate the invoice with arithmetic. Only an
   * absent or unusable figure falls back, and that fallback is counted in its
   * own column so the note can distinguish the two.
   */
  private recordCredits(body: Record<string, unknown>): void {
    const charged = finiteNumber(body.credits_charged);
    if (charged === null) this.creditsAssumed += ASSUMED_CREDITS_PER_REQUEST;
    else this.creditsCharged += charged;

    // `creditCount` is the same balance under the name the live endpoint now
    // uses (2026-09-09); read only when `credits_remaining` is absent, so a
    // response carrying both is banked from the documented field.
    const remaining = finiteNumber(body.credits_remaining) ?? finiteNumber(body.creditCount);
    if (remaining !== null) this.creditsRemaining = remaining;
  }
}

// ---------------------------------------------------------------------------
// The provider — one per platform, all sharing one client
// ---------------------------------------------------------------------------

export interface ScrapeCreatorsProviderOptions {
  readonly client: ScrapeCreatorsClient;
  readonly platform: Platform;
  /** What to ask for. Empty is a configuration error, not an empty result. */
  readonly sources: readonly PlatformSource[];
}

/**
 * `ProviderClient` for one platform, backed by the shared client.
 *
 * This is the object lib/platform/registry.ts hands to `InstagramAdapter`,
 * `FacebookAdapter` and (once it grows a slot for one) the TikTok adapter. It
 * implements exactly the two methods lib/platform/unavailable.ts declares and
 * nothing else, because every method added to that seam before it is needed is
 * a guess about somebody else's product.
 */
export class ScrapeCreatorsProvider implements KeywordSearchingProvider {
  readonly platform: Platform;
  private readonly client: ScrapeCreatorsClient;
  private readonly sources: readonly PlatformSource[];

  constructor(options: ScrapeCreatorsProviderOptions) {
    this.platform = options.platform;
    this.client = options.client;
    this.sources = options.sources;
    for (const source of this.sources) assertUsableSource(this.platform, source);
  }

  /**
   * Every seeded source, read, mapped and concatenated. NEVER [] TO MEAN BROKEN.
   *
   * `query.minViews` and `query.maxDurationSeconds` are deliberately NOT applied
   * here even though lib/platform/adapter.ts passes them in so a source that can
   * filter, does. NONE OF THESE ENDPOINTS FILTERS SERVER-SIDE — there is no
   * min-views parameter on any of them — so filtering locally would save no
   * money at all, and it would cost something: lib/shorts/run.ts computes
   * `returned` from what an adapter hands back and files every rejection under a
   * drop reason. Pre-filtering here would hide from the operator that they PAID
   * for those rows. On a metered API the drop tally is the receipt.
   *
   * `query.limit` IS applied, because it is a ceiling on how many pages get
   * bought, and that is real money.
   */
  async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    if (this.sources.length === 0) {
      throw new ScrapeCreatorsSourceError(
        `No ScrapeCreators sources are configured for ${this.platform}, so this run read nothing ` +
          "and this is NOT a report that the platform had no shorts. Configure at least one " +
          "source — a TikTok region or keyword, an Instagram handle, a Facebook page URL — before " +
          "the adapter is built.",
      );
    }
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new ScrapeCreatorsSourceError(
        `limit must be a positive integer, got ${String(query.limit)}. Nothing was sent.`,
      );
    }

    const discoveredAt = this.client.now().toISOString();
    const out: ShortRecord[] = [];

    for (const source of this.sources) {
      if (out.length >= query.limit) break;
      try {
        out.push(...(await this.readSource(source, query.limit - out.length, discoveredAt)));
      } catch (cause) {
        /*
         * THE BUDGET IS PER RUN, BUT THE GUARD INSIDE `readSource` IS PER
         * SOURCE — and that gap cost real money on 2026-09-05.
         *
         * `readSource` correctly keeps its rows and reports a truncation when
         * the cap is hit with rows already in hand. But when the cap is reached
         * at the START of a FRESH source, that source has nothing in hand, so
         * the throw stands and escapes to here. Before this catch it took the
         * whole platform down with it — discarding every row the EARLIER
         * sources had already been charged for.
         *
         * Measured: a 20-request run over 20 keywords spent all 20 credits,
         * collected rows from the first sources, hit the cap entering a later
         * one, threw, and persisted NOTHING. Twenty credits for zero rows.
         *
         * So a cap reached with rows already gathered is a run that WORKED and
         * STOPPED, exactly as `readSource` treats it. Rows are kept and the
         * stop is reported as a truncation, which lib/shorts/run.ts renders as
         * `partial` rather than as a complete answer.
         *
         * WITH NOTHING GATHERED THE THROW STILL STANDS. That is the honesty
         * rule and it is not being relaxed: a budget stop that returned []
         * would render as "this platform had nothing", which is the one thing
         * this repo refuses to say when it has not looked.
         */
        if (cause instanceof ScrapeCreatorsRequestCapError && out.length > 0) {
          this.client.reportTruncation({
            cause: "spend-cap",
            message:
              `Stopped before reading every configured source: the ceiling of ` +
              `${this.client.maxRequests} ScrapeCreators requests was reached. ` +
              `${out.length} row${out.length === 1 ? "" : "s"} had already been read and are kept — ` +
              "they were paid for. Raise `maxRequests` to read the rest.",
          });
          break;
        }
        throw cause;
      }
    }
    return out;
  }

  // ------------------------------------------------------------- by subject

  /**
   * This provider can be asked for words. See lib/platform/unavailable.ts.
   *
   * DECLARED FOR ALL THREE PLATFORMS AND HONOURED BY TWO. Facebook's refusal is
   * in `keywordSources` below, where it can name the reason; declaring the
   * capability per-platform here would make an operator's Facebook topic run
   * fail as "no capability" instead of as the sentence explaining that nobody
   * sells Facebook Reels search.
   */
  readonly [SEARCHES_KEYWORDS] = true as const;

  /**
   * The latest shorts these phrases return.
   *
   * ONE SOURCE PER PHRASE, built here and handed to the same `readSource` the
   * configured path uses, so the budget guard, the pagination cap, the
   * truncation reporting and the drop tally are all identical. A topic run and
   * a configured run cost money the same way and are metered by the same
   * receipt; the only difference is who chose the words.
   *
   * THE CONFIGURED SOURCES ARE NOT READ. A topic run asks for the topic and
   * nothing else — merging in the operator's standing keyword list would spend
   * their credits on a question they did not ask this time, and would file the
   * resulting rows under a subject they are not about.
   */
  async latestShortsForKeywords(
    keywords: readonly string[],
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]> {
    const sources = this.keywordSources(keywords);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new ScrapeCreatorsSourceError(
        `limit must be a positive integer, got ${String(query.limit)}. Nothing was sent.`,
      );
    }

    const discoveredAt = this.client.now().toISOString();
    const out: ShortRecord[] = [];

    for (const source of sources) {
      if (out.length >= query.limit) break;
      try {
        out.push(...(await this.readSource(source, query.limit - out.length, discoveredAt)));
      } catch (cause) {
        // Identical to `latestShorts`, and identical on purpose: a spend cap
        // reached with rows already paid for is a run that WORKED and STOPPED,
        // and discarding those rows is the bug that cost twenty credits on
        // 2026-09-05. See that method for the full scar.
        if (cause instanceof ScrapeCreatorsRequestCapError && out.length > 0) {
          this.client.reportTruncation({
            cause: "spend-cap",
            message:
              `Stopped before searching every phrase: the ceiling of ` +
              `${this.client.maxRequests} ScrapeCreators requests was reached. ` +
              `${out.length} row${out.length === 1 ? "" : "s"} had already been read and are kept — ` +
              "they were paid for. Raise `maxRequests` to search the rest.",
          });
          break;
        }
        throw cause;
      }
    }
    return out;
  }

  /**
   * One phrase -> one vendor source, per platform, or a refusal naming why not.
   *
   * The `region` on a TikTok keyword search is deliberately NOT invented: it is
   * taken from a configured trending or keyword source when the operator named
   * one and left unset otherwise, which is the vendor's own default. A default
   * region chosen here would be this file deciding which country a subject is
   * being searched in and charging a credit for the answer — the same rule
   * `VENDOR_SOURCES` in lib/platform/registry.ts already refuses to break.
   */
  private keywordSources(keywords: readonly string[]): PlatformSource[] {
    const phrases = keywords.map((k) => k.trim()).filter(Boolean);
    if (phrases.length === 0) {
      throw new ScrapeCreatorsSourceError(
        `No search phrases were given for ${this.platform}, so this run read nothing and this is ` +
          "NOT a report that the platform had no shorts about the subject.",
      );
    }

    if (this.platform === "tiktok") {
      const region = this.configuredRegion();
      return phrases.map((keyword) => ({ kind: "keyword", keyword, region }) satisfies TikTokSource);
    }

    if (this.platform === "instagram") {
      return phrases.map((query) => ({ kind: "keyword", query }) satisfies InstagramSource);
    }

    // Facebook, and any platform added later without a search endpoint. Named
    // rather than silently empty — see the honesty rule on `ProviderClient`.
    throw new ScrapeCreatorsSourceError(
      `Facebook cannot be searched for a subject. Meta's Graph API documents no public-content ` +
        "search and no read on a Page's video edges, and no data vendor sells Facebook Reels " +
        "discovery — this one included, whose Facebook catalogue is page-seeded only. Facebook can " +
        "return the Pages somebody names and nothing else, whatever those Pages are about.",
    );
  }

  /** The region the operator already named, if any. Never a default. */
  private configuredRegion(): string | undefined {
    for (const source of this.sources) {
      if (source.kind === "trending") return source.region;
      if (source.kind === "keyword" && "region" in source && source.region) return source.region;
    }
    return undefined;
  }

  /**
   * A media URL for a row, IF one was seen on a page this run already paid for.
   *
   * Null otherwise, which is the documented legitimate answer on this seam —
   * "this provider has no way to get you the file". It does NOT issue a second
   * request to find one. Two reasons, and the second is the binding one: a
   * per-video endpoint costs another credit for a button somebody may not
   * press, and the response shape of the single-item endpoints
   * (`/v2/tiktok/video`, `/v1/instagram/post`, `/v1/facebook/post`) has not
   * been read, so the field name would be a guess. This repo does not guess
   * field names; see the header.
   */
  async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== this.platform) {
      throw new ScrapeCreatorsSourceError(
        `A ${this.platform} provider was asked for a ${short.platform} download URL. Each provider ` +
          "resolves only its own platform's media; routing by platform is " +
          "lib/platform/registry.ts's job.",
      );
    }
    return this.client.recallMediaUrl(short.platform, short.platform_video_id);
  }

  // ------------------------------------------------------------------ private

  private async readSource(
    source: PlatformSource,
    remaining: number,
    discoveredAt: string,
  ): Promise<ShortRecord[]> {
    const plan = requestPlan(this.platform, source);
    const rows: ShortRecord[] = [];
    let cursor: string | undefined;
    let page = 0;

    while (rows.length < remaining && page < this.client.maxPagesPerSource) {
      /*
       * THE BUDGET, CHECKED HERE RATHER THAN ONLY INSIDE `get`, because the two
       * cases are genuinely different and only one of them is an error.
       *
       * Out of budget with rows already in hand is a run that WORKED and stopped
       * — the operator's own ceiling, hit deliberately. Those rows were paid for
       * and throwing them away would be paying twice for nothing. It is reported
       * as a `Truncation` with cause "spend-cap", which lib/shorts/run.ts renders
       * as `partial` rather than as a complete answer.
       *
       * Out of budget with NOTHING in hand is different: returning [] there
       * would be the honesty rule's exact failure — a budget stop rendering as
       * "this platform had nothing". So `get` throws, and the throw stands.
       */
      if (this.client.requestsRemaining <= 0 && rows.length > 0) {
        this.client.reportTruncation({
          cause: "spend-cap",
          message:
            `Stopped after ${this.client.maxRequests} ScrapeCreators requests, the ceiling set for ` +
            `this run. ${rows.length} row${rows.length === 1 ? "" : "s"} had already been read from ` +
            `${plan.describedTarget} and ${plan.endpoint} had more pages. ScrapeCreators bills per ` +
            "request, so every extra page is another credit — raise `maxRequests` if this is worth " +
            "paying for.",
        });
        break;
      }

      const { body } = await this.client.get(
        plan.endpoint,
        plan.params(cursor),
        plan.describedTarget,
      );
      page += 1;

      if (body.success === false) {
        throw ScrapeCreatorsShapeError.notSuccessful(plan.endpoint, this.platform, body);
      }

      const items = readArray(body, plan.resultsKey);
      if (items === null) {
        throw ScrapeCreatorsShapeError.missingResults(
          plan.endpoint,
          this.platform,
          plan.resultsKey,
          body,
        );
      }

      const mapped = plan.map(items, discoveredAt, this.client);
      if (items.length > 0 && mapped.length === 0) {
        throw ScrapeCreatorsShapeError.nothingParsed(
          plan.endpoint,
          this.platform,
          items.length,
          "an id and a URL",
        );
      }

      rows.push(...mapped.slice(0, remaining - rows.length));

      // A PRESENT-BUT-EMPTY PAGE IS AN ANSWER AND ENDS THE WALK. It is the one
      // case in this whole file where "nothing came back" is allowed to mean
      // nothing came back, and it is allowed only because the key was there and
      // the array was there.
      if (items.length === 0) break;

      const next = plan.nextCursor(body, page);
      if (!next) break;
      cursor = next;
    }

    return rows;
  }
}

// ---------------------------------------------------------------------------
// Source validation — refusals that cost nothing
// ---------------------------------------------------------------------------

/**
 * Refuse a source this client cannot build a correct request for, BEFORE
 * anything is charged for finding out.
 *
 * A rejected request is free; a request built from a guessed parameter name is
 * a credit spent on a 400, or worse a credit spent on the wrong answer. These
 * are the same class of check as `TikTokAdapter`'s sec_uid refusal in
 * lib/platform/tiktok.ts, for the same reason: fail at configuration time, in a
 * sentence naming the fix.
 */
export function assertUsableSource(platform: Platform, source: PlatformSource): void {
  const bad = (message: string): never => {
    throw new ScrapeCreatorsSourceError(message);
  };

  switch (source.kind) {
    case "trending":
      if (platform !== "tiktok") bad(`A "trending" source is TikTok-only, not ${platform}.`);
      if (!source.region.trim()) {
        bad(
          "A TikTok trending source needs a `region`. It is documented as required on " +
            `https://docs.scrapecreators.com${ENDPOINTS.tiktokTrending} and their example is "US". ` +
            "The region is the proxy location the feed is read from, so it decides whose trending " +
            "feed this is.",
        );
      }
      return;
    case "keyword":
      if (platform === "tiktok") {
        if (!(source as TikTokKeywordSource).keyword.trim()) {
          bad("A TikTok keyword source needs a non-empty `keyword`.");
        }
        return;
      }
      if (platform === "instagram") {
        if (!(source as InstagramKeywordSource).query.trim()) {
          bad("An Instagram keyword source needs a non-empty `query`.");
        }
        return;
      }
      return bad(`A "keyword" source is TikTok or Instagram, not ${platform}.`);
    case "hashtag":
      if (platform !== "tiktok") bad(`A "hashtag" source is TikTok-only, not ${platform}.`);
      if (!source.hashtag.trim()) bad("A TikTok hashtag source needs a non-empty `hashtag`.");
      if (!source.paramName.trim()) {
        bad(
          "A TikTok hashtag source needs `paramName` — the name of the query parameter that " +
            `carries the hashtag. https://docs.scrapecreators.com${ENDPOINTS.tiktokHashtag} was ` +
            "read on 2026-09-04 and documents the path, the 1-credit cost and the response shape, " +
            "but its curl sample carries no query string and the page does not name the " +
            "parameter. This tool will not guess one: a guessed name comes back as a 400 if we " +
            "are lucky and as a successful call for the wrong thing if we are not, and at a first " +
            "paid run both look exactly like a bad key. Read it off the 'Try it' panel on that " +
            "page and set it here.",
        );
      }
      return;
    case "creator":
      if (platform !== "instagram") bad(`A "creator" source is Instagram-only, not ${platform}.`);
      if (!source.handle?.trim() && !source.userId?.trim()) {
        bad(
          "An Instagram creator source needs a `handle` or a `userId`. Both are documented on " +
            `https://docs.scrapecreators.com${ENDPOINTS.instagramUserReels}, and the docs note ` +
            "that `user_id` gives faster responses — pass both when you have both.",
        );
      }
      return;
    case "page":
      if (platform !== "facebook") bad(`A "page" source is Facebook-only, not ${platform}.`);
      if (!source.url.trim()) {
        bad(
          "A Facebook page source needs a `url` — the public Facebook page URL, which is the " +
            `documented required parameter on https://docs.scrapecreators.com${ENDPOINTS.facebookProfileReels}. ` +
            "Facebook is page-seeded only here: nobody sells Facebook Reels discovery, this vendor " +
            "included, so there is no trending or keyword alternative to fall back on.",
        );
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Request plans — one per source kind
// ---------------------------------------------------------------------------

/**
 * What joins Facebook's two pagination values into one opaque cursor string.
 *
 * NAMED AND ESCAPED RATHER THAN TYPED AS A LITERAL. It was briefly an invisible
 * character sitting inside a string literal, which is unreviewable: nobody
 * reading `split(" ")` can tell whether that is a space, a NUL or a non-breaking
 * space, and all three behave differently against a real cursor. A separator
 * chosen for the property that it cannot occur in the data has to be spelled in
 * a way that shows what it is.
 *
 * NUL specifically, because ScrapeCreators' `cursor` and `next_page_id` are
 * URL-safe tokens and a space is not impossible in one. See the plan below for
 * why the pair is carried together rather than one being picked.
 */
const CURSOR_PAIR_SEPARATOR = "\u0000";

interface RequestPlan {
  readonly endpoint: EndpointPath;
  /** The array this parser reads. Absent means the shape changed; empty means no results. */
  readonly resultsKey: string;
  readonly describedTarget: string;
  params(cursor: string | undefined): Record<string, string | undefined>;
  /** The next cursor, or null to stop. `page` is 1-based and only `page` paging uses it. */
  nextCursor(body: Record<string, unknown>, page: number): string | null;
  map(
    items: readonly unknown[],
    discoveredAt: string,
    client: ScrapeCreatorsClient,
  ): ShortRecord[];
}

function requestPlan(platform: Platform, source: PlatformSource): RequestPlan {
  assertUsableSource(platform, source);
  switch (source.kind) {
    case "trending":
      return {
        endpoint: ENDPOINTS.tiktokTrending,
        resultsKey: "aweme_list",
        describedTarget: `the TikTok trending feed for region ${source.region}`,
        params: () => ({ region: source.region }),
        // NO PAGINATION CURSOR IS DOCUMENTED on the trending endpoint's response,
        // so this walks exactly one page rather than inventing a parameter to ask
        // for a second. One credit, one page of what is trending.
        nextCursor: () => null,
        map: (items, at, client) => tiktokRecords(items, at, ENDPOINTS.tiktokTrending, client),
      };
    case "keyword":
      if (platform === "tiktok") {
        const s = source as TikTokKeywordSource;
        return {
          endpoint: ENDPOINTS.tiktokKeyword,
          resultsKey: "search_item_list",
          describedTarget: `TikTok search for ${JSON.stringify(s.keyword)}`,
          // `query`, NOT `keyword`. Verified against the live API 2026-09-05:
          // `?keyword=funny&region=US` answers 400 `missing_parameter` — "You
          // must provide a query" — while `?query=funny` answers 200 with a
          // populated `search_item_list`. The endpoint's own docs page lists no
          // parameters at all, so this was measured rather than read. The
          // rejected call is charged 0 credits (`credits_charged: 0` in the 400
          // body), which is why the mistake was survivable rather than expensive.
          params: (cursor) => ({ query: s.keyword, region: s.region, cursor }),
          nextCursor: (body) => {
            const cursor = finiteNumber(body.cursor);
            return cursor === null ? null : String(cursor);
          },
          map: (items, at, client) =>
            // Keyword results nest the post one level down under `aweme_info`.
            tiktokRecords(
              items.map((item) => asRecord(item)?.aweme_info ?? item),
              at,
              ENDPOINTS.tiktokKeyword,
              client,
            ),
        };
      }
      {
        const s = source as InstagramKeywordSource;
        return {
          endpoint: ENDPOINTS.instagramReelSearch,
          resultsKey: "reels",
          describedTarget: `Instagram reel search for ${JSON.stringify(s.query)}`,
          params: (cursor) => ({
            query: s.query,
            date_posted: s.datePosted,
            page: cursor ?? "1",
          }),
          /*
           * PAGE NUMBERS, CAPPED AT 11 BY THE VENDOR. The docs say `page`
           * accepts "a number between 1-11", so this stops at 11 rather than
           * paying for a 400 to discover the edge.
           */
          nextCursor: (_body, page) => (page + 1 <= 11 ? String(page + 1) : null),
          map: (items, at) => instagramSearchRecords(items, at),
        };
      }
    case "hashtag":
      return {
        endpoint: ENDPOINTS.tiktokHashtag,
        resultsKey: "aweme_list",
        describedTarget: `TikTok hashtag ${JSON.stringify(source.hashtag)}`,
        params: () => ({ [source.paramName]: source.hashtag, region: source.region }),
        // No cursor parameter is documented for this endpoint either — see the
        // refusal in `assertUsableSource`. One page.
        nextCursor: () => null,
        map: (items, at, client) => tiktokRecords(items, at, ENDPOINTS.tiktokHashtag, client),
      };
    case "creator": {
      const who = source.handle ? `@${source.handle}` : `Instagram user ${source.userId}`;
      return {
        endpoint: ENDPOINTS.instagramUserReels,
        resultsKey: "items",
        describedTarget: `${who}'s Instagram reels`,
        params: (cursor) => ({
          handle: source.handle,
          user_id: source.userId,
          max_id: cursor,
        }),
        nextCursor: (body) => {
          const paging = asRecord(body.paging_info);
          if (!paging) return null;
          if (paging.more_available === false) return null;
          return nonEmptyString(paging.max_id);
        },
        map: (items, at, client) => instagramReelRecords(items, at, client),
      };
    }
    case "page":
      return {
        endpoint: ENDPOINTS.facebookProfileReels,
        resultsKey: "reels",
        describedTarget: `the Facebook page ${source.url}`,
        params: (cursor) => {
          // The docs list BOTH `cursor` and `next_page_id` as pagination
          // parameters and do not say whether either alone is enough. They are
          // carried as one opaque pair, joined by a character neither is
          // documented to contain, rather than picking one and hoping.
          const [nextPageId, plain] = (cursor ?? "").split(CURSOR_PAIR_SEPARATOR);
          return {
            url: source.url,
            next_page_id: nextPageId || undefined,
            cursor: plain || undefined,
          };
        },
        nextCursor: (body) => {
          const nextPageId = nonEmptyString(body.next_page_id) ?? "";
          const plain = nonEmptyString(body.cursor) ?? "";
          return nextPageId || plain ? `${nextPageId}${CURSOR_PAIR_SEPARATOR}${plain}` : null;
        },
        map: (items, at, client) => facebookReelRecords(items, at, client),
      };
  }
}

// ---------------------------------------------------------------------------
// Mappers — vendor vocabulary to ShortRecord
// ---------------------------------------------------------------------------

/**
 * A TikTok post, from any of the three TikTok endpoints.
 *
 * Field names, all read 2026-09-04:
 *   `aweme_id`, `desc`, `statistics.play_count`, `statistics.digg_count`,
 *   `statistics.comment_count`, `author.unique_id`, `author.uid`,
 *   `create_time`, `video.cover.url_list`, `video.play_addr.url_list`,
 *   `video.download_addr.url_list`
 *     — https://docs.scrapecreators.com/v1/tiktok/get-trending-feed
 *   `share_url`, `video.duration`, `has_more`, `max_cursor`
 *     — https://docs.scrapecreators.com/v3/tiktok/profile/videos
 *   `share_info.share_url`, `search_item_list[].aweme_info`
 *     — https://docs.scrapecreators.com/v1/tiktok/search/keyword
 *
 * THE PERMALINK IS READ FROM THREE PLACES AND CONSTRUCTED FROM NONE. The
 * trending feed calls it `url`, the profile endpoint calls it `share_url`, the
 * keyword search puts it at `share_info.share_url`. All three are documented;
 * building `https://www.tiktok.com/@handle/video/id` from parts is not, and a
 * constructed permalink that is subtly wrong is a link that 404s from a row
 * that otherwise looks perfect.
 *
 * `creator_url` IS NULL and stays null. No TikTok endpoint here documents a
 * profile URL field, and a constructed one would be this file guessing at
 * somebody else's URL scheme — the exact habit lib/platform/types.ts warns
 * about. An em dash for an unknown, per DESIGN.md, and never a fabrication.
 */
export function tiktokRecords(
  items: readonly unknown[],
  discoveredAt: string,
  endpoint: string,
  client?: ScrapeCreatorsClient,
): ShortRecord[] {
  const out: ShortRecord[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;

    const id = nonEmptyString(item.aweme_id);
    const url =
      nonEmptyString(item.share_url) ??
      nonEmptyString(asRecord(item.share_info)?.share_url) ??
      nonEmptyString(item.url);
    if (!id || !url) continue;

    const stats = asRecord(item.statistics) ?? {};
    const author = asRecord(item.author) ?? {};
    const video = asRecord(item.video) ?? {};

    // MILLISECONDS. See the file header for the two literals that prove it.
    const durationMs = finiteNumber(video.duration);
    const duration = durationMs === null ? null : durationMs / 1000;

    client?.rememberMediaUrl(
      "tiktok",
      id,
      firstUrl(asRecord(video.download_addr)?.url_list) ??
        firstUrl(asRecord(video.play_addr)?.url_list),
    );

    out.push({
      platform: "tiktok",
      platform_video_id: id,
      url,
      title: nonEmptyString(item.desc),
      creator_handle: nonEmptyString(author.unique_id),
      creator_id: nonEmptyString(author.uid) ?? nonEmptyString(author.sec_uid),
      creator_url: null,
      duration_seconds: duration,
      view_count: finiteNumber(stats.play_count),
      like_count: finiteNumber(stats.digg_count),
      comment_count: finiteNumber(stats.comment_count),
      published_at:
        isoFromUnixSeconds(item.create_time) ?? isoFromString(item.create_time_utc),
      thumbnail_url: firstUrl(asRecord(video.cover)?.url_list),
      discovered_at: discoveredAt,
      discovered_by: `scrapecreators:${endpoint}`,
      topic_slug: null,
    });
  }
  return out;
}

/**
 * Instagram reels for one seeded creator.
 *
 * https://docs.scrapecreators.com/v1/instagram/user/reels/, read 2026-09-04.
 * `items[].media` carries `pk`, `id`, `code`, `caption`, `play_count`,
 * `ig_play_count`, `like_count`, `comment_count`, `video_duration`,
 * `video_versions[].url`, `url`, `taken_at`, `created_at`, and thumbnails at
 * `image_versions2.candidates[].url`. `paging_info` carries `max_id` and
 * `more_available`.
 *
 * `play_count` AND NOT `ig_play_count`. The docs describe `play_count` as the
 * view count and `ig_play_count` as "Instagram views only"; in their example
 * both are 3865. They are the same number until the day they are not, and on
 * that day the one the docs call the view count is the one to have been
 * reading. Where `play_count` is absent, `ig_play_count` is used as a stated
 * fallback rather than a silent one — the alternative is a null that reads as
 * "nobody watched it".
 *
 * `video_duration` IS SECONDS, fractional — their example is 76.783. It is NOT
 * the same unit as TikTok's `video.duration`, which is milliseconds. Two fields
 * one word apart in two endpoints of one vendor; both were checked against a
 * literal value rather than a description.
 */
export function instagramReelRecords(
  items: readonly unknown[],
  discoveredAt: string,
  client?: ScrapeCreatorsClient,
): ShortRecord[] {
  const out: ShortRecord[] = [];
  for (const raw of items) {
    const wrapper = asRecord(raw);
    if (!wrapper) continue;
    // `items[].media`, with a bare item tolerated: the `trim=true` response is
    // documented as a different, flatter shape and this parser should not fail
    // an operator who set it.
    const media = asRecord(wrapper.media) ?? wrapper;

    const code = nonEmptyString(media.code);
    const id = nonEmptyString(media.pk) ?? nonEmptyString(media.id) ?? code;
    const url = nonEmptyString(media.url);
    if (!id || !url) continue;

    const owner = asRecord(media.user) ?? asRecord(media.owner) ?? {};

    client?.rememberMediaUrl("instagram", id, firstVersionUrl(media.video_versions));

    out.push({
      platform: "instagram",
      platform_video_id: id,
      url,
      title: captionText(media.caption),
      creator_handle: nonEmptyString(owner.username),
      creator_id: nonEmptyString(owner.pk) ?? nonEmptyString(owner.id),
      creator_url: null,
      duration_seconds: finiteNumber(media.video_duration),
      view_count: finiteNumber(media.play_count) ?? finiteNumber(media.ig_play_count),
      like_count: finiteNumber(media.like_count),
      comment_count: finiteNumber(media.comment_count),
      published_at: isoFromString(media.created_at) ?? isoFromUnixSeconds(media.taken_at),
      thumbnail_url: firstCandidateUrl(media.image_versions2),
      discovered_at: discoveredAt,
      discovered_by: `scrapecreators:${ENDPOINTS.instagramUserReels}`,
      topic_slug: null,
    });
  }
  return out;
}

/**
 * Instagram reels found by keyword. THE SECONDARY SWEEP, AND IT CANNOT ANSWER
 * THE PRODUCT'S QUESTION ON ITS OWN.
 *
 * https://docs.scrapecreators.com/v2/instagram/reels/search, read 2026-09-04.
 * The documented response carries `id`, `shortcode`, `url`, `caption`,
 * `video_url`, `video_duration`, `taken_at`, `like_count`, `comment_count` and
 * `owner.username` — AND NO VIEW COUNT OF ANY KIND. Not a null one; the field
 * is not in the response.
 *
 * VIEWS ARE THEREFORE DERIVED FROM LIKES HERE. Erik's instruction, 2026-09-08:
 * `view_count = like_count * INSTAGRAM_LIKES_TO_VIEWS`. See that constant for
 * the full argument and the warning about its value. The consequence to hold in
 * mind while reading this function is that the estimate is a REAL `view_count`
 * as far as the rest of the system is concerned — `judge()` compares it against
 * 500,000, a row that clears it is kept, shown and written to the database —
 * so every derived row leaves here carrying a `basis: "derived"` caveat, which
 * is the only thing standing between an estimate and a screen that calls it a
 * measurement.
 *
 * A ROW WITH NO LIKE COUNT IS STILL UNJUDGEABLE. It keeps `view_count: null`
 * and goes on landing in "could not be judged", because there is nothing to
 * multiply and a zero would be a claim about the reel.
 */
export function instagramSearchRecords(
  items: readonly unknown[],
  discoveredAt: string,
): ShortRecord[] {
  const out: ShortRecord[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;

    const id = nonEmptyString(item.id) ?? nonEmptyString(item.shortcode);
    const url = nonEmptyString(item.url);
    if (!id || !url) continue;

    const owner = asRecord(item.owner) ?? {};

    // THE ESTIMATE. `likes` is the vendor's own number; `derived` is ours, and
    // the two are kept in separate variables so the caveat can print both.
    // A null `likes` derives nothing — see the header.
    const likes = finiteNumber(item.like_count);
    const derived = likes === null ? null : Math.round(likes * INSTAGRAM_LIKES_TO_VIEWS);

    const row: ShortRecord = {
      platform: "instagram",
      platform_video_id: id,
      url,
      title: captionText(item.caption),
      creator_handle: nonEmptyString(owner.username),
      creator_id: nonEmptyString(owner.id),
      creator_url: null,
      duration_seconds: finiteNumber(item.video_duration),
      // DERIVED, NOT REPORTED. This endpoint publishes no view count; the
      // number here was computed from `like_count` and is carrying a caveat.
      view_count: derived,
      like_count: likes,
      comment_count: finiteNumber(item.comment_count),
      published_at: isoFromString(item.taken_at) ?? isoFromUnixSeconds(item.taken_at),
      // OPPORTUNISTIC, AND NULL WHEN ABSENT. The documented reels-search response
      // (https://docs.scrapecreators.com/v2/instagram/reels/search) lists no
      // thumbnail, so this used to be a flat `null`. Instagram payloads commonly
      // carry one anyway under one of these names, and a picture is the thing a
      // person scans a wall of clips by — so each known shape is tried and the
      // first that is really there wins. None present is still `null`: a missing
      // field is never invented, and the card falls back to its placeholder.
      thumbnail_url:
        firstCandidateUrl(item.image_versions2) ??
        nonEmptyString(item.thumbnail_url) ??
        nonEmptyString(item.display_url) ??
        nonEmptyString(item.display_uri) ??
        nonEmptyString(item.thumbnail_src) ??
        null,
      discovered_at: discoveredAt,
      discovered_by: `scrapecreators:${ENDPOINTS.instagramReelSearch}`,
      topic_slug: null,
    };

    if (likes === null || derived === null) {
      out.push(row);
      continue;
    }

    const caveated: CaveatedShortRecord = {
      ...row,
      measurement_caveat: {
        field: "view_count",
        basis: "derived",
        // NULL, and not the like count. This field means "what the source said
        // about VIEWS", and the source said nothing about views. Putting the
        // likes here would read as a reported view count of 12,000, which is
        // the exact confusion the caveat exists to stop.
        reportedValue: null,
        note: instagramDerivedViewsNote(likes, derived),
      },
    };
    out.push(caveated);
  }
  return out;
}

/**
 * Facebook page reels. EVERY ROW CARRIES A HEALTH WARNING ON ITS VIEW COUNT.
 *
 * https://docs.scrapecreators.com/v1/facebook/profile/reels, read 2026-09-04.
 * `reels[]` carries `id`, `post_id`, `video_id`, `creation_time` (ISO 8601),
 * `url`, `view_count`, `description`, `thumbnail`, `play_time_in_ms`,
 * `video_url` and `author.{id,name,url,is_verified}`. The envelope carries
 * `cursor` and `next_page_id`, and the endpoint returns 10 reels at a time.
 *
 * `play_time_in_ms` IS MILLISECONDS and the field name says so, which is more
 * than TikTok's `video.duration` does.
 *
 * `view_count` IS MULTIPLIED BY `FACEBOOK_VIEWS_MULTIPLIER` BEFORE IT IS USED.
 * Erik, 2026-09-08. The vendor's raw figure is preserved untouched in
 * `measurement_caveat.reportedValue`; the record's `view_count` is the product,
 * and that product is what `judge()` compares against 500,000.
 *
 * THIS REVERSES THE PREVIOUS BEHAVIOUR, WHICH WAS TO REFUSE. Until now
 * `view_count` was null here and every Facebook row landed in "could not be
 * judged" — the argument being that a number which may be an order of magnitude
 * wrong cannot be compared in either direction. That argument was not refuted;
 * it was overruled, and the correction is a guess layered on top of a distrusted
 * figure. Two unproven things multiplied together do not make a measurement,
 * which is why the caveat rides along and why the console marks the cell.
 *
 * NOTE WHAT IS NOT GUESSED HERE. `play_time_in_ms` is a real duration from the
 * vendor, so a Facebook row is half-measured: its length is read and only its
 * view count is invented. That is a better position than Instagram keyword
 * search, where neither was available.
 *
 * `like_count` and `comment_count` are null because this endpoint does not
 * document them. Absent, not zero.
 */
export function facebookReelRecords(
  items: readonly unknown[],
  discoveredAt: string,
  client?: ScrapeCreatorsClient,
): CaveatedShortRecord[] {
  const out: CaveatedShortRecord[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;

    const id =
      nonEmptyString(item.video_id) ?? nonEmptyString(item.post_id) ?? nonEmptyString(item.id);
    const url = nonEmptyString(item.url);
    if (!id || !url) continue;

    const author = asRecord(item.author) ?? {};
    const playMs = finiteNumber(item.play_time_in_ms);

    client?.rememberMediaUrl("facebook", id, nonEmptyString(item.video_url));

    // THE VENDOR'S NUMBER AND OURS, KEPT APART. `reported` is preserved
    // verbatim in the caveat and never compared; `corrected` is what the rest
    // of the system sees as this row's view count.
    const reported = finiteNumber(item.view_count);
    const corrected = reported === null ? null : Math.round(reported * FACEBOOK_VIEWS_MULTIPLIER);

    out.push({
      platform: "facebook",
      platform_video_id: id,
      url,
      title: nonEmptyString(item.description),
      creator_handle: nonEmptyString(author.name),
      creator_id: nonEmptyString(author.id),
      creator_url: nonEmptyString(author.url),
      duration_seconds: playMs === null ? null : playMs / 1000,
      // THE CORRECTED FIGURE, or null when the vendor sent nothing to correct.
      view_count: corrected,
      like_count: null,
      comment_count: null,
      published_at: isoFromString(item.creation_time) ?? isoFromUnixSeconds(item.creation_time),
      thumbnail_url: nonEmptyString(item.thumbnail),
      discovered_at: discoveredAt,
      discovered_by: `scrapecreators:${ENDPOINTS.facebookProfileReels}`,
      topic_slug: null,
      measurement_caveat: {
        field: "view_count",
        // DERIVED even though the vendor did report a number, because the
        // number in `view_count` is not the one it reported. `basis` describes
        // the figure the row is carrying, not what arrived on the wire — and
        // the figure this row carries was computed here.
        basis: "derived",
        // The vendor's own figure, unmodified, including null. This is the one
        // field on the row that is still purely what Facebook said.
        reportedValue: reported,
        note:
          reported === null || corrected === null
            ? FACEBOOK_VIEW_COUNT_CAVEAT
            : facebookCorrectedViewsNote(reported, corrected),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small, total readers
// ---------------------------------------------------------------------------
//
// Every one of these is TOTAL: it takes `unknown` and returns a value or null,
// and none of them throws. That is deliberate. A vendor whose endpoints migrate
// data sources will send a string where a number was, and a parser that throws
// on the first surprising field turns one changed subfield into a dead
// platform. The decisions about what is fatal are made in one place —
// `readSource` — where an absent results array and an unparseable page are told
// apart. Everything else degrades to null, which this repo has a word for:
// "the source did not say".

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Numbers arrive as strings often enough in scraped payloads that refusing
  // them would throw away real data. A non-numeric string is still null.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The results array, or null when the key is absent or not an array. */
function readArray(body: Record<string, unknown>, key: string): readonly unknown[] | null {
  const value = body[key];
  return Array.isArray(value) ? value : null;
}

function firstUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const url = nonEmptyString(entry);
    if (url) return url;
  }
  return null;
}

/** `video_versions: [{ url, width, height, type }]` — the first usable url. */
function firstVersionUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const url = nonEmptyString(asRecord(entry)?.url);
    if (url) return url;
  }
  return null;
}

/** `image_versions2.candidates[].url` — the first usable thumbnail. */
function firstCandidateUrl(value: unknown): string | null {
  const candidates = asRecord(value)?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const entry of candidates) {
    const url = nonEmptyString(asRecord(entry)?.url);
    if (url) return url;
  }
  return null;
}

/**
 * A caption, which the docs type as `string|null` and Instagram's own payloads
 * routinely send as `{ text }`. Both are read; anything else is null.
 */
function captionText(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  return nonEmptyString(asRecord(value)?.text);
}

/**
 * A unix SECONDS timestamp as ISO, or null.
 *
 * Rejects anything that is not a plausible unix-seconds value, because the
 * alternative is silently filing a millisecond timestamp as the year 57000 and
 * a bad parse as 1970. Both are wrong in a way that looks like data.
 */
function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0 || seconds > 4_102_444_800) return null;
  return new Date(seconds * 1000).toISOString();
}

/** An ISO-8601 string as a normalised ISO string, or null. Never a bare number. */
function isoFromString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The keys a body actually carried, for a shape error's message. */
function describeKeys(body: unknown): string {
  const record = asRecord(body);
  if (!record) return Array.isArray(body) ? "(a bare array)" : `(${typeof body})`;
  const keys = Object.keys(record);
  return keys.length === 0 ? "(none)" : keys.map((k) => `\`${k}\``).join(", ");
}

/** Whatever this response said, in one line, for an error message. */
/**
 * WHAT A REPLY ACTUALLY CARRIED, IN FIELD NAMES AND NUMBERS ONLY.
 *
 * Written for the balance check, where every press costs a credit and a
 * complaint that names only the missing field makes the operator buy the
 * diagnosis a second time to learn what arrived instead.
 *
 * STRING VALUES ARE DELIBERATELY OMITTED. Names, types, finite numbers and
 * booleans go in; the contents of a string never do. A vendor that echoed the
 * request back would otherwise hand the API key into an error string that an
 * admin page renders, and this helper is reachable from a 200 — the one branch
 * that never passes through the scrubbing the error paths get.
 *
 * ONE LEVEL OF NESTING IS DESCRIBED, because "moved under a wrapper" is the
 * likeliest drift of the four and spotting it should not cost another credit.
 */
function describeShape(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  // `get` folds a null body into `{}`, so an empty record is a body that could
  // not be parsed as JSON just as much as it is a vendor sending `{}`. Both are
  // "they sent no fields", which is a different complaint from "the field is
  // missing" and reads as one.
  if (keys.length === 0) return "The reply carried no JSON fields at all.";

  const listed = keys.map((k) => describeField(k, body[k])).join(", ");
  // The caller's message is truncated at 500 characters by the credentials
  // action before an operator sees it. A shape that ran long would push the
  // sentences after it off the end, so it is capped here where the cost of the
  // cap is visible.
  return `The reply carried: ${listed.length > 110 ? `${listed.slice(0, 110)}…` : listed}.`;
}

/** One field as `name=number`, `name[n]`, `name{inner keys}` or `name (type)`. */
function describeField(name: string, value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return `${name}=${value}`;
  if (typeof value === "boolean") return `${name}=${value}`;
  if (value === null) return `${name}=null`;
  if (Array.isArray(value)) return `${name}[${value.length}]`;
  const nested = asRecord(value);
  if (nested) return `${name}{${Object.keys(nested).slice(0, 8).join(" ") || "empty"}}`;
  return `${name} (${typeof value})`;
}

function detailOf(body: unknown, status: number): string {
  const record = asRecord(body);
  if (record) {
    const message =
      nonEmptyString(record.message) ??
      nonEmptyString(record.error) ??
      nonEmptyString(record.detail);
    if (message) return message;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  return `no message body (HTTP ${status})`;
}

/** `retry-after` in seconds, when the response bothered to send one. */
function retryAfterOf(response: Response): number | null {
  const raw = response.headers?.get?.("retry-after");
  return raw === null || raw === undefined ? null : finiteNumber(raw);
}

/** A JSON body, or null. A malformed body is a fact about the response, not a throw. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
