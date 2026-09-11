/**
 * WHERE THE SHORTS LIVE. The port, and the one shape a read is allowed to have.
 *
 * The run (lib/shorts/run.ts) is written against this and not against Supabase,
 * so the thing the client is actually buying — one list, over the threshold,
 * grouped by platform, no duplicates when it is run twice — is provable in
 * milliseconds against an in-memory implementation, with no database and no
 * credentials. `SupabaseShortsStore` implements the same interface.
 *
 * IDENTITY IS (platform, platform_video_id) AND NOTHING ELSE.
 *
 * `shortKey` below is the only definition of that in this cluster. There is no
 * global id format, no regex, no parser — see lib/platform/types.ts for why a
 * shape validator is exactly the mistake that made this repo single-platform.
 * An implementation that keys on `platform_video_id` alone would be correct
 * right up until an Instagram shortcode and a YouTube id collide, at which
 * point one real short silently overwrites another and nothing anywhere says
 * so.
 *
 * WHY A READ RETURNS A UNION AND NOT AN ARRAY — THIS IS A SCAR
 *
 * The port this replaces (`lib/inventory/query.ts`) returned bare arrays, and
 * that shape is what made its worst bug unreportable. PostgREST caps every
 * response at the project's `Max rows` — 1000 by default — and it does that
 * with a 200, a `Content-Range` header, and NO ERROR OBJECT. The concrete
 * failing input on that code was 8 channels x 137 uploads = 1096 rows: `error`
 * was null, the code believed it had the lot, and every median on the page was
 * computed from 1000 of 1096 rows. A wrong number that looks exactly like a
 * right one.
 *
 * The fix there had to be bolted on as a widening (`TruncationAwareQuery`)
 * because the port could not be changed. This port is new, so the honesty is in
 * the type from the start: `readShorts` returns `ShortsRead`, and
 * `read.shorts` does not compile until `read.complete` has been checked. A
 * caller cannot render a partial list as a total one by forgetting to look —
 * the old bug was not that somebody ignored a warning, it was that there was
 * nothing to ignore.
 *
 * `requireComplete` is here for the callers that genuinely cannot use partial
 * rows (an export, a count printed as a fact). It throws. That is the only
 * honest thing a function returning a bare array can do.
 *
 * WHAT IS NOT ON THIS PORT, DELIBERATELY
 *
 * There is no `downloadUrl` column, no `media_url`, and no method that would
 * store one. A direct media URL from any of these platforms is signed and
 * expires in minutes to hours; a table of them is a table of dead links that
 * look alive. `PlatformAdapter.downloadUrl` resolves one at the moment somebody
 * wants the file. The canonical post `url` on `ShortRecord` is what persists.
 */
import type { MeasurementCaveat } from "../platform/caveat";
import type { Platform, ShortRecord } from "../platform/types";

/**
 * The primary key, as one string.
 *
 * The separator is NUL because it is the one byte that cannot appear inside a
 * `platform_video_id`: Postgres `text` cannot hold it, and no platform issues
 * ids containing it. A `:` or a `/` would be readable and would also be
 * forgeable — an id containing the separator could be made to collide with a
 * different (platform, id) pair, which is a silent overwrite of one real row by
 * another. Readability is not worth that; nothing prints this value.
 */
export function shortKey(short: Pick<ShortRecord, "platform" | "platform_video_id">): string {
  return `${short.platform}\u0000${short.platform_video_id}`;
}

/**
 * What a read may narrow to.
 *
 * Both fields are PUSHED INTO THE QUERY by the Supabase implementation rather
 * than applied to the rows afterwards, and that is the other half of the scar
 * above: the old CSV export asked for an arbitrary 500-row window and THEN
 * filtered it to `approved` in JavaScript, so an approved channel outside the
 * window was silently absent from a file whose name said approved. A predicate
 * applied after a capped read is not a filter, it is a lottery.
 */
export interface ShortsFilter {
  readonly platform?: Platform;
  /**
   * Keep rows at or above this view count.
   *
   * A row whose `view_count` is null is EXCLUDED by this filter, because null
   * means "the source did not say" and an unknown number has not been shown to
   * clear a threshold. That is the same rule the run applies before it stores
   * anything (lib/shorts/run.ts), stated again here because a stored row is not
   * evidence that today's threshold is the one it passed — the threshold is
   * config and can be raised.
   */
  readonly minViews?: number;
}

/** Which table a read gave up on. A field so a truncation message can name it. */
export type ShortsTable = "shorts" | "unverified_shorts";

/** A read that stopped early, and everything a caller needs to say so out loud. */
export interface ShortsTruncation {
  readonly table: ShortsTable;
  readonly reason: "row-cap" | "request-budget";
  /** The ceiling that was hit: rows for `row-cap`, requests for `request-budget`. */
  readonly cap: number;
  /**
   * Rows actually returned. For a `row-cap` this is a little OVER the ceiling on
   * purpose — the read has to see a row past it to know there was one.
   */
  readonly rowsRead: number;
  /** One sentence, already fit to print on a page. */
  readonly message: string;
}

/**
 * The result of a read that knows whether it finished.
 *
 * The two branches deliberately do NOT share a field name for the rows, so
 * reaching for `shorts` on a possibly-truncated read is a compile error rather
 * than a wrong list on a screen.
 */
export type ShortsRead =
  | { readonly complete: true; readonly shorts: ShortRecord[] }
  | {
      readonly complete: false;
      readonly partial: ShortRecord[];
      readonly truncation: ShortsTruncation;
    };

/**
 * A short that could NOT be judged against both filters, as it is stored.
 *
 * It is a `ShortRecord` plus the two facts that say why it is unverified rather
 * than kept: which filters were unproven, and the caveat on any figure that is
 * not a plain measurement. These live in their own table (`unverified_shorts`),
 * never in `shorts`, so a ranking that trusts view counts never reads an
 * estimate — see the migration and lib/shorts/run.ts.
 */
export interface StoredUnverifiedShort extends ShortRecord {
  /** Which filters could not be evaluated ("views" | "duration"). Never empty. */
  readonly unproven: readonly string[];
  /** The health warning on an estimated or unusable figure, or null. */
  readonly measurement_caveat: MeasurementCaveat | null;
}

/** A read of the unverified table, with the same finished-or-not contract. */
export type UnverifiedRead =
  | { readonly complete: true; readonly shorts: StoredUnverifiedShort[] }
  | {
      readonly complete: false;
      readonly partial: StoredUnverifiedShort[];
      readonly truncation: ShortsTruncation;
    };

export class ShortsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortsStoreError";
  }
}

/** Thrown by `requireComplete`. Carries the truncation so a caller can print it. */
export class ShortsTruncatedError extends ShortsStoreError {
  constructor(readonly truncation: ShortsTruncation) {
    super(truncation.message);
    this.name = "ShortsTruncatedError";
  }
}

/**
 * The storage port. Two methods.
 *
 * There is no `delete`, no `setState`, no `approve`. This tool has one action
 * and shorts are observations, not decisions — the curation state machine that
 * used to live here is gone and is not coming back through the storage layer.
 */
export interface ShortsStore {
  /**
   * Write, keyed on (platform, platform_video_id).
   *
   * RE-RUNNING MUST NEVER DUPLICATE A ROW, and re-running is the normal case:
   * "get latest shorts" is pressed again tomorrow and most of yesterday's list
   * is still the latest. Implementations upsert on the primary key.
   *
   * A conflicting row is REPLACED rather than kept, because every field on a
   * short except its identity is an observation that moves — views climb,
   * titles get edited, a thumbnail is re-encoded. Keeping the first reading
   * would freeze the view counts at whenever the short was first seen while the
   * list went on claiming to be current. (The opposite choice was correct for a
   * channel's curation state in the code this replaces: a decision must not be
   * overwritten by a robot, an observation must.)
   */
  upsertShorts(records: readonly ShortRecord[]): Promise<void>;

  /**
   * Read, and say whether that was all of them.
   *
   * NO ORDER IS PROMISED beyond what the implementations happen to share: both
   * return rows in primary-key order, because that is the order the Supabase
   * one must page in, and having the in-memory one disagree would let a test
   * pass against an ordering production never produces. Primary-key order is
   * NOT a ranking. Sorting for a human — highest views first, grouped by
   * platform — happens in lib/shorts/run.ts over rows that have all arrived.
   */
  readShorts(filter?: ShortsFilter): Promise<ShortsRead>;

  /**
   * Write the rows a run could not judge, keyed on the same identity as a short.
   *
   * SEPARATE FROM `upsertShorts` AND FROM THE `shorts` TABLE, on purpose: the
   * whole reason these rows exist is that they were NOT measured, and the
   * measured table is what the auto-seed ranking trusts. Upserts on the primary
   * key, same replace-on-conflict rule as `upsertShorts` for the same reason.
   */
  upsertUnverified(records: readonly StoredUnverifiedShort[]): Promise<void>;

  /**
   * Read the unverified rows, and say whether that was all of them. Same
   * finished-or-not contract as `readShorts`, for the same PostgREST reason.
   */
  readUnverified(): Promise<UnverifiedRead>;
}

/**
 * The rows, or a refusal.
 *
 * For callers that state a fact from the result — a count, an export, "here are
 * the shorts over 500,000 views". Those callers have no way to caveat a bare
 * array, so handing them a partial one is handing them a wrong number with full
 * confidence. Callers that genuinely want the partial rows plus the notice use
 * `readShorts` directly and print the truncation beside them.
 */
export function requireComplete(read: ShortsRead): ShortRecord[] {
  if (!read.complete) throw new ShortsTruncatedError(read.truncation);
  return read.shorts;
}

/**
 * Primary-key order. Shared by both implementations so they cannot disagree.
 *
 * Sorts by `platform` first and `platform_video_id` second, which is the same
 * composite the Supabase reader pages by — and both columns are needed, which
 * is the whole point: `platform` alone has five distinct values across the
 * entire table, so range-paging over it would put tied rows on either side of a
 * page boundary and drop and repeat them with no error at all.
 */
export function primaryKeyOrder(records: readonly ShortRecord[]): ShortRecord[] {
  return [...records].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    if (a.platform_video_id === b.platform_video_id) return 0;
    return a.platform_video_id < b.platform_video_id ? -1 : 1;
  });
}

/** True when a stored row passes a filter. The ONE definition; both stores use it. */
export function matchesFilter(short: ShortRecord, filter: ShortsFilter = {}): boolean {
  if (filter.platform !== undefined && short.platform !== filter.platform) return false;
  if (filter.minViews !== undefined) {
    // Null is not zero and it is not "probably fine". An unknown view count has
    // not been shown to clear the threshold, so it does not.
    if (short.view_count === null) return false;
    if (short.view_count < filter.minViews) return false;
  }
  return true;
}
