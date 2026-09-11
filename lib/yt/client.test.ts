import { describe, expect, it, vi } from "vitest";

import { COSTS, declaredSeededEnumerationUnits, declaredUnits, OPERATIONS } from "./cost";
import { BudgetExhaustedError, QuotaExceededError, YouTubeApiError, YouTubeClient, redact } from "./client";

const KEY = "test-key-not-a-real-credential";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof globalThis.fetch, budgetUnits: number | null = null) {
  return new YouTubeClient({
    apiKey: KEY,
    fetch: fetchImpl,
    budgetUnits,
    sleep: async () => {},
    now: (() => {
      let t = 1_000;
      return () => (t += 5);
    })(),
  });
}

describe("cost table", () => {
  it("declares a positive cost and a page size for every operation", () => {
    for (const op of OPERATIONS) {
      expect(COSTS[op].declaredUnits).toBeGreaterThan(0);
      expect(COSTS[op].maxPageSize).toBeGreaterThan(0);
      // The discipline this asserts is that every declared figure names itself
      // as documentation. That labelling is what made the 2026-09-04 quota
      // correction catchable at all — a number presented as fact would have had
      // nowhere honest to be corrected. Matched loosely on purpose: the wording
      // of the source string belongs to lib/yt/cost.ts, the admission does not.
      expect(COSTS[op].declaredSource).toMatch(/not\s+(a\s+)?measure/i);
    }
  });

  it("prices a seeded enumeration as one list page plus one hydrate page per 50", () => {
    // The arithmetic the whole seeded/autonomous split rests on.
    expect(declaredSeededEnumerationUnits(0)).toBe(1);
    expect(declaredSeededEnumerationUnits(1)).toBe(2);
    expect(declaredSeededEnumerationUnits(50)).toBe(2);
    expect(declaredSeededEnumerationUnits(51)).toBe(4);
    expect(declaredSeededEnumerationUnits(137)).toBe(6);
  });

  it("refuses a negative video count rather than returning a negative cost", () => {
    expect(() => declaredSeededEnumerationUnits(-1)).toThrow(RangeError);
  });
});

describe("YouTubeClient budget", () => {
  it("charges the declared cost of every call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    await c.call("videos.list", { part: "id" });
    await c.call("search.list", { part: "id" });
    expect(c.spentUnits).toBe(declaredUnits("videos.list") + declaredUnits("search.list"));
  });

  it("stops BEFORE the call that would exceed the budget, and sends nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    // One unit short of what the operation declares, whatever that happens to
    // be. Pinning a literal here would make this a test of the price rather
    // than of the stop, and the price is documentation that can change under us.
    const c = client(fetchImpl as unknown as typeof globalThis.fetch, declaredUnits("search.list") - 1);
    await expect(c.call("search.list", { part: "id" })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(c.spentUnits).toBe(0);
  });

  it("reports what is left, and refuses the call that no longer fits", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    const budget = declaredUnits("videos.list") + declaredUnits("playlistItems.list");
    const c = client(fetchImpl as unknown as typeof globalThis.fetch, budget);
    await c.call("videos.list", { part: "id" });
    expect(c.remainingUnits).toBe(declaredUnits("playlistItems.list"));
    expect(c.canAfford("playlistItems.list")).toBe(true);
    await c.call("playlistItems.list", { part: "id" });
    expect(c.remainingUnits).toBe(0);
    expect(c.canAfford("playlistItems.list")).toBe(false);
  });

  it("counts search.list in units like anything else — it cannot see the 100-call bucket", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    const calls = 200;
    const c = client(fetchImpl as unknown as typeof globalThis.fetch, calls * declaredUnits("search.list"));
    for (let i = 0; i < calls; i++) await c.call("search.list", { part: "id" });

    // 200 is twice the documented daily ceiling for `search.list`, which lives
    // in a bucket of its own at 100 CALLS a day — not units — per Google's
    // quota-cost table (developers.google.com/youtube/v3/determine_quota_cost,
    // fetched 2026-09-04). The client raised no objection, because it counts
    // units and every operation costs the same. This test characterises the
    // gap rather than endorsing it: nothing in this repo issues a search.list,
    // and the seeded path exists so nothing has to. If a caller ever does, it
    // needs a per-bucket call counter, and this is the test that will fail and
    // say so.
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
    expect(c.spentUnits).toBe(calls * declaredUnits("search.list"));
  });
});

describe("YouTubeClient error handling", () => {
  it("treats 403 quotaExceeded as terminal and does not retry it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } },
        403,
      ),
    );
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    await expect(c.call("videos.list", { part: "id" })).rejects.toBeInstanceOf(QuotaExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ error: { message: "slow down", errors: [{ reason: "rateLimitExceeded" }] } }, 429, {
            "retry-after": "1",
          })
        : jsonResponse({ items: [{ id: "x" }] });
    });
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    const body = await c.call<{ items: unknown[] }>("videos.list", { part: "id" });
    expect(body.items).toHaveLength(1);
    expect(calls).toBe(2);
    // A retry does not cost a second unit charge: the budget was charged once,
    // up front, and the API charges the units either way.
    expect(c.spentUnits).toBe(1);
  });

  it("gives up on a 400 immediately", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "bad", errors: [{ reason: "invalidParameter" }] } }, 400),
    );
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    await expect(c.call("videos.list", { part: "id" })).rejects.toBeInstanceOf(YouTubeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("YouTubeClient ledger and secrecy", () => {
  it("records evidence of each call without recording any parameter VALUE", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ id: "a" }], pageInfo: { totalResults: 7 }, nextPageToken: "n" }),
    );
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    await c.call("playlistItems.list", { part: "contentDetails", playlistId: "UU_secretish_value" });
    const [record] = c.calls;
    expect(record.operation).toBe("playlistItems.list");
    expect(record.items).toBe(1);
    expect(record.totalResults).toBe(7);
    expect(record.hasNextPage).toBe(true);
    expect(record.paramNames).toEqual(["part", "playlistId"]);
    // The whole ledger is committed to the repo as evidence, so it must carry
    // names and never values.
    expect(JSON.stringify(c.calls)).not.toContain("UU_secretish_value");
    expect(JSON.stringify(c.calls)).not.toContain(KEY);
  });

  it("redacts the key out of any URL a human might see", () => {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=id&key=${KEY}`;
    expect(redact(url)).toContain("key=REDACTED");
    expect(redact(url)).not.toContain(KEY);
  });
});

describe("YouTubeClient pagination", () => {
  it("follows nextPageToken and stops at the limit", async () => {
    const pages = [
      { items: [{ id: 1 }, { id: 2 }], nextPageToken: "p2" },
      { items: [{ id: 3 }, { id: 4 }], nextPageToken: "p3" },
      { items: [{ id: 5 }] },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(pages[i++]));
    const c = client(fetchImpl as unknown as typeof globalThis.fetch);
    const out: unknown[] = [];
    for await (const item of c.paginate("playlistItems.list", { part: "contentDetails" }, 5)) out.push(item);
    expect(out).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops cleanly on the budget instead of throwing mid-walk", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [{ id: 1 }], nextPageToken: "next" }));
    const c = client(fetchImpl as unknown as typeof globalThis.fetch, 2);
    const out: unknown[] = [];
    for await (const item of c.paginate("playlistItems.list", { part: "contentDetails" }, 100)) out.push(item);
    // Two pages affordable, then it returns rather than raising — the caller
    // keeps what it got and resumes tomorrow.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
    expect(c.remainingUnits).toBe(0);
  });
});
