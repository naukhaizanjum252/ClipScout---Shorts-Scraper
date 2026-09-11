/**
 * Tests for the in-memory store, and through it for the identity rule.
 *
 * These are not tests of a test double. `MemoryShortsStore` is the only store
 * that can run today — no Supabase project has been handed over — so it is what
 * `scripts/latest.ts` writes through and what every run test persists into. Its
 * conflict behaviour is also the specification the Supabase upsert has to match:
 * if the two disagree, one of them is wrong about what re-running does, and the
 * one nobody can execute is the one that will stay wrong.
 *
 * THE FILTER IS TESTED HERE AND NOT ONLY IN THE SUPABASE STORE ON PURPOSE. The
 * Supabase one pushes the same predicate into SQL, where `view_count >= n` and
 * a NULL do the right thing for reasons that belong to SQL rather than to this
 * codebase. `matchesFilter` has to reach the same answer for reasons somebody
 * wrote down, and this is where that is checked.
 */
import { describe, expect, it } from "vitest";

import type { Platform, ShortRecord } from "../platform/types";
import { MemoryShortsStore } from "./memory-store";
import { matchesFilter, primaryKeyOrder, requireComplete, shortKey, ShortsTruncatedError } from "./store";

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

async function read(store: MemoryShortsStore, filter?: Parameters<MemoryShortsStore["readShorts"]>[0]) {
  return requireComplete(await store.readShorts(filter));
}

describe("identity", () => {
  it("writes one row when the same short arrives twice", async () => {
    // Re-running "get latest shorts" tomorrow re-reads most of today's list.
    // A store that appended would double the inventory every single day.
    const store = new MemoryShortsStore();
    await store.upsertShorts([aShort({ platform: "youtube", platform_video_id: "y1" })]);
    await store.upsertShorts([aShort({ platform: "youtube", platform_video_id: "y1" })]);
    expect(store.size).toBe(1);
    expect(await read(store)).toHaveLength(1);
  });

  it("treats the same id on two platforms as two shorts", async () => {
    // Identity is the PAIR. An Instagram shortcode and a YouTube id are both
    // 11 characters of different alphabets, so a collision is a matter of time,
    // and keying on the id alone would have one silently overwrite the other.
    const store = new MemoryShortsStore();
    await store.upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "abc123" }),
      aShort({ platform: "tiktok", platform_video_id: "abc123" }),
    ]);
    expect(store.size).toBe(2);
  });

  it("keys on both columns and nothing else", () => {
    const a = aShort({ platform: "youtube", platform_video_id: "1", view_count: 1 });
    const b = aShort({ platform: "youtube", platform_video_id: "1", view_count: 2, title: "changed" });
    expect(shortKey(a)).toBe(shortKey(b));
    expect(shortKey(a)).not.toBe(shortKey(aShort({ platform: "tiktok", platform_video_id: "1" })));
  });
});

describe("a conflicting row is replaced, not merged", () => {
  it("takes the newer view count", async () => {
    // Views climb. Keeping the first reading would pin the whole ranking to
    // whenever a short was first seen while the page went on calling itself
    // the latest.
    const store = new MemoryShortsStore();
    await store.upsertShorts([aShort({ platform: "youtube", platform_video_id: "y1", view_count: 600_000 })]);
    await store.upsertShorts([aShort({ platform: "youtube", platform_video_id: "y1", view_count: 900_000 })]);
    const [stored] = await read(store);
    expect(stored!.view_count).toBe(900_000);
  });

  it("drops a field the platform has since removed", async () => {
    // A merge would resurrect a title or a thumbnail that no longer exists,
    // and the row would keep asserting it forever.
    const store = new MemoryShortsStore();
    await store.upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "y1", title: "original", thumbnail_url: "https://t" }),
    ]);
    await store.upsertShorts([
      aShort({ platform: "youtube", platform_video_id: "y1", title: null, thumbnail_url: null }),
    ]);
    const [stored] = await read(store);
    expect(stored!.title).toBeNull();
    expect(stored!.thumbnail_url).toBeNull();
  });
});

describe("the filter", () => {
  const store = () =>
    new MemoryShortsStore([
      aShort({ platform: "youtube", platform_video_id: "y1", view_count: 900_000 }),
      aShort({ platform: "youtube", platform_video_id: "y2", view_count: 100_000 }),
      aShort({ platform: "tiktok", platform_video_id: "t1", view_count: 900_000 }),
      aShort({ platform: "tiktok", platform_video_id: "t2", view_count: null }),
    ]);

  it("narrows to one platform", async () => {
    const shorts = await read(store(), { platform: "tiktok" });
    expect(shorts.map((s) => s.platform_video_id)).toEqual(["t1", "t2"]);
  });

  it("keeps a row at exactly the threshold", async () => {
    const only = new MemoryShortsStore([
      aShort({ platform: "youtube", platform_video_id: "y1", view_count: 500_000 }),
    ]);
    expect(await read(only, { minViews: 500_000 })).toHaveLength(1);
  });

  it("excludes a row whose view count the source never gave", async () => {
    // Null is not zero and it is not "probably fine". An unknown number has not
    // been shown to clear a threshold, and a stored row is not evidence that
    // today's threshold is the one it passed — the threshold is config and can
    // be raised.
    const shorts = await read(store(), { minViews: 500_000 });
    expect(shorts.map((s) => s.platform_video_id)).toEqual(["t1", "y1"]);
    expect(matchesFilter(aShort({ platform: "x", platform_video_id: "n", view_count: null }), { minViews: 1 })).toBe(
      false,
    );
  });

  it("applies both narrowings together", async () => {
    const shorts = await read(store(), { platform: "youtube", minViews: 500_000 });
    expect(shorts.map((s) => s.platform_video_id)).toEqual(["y1"]);
  });
});

describe("ordering", () => {
  it("reads back in primary-key order so the two stores cannot disagree", async () => {
    // Not a ranking — the human ordering (views, grouped by platform) is applied
    // in lib/shorts/run.ts. This exists because the Supabase store MUST page in
    // primary-key order, and an in-memory store that returned insertion order
    // would let a test pass against an ordering production never produces.
    const store = new MemoryShortsStore([
      aShort({ platform: "tiktok", platform_video_id: "b" }),
      aShort({ platform: "youtube", platform_video_id: "a" }),
      aShort({ platform: "tiktok", platform_video_id: "a" }),
    ]);
    expect((await read(store)).map(shortKey)).toEqual(
      primaryKeyOrder([
        aShort({ platform: "tiktok", platform_video_id: "a" }),
        aShort({ platform: "tiktok", platform_video_id: "b" }),
        aShort({ platform: "youtube", platform_video_id: "a" }),
      ]).map(shortKey),
    );
  });

  it("orders by platform first and then by id", () => {
    const ordered = primaryKeyOrder([
      aShort({ platform: "youtube", platform_video_id: "a" }),
      aShort({ platform: "tiktok", platform_video_id: "z" }),
      aShort({ platform: "tiktok", platform_video_id: "a" }),
    ]);
    expect(ordered.map((s) => `${s.platform}/${s.platform_video_id}`)).toEqual([
      "tiktok/a",
      "tiktok/z",
      "youtube/a",
    ]);
  });
});

describe("completeness", () => {
  it("reports a read as complete, because there is nothing here that could truncate", async () => {
    // A claim this implementation can honestly make: no server, no row cap, no
    // request budget. It is exactly why the Supabase one may not copy it.
    const store = new MemoryShortsStore([aShort({ platform: "youtube", platform_video_id: "y1" })]);
    expect((await store.readShorts()).complete).toBe(true);
  });

  it("requireComplete throws on a truncated read rather than returning a short list", async () => {
    // The only honest thing a function returning a bare array can do.
    const truncation = {
      table: "shorts",
      reason: "row-cap",
      cap: 10,
      rowsRead: 11,
      message: "partial",
    } as const;
    expect(() => requireComplete({ complete: false, partial: [], truncation })).toThrow(ShortsTruncatedError);
  });
});

describe("counting", () => {
  it("counts writes, so a run that did not persist cannot look like one that did", async () => {
    const store = new MemoryShortsStore();
    expect(store.writes).toBe(0);
    await store.upsertShorts([]);
    expect(store.writes).toBe(1);
  });

  it("holds one row per (platform, id) across every platform", async () => {
    const store = new MemoryShortsStore();
    const platforms: Platform[] = ["youtube", "tiktok", "instagram", "x", "facebook"];
    await store.upsertShorts(platforms.map((platform) => aShort({ platform, platform_video_id: "same" })));
    expect(store.size).toBe(5);
  });
});
