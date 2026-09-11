/**
 * Tests for the Supabase store.
 *
 * THESE EXIST BECAUSE OF WHAT PostgREST DOES WHEN IT TRUNCATES: it answers 200,
 * sets a `Content-Range` header, and returns NO ERROR OBJECT. The code this
 * replaces read a table with no limit and no paging and checked `error`, which
 * is null in exactly that case, so 1096 rows arrived as 1000 and every median on
 * the review queue was computed from a partial set. Nothing went red. Nothing
 * looked wrong.
 *
 * So the fake below imitates the TRUNCATION rather than an error: `maxRows` caps
 * every response silently, the way a real project's `Max rows` setting does.
 *
 * THE FAKE ALSO REFUSES TO ORDER ROWS FAITHFULLY UNLESS THE ORDER IS UNIQUE.
 * Rows tied on the columns the query ordered by are rotated, differently on each
 * request. That is not spite — Postgres makes no promise about the order of tied
 * rows, and `range()` paging over a non-unique order genuinely drops rows and
 * repeats others. It matters more here than it did on the code this came from,
 * because `platform` has five distinct values across the whole table: a pager
 * ordered by it alone is ordered by almost nothing. A fake that always returned
 * insertion order would pass with the second `order()` clause deleted, which is
 * the one thing this file must not do.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the paging loop, the
 * filter push-down, the ceilings, the truncation signal and the exact shape of
 * the write, against a server that behaves the way the PostgREST documentation
 * says it behaves. It proves nothing about a real database — none has ever been
 * pointed at this code — and nothing about whether the `shorts` table exists,
 * whether `shorts_scraper` is on the project's exposed-schemas list, or whether
 * the role may write. No assertion below is evidence about a live system.
 */
import { describe, expect, it } from "vitest";

import type { Platform, ShortRecord } from "../platform/types";
import type { TenantClient } from "../supabase/config";
import { requireComplete, ShortsStoreError, ShortsTruncatedError, shortKey } from "./store";
import {
  CONFLICT_TARGET,
  MAX_REQUESTS_PER_READ,
  MAX_SHORT_ROWS,
  READ_PAGE_ROWS,
  SHORT_COLUMNS,
  SHORTS_TABLE,
  SupabaseShortsStore,
  UNVERIFIED_COLUMNS,
  UNVERIFIED_SHORTS_TABLE,
  WRITE_CHUNK_ROWS,
} from "./supabase-store";
import type { StoredUnverifiedShort } from "./store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIVE: readonly Platform[] = ["youtube", "tiktok", "instagram", "x", "facebook"];

function aShort(over: Partial<ShortRecord> & Pick<ShortRecord, "platform" | "platform_video_id">): ShortRecord {
  return {
    url: `https://example.test/${over.platform}/${over.platform_video_id}`,
    title: null,
    creator_handle: null,
    creator_id: null,
    creator_url: null,
    duration_seconds: 30,
    view_count: 800_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-04T00:00:00.000Z",
    discovered_by: "test",
    topic_slug: null,
    ...over,
  };
}

/**
 * `count` shorts spread across all five platforms.
 *
 * Spread on purpose: a table whose rows all share one `platform` would let a
 * pager ordered by `platform` alone look fine, because with one value there are
 * no page boundaries between distinct values to lose rows at. Five values across
 * thousands of rows is what makes the tie-rotation bite.
 */
function manyShorts(count: number): ShortRecord[] {
  return Array.from({ length: count }, (_, i) =>
    aShort({
      platform: FIVE[i % FIVE.length]!,
      // Zero-padded so lexicographic order — which is what Postgres does to a
      // text column and what the fake does — is stable and predictable.
      platform_video_id: String(i).padStart(6, "0"),
      view_count: 500_000 + i,
    }),
  );
}

// ---------------------------------------------------------------------------
// A fake PostgREST
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };

interface RecordedRead {
  readonly table: string;
  readonly columns: string;
  /** Order columns, in the order they were applied. */
  readonly order: readonly string[];
  readonly eq: ReadonlyArray<readonly [string, unknown]>;
  readonly gte: ReadonlyArray<readonly [string, unknown]>;
  readonly from: number;
  readonly to: number;
}

interface RecordedWrite {
  readonly table: string;
  readonly rows: Row[];
  readonly options: Record<string, unknown> | undefined;
}

/** A table with no end, generated per request so the test costs no memory. */
interface EndlessTable {
  readonly endless: true;
  row(index: number): Row;
}

function isEndless(table: Row[] | EndlessTable): table is EndlessTable {
  return !Array.isArray(table);
}

class FakePostgrest {
  readonly reads: RecordedRead[] = [];
  readonly writes: RecordedWrite[] = [];

  /** Set to make the NEXT call answer the way PostgREST answers a refusal. */
  failWith: string | null = null;

  constructor(
    private readonly tables: Record<string, Row[] | EndlessTable>,
    /** The project's `Max rows`. Caps every response, silently, like the real one. */
    private readonly maxRows = 1000,
  ) {}

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  /** The client, as far as the code under test is concerned. */
  asClient(): TenantClient {
    return this as unknown as TenantClient;
  }

  private take(): { message: string } | null {
    if (this.failWith === null) return null;
    const message = this.failWith;
    this.failWith = null;
    return { message };
  }

  /**
   * Order the way Postgres is ALLOWED to, not the way it is convenient to.
   *
   * Rows are sorted by the requested columns; rows tied on all of them are then
   * rotated by the request number. With a unique order there are no ties and
   * this is a plain sort. With a non-unique one — `platform` alone, or no
   * `order()` at all — the same row lands on different pages on different
   * requests, which is exactly the row loss a real server produces.
   */
  private arrange(rows: readonly Row[], order: readonly string[], request: number): Row[] {
    const sorted = [...rows].sort((a, b) => {
      for (const column of order) {
        const left = String(a[column] ?? "");
        const right = String(b[column] ?? "");
        if (left !== right) return left < right ? -1 : 1;
      }
      return 0;
    });

    const out: Row[] = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (
        j < sorted.length &&
        order.every((column) => String(sorted[j]![column] ?? "") === String(sorted[i]![column] ?? ""))
      ) {
        j += 1;
      }
      const group = sorted.slice(i, j);
      const by = group.length > 1 ? request % group.length : 0;
      out.push(...group.slice(by), ...group.slice(0, by));
      i = j;
    }
    return out;
  }

  executeRead(read: RecordedRead): Answer {
    const request = this.reads.length;
    this.reads.push(read);

    const error = this.take();
    if (error) return { data: null, error };

    const table = this.tables[read.table] ?? [];
    const span = Math.min(read.to - read.from + 1, this.maxRows);
    if (span <= 0) return { data: [], error: null };

    if (isEndless(table)) {
      return {
        data: Array.from({ length: span }, (_, i) => table.row(read.from + i)),
        error: null,
      };
    }

    const filtered = table.filter(
      (row) =>
        read.eq.every(([column, value]) => row[column] === value) &&
        read.gte.every(([column, value]) => Number(row[column]) >= Number(value) && row[column] !== null),
    );
    const arranged = this.arrange(filtered, read.order, request);
    return { data: arranged.slice(read.from, read.from + span), error: null };
  }

  executeWrite(write: RecordedWrite): Answer {
    this.writes.push(write);
    const error = this.take();
    return error ? { data: null, error } : { data: null, error: null };
  }
}

/**
 * The builder.
 *
 * Its state fields are named `orderColumns`, `eqClauses` and so on rather than
 * `order`, `eq` and `gte`, which is not style: a class field and a prototype
 * method of the same name are the same property, and the field wins. Calling
 * them the obvious thing makes `.select(...).order(...)` a TypeError at runtime
 * while the types stay perfectly happy.
 */
class FakeQuery implements PromiseLike<Answer> {
  private columns = "*";
  private readonly orderColumns: string[] = [];
  private readonly eqClauses: Array<readonly [string, unknown]> = [];
  private readonly gteClauses: Array<readonly [string, unknown]> = [];
  private rangeFrom = 0;
  private rangeTo = Number.MAX_SAFE_INTEGER;
  private write: RecordedWrite | null = null;

  constructor(
    private readonly server: FakePostgrest,
    private readonly table: string,
  ) {}

  select(columns: string): this {
    this.columns = columns;
    return this;
  }

  order(column: string, _options?: { ascending?: boolean }): this {
    this.orderColumns.push(column);
    return this;
  }

  eq(column: string, value: unknown): this {
    this.eqClauses.push([column, value]);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.gteClauses.push([column, value]);
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  upsert(rows: Row[], options?: Record<string, unknown>): this {
    this.write = { table: this.table, rows, options };
    return this;
  }

  then<A = Answer, B = never>(
    onfulfilled?: ((value: Answer) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const answer = this.write
      ? this.server.executeWrite(this.write)
      : this.server.executeRead({
          table: this.table,
          columns: this.columns,
          order: [...this.orderColumns],
          eq: [...this.eqClauses],
          gte: [...this.gteClauses],
          from: this.rangeFrom,
          to: this.rangeTo,
        });
    return Promise.resolve(answer).then(onfulfilled, onrejected);
  }
}

function serverWith(shorts: readonly ShortRecord[], maxRows = 1000): FakePostgrest {
  return new FakePostgrest({ [SHORTS_TABLE]: shorts.map((s) => ({ ...s })) }, maxRows);
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe("every read is paged to the end", () => {
  it("reads a table larger than one page, exactly once each", async () => {
    // 2500 rows through a 1000-row cap. This is the shape of the original bug:
    // an unpaged read would return 1000 with `error: null` and look finished.
    const shorts = manyShorts(2500);
    const server = serverWith(shorts);
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();
    const got = requireComplete(read);

    expect(got).toHaveLength(2500);
    expect(new Set(got.map(shortKey)).size).toBe(2500);
    expect(server.reads.length).toBeGreaterThan(1);
  });

  it("reads everything from a server whose Max rows is set below the page size", async () => {
    // THE SUBTLE ONE. "Stop when a page comes back shorter than I asked for" is
    // wrong: with `Max rows` at 200 every page is short, so that rule stops
    // after the first — the original bug, wearing a loop. An operator can set
    // this number and the pager cannot read the setting.
    const shorts = manyShorts(1000);
    const server = serverWith(shorts, 200);
    const got = requireComplete(await new SupabaseShortsStore(server.asClient()).readShorts());

    expect(got).toHaveLength(1000);
    expect(new Set(got.map(shortKey)).size).toBe(1000);
  });

  it("stops on the empty page rather than assuming a full page means more", async () => {
    // A table whose row count lands exactly on a page boundary costs one extra
    // round trip and must not report truncation for it.
    const shorts = manyShorts(READ_PAGE_ROWS);
    const server = serverWith(shorts);
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();

    expect(read.complete).toBe(true);
    if (!read.complete) throw new Error("unreachable");
    expect(read.shorts).toHaveLength(READ_PAGE_ROWS);
    expect(server.reads).toHaveLength(2);
  });

  it("reads an empty table in one request", async () => {
    const server = serverWith([]);
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();
    expect(requireComplete(read)).toEqual([]);
    expect(server.reads).toHaveLength(1);
  });
});

describe("the paging order is the whole primary key", () => {
  it("orders by platform and then by platform_video_id, in that order", async () => {
    // Both columns, and `platform` first. Asserted directly as well as through
    // the row-loss test below, because the fake can only punish a missing order
    // when there are enough tied rows to page across.
    const server = serverWith(manyShorts(10));
    await new SupabaseShortsStore(server.asClient()).readShorts();
    expect(server.reads[0]!.order).toEqual(["platform", "platform_video_id"]);
  });

  it("comes back in primary-key order", async () => {
    const server = serverWith(manyShorts(1500));
    const got = requireComplete(await new SupabaseShortsStore(server.asClient()).readShorts());
    const keys = got.map(shortKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("a read that could not finish says so", () => {
  it("reports the row ceiling instead of handing back a partial list as whole", async () => {
    const server = new FakePostgrest(
      { [SHORTS_TABLE]: { endless: true, row: (i) => ({ ...aShort({ platform: "youtube", platform_video_id: String(i).padStart(9, "0") }) }) } },
      READ_PAGE_ROWS,
    );
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();

    expect(read.complete).toBe(false);
    if (read.complete) throw new Error("unreachable");
    expect(read.truncation.reason).toBe("row-cap");
    expect(read.truncation.cap).toBe(MAX_SHORT_ROWS);
    expect(read.truncation.rowsRead).toBeGreaterThan(MAX_SHORT_ROWS);
    // The message has to be printable as it stands: nobody will write a better
    // one at the call site, and the alternative is a silent partial list.
    expect(read.truncation.message).toContain("part of the table and not all of it");
    // And the partial rows are still there, for a caller that wants to show them
    // BESIDE the notice rather than instead of it.
    expect(read.partial.length).toBeGreaterThan(MAX_SHORT_ROWS);
  });

  it("reports the request budget when a server dribbles rows one at a time", async () => {
    // The row cap alone is not enough: a server answering one row per page
    // would take 50,000 requests to reach it. Three independent stopping
    // conditions, and exhausting the budget is truncation, never success.
    const server = new FakePostgrest(
      { [SHORTS_TABLE]: { endless: true, row: (i) => ({ ...aShort({ platform: "youtube", platform_video_id: String(i) }) }) } },
      1,
    );
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();

    expect(read.complete).toBe(false);
    if (read.complete) throw new Error("unreachable");
    expect(read.truncation.reason).toBe("request-budget");
    expect(read.truncation.cap).toBe(MAX_REQUESTS_PER_READ);
    expect(server.reads).toHaveLength(MAX_REQUESTS_PER_READ);
  });

  it("refuses through requireComplete, for callers that state a fact", async () => {
    const server = new FakePostgrest(
      { [SHORTS_TABLE]: { endless: true, row: (i) => ({ ...aShort({ platform: "youtube", platform_video_id: String(i) }) }) } },
      READ_PAGE_ROWS,
    );
    const read = await new SupabaseShortsStore(server.asClient()).readShorts();
    expect(() => requireComplete(read)).toThrow(ShortsTruncatedError);
  });

  it("turns a real PostgREST error into a ShortsStoreError naming the table", async () => {
    const server = serverWith(manyShorts(5));
    server.failWith = "PGRST106: the schema must be added to Exposed schemas";
    await expect(new SupabaseShortsStore(server.asClient()).readShorts()).rejects.toThrow(ShortsStoreError);
  });
});

// ---------------------------------------------------------------------------
// Filter push-down
// ---------------------------------------------------------------------------

describe("filters are pushed into the query, not applied afterwards", () => {
  it("sends the platform as an eq clause", async () => {
    // A predicate applied after a capped read filters an arbitrary window, so a
    // matching row can sit outside the window and be absent from a list that
    // claims to contain it. That is how the old CSV export lost approved
    // channels.
    const server = serverWith(manyShorts(20));
    const got = requireComplete(
      await new SupabaseShortsStore(server.asClient()).readShorts({ platform: "tiktok" }),
    );
    expect(server.reads[0]!.eq).toEqual([["platform", "tiktok"]]);
    expect(got.every((s) => s.platform === "tiktok")).toBe(true);
    expect(got.length).toBeGreaterThan(0);
  });

  it("sends the view threshold as a gte clause", async () => {
    const server = serverWith([
      aShort({ platform: "youtube", platform_video_id: "a", view_count: 900_000 }),
      aShort({ platform: "youtube", platform_video_id: "b", view_count: 100_000 }),
    ]);
    const got = requireComplete(
      await new SupabaseShortsStore(server.asClient()).readShorts({ minViews: 500_000 }),
    );
    expect(server.reads[0]!.gte).toEqual([["view_count", 500_000]]);
    expect(got.map((s) => s.platform_video_id)).toEqual(["a"]);
  });

  it("does not send a clause that was not asked for", async () => {
    const server = serverWith(manyShorts(3));
    await new SupabaseShortsStore(server.asClient()).readShorts();
    expect(server.reads[0]!.eq).toEqual([]);
    expect(server.reads[0]!.gte).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

describe("the write", () => {
  it("upserts on the composite primary key so a re-run cannot duplicate a row", async () => {
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "y1" }),
    ]);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.table).toBe(SHORTS_TABLE);
    expect(server.writes[0]!.options).toEqual({ onConflict: CONFLICT_TARGET });
    expect(CONFLICT_TARGET).toBe("platform,platform_video_id");
  });

  it("does NOT pass ignoreDuplicates, because a short's numbers are observations", async () => {
    // The opposite choice was right for a channel's curation state in the code
    // this replaces: a human decision must not be overwritten by a robot. Views
    // climb, and a frozen view count would pin the ranking to the first sighting
    // while the list went on calling itself the latest.
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "y1" }),
    ]);
    expect(server.writes[0]!.options).not.toHaveProperty("ignoreDuplicates");
  });

  it("sends exactly the fields of a ShortRecord — no more and no fewer", async () => {
    // THE SCAR. The store this replaces built rows from a hand-written column
    // list, so a field on the record and not on the list was dropped on the way
    // to the database with no error anywhere: no type complained, no test
    // complained, and the column read back null forever. `source_position` did
    // exactly that. Comparing against a real record is what catches the next one.
    const record = aShort({ platform: "youtube", platform_video_id: "y1" });
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts([record]);

    expect(Object.keys(server.writes[0]!.rows[0]!).sort()).toEqual(Object.keys(record).sort());
    expect([...SHORT_COLUMNS].sort()).toEqual(Object.keys(record).sort());
  });

  it("never sends a media or download column", async () => {
    // A direct media URL is signed and expires in minutes to hours. Stored, it
    // is a dead link that looks alive — the worst failure available, because
    // nothing about the row says it has rotted until somebody clicks it.
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "y1" }),
    ]);
    const sent = Object.keys(server.writes[0]!.rows[0]!);
    expect(sent).not.toContain("download_url");
    expect(sent).not.toContain("media_url");
    expect(sent).toContain("url");
  });

  it("chunks a large write", async () => {
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts(manyShorts(WRITE_CHUNK_ROWS * 2 + 1));
    expect(server.writes.map((w) => w.rows.length)).toEqual([WRITE_CHUNK_ROWS, WRITE_CHUNK_ROWS, 1]);
  });

  it("makes no request at all for an empty write", async () => {
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertShorts([]);
    expect(server.writes).toHaveLength(0);
  });

  it("turns a refused write into a ShortsStoreError", async () => {
    const server = serverWith([]);
    server.failWith = "new row violates row-level security policy";
    await expect(
      new SupabaseShortsStore(server.asClient()).upsertShorts([
        aShort({ platform: "youtube", platform_video_id: "y1" }),
      ]),
    ).rejects.toThrow(ShortsStoreError);
  });
});

// ---------------------------------------------------------------------------
// The unverified table
// ---------------------------------------------------------------------------

function anUnverified(
  over: Partial<StoredUnverifiedShort> & Pick<StoredUnverifiedShort, "platform" | "platform_video_id">,
): StoredUnverifiedShort {
  return {
    ...aShort(over),
    unproven: ["duration"],
    measurement_caveat: null,
    ...over,
  };
}

describe("the unverified table is written and read apart from the measured one", () => {
  it("writes to unverified_shorts, never to shorts, on the same primary key", async () => {
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertUnverified([
      anUnverified({ platform: "instagram", platform_video_id: "ig1" }),
    ]);

    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]!.table).toBe(UNVERIFIED_SHORTS_TABLE);
    expect(server.writes[0]!.table).not.toBe(SHORTS_TABLE);
    expect(server.writes[0]!.options).toEqual({ onConflict: CONFLICT_TARGET });
  });

  it("sends exactly the fields of a StoredUnverifiedShort — the same scar guard as `shorts`", async () => {
    // A field on the record and off the column list is dropped silently — the
    // `source_position` bug. This is the unverified table's copy of that guard,
    // and it is what would fail the day `unproven` or `measurement_caveat` was
    // added to the type and forgotten in the column list.
    const record = anUnverified({ platform: "instagram", platform_video_id: "ig1" });
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertUnverified([record]);

    expect(Object.keys(server.writes[0]!.rows[0]!).sort()).toEqual(Object.keys(record).sort());
    expect([...UNVERIFIED_COLUMNS].sort()).toEqual(Object.keys(record).sort());
  });

  it("rounds a fractional duration to satisfy the integer column", async () => {
    // Instagram's `video_duration` is a float; the measured table already rounds
    // it (an unrounded row once failed a whole batch), and this table takes the
    // same rows, so it must round too.
    const server = serverWith([]);
    await new SupabaseShortsStore(server.asClient()).upsertUnverified([
      anUnverified({ platform: "instagram", platform_video_id: "ig1", duration_seconds: 41.5 }),
    ]);
    expect(server.writes[0]!.rows[0]!.duration_seconds).toBe(42);
  });

  it("reads unverified_shorts and keeps the unproven and caveat fields intact", async () => {
    const stored = anUnverified({
      platform: "instagram",
      platform_video_id: "ig1",
      view_count: 2_000_000,
      unproven: ["duration"],
      measurement_caveat: { field: "view_count", basis: "derived", reportedValue: null, note: "≈" },
    });
    const server = new FakePostgrest({ [UNVERIFIED_SHORTS_TABLE]: [{ ...stored } as unknown as Row] });

    const read = await new SupabaseShortsStore(server.asClient()).readUnverified();
    if (!read.complete) throw new Error("unreachable");
    expect(read.shorts).toHaveLength(1);
    expect(read.shorts[0]!.unproven).toEqual(["duration"]);
    expect(read.shorts[0]!.measurement_caveat?.basis).toBe("derived");
    // Read in primary-key order, like the measured table, for the same reason.
    expect(server.reads[0]!.order).toEqual(["platform", "platform_video_id"]);
  });
});
