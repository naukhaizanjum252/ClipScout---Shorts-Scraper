/**
 * The cost table — one entry per operation this tool is allowed to call, and
 * the QUOTA BUCKET each one draws on.
 *
 * READ THIS BEFORE QUOTING A NUMBER FROM IT.
 *
 * `declaredUnits` is a CLAIM, not a measurement. It is what Google's published
 * quota-cost table says the operation costs, and it is what the client pays if
 * the docs are right. Phase 0 of the plan exists precisely because a published
 * figure about the API in general is not a measurement of OUR project.
 *
 * A unit price on its own no longer describes the constraint, which is why an
 * `OperationCost` also names a bucket. Two ceilings apply to a day's work and
 * they are not interchangeable: `search.list` is metered in CALLS out of its own
 * small ration, everything else is metered in UNITS out of a shared pool. A run
 * can be nowhere near the unit pool and still be finished for the day.
 *
 * `verify/quota.ts` records observed cost against these claims. Until it has,
 * `verify/fixtures/quota.json` does not exist and `--check` is red. That red is
 * the honest state of the project.
 *
 * A call site declares which operation it is by name, so the cost accounting is
 * impossible to forget: `YouTubeClient.call()` takes an `Operation` and there is
 * no way to issue a request without naming one.
 *
 * ---------------------------------------------------------------------------
 * SCAR, 2026-09-04. The figure this table published was wrong.
 *
 * WHAT WAS WRONG. Until today this table declared `search.list` at 100 units,
 * and the repo reasoned everywhere from a "100x gap" between a search and an
 * uploads-playlist page. Google's published table prices all four of these
 * operations at 1 unit. `search.list` is not expensive. It is RATIONED: it has
 * its own quota bucket with a default ceiling of 100 calls a day, and that
 * ration cannot be topped up out of the shared pool the other three draw on,
 * because it is a different bucket.
 *
 * WHAT IT WOULD HAVE CAUSED. A budget that counts only units. At a claimed 100
 * units a call, a unit ceiling was an adequate brake on searching — spend too
 * many and the budget stopped you. At the true price a search costs exactly what
 * a playlist page costs, so a units-only budget sees nothing at all as a run
 * spends its hundredth search call, and the hundred-and-first comes back 403
 * with the unit pool barely touched and no way to buy the bucket back. Every
 * capacity figure derived from the old ratio was wrong in both directions:
 * searching was far cheaper than claimed, and far scarcer.
 *
 * WHAT STOPS IT NOW. A cost is no longer just a number. `OperationCost` names
 * the bucket the operation draws on and `BUCKETS` carries that bucket's daily
 * ceiling, so a caller can refuse a call that a unit budget would have allowed.
 *
 * AND THE DISCIPLINE THAT CAUGHT IT. Nothing measured the old number wrong.
 * This docblock always said, in as many words, that `declaredUnits` was a CLAIM
 * and that Phase 0 existed to replace it with an observation. Labelling a
 * published figure as documentation rather than fact is exactly what left the
 * repo somewhere honest to put the correction when the documentation moved.
 * Keep the label. It earned its keep.
 *
 * THE DECISION IT WAS USED TO JUSTIFY IS UNCHANGED, AND NOW BETTER FOUNDED.
 * Walk a known channel's uploads playlist; do not enumerate a channel with
 * `search.list`. The old reason was price. The new reason is supply: at 50
 * results a call, 100 calls is at most 5,000 candidates in a day, hard, and no
 * amount of unit budget buys a 101st call. Walking uploads costs 1 unit per 50
 * videos out of the shared pool, which for this workload is effectively
 * unlimited. Google's own `search.list` reference separately advises against
 * using it to fetch a channel's recent uploads, which endorses the same choice
 * from the other direction.
 */

/** Every operation the tool may issue. Adding one means adding its cost here. */
export const OPERATIONS = ["search.list", "playlistItems.list", "videos.list", "channels.list"] as const;

export type Operation = (typeof OPERATIONS)[number];

/**
 * The quota buckets a day is spent out of. They are separate accounts, not two
 * views of one balance: exhausting either one stops the operations that draw on
 * it while the other sits untouched.
 */
export const QUOTA_BUCKETS = ["search", "general"] as const;

export type QuotaBucket = (typeof QUOTA_BUCKETS)[number];

/** Where every declared figure below came from. Cited, so nobody has to guess. */
export const DECLARED_SOURCE_URL = "https://developers.google.com/youtube/v3/determine_quota_cost";

/** The day the page above was read. A published figure can move; this one did. */
export const DECLARED_SOURCE_READ_ON = "2026-09-04";

const DOC_SOURCE =
  `YouTube Data API v3 published quota-cost table, ${DECLARED_SOURCE_URL}, read ${DECLARED_SOURCE_READ_ON}. ` +
  "A documentation figure, NOT a measurement of this project — Phase 0 replaces it with one.";

export interface QuotaBucketSpec {
  readonly bucket: QuotaBucket;
  /**
   * Calls a day this bucket allows, where Google publishes a fixed per-method
   * ceiling for it. `null` where the ceiling is a per-project allowance instead
   * — see the `general` entry for why that null is deliberate.
   *
   * DOCUMENTATION, like every figure in this file. Nothing here is measured.
   */
  readonly declaredDailyCalls: number | null;
  /** What runs out first in this bucket, in one line. */
  readonly meters: string;
  readonly declaredSource: string;
}

export const BUCKETS: Readonly<Record<QuotaBucket, QuotaBucketSpec>> = Object.freeze({
  search: {
    bucket: "search",
    // A hundred calls. Not a hundred units of anything shared — this bucket is
    // its own account, and this is the number that ends a day's discovery.
    declaredDailyCalls: 100,
    meters:
      "calls, in a bucket of its own. Google gives search.list a default limit of 100 per day " +
      "and it cannot be topped up from the shared unit pool.",
    declaredSource: DOC_SOURCE,
  },
  general: {
    bucket: "general",
    // Deliberately null, and it must stay null. The shared pool's ceiling is a
    // per-project allowance an operator reads off their own Cloud console, and
    // this repo refuses to assume one anywhere (lib/config.ts:dailyQuotaUnits).
    // The published default is widely quoted; quoting it here would turn a
    // per-project figure into a constant, which is the exact Phase 0 rule.
    declaredDailyCalls: null,
    meters:
      "units, out of the project's own daily allowance, shared by every operation except " +
      "search.list. The allowance is per Google Cloud project and this repo holds no default " +
      "for it — see lib/config.ts:dailyQuotaUnits.",
    declaredSource: DOC_SOURCE,
  },
});

export interface OperationCost {
  /** The API path under https://www.googleapis.com/youtube/v3/ */
  readonly path: string;
  /**
   * Units Google's published quota table says one call costs.
   * UNVERIFIED against our own project until Phase 0 records an observation.
   */
  readonly declaredUnits: number;
  /**
   * Which account the call is billed to. A unit total that ignores this cannot
   * tell a run it has run out of searches, because it has not run out of units.
   */
  readonly bucket: QuotaBucket;
  /** Max items a single page of this operation can return. */
  readonly maxPageSize: number;
  /** Where `declaredUnits` came from, so nobody has to guess later. */
  readonly declaredSource: string;
}

export const COSTS: Readonly<Record<Operation, OperationCost>> = Object.freeze({
  "search.list": { path: "search", declaredUnits: 1, bucket: "search", maxPageSize: 50, declaredSource: DOC_SOURCE },
  "playlistItems.list": {
    path: "playlistItems",
    declaredUnits: 1,
    bucket: "general",
    maxPageSize: 50,
    declaredSource: DOC_SOURCE,
  },
  "videos.list": { path: "videos", declaredUnits: 1, bucket: "general", maxPageSize: 50, declaredSource: DOC_SOURCE },
  "channels.list": {
    path: "channels",
    declaredUnits: 1,
    bucket: "general",
    maxPageSize: 50,
    declaredSource: DOC_SOURCE,
  },
});

export function declaredUnits(op: Operation): number {
  return COSTS[op].declaredUnits;
}

export function maxPageSize(op: Operation): number {
  return COSTS[op].maxPageSize;
}

/** Which account `op` is billed to. */
export function bucketOf(op: Operation): QuotaBucket {
  return COSTS[op].bucket;
}

export function bucketSpec(bucket: QuotaBucket): QuotaBucketSpec {
  return BUCKETS[bucket];
}

/**
 * Calls of `op` a day declares, or `null` when the ceiling is the operator's own
 * unit allowance rather than a published per-method limit.
 *
 * A caller that only asks `declaredUnits` cannot see the ration; this is the
 * question a run has to ask before it starts searching.
 */
export function declaredDailyCallCeiling(op: Operation): number | null {
  return BUCKETS[bucketOf(op)].declaredDailyCalls;
}

export function isOperation(value: string): value is Operation {
  return (OPERATIONS as readonly string[]).includes(value);
}

export function isQuotaBucket(value: string): value is QuotaBucket {
  return (QUOTA_BUCKETS as readonly string[]).includes(value);
}

/**
 * Declared cost of walking `videoCount` uploads of a KNOWN channel: one
 * `playlistItems.list` page per 50 ids, plus one `videos.list` hydration page
 * per 50 ids. This is the arithmetic the seeded/autonomous split rests on, so
 * it lives next to the costs it uses rather than in a comment somewhere.
 *
 * Every operation it counts draws on the `general` bucket, which is the point:
 * the seeded path spends no part of the search ration at all.
 */
export function declaredSeededEnumerationUnits(videoCount: number): number {
  if (!Number.isSafeInteger(videoCount) || videoCount < 0) {
    throw new RangeError(`videoCount must be a non-negative integer, got ${videoCount}`);
  }
  if (videoCount === 0) {
    // Even an empty channel costs one page request to find that out.
    return declaredUnits("playlistItems.list");
  }
  const listPages = Math.ceil(videoCount / maxPageSize("playlistItems.list"));
  const hydratePages = Math.ceil(videoCount / maxPageSize("videos.list"));
  return listPages * declaredUnits("playlistItems.list") + hydratePages * declaredUnits("videos.list");
}

/**
 * The most candidates a day of searching can surface, from the declared ration:
 * the bucket's call ceiling times a full page. `null` when the bucket publishes
 * no ceiling.
 *
 * This is the successor to the old "100x" sentence. The gap between the two
 * paths is no longer a price ratio, it is a supply ceiling — and this is the
 * number that states it.
 */
export function declaredSearchCandidatesPerDay(): number | null {
  const ceiling = declaredDailyCallCeiling("search.list");
  return ceiling === null ? null : ceiling * maxPageSize("search.list");
}
