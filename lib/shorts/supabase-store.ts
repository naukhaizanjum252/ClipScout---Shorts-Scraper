/**
 * The Supabase-backed `ShortsStore`.
 *
 * No decision logic is here. What is here is row I/O and the two places
 * PostgREST needs handling: upsert-on-conflict for the composite primary key,
 * and paging, because PostgREST truncates silently and the code this replaces
 * was caught by it.
 *
 * UNEXERCISED. The tool lives in the `shorts_scraper` schema of a database
 * shared with LookUp Media's other tools (Erik, 2026-09-02), but no project
 * reference has ever been handed over, so not one line below has spoken to
 * PostgREST. The tests beside this file drive it against a fake that imitates
 * PostgREST's `Max rows` behaviour; they prove the LOOP, they do not prove the
 * SERVER. Nothing here should be read as a claim about a live database.
 *
 * THE SCAR THIS FILE CARRIES FORWARD — DO NOT UNDO THE PAGING
 *
 * Inherited from lib/inventory/supabase-query.ts, which is deleted. PostgREST
 * caps every response at the project's `Max rows` — 1000 by default — and it
 * does that with a 200, a `Content-Range` header, and NO ERROR OBJECT. The
 * concrete failing input on that code was 8 channels x 137 uploads = 1096 rows:
 * `error` was null, the code believed it had the lot, and every median on the
 * page was computed from 1000 of 1096 rows. A wrong number that looks exactly
 * like a right one.
 *
 * That risk is HIGHER here, not lower. That page showed a median, which is
 * robust to losing a tail; this one shows the list itself, and the rows a
 * truncated read drops are the tail of the primary-key order — an arbitrary
 * slice of the product's entire output, missing with nothing on screen to say
 * so. So every read pages to the end or reports that it could not.
 *
 * WHY THE PAGING ORDER IS BOTH KEY COLUMNS AND NOT JUST `platform`
 *
 * `range()` paging over a non-unique order is free to place a tied row on
 * either side of a page boundary, which drops rows and repeats others while
 * reporting nothing. `platform` takes five distinct values across the whole
 * table, so ordering by it alone is very nearly ordering by nothing: it would
 * lose rows on every single boundary. The order is therefore the full primary
 * key, `platform` then `platform_video_id`, which is unique by construction.
 *
 * THAT ORDER IS FOR PAGING AND FOR NOTHING ELSE. The order a human sees —
 * highest views first, grouped by platform — is applied in lib/shorts/run.ts to
 * rows that have all arrived. It is tempting to ask the database for
 * `order("view_count", { ascending: false })` and skip the sort; that reorders
 * the pager onto a column that is neither unique nor even non-null, and
 * reintroduces exactly the silent row loss this header is about.
 */
import type { Platform, ShortRecord } from "../platform/types";
import type { TenantClient } from "../supabase/config";
import {
  ShortsStoreError,
  type ShortsFilter,
  type ShortsRead,
  type ShortsStore,
  type ShortsTable,
  type ShortsTruncation,
  type StoredUnverifiedShort,
  type UnverifiedRead,
} from "./store";

/** The table of measured shorts. */
export const SHORTS_TABLE = "shorts" as const;

/** The table of rows a run found but could not judge. Kept apart on purpose. */
export const UNVERIFIED_SHORTS_TABLE = "unverified_shorts" as const;

/**
 * Columns written to `unverified_shorts`: every short column, plus the two that
 * say why the row is here rather than in `shorts`. `measurement_caveat` is a
 * jsonb column, so the object is sent as-is; `unproven` is a text[].
 */
export const UNVERIFIED_COLUMNS = [
  ...([
    "platform",
    "platform_video_id",
    "url",
    "title",
    "creator_handle",
    "creator_id",
    "creator_url",
    "duration_seconds",
    "view_count",
    "like_count",
    "comment_count",
    "published_at",
    "thumbnail_url",
    "discovered_at",
    "discovered_by",
    "topic_slug",
  ] as const),
  "unproven",
  "measurement_caveat",
] as const satisfies readonly (keyof StoredUnverifiedShort)[];

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

/**
 * Columns written to `shorts`.
 *
 * THIS LIST IS A FILTER, WHICH MAKES OMISSION SILENT — and that is not a
 * hypothetical, it is a bug this repo already shipped once. The store this
 * replaces built each row with `Object.fromEntries(VIDEO_COLUMNS.map(...))`, so
 * a field present on the record type and absent from the list was dropped on
 * the way to the database with no error anywhere: no type complained, no test
 * that only inspected the record complained, and the column read back null
 * forever. `source_position` did exactly that, and the recency window it fed
 * would have degraded to an all-time median against a live database while every
 * test stayed green.
 *
 * Two independent guards now. `EVERY_SHORT_COLUMN_IS_WRITTEN` below fails
 * COMPILATION and names the missing field. supabase-store.test.ts compares the
 * keys actually sent to PostgREST against the keys of a real `ShortRecord`,
 * which also catches the reverse mistake of sending a column the table does not
 * have.
 *
 * THERE IS NO MEDIA OR DOWNLOAD COLUMN AND THERE MUST NOT BE ONE. A direct
 * media URL is signed and expires in minutes to hours; stored, it becomes a
 * dead link that looks alive. `PlatformAdapter.downloadUrl` resolves one when
 * somebody actually wants the file.
 */
export const SHORT_COLUMNS = [
  "platform",
  "platform_video_id",
  "url",
  "title",
  "creator_handle",
  "creator_id",
  "creator_url",
  "duration_seconds",
  "view_count",
  "like_count",
  "comment_count",
  "published_at",
  "thumbnail_url",
  "discovered_at",
  "discovered_by",
  "topic_slug",
] as const satisfies readonly (keyof ShortRecord)[];

type MissingColumn = Exclude<keyof ShortRecord, (typeof SHORT_COLUMNS)[number]>;

/**
 * A compile-time proof that every field of `ShortRecord` is written.
 *
 * Add a field to `ShortRecord` and forget this list, and the type of this
 * constant becomes the name of the field you forgot, `true` stops being
 * assignable to it, and `tsc` prints that name. It is deliberately an exported
 * value rather than a bare type alias, so nothing can prune it as unused.
 */
export const EVERY_SHORT_COLUMN_IS_WRITTEN: MissingColumn extends never ? true : MissingColumn = true;

/** PostgREST's conflict target. Must name the table's primary key, in order. */
export const CONFLICT_TARGET = "platform,platform_video_id";

/**
 * Rows per write request.
 *
 * One run of five platforms is small, but the URL and body limits are easier to
 * respect than to discover, and a chunked write is the same code at any size.
 */
export const WRITE_CHUNK_ROWS = 500;

// ---------------------------------------------------------------------------
// The ceilings
// ---------------------------------------------------------------------------

/**
 * Rows asked for per read request.
 *
 * 1000 because that is PostgREST's default `Max rows`, so a healthy page costs
 * one round trip. The pager does NOT assume the server honours it — an operator
 * can set that number lower, and a pager that treated "fewer rows than I asked
 * for" as "end of table" would reintroduce the exact silent truncation this
 * file exists to stop. See the stopping rule in `readPages`.
 */
export const READ_PAGE_ROWS = 1000;

/**
 * The row ceiling. NOT a capacity claim — nobody has measured a real run.
 *
 * It exists so a runaway read fails loudly instead of eating the request's
 * memory, and so a caller is told which read stopped and why.
 */
export const MAX_SHORT_ROWS = 50_000;

/**
 * A hard stop on requests per read, so the loop cannot spin forever.
 *
 * The row cap alone is not enough. A server answering every page with one row
 * would take this many requests to reach it, and a server answering with a page
 * that never advanced the offset would take infinitely many. The loop advances
 * by rows ACTUALLY RECEIVED, stops dead on an empty page, and is additionally
 * bounded by this count — three independent reasons it terminates. Exhausting
 * the budget is reported as truncation, never as success.
 */
export const MAX_REQUESTS_PER_READ = 512;

function truncationOf(
  table: ShortsTable,
  reason: ShortsTruncation["reason"],
  cap: number,
  rowsRead: number,
): ShortsTruncation {
  const why =
    reason === "row-cap"
      ? `hit its ${cap.toLocaleString("en")}-row ceiling`
      : `used all ${cap.toLocaleString("en")} of its requests`;
  return {
    table,
    reason,
    cap,
    rowsRead,
    message:
      `The ${table} read ${why} before reaching the end of the table, having read ` +
      `${rowsRead.toLocaleString("en")} rows. That is part of the table and not all of it, so a ` +
      `list, a count or an export taken from this read is missing shorts, and nothing on the ` +
      `page would show it.`,
  };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * The slice of PostgREST's builder the pager needs.
 *
 * Structural rather than imported: it says exactly what a query must be able to
 * do to be paged, and it lets the tests drive `readPages` with a fake that
 * imitates a `Max rows` cap without importing supabase-js.
 */
interface PagedQuery<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  range(from: number, to: number): PagedQuery<T>;
}

interface PagedResult<T> {
  readonly rows: T[];
  /** Null when the read reached the end of the table. */
  readonly truncation: ShortsTruncation | null;
}

/**
 * Read a table to the end, or say why it could not.
 *
 * `newQuery` must build a FRESH builder each call — every filter and both
 * `order()` clauses included — because `range()` mutates the builder it is
 * called on.
 *
 * THE STOPPING RULE IS THE SUBTLE PART. "Stop when a page comes back shorter
 * than I asked for" is wrong: if the project's `Max rows` is set below
 * `READ_PAGE_ROWS`, EVERY page is short and the read would stop after one of
 * them — the original bug, wearing a loop. So this stops on a page shorter than
 * the widest page the server has actually served in this read, and on an empty
 * page. The cost is one extra round trip on a table whose row count lands
 * exactly on a page boundary; the benefit is a pager that is correct without
 * knowing a server setting it cannot read.
 *
 * The ceiling is checked with `>` and not `>=`: a table holding exactly `cap`
 * rows has been read in full, and reporting that as truncated would refuse a
 * perfectly good list for no reason.
 */
async function readPages<T>(
  cap: number,
  newQuery: () => PagedQuery<T>,
  table: ShortsTable = SHORTS_TABLE,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let widestPage = 0;

  for (let request = 0; request < MAX_REQUESTS_PER_READ; request += 1) {
    const { data, error } = await newQuery().range(rows.length, rows.length + READ_PAGE_ROWS - 1);
    if (error) throw new ShortsStoreError(`${table}: ${error.message}`);

    const page = data ?? [];
    // An empty page is the only unambiguous end of the table, and it is also
    // what stops the offset standing still: every other continuation advances
    // by rows actually received, which is at least one.
    if (page.length === 0) return { rows, truncation: null };

    rows.push(...page);
    if (rows.length > cap) {
      return { rows, truncation: truncationOf(table, "row-cap", cap, rows.length) };
    }
    if (page.length < widestPage) return { rows, truncation: null };
    widestPage = page.length;
  }

  return {
    rows,
    truncation: truncationOf(table, "request-budget", MAX_REQUESTS_PER_READ, rows.length),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SupabaseShortsStore implements ShortsStore {
  constructor(private readonly client: TenantClient) {}

  /**
   * Upsert on the composite primary key, chunked.
   *
   * NOTE THE ABSENT `ignoreDuplicates`. The code this replaces used it for
   * channels and that was right there, because a channel's curation state was a
   * human decision and a second run must not overwrite it. Nothing on a
   * `ShortRecord` is a decision. Every field except the identity is an
   * observation that moves — views climb, titles are edited — so a conflicting
   * row is replaced, and the list stays as current as the last run that saw it.
   *
   * ONE CONSEQUENCE, STATED RATHER THAN HIDDEN: `discovered_at` and
   * `discovered_by` are overwritten too, so they mean "the most recent run that
   * saw this short", not "the first time we ever saw it". Nothing in the product
   * asks for first-seen today. If it ever does — "new since yesterday" is the
   * obvious feature — that is a separate column with a database default, which
   * a PostgREST upsert leaves alone because it only updates the columns the
   * payload actually carries. It is not this column quietly changing meaning.
   */
  async upsertShorts(records: readonly ShortRecord[]): Promise<void> {
    if (records.length === 0) return;

    const rows = records.map((record) =>
      Object.fromEntries(
        SHORT_COLUMNS.map((column) => [
          column,
          // `duration_seconds` IS AN INTEGER COLUMN AND SOME SOURCES SEND A
          // FRACTION. Instagram's `video_duration` is a float in seconds and
          // ScrapeCreators' Facebook reels give `play_time_in_ms`, which is
          // divided down; both produce values like 16.06599998474121. Postgres
          // rejects the whole statement with `invalid input syntax for type
          // integer`, and because the write is chunked and the error is caught
          // into `report.persistence`, ONE fractional row silently cost the
          // entire batch. Measured 2026-09-05: an Instagram run kept 224 rows,
          // wrote 0, and reported ok on screen.
          //
          // ROUNDED HERE AND NOT AT THE SOURCE, deliberately. The 120-second
          // Shorts ceiling is judged in memory against the real number, where
          // the fraction is more accurate; only the stored copy has to satisfy
          // the column. Rounding at each adapter would throw the precision away
          // before the ceiling was applied, and would have to be repeated for
          // every future source.
          column === "duration_seconds" && typeof record[column] === "number"
            ? Math.round(record[column] as number)
            : record[column],
        ]),
      ),
    );

    for (let i = 0; i < rows.length; i += WRITE_CHUNK_ROWS) {
      const { error } = await this.client
        .from(SHORTS_TABLE)
        .upsert(rows.slice(i, i + WRITE_CHUNK_ROWS), { onConflict: CONFLICT_TARGET });
      if (error) throw new ShortsStoreError(`upsertShorts: ${error.message}`);
    }
  }

  /**
   * Read to the end of the table, or hand back what arrived plus the reason it
   * stopped.
   *
   * Both filters are pushed INTO the query rather than applied to the rows
   * afterwards. That is not an optimisation, it is the correctness fix: a
   * predicate applied after a capped read filters an arbitrary window, so a
   * short that matches can sit outside the window and be absent from a list that
   * claims to contain it. `matchesFilter` is not re-applied here — the database
   * has already applied the same predicate, and a second pass in JavaScript
   * would hide a wrong clause rather than reveal one.
   *
   * `gte` on `view_count` also does the right thing with nulls without being
   * asked: SQL comparison with NULL is not true, so a short whose view count the
   * source never gave is excluded — which is the rule, because an unknown number
   * has not been shown to clear a threshold.
   */
  async readShorts(filter: ShortsFilter = {}): Promise<ShortsRead> {
    const read = await readPages<ShortRecord>(MAX_SHORT_ROWS, () => {
      let query = this.client
        .from(SHORTS_TABLE)
        .select("*")
        // Both key columns, in key order. See the header: one column is not a
        // unique order and range-paging over it drops and repeats rows.
        .order("platform", { ascending: true })
        .order("platform_video_id", { ascending: true });
      if (filter.platform !== undefined) query = query.eq("platform", filter.platform as Platform);
      if (filter.minViews !== undefined) query = query.gte("view_count", filter.minViews);
      return query as unknown as PagedQuery<ShortRecord>;
    });

    return read.truncation
      ? { complete: false, partial: read.rows, truncation: read.truncation }
      : { complete: true, shorts: read.rows };
  }

  /**
   * Write to `unverified_shorts`. Same shape as `upsertShorts` — chunked, and
   * `duration_seconds` rounded to satisfy the integer column when a source sends
   * a fraction — over a wider column set. `measurement_caveat` is jsonb and goes
   * as the object it is; `unproven` is a text[].
   */
  async upsertUnverified(records: readonly StoredUnverifiedShort[]): Promise<void> {
    if (records.length === 0) return;

    const rows = records.map((record) =>
      Object.fromEntries(
        UNVERIFIED_COLUMNS.map((column) => [
          column,
          column === "duration_seconds" && typeof record[column] === "number"
            ? Math.round(record[column] as number)
            : record[column],
        ]),
      ),
    );

    for (let i = 0; i < rows.length; i += WRITE_CHUNK_ROWS) {
      const { error } = await this.client
        .from(UNVERIFIED_SHORTS_TABLE)
        .upsert(rows.slice(i, i + WRITE_CHUNK_ROWS), { onConflict: CONFLICT_TARGET });
      if (error) throw new ShortsStoreError(`upsertUnverified: ${error.message}`);
    }
  }

  /**
   * Read `unverified_shorts` to the end, or say why it stopped — the same paging
   * and the same finished-or-not contract as `readShorts`. No `view_count`
   * filter: these rows are shown regardless of what their (often estimated)
   * views are, and many have none at all.
   */
  async readUnverified(): Promise<UnverifiedRead> {
    const read = await readPages<StoredUnverifiedShort>(MAX_SHORT_ROWS, () => {
      const query = this.client
        .from(UNVERIFIED_SHORTS_TABLE)
        .select("*")
        .order("platform", { ascending: true })
        .order("platform_video_id", { ascending: true });
      return query as unknown as PagedQuery<StoredUnverifiedShort>;
    }, UNVERIFIED_SHORTS_TABLE);

    return read.truncation
      ? { complete: false, partial: read.rows, truncation: read.truncation }
      : { complete: true, shorts: read.rows };
  }
}
