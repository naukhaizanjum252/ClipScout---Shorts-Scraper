/**
 * Tests for the stored-run store.
 *
 * TWO THINGS ARE UNDER TEST AND ONLY ONE OF THEM IS I/O.
 *
 * The first is the PARSER, and it is the half that matters. A stored report is
 * the only value in this application that arrives as `unknown` and is then
 * rendered as though the compiler had checked it: everything else on
 * /admin/shorts comes straight out of `getLatestShorts`, whose union the type
 * system enforces end to end. So the assertions below are mostly about what the
 * parser REFUSES, because the failure that costs something is not a rejected
 * row — that shows an honest empty state — it is a half-formed one accepted and
 * drawn, where a missing `dropped` becomes a zero beside the words "under the
 * threshold" and the screen invents a fact about a platform.
 *
 * The second is the WRITE AND THE TRIM, against a fake PostgREST. It proves the
 * order of operations — insert first, trim after, a failed trim swallowed — and
 * the shape of the two queries. It proves nothing about a real database; none
 * has ever been pointed at this code, which is the standing caveat on every
 * store in this repo.
 */
import { describe, expect, it, vi } from "vitest";

import type { TenantClient } from "../supabase/config";
import {
  KEPT_REPORTS,
  RUN_REPORTS_TABLE,
  SupabaseRunReportStore,
  parseStoredReport,
} from "./report-store";
import type { LatestShortsReport, PlatformOutcome } from "./run";
import { ShortsStoreError } from "./store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function okOutcome(platform: string): PlatformOutcome {
  return {
    platform: platform as PlatformOutcome["platform"],
    status: "ok",
    description: `The ${platform} adapter.`,
    returned: 0,
    kept: 0,
    duplicates: 0,
    dropped: {
      wrongPlatform: 0,
      tooLong: 0,
      tooShort: 0,
      belowThreshold: 0,
      unknownDuration: 0,
      unknownViews: 0,
    },
    shorts: [],
  };
}

function aReport(over: Partial<LatestShortsReport> = {}): LatestShortsReport {
  return {
    startedAt: "2026-09-05T03:00:00.000Z",
    finishedAt: "2026-09-05T03:00:11.000Z",
    minViews: 500_000,
    minDurationSeconds: 0,
    maxDurationSeconds: 120,
    limit: 50,
    platforms: [okOutcome("youtube"), okOutcome("tiktok")],
    shorts: [],
    unverified: [],
    spend: [],
    persistence: { status: "written", rows: 0 },
    ...over,
  };
}

/** A report as it comes back from Postgres: a plain object, no types attached. */
function asStored(report: LatestShortsReport): unknown {
  return JSON.parse(JSON.stringify(report));
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe("reading a stored report back", () => {
  it("accepts a report that has been through JSON and returns it whole", () => {
    const report = aReport({ platforms: [okOutcome("youtube")] });
    const parsed = parseStoredReport(asStored(report));

    expect(parsed).not.toBeNull();
    // Round-tripped, not reconstructed. The point of storing the whole object is
    // that the screen gets back what it had; a parser that rebuilt a subset
    // would pass a shallower assertion than this one.
    expect(parsed).toEqual(report);
  });

  /**
   * THE COMPATIBILITY CASE, AND IT IS THE REASON THE PARSER IS PERMISSIVE ABOUT
   * EXACTLY THESE TWO FIELDS AND NOTHING ELSE.
   *
   * `unverified` and `spend` both arrived after `LatestShortsReport` was first
   * written, and both are optional on the type for that reason — absent reads as
   * "nothing was said" everywhere they are consumed. Rejecting a row for missing
   * them would throw away every run stored before the next field lands.
   */
  it("accepts a report stored before `unverified` and `spend` existed", () => {
    const stored = asStored(aReport()) as Record<string, unknown>;
    delete stored.unverified;
    delete stored.spend;

    expect(parseStoredReport(stored)).not.toBeNull();
  });

  it.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
  ])("refuses %s", (_label, value) => {
    expect(parseStoredReport(value)).toBeNull();
  });

  /**
   * EVERY FILTER IS REQUIRED, and each one is listed separately rather than
   * checked in a loop over a list, so that deleting one from the parser fails a
   * named test. All four are printed on the page as the terms the list below
   * them was gathered on, and all four seed a control the operator can then
   * press "Get latest shorts" with.
   */
  it.each(["minViews", "minDurationSeconds", "maxDurationSeconds", "limit"])(
    "refuses a report with no %s, because the page prints it as the terms of the list",
    (field) => {
      const stored = asStored(aReport()) as Record<string, unknown>;
      delete stored[field];
      expect(parseStoredReport(stored)).toBeNull();
    },
  );

  /**
   * THE SUBJECT, WHEN THERE IS ONE.
   *
   * Optional like `unverified` and `spend`, because a run stored before the
   * subject menu existed is still a run — and unlike those two, a malformed one
   * fails the whole report. It is printed as what the list below was gathered
   * for AND it seeds the control that narrows the next run, so half of it is a
   * screen making a claim about a subject out of a shape nobody wrote.
   */
  it("accepts a report stored before a run could be narrowed to one subject", () => {
    const stored = asStored(aReport()) as Record<string, unknown>;
    expect("topic" in stored).toBe(false);
    expect(parseStoredReport(stored)).not.toBeNull();
  });

  it("keeps the subject a narrowed run was made for", () => {
    const report = aReport({ topic: { slug: "shark-tank", name: "Shark Tank" } });
    expect(parseStoredReport(asStored(report))?.topic).toEqual({
      slug: "shark-tank",
      name: "Shark Tank",
    });
  });

  it.each([
    ["a bare slug", "shark-tank"],
    ["a subject with no name", { slug: "shark-tank" }],
    ["a name with no address", { name: "Shark Tank" }],
  ])("refuses the whole report when the subject is %s", (_label, topic) => {
    expect(parseStoredReport({ ...(asStored(aReport()) as object), topic })).toBeNull();
  });

  it("refuses a report whose platforms are not an array", () => {
    expect(parseStoredReport({ ...(asStored(aReport()) as object), platforms: "youtube" })).toBeNull();
  });

  /**
   * THE ASSERTION THIS WHOLE FILE EXISTS FOR.
   *
   * One malformed outcome rejects the WHOLE report. The tempting alternative —
   * keep the outcomes that parse, drop the ones that do not — produces a page
   * that is missing a platform section with nothing saying so, which is
   * precisely "could not be read" and "found nothing" rendered the same way:
   * the one failure this product is built to prevent.
   */
  it("refuses the whole report when a single platform outcome is malformed", () => {
    const stored = asStored(
      aReport({ platforms: [okOutcome("youtube"), okOutcome("tiktok")] }),
    ) as { platforms: Record<string, unknown>[] };
    delete stored.platforms[1].dropped;

    expect(parseStoredReport(stored)).toBeNull();
  });

  /**
   * A ZERO INVENTED BY A PARSER IS A CLAIM ABOUT A PLATFORM. An `ok` outcome
   * with no counts would render `undefined` — or, after one well-meaning
   * `?? 0`, a confident zero next to "dropped under the threshold", which is a
   * statement about what somebody published, made up by this module.
   */
  it.each(["returned", "kept", "duplicates", "dropped", "shorts"])(
    "refuses an `ok` outcome with no %s",
    (field) => {
      const stored = asStored(aReport({ platforms: [okOutcome("youtube")] })) as {
        platforms: Record<string, unknown>[];
      };
      delete stored.platforms[0][field];
      expect(parseStoredReport(stored)).toBeNull();
    },
  );

  /**
   * `partial` IS THE TRUNCATION BRANCH. An outcome that says it stopped early
   * and cannot say what stopped it renders as a complete read with its caveat
   * missing — a list that looks like everything the platform has, when what is
   * absent from it was never looked at.
   */
  it("refuses a `partial` outcome that does not say what stopped it", () => {
    const stored = asStored(
      aReport({ platforms: [{ ...okOutcome("x"), status: "partial" } as PlatformOutcome] }),
    );
    expect(parseStoredReport(stored)).toBeNull();
  });

  it("accepts a `partial` outcome that does", () => {
    const stored = asStored(
      aReport({
        platforms: [
          {
            ...okOutcome("x"),
            status: "partial",
            truncation: { kind: "spend-cap", message: "The budget ran out." },
          } as unknown as PlatformOutcome,
        ],
      }),
    );
    expect(parseStoredReport(stored)).not.toBeNull();
  });

  /**
   * The four outcomes that carry a sentence and no arithmetic. A platform that
   * could not be read has ONE thing to say and this is it; an outcome that has
   * lost it renders a heading with nothing under it, which reads as empty.
   */
  it.each([
    ["unavailable", { platform: "instagram", status: "unavailable", description: "d" }],
    ["failed", { platform: "facebook", status: "failed", description: "d" }],
    ["no-adapter", { platform: "x", status: "no-adapter" }],
    ["not-asked", { platform: "tiktok", status: "not-asked" }],
  ])("refuses a %s outcome with no sentence to print", (_label, outcome) => {
    const stored = asStored(aReport({ platforms: [outcome as unknown as PlatformOutcome] }));
    expect(parseStoredReport(stored)).toBeNull();
  });

  /**
   * FAILING CLOSED ON AN UNKNOWN STATUS. The list of statuses is hand-written,
   * so it can go stale — and when it does, the safe direction is a rejected
   * report and an honest empty state, not a section the page has no branch for.
   */
  it("refuses an outcome whose status the union does not admit", () => {
    const stored = asStored(
      aReport({ platforms: [{ platform: "youtube", status: "pending" } as unknown as PlatformOutcome] }),
    );
    expect(parseStoredReport(stored)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A fake PostgREST, just wide enough for the two queries this store makes
// ---------------------------------------------------------------------------

interface Call {
  readonly table: string;
  readonly verb: "insert" | "select" | "delete";
  readonly payload?: unknown;
  readonly range?: readonly [number, number];
  readonly lte?: readonly [string, string];
}

function fakeClient(options: {
  readonly rows?: { readonly saved_at: string; readonly report: unknown }[];
  readonly cutoff?: { readonly saved_at: string }[];
  readonly insertError?: string;
  readonly selectError?: string;
  readonly deleteError?: string;
}) {
  const calls: Call[] = [];

  const client = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, verb: "insert", payload });
          return Promise.resolve({
            error: options.insertError ? { message: options.insertError } : null,
          });
        },
        delete() {
          const chain = {
            lte(column: string, value: string) {
              calls.push({ table, verb: "delete", lte: [column, value] });
              return Promise.resolve({
                error: options.deleteError ? { message: options.deleteError } : null,
              });
            },
          };
          return chain;
        },
        select(_columns: string) {
          const chain = {
            order() {
              return chain;
            },
            limit() {
              calls.push({ table, verb: "select" });
              return Promise.resolve({
                data: options.rows ?? [],
                error: options.selectError ? { message: options.selectError } : null,
              });
            },
            range(from: number, to: number) {
              calls.push({ table, verb: "select", range: [from, to] });
              return Promise.resolve({ data: options.cutoff ?? [], error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  return { client: client as unknown as TenantClient, calls };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("keeping a run", () => {
  it("writes the whole report, with the two timestamps lifted out for the index", () => {
    const { client, calls } = fakeClient({});
    const report = aReport();

    return new SupabaseRunReportStore(client).saveReport(report).then(() => {
      const insert = calls.find((c) => c.verb === "insert");
      expect(insert?.table).toBe(RUN_REPORTS_TABLE);
      expect(insert?.payload).toEqual({
        started_at: report.startedAt,
        finished_at: report.finishedAt,
        report,
      });
    });
  });

  /**
   * THE ORDER IS THE ASSERTION. A trim that ran first could delete the only
   * stored run and then fail to write the new one — which is the bug this whole
   * module was added to fix, arriving through the back door.
   */
  it("trims only after the insert has landed", async () => {
    const { client, calls } = fakeClient({ cutoff: [{ saved_at: "2026-01-01T00:00:00.000Z" }] });

    await new SupabaseRunReportStore(client).saveReport(aReport());

    expect(calls.map((c) => c.verb)).toEqual(["insert", "select", "delete"]);
  });

  it("asks for the row one past the ceiling, and deletes from there down", async () => {
    const { client, calls } = fakeClient({ cutoff: [{ saved_at: "2026-01-01T00:00:00.000Z" }] });

    await new SupabaseRunReportStore(client).saveReport(aReport());

    expect(calls.find((c) => c.range)?.range).toEqual([KEPT_REPORTS, KEPT_REPORTS]);
    // `lte` and not `lt`: two rows written in the same microsecond would
    // otherwise leave the table one row over the ceiling for ever.
    expect(calls.find((c) => c.verb === "delete")?.lte).toEqual([
      "saved_at",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("deletes nothing when the table is under the ceiling", async () => {
    const { client, calls } = fakeClient({ cutoff: [] });

    await new SupabaseRunReportStore(client).saveReport(aReport());

    expect(calls.some((c) => c.verb === "delete")).toBe(false);
  });

  /**
   * A FAILED TRIM COSTS DISK; A FAILED WRITE COSTS THE FEATURE. Only one of
   * those is worth failing the caller over, and the caller here is a run that
   * has already been paid for.
   */
  it("keeps the report when the trim fails, and says so in the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls } = fakeClient({
      cutoff: [{ saved_at: "2026-01-01T00:00:00.000Z" }],
      deleteError: "permission denied",
    });

    await expect(new SupabaseRunReportStore(client).saveReport(aReport())).resolves.toBeUndefined();

    expect(calls.some((c) => c.verb === "insert")).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("refuses loudly when the write itself fails", async () => {
    const { client } = fakeClient({ insertError: "permission denied for table run_reports" });

    await expect(new SupabaseRunReportStore(client).saveReport(aReport())).rejects.toBeInstanceOf(
      ShortsStoreError,
    );
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("reading the last run", () => {
  it("returns the newest row's report, with the time it was written down", async () => {
    const report = aReport();
    const { client } = fakeClient({
      rows: [{ saved_at: "2026-09-05T03:05:00.000Z", report: asStored(report) }],
    });

    const stored = await new SupabaseRunReportStore(client).latestReport();

    expect(stored?.savedAt).toBe("2026-09-05T03:05:00.000Z");
    expect(stored?.report).toEqual(report);
  });

  it("returns null when nothing has ever been kept", async () => {
    const { client } = fakeClient({ rows: [] });
    expect(await new SupabaseRunReportStore(client).latestReport()).toBeNull();
  });

  /**
   * A ROW THAT WILL NOT PARSE IS NOT A ROW. The page then shows its empty
   * state, which says nothing about any platform — and the reason is logged,
   * because the screen is deliberately quiet about it and somebody has to be
   * able to tell "nothing stored" from "stored and rejected".
   */
  it("returns null and logs when the newest row does not parse", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({
      rows: [{ saved_at: "2026-09-05T03:05:00.000Z", report: { startedAt: "yesterday" } }],
    });

    expect(await new SupabaseRunReportStore(client).latestReport()).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("refuses loudly when the read itself fails", async () => {
    const { client } = fakeClient({ rows: [], selectError: "permission denied" });

    await expect(new SupabaseRunReportStore(client).latestReport()).rejects.toBeInstanceOf(
      ShortsStoreError,
    );
  });
});
