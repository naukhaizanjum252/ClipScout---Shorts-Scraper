import { describe, expect, it } from "vitest";

import {
  BUCKETS,
  COSTS,
  DECLARED_SOURCE_READ_ON,
  DECLARED_SOURCE_URL,
  OPERATIONS,
  QUOTA_BUCKETS,
  bucketOf,
  declaredDailyCallCeiling,
  declaredSearchCandidatesPerDay,
  declaredSeededEnumerationUnits,
  declaredUnits,
  isOperation,
  isQuotaBucket,
  maxPageSize,
} from "./cost";

/**
 * The cost table's own tests.
 *
 * SCAR, 2026-09-04. This table declared `search.list` at 100 units and the repo
 * reasoned everywhere from a "100x gap". Google prices all four operations at 1
 * unit; `search.list` is RATIONED rather than expensive — its own bucket, a
 * published ceiling of 100 calls a day, unreachable from the shared unit pool.
 * The old assertions could only ever have caught a change to a number. These
 * assert the SHAPE of the constraint as well, because that is what a units-only
 * model got wrong: a budget can be well inside its unit ceiling and still have
 * no searches left.
 */
describe("the declared cost table", () => {
  it("prices every operation at one unit — the search premium was never real", () => {
    for (const op of OPERATIONS) {
      expect(declaredUnits(op), `${op} declared cost`).toBe(1);
    }
  });

  it("cites the page and the date the figures were read from", () => {
    // A published figure moved once. The next reader needs to know which edition
    // this table is quoting before they trust it.
    expect(DECLARED_SOURCE_URL).toBe("https://developers.google.com/youtube/v3/determine_quota_cost");
    expect(DECLARED_SOURCE_READ_ON).toBe("2026-09-04");
    for (const op of OPERATIONS) {
      expect(COSTS[op].declaredSource).toContain(DECLARED_SOURCE_URL);
      expect(COSTS[op].declaredSource).toContain(DECLARED_SOURCE_READ_ON);
      // Still documentation. Nothing in this repo has measured any of it.
      expect(COSTS[op].declaredSource).toMatch(/NOT a measurement/);
    }
  });

  it("declares a positive cost, a page size and a known bucket for every operation", () => {
    for (const op of OPERATIONS) {
      expect(COSTS[op].declaredUnits).toBeGreaterThan(0);
      expect(COSTS[op].maxPageSize).toBeGreaterThan(0);
      expect(isQuotaBucket(COSTS[op].bucket)).toBe(true);
    }
  });
});

describe("the quota buckets", () => {
  it("puts search.list in a bucket of its own, and every seeded operation in the shared one", () => {
    expect(bucketOf("search.list")).toBe("search");
    expect(bucketOf("playlistItems.list")).toBe("general");
    expect(bucketOf("videos.list")).toBe("general");
    expect(bucketOf("channels.list")).toBe("general");
    expect(bucketOf("search.list")).not.toBe(bucketOf("playlistItems.list"));
  });

  it("rations search.list by calls, at a published hundred a day", () => {
    expect(declaredDailyCallCeiling("search.list")).toBe(100);
    expect(BUCKETS.search.meters).toMatch(/cannot be topped up/);
  });

  it("holds NO ceiling for the shared pool, because that allowance is per project", () => {
    // Deliberate null, and the Phase 0 rule: the unit allowance is a fact about
    // one operator's Cloud project, read off their console, never a constant in
    // here. A number appearing in this slot is the regression to catch.
    expect(declaredDailyCallCeiling("playlistItems.list")).toBeNull();
    expect(BUCKETS.general.declaredDailyCalls).toBeNull();
    expect(BUCKETS.general.meters).toMatch(/lib\/config\.ts:dailyQuotaUnits/);
  });

  it("names every bucket some operation actually draws on", () => {
    const drawn = new Set(OPERATIONS.map(bucketOf));
    expect([...QUOTA_BUCKETS].sort()).toEqual([...drawn].sort());
  });
});

describe("what a day buys, as declared", () => {
  it("prices a seeded enumeration as one list page plus one hydrate page per 50", () => {
    // The arithmetic the whole seeded/autonomous split rests on. Unchanged by
    // the correction: neither of these operations ever cost anything but 1.
    expect(declaredSeededEnumerationUnits(0)).toBe(1);
    expect(declaredSeededEnumerationUnits(1)).toBe(2);
    expect(declaredSeededEnumerationUnits(50)).toBe(2);
    expect(declaredSeededEnumerationUnits(51)).toBe(4);
    expect(declaredSeededEnumerationUnits(137)).toBe(6);
  });

  it("refuses a negative video count rather than returning a negative cost", () => {
    expect(() => declaredSeededEnumerationUnits(-1)).toThrow(RangeError);
  });

  it("caps a day of discovery at the ration times a page, whatever the unit budget", () => {
    // The successor to the old "100x" sentence, as a number: 100 calls at 50
    // results each. No quantity of units raises it, because it is a different
    // account — which is exactly why the seeded path is still the right default.
    expect(declaredSearchCandidatesPerDay()).toBe(100 * maxPageSize("search.list"));
    expect(declaredSearchCandidatesPerDay()).toBe(5_000);
  });
});

describe("isOperation", () => {
  it("accepts exactly the operations the table prices", () => {
    for (const op of OPERATIONS) expect(isOperation(op)).toBe(true);
    expect(isOperation("videos.insert")).toBe(false);
    expect(isOperation("")).toBe(false);
  });
});
