import { describe, expect, it } from "vitest";

import { OPERATIONS, QUOTA_BUCKETS, bucketOf, declaredUnits } from "../yt/cost";
import {
  RECORDING_SCHEMA,
  RecordingError,
  emptyRecording,
  parseRecording,
  renderReport,
  serialise,
  type Recording,
} from "./recording";

function completeRecording(over: Partial<Recording> = {}): Recording {
  return {
    schema: RECORDING_SCHEMA,
    method: "test fixture — synthetic, not a measurement",
    credential: { id: "cred-1", label: "test" },
    // A test may pick an arbitrary allowance, because a test that cannot pick a
    // number cannot assert arithmetic. Neither of these is a real figure, and
    // they are deliberately different so a report that crossed the two buckets
    // would produce visibly wrong capacity rather than a plausible one.
    dailyQuota: {
      general: { units: 10_000, source: "test fixture — not a real allowance" },
      search: { units: 100, source: "test fixture — not a real ration" },
    },
    observations: OPERATIONS.map((operation) => ({
      operation,
      declaredUnits: declaredUnits(operation),
      bucket: bucketOf(operation),
      observedUnits: declaredUnits(operation),
      method: "console-readback" as const,
      source: "test fixture",
      measuredAt: "1970-01-01",
      probes: [],
    })),
    ...over,
  };
}

describe("the bucket model", () => {
  /**
   * SCAR, 2026-09-04. The cost table used to price search.list at 100 units and
   * everything downstream reasoned from that "100x". All four operations cost 1
   * unit; search is rationed by calls in a bucket of its own. These assertions
   * pin the SHAPE of the constraint, so a future edit that flattens it back into
   * a single unit price fails here rather than in a client conversation.
   */
  it("bills search.list to its own bucket and everything else to the shared one", () => {
    expect(bucketOf("search.list")).toBe("search");
    expect(bucketOf("playlistItems.list")).toBe("general");
    expect(bucketOf("videos.list")).toBe("general");
    expect(bucketOf("channels.list")).toBe("general");
  });

  it("carries the ration beside the unit price in every report row", () => {
    const rows = renderReport(completeRecording()).rows;
    const search = rows.find((r) => r.operation === "search.list");
    const playlist = rows.find((r) => r.operation === "playlistItems.list");
    // Same price. Different account, and only one of them has a published
    // per-method call ceiling — the other's is the operator's own allowance.
    expect(search?.declaredUnits).toBe(1);
    expect(playlist?.declaredUnits).toBe(1);
    expect(search?.declaredDailyCalls).toBe(100);
    expect(playlist?.declaredDailyCalls).toBeNull();
  });

  it("reports one bucket row per bucket, so neither ceiling can be quoted as the other", () => {
    const report = renderReport(completeRecording());
    expect(report.buckets.map((b) => b.bucket)).toEqual([...QUOTA_BUCKETS]);
    expect(report.buckets.find((b) => b.bucket === "search")?.allowanceUnits).toBe(100);
    expect(report.buckets.find((b) => b.bucket === "general")?.allowanceUnits).toBe(10_000);
  });
});

describe("renderReport", () => {
  it("is pure — the same recording always produces the same bytes", () => {
    const rec = completeRecording();
    expect(serialise(renderReport(rec))).toBe(serialise(renderReport(rec)));
  });

  it("reports an empty recording as incomplete, with one unresolved line per operation and per bucket", () => {
    const report = renderReport(emptyRecording("nothing measured"));
    expect(report.complete).toBe(false);
    expect(report.unresolved).toHaveLength(OPERATIONS.length + QUOTA_BUCKETS.length);
    expect(report.unresolved.join(" ")).toMatch(/search bucket allowance: unknown/);
    expect(report.unresolved.join(" ")).toMatch(/general bucket allowance: unknown/);
  });

  it("cites the published source and the date it was read, for every unmeasured cost", () => {
    // The figure moved once already. Whoever reads this report next needs to
    // know which edition of the documentation it came from.
    const report = renderReport(emptyRecording("nothing measured"));
    const line = report.unresolved.find((u) => u.startsWith("search.list:"));
    expect(line).toMatch(/developers\.google\.com\/youtube\/v3\/determine_quota_cost/);
    expect(line).toMatch(/read 2026-09-04/);
  });

  it("says so loudly when an observation contradicts the declared cost", () => {
    const rec = completeRecording();
    const contradicted: Recording = {
      ...rec,
      observations: rec.observations.map((o) =>
        o.operation === "search.list" ? { ...o, observedUnits: 250 } : o,
      ),
    };
    const report = renderReport(contradicted);
    expect(report.complete).toBe(false);
    expect(report.unresolved.join(" ")).toMatch(/declared 1 units but observed 250/);
  });

  it("recomputes declaredUnits from the live cost table, so a hand-edited recording cannot fake agreement", () => {
    const rec = completeRecording();
    const tampered = JSON.parse(serialise(rec)) as Recording;
    // Somebody edits the recording to claim search.list was always expensive —
    // the mirror image of the old bug, and just as unfalsifiable by hand.
    (tampered.observations as unknown as Array<{ operation: string; declaredUnits: number; observedUnits: number }>)
      .filter((o) => o.operation === "search.list")
      .forEach((o) => {
        o.declaredUnits = 100;
        o.observedUnits = 100;
      });
    const report = renderReport(parseRecording(tampered));
    const row = report.rows.find((r) => r.operation === "search.list");
    expect(row?.declaredUnits).toBe(1);
    expect(row?.declarationHolds).toBe(false);
  });

  it("derives capacity from the OBSERVED costs, each out of its own bucket", () => {
    const report = renderReport(completeRecording());
    // general: 10_000 units / (1 + 1) per 50 videos = 250_000 videos
    expect(report.capacity.seededVideosPerDay).toBe(250_000);
    // search: 100 units / 1 per call = 100 calls, at 50 results each
    expect(report.capacity.searchCallsPerDay).toBe(100);
    expect(report.capacity.searchCandidatesPerDay).toBe(5_000);
    // The successor to the old "100x": a reach ratio, not a price ratio.
    expect(report.capacity.seededReachMultiple).toBe(50);
  });

  it("does not let the unit allowance buy a single extra search", () => {
    // The failure a units-only model could not express. A hundredfold unit pool
    // moves the seeded figure and leaves discovery exactly where it was.
    const rec = completeRecording();
    const rich = renderReport({
      ...rec,
      dailyQuota: { ...rec.dailyQuota, general: { units: 1_000_000, source: "test fixture" } },
    });
    expect(rich.capacity.searchCallsPerDay).toBe(100);
    expect(rich.capacity.searchCandidatesPerDay).toBe(5_000);
    expect(rich.capacity.seededVideosPerDay).toBe(25_000_000);
  });

  it("leaves each capacity figure null when ITS bucket's allowance is unknown", () => {
    const rec = completeRecording();
    const noSearch = renderReport({
      ...rec,
      dailyQuota: { ...rec.dailyQuota, search: { units: null, source: null } },
    });
    expect(noSearch.capacity.searchCallsPerDay).toBeNull();
    expect(noSearch.capacity.searchCandidatesPerDay).toBeNull();
    expect(noSearch.capacity.seededReachMultiple).toBeNull();
    // The other bucket is a separate fact and survives.
    expect(noSearch.capacity.seededVideosPerDay).toBe(250_000);

    const noGeneral = renderReport({
      ...rec,
      dailyQuota: { ...rec.dailyQuota, general: { units: null, source: null } },
    });
    expect(noGeneral.capacity.seededVideosPerDay).toBeNull();
    expect(noGeneral.capacity.searchCallsPerDay).toBe(100);
  });

  it("carries the credential through, because quota is never a global figure", () => {
    expect(renderReport(completeRecording()).credential).toEqual({ id: "cred-1", label: "test" });
  });
});

describe("parseRecording", () => {
  it("refuses an observation with no method — a number nobody can attribute", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Recording;
    (rec.observations as unknown as Array<{ method: unknown }>)[0].method = null;
    expect(() => parseRecording(rec)).toThrow(RecordingError);
  });

  it("refuses an observation with no source — a measurement nobody can re-check", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Recording;
    (rec.observations as unknown as Array<{ source: unknown }>)[0].source = "";
    expect(() => parseRecording(rec)).toThrow(RecordingError);
  });

  it("refuses a recording with no credential block", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Record<string, unknown>;
    delete rec.credential;
    expect(() => parseRecording(rec)).toThrow(/credential/);
  });

  it("refuses a recording that is missing an operation", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Recording;
    (rec as unknown as { observations: unknown[] }).observations = rec.observations.slice(1);
    expect(() => parseRecording(rec)).toThrow(/missing an entry/);
  });

  it("refuses an unknown schema version", () => {
    expect(() => parseRecording({ ...completeRecording(), schema: 99 })).toThrow(/schema/);
  });

  it("refuses a schema-1 recording rather than reading its single allowance as a bucket map", () => {
    // The migration hazard the version bump exists for. Schema 1's
    // `dailyQuota: { units, source }` parses as an object; read as a bucket map
    // it would leave both allowances null and the report silently capacity-free.
    const v1 = {
      ...completeRecording(),
      schema: 1,
      dailyQuota: { units: 10_000, source: "the old single-allowance shape" },
    };
    expect(() => parseRecording(v1)).toThrow(/schema 1/i);
  });

  it("refuses a schema-2 recording that still carries the single-allowance shape", () => {
    const shaped = { ...completeRecording(), dailyQuota: { units: 10_000, source: "wrong shape" } };
    expect(() => parseRecording(shaped)).toThrow(/two independent/);
  });

  it("refuses a recording that omits a bucket entirely", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Record<string, unknown>;
    delete (rec.dailyQuota as Record<string, unknown>).search;
    expect(() => parseRecording(rec)).toThrow(/dailyQuota\.search/);
  });

  it("refuses an allowance with no source, because every capacity figure divides by it", () => {
    const rec = JSON.parse(serialise(completeRecording())) as Record<string, unknown>;
    (rec.dailyQuota as Record<string, unknown>).search = { units: 100, source: "" };
    expect(() => parseRecording(rec)).toThrow(/source is empty/);
  });

  it("accepts a fully specified recording", () => {
    const rec = parseRecording(JSON.parse(serialise(completeRecording())));
    expect(renderReport(rec).complete).toBe(true);
  });
});
