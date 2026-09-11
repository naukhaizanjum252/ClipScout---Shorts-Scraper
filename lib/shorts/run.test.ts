/**
 * Tests for the one action.
 *
 * MOST OF THIS FILE IS ABOUT ONE SENTENCE: "no results" and "this platform
 * could not be read" must never look the same. Three of the five platforms
 * cannot be read at all today, so that is not a corner case here, it is the
 * majority state of the product. A run that returned `[]` for Instagram would
 * be reporting, in the client's own UI, that Instagram has no viral content.
 *
 * The assertions therefore test the SHAPE of the outcome and not just its row
 * count. Asserting `kept === 0` would pass for all five outcomes at once, which
 * is the exact confusion under test.
 *
 * TWO MORE DISTINCTIONS ARRIVED ON 2026-09-04 and the second half of this file
 * is about them. A platform can now RUN AND STOP SHORT, because X bills per
 * post returned and a run has to be allowed to hit a budget — and a row can now
 * arrive having failed no filter and passed less than all of them, because X may
 * not populate a view count for third-party media and Instagram's official API
 * publishes no duration for anything at all. Both are absences dressed as
 * results, which is the same failure this file has always been about.
 *
 * WHAT THESE TESTS DO NOT PROVE. Nothing here touches a network, a platform or a
 * database — the adapters are fakes that return the rows the test hands them.
 * They prove the filtering, the dedupe, the failure isolation and the report's
 * arithmetic. They prove nothing about whether any real adapter can read any
 * real platform, and no assertion below should ever be quoted as though they
 * did.
 */
import { describe, expect, it } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "../platform/adapter";
import { PLATFORMS, type Platform, type ShortRecord } from "../platform/types";
import { MemoryShortsStore } from "./memory-store";
import {
  asAccounting,
  asForecasting,
  forecastLatestShortsSpend,
  getLatestShorts,
  LatestShortsRunError,
  markSafeToShow,
  meteringSummary,
  METERS_ITS_OWN_SPEND,
  ran,
  safeToShowMessage,
  SpendContractError,
  spendCapabilities,
  stoppedEarly,
  summariseRun,
  totalDropped,
  type LatestShortsReport,
  type PlatformOutcome,
  type RunAccount,
  type SpendForecast,
} from "./run";
import { shortKey, type ShortsStore } from "./store";

// THE REAL X LEG, IMPORTED ON PURPOSE. Every other adapter in this file is a
// fake, and fakes are why the bug this suite now covers survived 746 green
// tests: a hand-built metering adapter proves the run's arithmetic and says
// NOTHING about whether the application ever builds one. The tests at the
// bottom construct the X client and the X adapter the way the app does and
// push them through `getLatestShorts`, which is the only way to find out.
// (lib/platform/registry.test.ts's platform-branching scan skips test files,
// which is what makes importing a named platform here legitimate.)
import { XAdapter } from "../platform/x";
import {
  billingCycle,
  InMemoryXSpendLedger,
  meterWithX,
  XClient,
  XMonthlyCapError,
  XSpendCapError,
  MICROS_PER_COUNTS_REQUEST,
  MICROS_PER_POST_READ,
} from "../platform/x-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A short that clears every filter unless the test says otherwise.
 *
 * Defaults are deliberately COMFORTABLY inside the bar (800k views, 30s) so that
 * a test about the duration ceiling cannot pass because the row happened to
 * fail the view threshold instead.
 */
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
    discovered_by: `${over.platform}-fake`,

    topic_slug: null,
    ...over,
  };
}

type Behaviour =
  | { readonly kind: "rows"; readonly rows: readonly ShortRecord[] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "throws"; readonly message: string }
  | { readonly kind: "unavailable-throws"; readonly message: string };

class FakeAdapter implements PlatformAdapter {
  readonly queries: LatestShortsQuery[] = [];
  downloadUrlCalls = 0;
  /**
   * COUNTED BECAUSE A PLATFORM NOBODY ASKED FOR MUST NOT BE TOUCHED AT ALL.
   * `unavailableReason()` is the cheapest thing an adapter does and it is still
   * not free — the yt-dlp adapters spawn a process to answer it, and asserting
   * only that `latestShorts` was skipped would let a "skipped" platform go on
   * spawning one per press.
   */
  unavailableReasonCalls = 0;

  constructor(
    readonly platform: Platform,
    private readonly behaviour: Behaviour,
  ) {}

  describe(): string {
    return `fake ${this.platform} adapter`;
  }

  async unavailableReason(): Promise<string | null> {
    this.unavailableReasonCalls += 1;
    if (this.behaviour.kind === "unavailable") return this.behaviour.reason;
    if (this.behaviour.kind === "unavailable-throws") throw new Error(this.behaviour.message);
    return null;
  }

  async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    this.queries.push(query);
    if (this.behaviour.kind === "throws") throw new Error(this.behaviour.message);
    if (this.behaviour.kind !== "rows") throw new Error("latestShorts called on an unavailable adapter");
    return [...this.behaviour.rows];
  }

  async downloadUrl(): Promise<string | null> {
    this.downloadUrlCalls += 1;
    return "https://signed.example.test/expires-in-minutes";
  }
}

const rows = (platform: Platform, ...records: ShortRecord[]) =>
  new FakeAdapter(platform, { kind: "rows", rows: records });

/**
 * An adapter that meters itself, which the plain `FakeAdapter` deliberately
 * does not.
 *
 * TWO CLASSES AND NOT ONE OPTIONAL FIELD, because `asAccounting` detects the
 * capability by looking for the method. A single fake that always defined
 * `accountForLastRun` would make every adapter in this file a metered one and
 * would make the "an adapter that does not report a price is not reported as
 * free" case untestable — which is the case most likely to be got wrong.
 */
class MeteredFakeAdapter extends FakeAdapter {
  // THE BRAND, AND THE REASON THE FAKES CARRY IT. Metering used to be detected
  // by looking for a method name, and the fakes here defined one, so this file
  // was green while no real adapter implemented anything. The brand is what a
  // real metering adapter now has to declare, so the fakes declare it too — and
  // the test below proves that declaring one half and not the other throws.
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  accountCalls = 0;
  forecastCalls = 0;

  constructor(
    platform: Platform,
    behaviour: Behaviour,
    private readonly meter: {
      readonly account?: RunAccount | null;
      readonly accountThrows?: string;
      readonly forecast?: SpendForecast;
      readonly forecastThrows?: string;
    },
  ) {
    super(platform, behaviour);
  }

  accountForLastRun(): RunAccount | null {
    this.accountCalls += 1;
    if (this.meter.accountThrows) throw new Error(this.meter.accountThrows);
    return this.meter.account ?? null;
  }

  async forecastSpend(): Promise<SpendForecast> {
    this.forecastCalls += 1;
    if (this.meter.forecastThrows) throw new Error(this.meter.forecastThrows);
    return this.meter.forecast ?? { usdMicros: null, note: "no forecast configured" };
  }
}

/** An adapter that meters spend but not forecasting, and vice versa, needs neither method. */
class AccountingOnlyAdapter extends FakeAdapter {
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  constructor(
    platform: Platform,
    behaviour: Behaviour,
    private readonly account: RunAccount | null,
  ) {
    super(platform, behaviour);
  }

  accountForLastRun(): RunAccount | null {
    return this.account;
  }
}

/** A fixed clock, so a report is comparable between runs. */
const clock = () => "2026-09-04T12:00:00.000Z";

async function run(
  adapters: readonly PlatformAdapter[],
  extra: {
    store?: ShortsStore;
    minViews?: number;
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    limit?: number;
    /** Omitted means every platform, which is what every caller but the run's own selection tests wants. */
    platforms?: readonly Platform[];
  } = {},
): Promise<LatestShortsReport> {
  return getLatestShorts({
    adapters,
    store: extra.store ?? new MemoryShortsStore(),
    limit: extra.limit ?? 50,
    minViews: extra.minViews ?? 500_000,
    // OMITTED IS NO FLOOR, exactly as `getLatestShorts` reads it, so every case
    // written before the length window existed still describes the same run.
    ...(extra.minDurationSeconds === undefined
      ? {}
      : { minDurationSeconds: extra.minDurationSeconds }),
    maxDurationSeconds: extra.maxDurationSeconds ?? 120,
    ...(extra.platforms === undefined ? {} : { platforms: extra.platforms }),
    now: clock,
  });
}

function outcome(report: LatestShortsReport, platform: Platform): PlatformOutcome {
  const found = report.platforms.find((o) => o.platform === platform);
  if (!found) throw new Error(`no outcome for ${platform}`);
  return found;
}

// ---------------------------------------------------------------------------
// The honesty rule
// ---------------------------------------------------------------------------

describe("the five outcomes are five different things", () => {
  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Four platforms, four reasons a group is empty, and every one of them has a
   * distinct `status`. The fifth — read and stopped short — has its own block
   * further down, because it is the only one of the five with rows in it. If any pair of these collapsed into the same value, the
   * UI would have no way to tell a client "Instagram is unreadable" apart from
   * "Instagram had a quiet day", and it would pick one of them to say.
   */
  it("keeps ran-and-found-nothing, unavailable, failed and unconfigured apart", async () => {
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1", view_count: 12_000 })),
      new FakeAdapter("tiktok", { kind: "unavailable", reason: "No TikTok data provider has been chosen." }),
      new FakeAdapter("instagram", { kind: "throws", message: "instagram:user is CURRENTLY BROKEN" }),
      // x has an adapter, facebook does not.
      new FakeAdapter("x", { kind: "unavailable", reason: "No X timeline enumerator exists." }),
    ]);

    const youtube = outcome(report, "youtube");
    expect(youtube.status).toBe("ok");
    // Ran, read one short, kept none. That is a real answer ABOUT YouTube.
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.returned).toBe(1);
    expect(youtube.kept).toBe(0);

    const instagram = outcome(report, "instagram");
    expect(instagram.status).toBe("failed");
    if (instagram.status !== "failed") throw new Error("unreachable");
    expect(instagram.error).toContain("CURRENTLY BROKEN");

    const tiktok = outcome(report, "tiktok");
    expect(tiktok.status).toBe("unavailable");
    if (tiktok.status !== "unavailable") throw new Error("unreachable");
    expect(tiktok.reason).toBe("No TikTok data provider has been chosen.");

    const facebook = outcome(report, "facebook");
    expect(facebook.status).toBe("no-adapter");

    // All four groups are empty. Nothing but `status` tells them apart, which
    // is the point: a caller reading only row counts sees four identical zeros.
    expect(report.shorts).toHaveLength(0);
    expect(new Set(report.platforms.map((o) => o.status)).size).toBe(4);
  });

  it("reports every platform even when no adapter was configured for it", async () => {
    const report = await run([rows("youtube")]);

    // A platform missing from the report is the most invisible failure there is:
    // nobody scrolls looking for a heading that is not there.
    expect(report.platforms.map((o) => o.platform)).toEqual([...PLATFORMS]);
    for (const platform of ["tiktok", "instagram", "x", "facebook"] as const) {
      expect(outcome(report, platform).status).toBe("no-adapter");
    }
  });

  it("treats an adapter that cannot even say whether it can run as failed, not unavailable", async () => {
    // An `unavailableReason()` that throws has told us nothing about
    // availability. Calling that "unavailable" would print a made-up reason;
    // calling it "ok" would print an empty list. It is broken, and says so.
    const report = await run([
      new FakeAdapter("tiktok", { kind: "unavailable-throws", message: "provider handshake failed" }),
    ]);
    const tiktok = outcome(report, "tiktok");
    expect(tiktok.status).toBe("failed");
    if (tiktok.status !== "failed") throw new Error("unreachable");
    expect(tiktok.error).toBe("provider handshake failed");
  });

  it("never calls latestShorts on an adapter that said it is unavailable", async () => {
    // The fake throws if that order is broken. `unavailableReason()` is the
    // whole mechanism, and a caller that asks after reading has not used it.
    const adapter = new FakeAdapter("instagram", { kind: "unavailable", reason: "broken upstream" });
    const report = await run([adapter]);
    expect(adapter.queries).toHaveLength(0);
    expect(outcome(report, "instagram").status).toBe("unavailable");
  });

  it("says out loud in the one-line summary which platforms were not read", async () => {
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
      new FakeAdapter("tiktok", { kind: "unavailable", reason: "no provider" }),
      new FakeAdapter("x", { kind: "throws", message: "boom" }),
    ]);
    const line = summariseRun(report);
    expect(line).toContain("1 platform(s) read");
    expect(line).toContain("1 unavailable");
    expect(line).toContain("1 failed");
    expect(line).toContain("3 with no adapter");
  });
});

// ---------------------------------------------------------------------------
// Partial success
// ---------------------------------------------------------------------------

describe("partial success", () => {
  it("keeps one adapter's results when another throws", async () => {
    // This is the normal case, not an edge case: on 2026-09-04 three of five
    // platforms cannot be read. A run that lost YouTube because Instagram is
    // broken would deliver nothing on almost every run.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1", view_count: 900_000 })),
      new FakeAdapter("instagram", { kind: "throws", message: "boom" }),
      rows("tiktok", aShort({ platform: "tiktok", platform_video_id: "t1", view_count: 700_000 })),
    ]);

    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["y1", "t1"]);
    expect(outcome(report, "instagram").status).toBe("failed");
  });

  it("stores the results of the adapters that worked", async () => {
    const store = new MemoryShortsStore();
    await run(
      [
        rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
        new FakeAdapter("tiktok", { kind: "throws", message: "boom" }),
      ],
      { store },
    );
    expect(store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------

describe("the threshold and the ceiling", () => {
  it("keeps a short with exactly minViews and drops the one below it", async () => {
    // `minViews` is a minimum, so it is inclusive. The boundary is written down
    // in a test rather than left for the next reader to rediscover from an
    // operator `>=` in a conditional.
    const report = await run([
      rows(
        "youtube",
        aShort({ platform: "youtube", platform_video_id: "exact", view_count: 500_000 }),
        aShort({ platform: "youtube", platform_video_id: "under", view_count: 499_999 }),
      ),
    ]);
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["exact"]);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.belowThreshold).toBe(1);
  });

  it("keeps a short of exactly the ceiling and drops the one a second longer", async () => {
    const report = await run([
      rows(
        "youtube",
        aShort({ platform: "youtube", platform_video_id: "exact", duration_seconds: 120 }),
        aShort({ platform: "youtube", platform_video_id: "over", duration_seconds: 121 }),
      ),
    ]);
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["exact"]);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.tooLong).toBe(1);
  });

  it("refuses to call an unknown duration a Short", async () => {
    // Duration is the only thing that defines a Short. A null duration is
    // usually a live or upcoming broadcast, and filing one as a Short is how a
    // 3-hour stream ends up in a list of clips.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "live", duration_seconds: null })),
    ]);
    expect(report.shorts).toHaveLength(0);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.unknownDuration).toBe(1);
    // Counted as its own reason. Folding it into `tooLong` would let a source
    // that stopped reporting durations look like a source reporting long videos.
    expect(youtube.dropped.tooLong).toBe(0);
  });

  it("refuses to let an unknown view count clear the threshold", async () => {
    // Null is not zero and it is not "probably fine": it has not been shown to
    // be over 500,000, so it is not over 500,000.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "unknown", view_count: null })),
    ]);
    expect(report.shorts).toHaveLength(0);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.unknownViews).toBe(1);
    expect(youtube.dropped.belowThreshold).toBe(0);
  });

  it("drops a row an adapter labelled with a platform it does not read", async () => {
    // Trusting the label would file a TikTok under YouTube, which is only ever
    // caught by a human noticing. Re-labelling it would be this file guessing on
    // behalf of an adapter it cannot see.
    const report = await run([
      rows(
        "youtube",
        aShort({ platform: "tiktok", platform_video_id: "mislabelled" }),
        aShort({ platform: "youtube", platform_video_id: "y1" }),
      ),
    ]);
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["y1"]);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.wrongPlatform).toBe(1);
    expect(outcome(report, "tiktok").status).toBe("no-adapter");
  });

  it("passes the threshold and both length bounds down to the adapter", async () => {
    // So a source that CAN filter upstream does. Asking TikTok for 50 posts and
    // throwing 48 away is 48 posts of somebody else's bandwidth, and on a
    // metered API it is real money.
    const adapter = rows("youtube");
    await run([adapter], {
      limit: 7,
      minViews: 250_000,
      minDurationSeconds: 20,
      maxDurationSeconds: 90,
    });
    expect(adapter.queries).toEqual([
      { limit: 7, minViews: 250_000, minDurationSeconds: 20, maxDurationSeconds: 90 },
    ]);
  });

  it("hands the adapter a floor of zero when nobody asked for one", async () => {
    // The scheduler, the CLI and the cron route have never been given a length
    // floor, and an adapter that filtered on `undefined` would drop everything
    // or nothing depending on how it coerced. Zero says the same thing the
    // absence did, in a number.
    const adapter = rows("youtube");
    await run([adapter]);
    expect(adapter.queries[0]?.minDurationSeconds).toBe(0);
  });

  it("drops a short under the length floor, and counts it apart from the ceiling", async () => {
    // "Longer than a Short" is a fact about the video; "shorter than you asked
    // for" is a fact about the request. Folding the second into `tooLong` would
    // tell an operator the platform returned things that are not Shorts.
    const report = await run(
      [
        rows(
          "youtube",
          aShort({ platform: "youtube", platform_video_id: "brief", duration_seconds: 8 }),
          aShort({ platform: "youtube", platform_video_id: "long-enough", duration_seconds: 45 }),
        ),
      ],
      { minDurationSeconds: 30 },
    );
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["long-enough"]);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.dropped.tooShort).toBe(1);
    expect(youtube.dropped.tooLong).toBe(0);
    expect(youtube.dropped.belowThreshold).toBe(0);
  });

  it("keeps a short of exactly the floor, because a minimum is inclusive", async () => {
    // The same reading `minViews` gets. Two minimums on one screen that
    // disagree about their own boundary is a difference nobody thinks to check.
    const report = await run(
      [rows("youtube", aShort({ platform: "youtube", platform_video_id: "exact", duration_seconds: 30 }))],
      { minDurationSeconds: 30 },
    );
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["exact"]);
  });

  it("records the thresholds it used on the report, the length floor included", async () => {
    // A list read yesterday at 500k and a list read today at 1M are different
    // claims, and the report has to carry which one it is. The floor is the one
    // that most needs recording: it makes the list shorter and nothing else on
    // the page would say why.
    const report = await run([rows("youtube")], {
      minViews: 1_000_000,
      minDurationSeconds: 15,
      maxDurationSeconds: 60,
    });
    expect(report.minViews).toBe(1_000_000);
    expect(report.minDurationSeconds).toBe(15);
    expect(report.maxDurationSeconds).toBe(60);
  });

  it("records a floor of zero when there was none, rather than leaving it absent", async () => {
    const report = await run([rows("youtube")]);
    expect(report.minDurationSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe("the report's numbers add up", () => {
  it("accounts for every returned row exactly once", async () => {
    // A report whose parts do not sum to its total is a report nobody can use to
    // work out where the shorts went. Each row is charged to exactly one bucket.
    const report = await run([
      rows(
        "youtube",
        aShort({ platform: "youtube", platform_video_id: "keep1", view_count: 900_000 }),
        aShort({ platform: "youtube", platform_video_id: "keep2", view_count: 800_000 }),
        aShort({ platform: "youtube", platform_video_id: "keep1", view_count: 900_000 }), // duplicate
        aShort({ platform: "youtube", platform_video_id: "low", view_count: 1 }),
        aShort({ platform: "youtube", platform_video_id: "long", duration_seconds: 600 }),
        aShort({ platform: "youtube", platform_video_id: "nodur", duration_seconds: null }),
        aShort({ platform: "youtube", platform_video_id: "noviews", view_count: null }),
        aShort({ platform: "tiktok", platform_video_id: "wrong" }),
      ),
    ]);

    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.returned).toBe(8);
    expect(youtube.kept).toBe(2);
    expect(youtube.duplicates).toBe(1);
    expect(totalDropped(youtube.dropped)).toBe(5);
    expect(youtube.kept + youtube.duplicates + totalDropped(youtube.dropped)).toBe(youtube.returned);
  });
});

// ---------------------------------------------------------------------------
// Identity and dedupe
// ---------------------------------------------------------------------------

describe("identity is (platform, platform_video_id)", () => {
  it("keeps the same id on two platforms as two different shorts", async () => {
    // The pair is the primary key. Keying on the id alone would have one real
    // short silently overwrite another the first time an Instagram shortcode
    // collides with a YouTube id, and nothing anywhere would say so.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "abc123" })),
      rows("tiktok", aShort({ platform: "tiktok", platform_video_id: "abc123" })),
    ]);
    expect(report.shorts).toHaveLength(2);
    expect(new Set(report.shorts.map(shortKey)).size).toBe(2);
  });

  it("does not duplicate a row when the same run is repeated", async () => {
    // Re-running is the normal case: "get latest shorts" is pressed again
    // tomorrow and most of yesterday's list is still the latest.
    const store = new MemoryShortsStore();
    const adapters = () => [rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))];
    await run(adapters(), { store });
    await run(adapters(), { store });
    expect(store.size).toBe(1);
    expect(store.writes).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Already in the library
// ---------------------------------------------------------------------------

describe("marks the kept shorts that were already in the library", () => {
  const key = (id: string) => shortKey({ platform: "youtube", platform_video_id: id });

  it("carries nothing over on a first run against an empty library", async () => {
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
    ]);
    // The field is always set — absent and empty mean different things, and a
    // real run never leaves it absent.
    expect(report.carriedOverKeys).toEqual([]);
  });

  it("names the rows a previous run already stored, and only those", async () => {
    const store = new MemoryShortsStore();
    await run([rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))], { store });

    // The next run finds y1 again and a brand-new y2.
    const report = await run(
      [
        rows(
          "youtube",
          aShort({ platform: "youtube", platform_video_id: "y1" }),
          aShort({ platform: "youtube", platform_video_id: "y2" }),
        ),
      ],
      { store },
    );

    expect(report.carriedOverKeys).toEqual([key("y1")]);
    // The list itself is untouched — hiding is a page choice, not a filter here,
    // and Export All still exports the whole run.
    expect(report.shorts).toHaveLength(2);
  });

  it("measures the library BEFORE this run's own write, or a first sighting marks itself old", async () => {
    // If the mark were taken after the upsert, y1 would already be in the
    // library by the time it was read and would report itself carried over on
    // the one run that actually discovered it.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
    ]);
    expect(report.carriedOverKeys).toEqual([]);
  });

  it("carries nothing over when the library cannot be read, rather than hiding a new clip", async () => {
    const base = new MemoryShortsStore();
    const store: ShortsStore = {
      upsertShorts: (records) => base.upsertShorts(records),
      readShorts: async () => {
        throw new Error("library unreachable");
      },
      upsertUnverified: (records) => base.upsertUnverified(records),
      readUnverified: () => base.readUnverified(),
    };

    const report = await run(
      [rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))],
      { store },
    );

    // The read failed, so nothing is known to be old. The safe direction is to
    // hide nothing — a clip shown twice, never a new one hidden.
    expect(report.carriedOverKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("one list, categorised by platform, highest views first", () => {
  it("groups in PLATFORMS order and sorts by views inside each group", async () => {
    const report = await run([
      rows(
        "tiktok",
        aShort({ platform: "tiktok", platform_video_id: "t-low", view_count: 600_000 }),
        aShort({ platform: "tiktok", platform_video_id: "t-high", view_count: 3_000_000 }),
      ),
      rows(
        "youtube",
        aShort({ platform: "youtube", platform_video_id: "y-low", view_count: 500_001 }),
        aShort({ platform: "youtube", platform_video_id: "y-high", view_count: 9_000_000 }),
      ),
    ]);

    // YouTube first because PLATFORMS says so, not because it answered first —
    // the adapters were passed in the other order on purpose.
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["y-high", "y-low", "t-high", "t-low"]);
  });

  it("gives each platform's outcome the same rows as the flat list", async () => {
    const report = await run([
      rows(
        "youtube",
        aShort({ platform: "youtube", platform_video_id: "a", view_count: 700_000 }),
        aShort({ platform: "youtube", platform_video_id: "b", view_count: 900_000 }),
      ),
    ]);
    const youtube = outcome(report, "youtube");
    if (youtube.status !== "ok") throw new Error("unreachable");
    expect(youtube.shorts.map((s) => s.platform_video_id)).toEqual(["b", "a"]);
    expect(report.shorts).toEqual(youtube.shorts);
  });
});

// ---------------------------------------------------------------------------
// Download URLs
// ---------------------------------------------------------------------------

describe("download URLs are never resolved by the run and never stored", () => {
  it("does not call downloadUrl and stores no media url", async () => {
    // A direct media URL is signed and expires in minutes to hours. Resolving
    // one per short on every run would also be one extra request per row, for a
    // link that is dead before anybody clicks it.
    const store = new MemoryShortsStore();
    const adapter = rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }));
    await run([adapter], { store });

    expect(adapter.downloadUrlCalls).toBe(0);
    const read = await store.readShorts();
    if (!read.complete) throw new Error("unreachable");
    for (const stored of read.shorts) {
      expect(Object.keys(stored)).not.toContain("download_url");
      expect(Object.keys(stored)).not.toContain("media_url");
      // The canonical post URL is the half that persists, and it is present.
      expect(stored.url).toMatch(/^https:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence is reported, not assumed", () => {
  it("keeps the shorts in the report when the store refuses", async () => {
    // The shorts were really read and really cleared the threshold whether or
    // not a database accepted them. Throwing the run away would turn a
    // recoverable problem into a total loss.
    const store: ShortsStore = {
      async upsertShorts() {
        throw new Error("PGRST106: schema must be added to Exposed schemas");
      },
      async readShorts() {
        return { complete: true, shorts: [] };
      },
      async upsertUnverified() {
        throw new Error("PGRST106: schema must be added to Exposed schemas");
      },
      async readUnverified() {
        return { complete: true, shorts: [] };
      },
    };
    const report = await run([rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))], {
      store,
    });

    expect(report.shorts).toHaveLength(1);
    expect(report.persistence.status).toBe("failed");
    if (report.persistence.status !== "failed") throw new Error("unreachable");
    expect(report.persistence.error).toContain("PGRST106");
    expect(report.persistence.rows).toBe(1);
    // And a run that did not persist says so in the one line somebody reads.
    expect(summariseRun(report)).toContain("NOT STORED");
  });

  it("reports how many rows were written when the store accepts", async () => {
    const report = await run([rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))]);
    expect(report.persistence).toEqual({ status: "written", rows: 1 });
  });
});

// ---------------------------------------------------------------------------
// Configuration refusals
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("refuses two adapters for one platform rather than merging them", async () => {
    // Every per-platform number in the report would be ambiguous — whose
    // `returned` is 40? — and a duplicate between the two would be
    // indistinguishable from a duplicate within one.
    await expect(run([rows("youtube"), rows("youtube")])).rejects.toBeInstanceOf(LatestShortsRunError);
  });

  it("runs with no adapters at all and says so about all five", async () => {
    const report = await run([]);
    expect(report.platforms.every((o) => o.status === "no-adapter")).toBe(true);
    expect(report.shorts).toHaveLength(0);
    expect(report.persistence).toEqual({ status: "written", rows: 0 });
  });
});

// ---------------------------------------------------------------------------
// The fifth outcome: it ran, and it stopped short
// ---------------------------------------------------------------------------

/** A truncation as an adapter would report it. */
const capped = (message: string, cause: "spend-cap" | "rate-limit" = "spend-cap"): RunAccount => ({
  spend: null,
  truncation: { cause, message },
});

describe("a platform that ran and stopped short is not a platform that finished", () => {
  it("reports `partial` and carries the adapter's sentence, not a flag on `ok`", async () => {
    // THE TEST THIS OUTCOME EXISTS FOR. X bills per post returned, so a run has
    // to be allowed to stop at a budget — and a list that called that `ok`
    // would have LookUp Media believe they had seen everything over 500,000
    // views when they had seen the first page of it.
    const report = await run([
      new AccountingOnlyAdapter(
        "x",
        { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
        capped("Stopped after 200 posts: the run's spend ceiling for X was reached."),
      ),
    ]);

    const x = outcome(report, "x");
    expect(x.status).toBe("partial");
    if (x.status !== "partial") throw new Error("unreachable");
    expect(x.truncation.cause).toBe("spend-cap");
    expect(x.truncation.message).toMatch(/spend ceiling/);
  });

  it("keeps the rows it did get, in the one list, exactly as a complete run would", async () => {
    // The rows are real. Losing them because the read was incomplete would turn
    // a partial answer into no answer, which is the opposite of the point.
    const report = await run([
      new AccountingOnlyAdapter(
        "x",
        {
          kind: "rows",
          rows: [
            aShort({ platform: "x", platform_video_id: "low", view_count: 600_000 }),
            aShort({ platform: "x", platform_video_id: "high", view_count: 3_000_000 }),
          ],
        },
        capped("Rate limited by X after one page.", "rate-limit"),
      ),
    ]);

    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["high", "low"]);
    const x = outcome(report, "x");
    if (x.status !== "partial") throw new Error("unreachable");
    expect(x.kept).toBe(2);
    expect(x.returned).toBe(2);
    expect(x.truncation.cause).toBe("rate-limit");
  });

  it("counts as read by `ran` and only as capped by `stoppedEarly`", async () => {
    // Four places used `status === "ok"` to mean "it ran" before `partial`
    // existed. Every one of them would have silently dropped a capped X off the
    // page while the figures went on looking tidy.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
      new AccountingOnlyAdapter(
        "x",
        { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
        capped("Budget reached."),
      ),
      new FakeAdapter("tiktok", { kind: "unavailable", reason: "no provider" }),
    ]);

    expect(report.platforms.filter(ran).map((o) => o.platform)).toEqual(["youtube", "x"]);
    expect(report.platforms.filter(stoppedEarly).map((o) => o.platform)).toEqual(["x"]);
  });

  it("stays `ok` when the adapter reports an account with nothing to report", async () => {
    // Null, and a RunAccount with both halves null, both mean "it finished".
    // Treating a present-but-empty account as a truncation would mark every
    // metered platform partial forever.
    const report = await run([
      new AccountingOnlyAdapter(
        "x",
        { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
        { spend: null, truncation: null },
      ),
    ]);
    expect(outcome(report, "x").status).toBe("ok");
  });

  it("does not let a throwing accounting method turn a good read into a failure", async () => {
    // The rows are already in hand and they are real. Losing them because a
    // bookkeeping call misbehaved would be the tail wagging the dog.
    const adapter = new MeteredFakeAdapter(
      "x",
      { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
      { accountThrows: "accounting exploded" },
    );
    const report = await run([adapter]);

    expect(outcome(report, "x").status).toBe("ok");
    expect(report.shorts).toHaveLength(1);
  });

  it("says out loud in the one-line summary that a platform stopped early", async () => {
    const report = await run([
      new AccountingOnlyAdapter("x", { kind: "rows", rows: [] }, capped("Out of budget.")),
    ]);
    const line = summariseRun(report);
    expect(line).toContain("1 platform(s) read");
    expect(line).toContain("1 stopped early");
  });
});

// ---------------------------------------------------------------------------
// Rows that failed nothing and passed less than everything
// ---------------------------------------------------------------------------

describe("a row nobody could judge is neither kept nor thrown away", () => {
  it("puts a row with no view count in `unverified`, naming views as the unproven claim", async () => {
    // X documents a view count on media and nobody has confirmed it is
    // populated for third-party posts. If those rows vanished, X would report
    // as empty and the operator would never learn which of the two it was.
    const report = await run([
      rows("x", aShort({ platform: "x", platform_video_id: "x1", view_count: null })),
    ]);

    expect(report.shorts).toHaveLength(0);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified?.[0]?.unproven).toEqual(["views"]);
    expect(report.unverified?.[0]?.short.platform_video_id).toBe("x1");
  });

  it("puts a row with no duration in `unverified`, naming duration", async () => {
    // Instagram's Graph API has NO duration field on media at all — not a null
    // one, none — so the Shorts ceiling cannot be evaluated from official
    // Instagram data. That is a hole in the product and this is where it shows.
    const report = await run([
      rows(
        "instagram",
        aShort({ platform: "instagram", platform_video_id: "ig1", duration_seconds: null }),
      ),
    ]);

    expect(report.unverified?.[0]?.unproven).toEqual(["duration"]);
  });

  it("names both when the source reported neither", async () => {
    const report = await run([
      rows(
        "x",
        aShort({ platform: "x", platform_video_id: "x1", view_count: null, duration_seconds: null }),
      ),
    ]);
    expect(report.unverified?.[0]?.unproven).toEqual(["views", "duration"]);
  });

  it("never puts an unverified row in the one list or the measured table", async () => {
    // `report.shorts` means every filter was checked and every filter passed.
    // That promise is the product, and the MEASURED table is the answer to
    // "shorts over 500,000 views" — a row nobody measured is not one. It has a
    // table of its own (see below); it must never reach this one.
    const store = new MemoryShortsStore();
    const report = await run(
      [
        rows(
          "x",
          aShort({ platform: "x", platform_video_id: "measured", view_count: 900_000 }),
          aShort({ platform: "x", platform_video_id: "unmeasured", view_count: null }),
        ),
      ],
      { store },
    );

    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["measured"]);
    expect(report.unverified?.map((u) => u.short.platform_video_id)).toEqual(["unmeasured"]);
    expect(store.size).toBe(1);
    const read = await store.readShorts();
    if (!read.complete) throw new Error("unreachable");
    expect(read.shorts.map((s) => s.platform_video_id)).toEqual(["measured"]);
  });

  it("saves the unverified rows to their own table, so the Library can show them", async () => {
    // Asad, 2026-09-10: Instagram reels have no duration, so they never clear
    // the ceiling and never reach `shorts`; they still belong in the Library.
    // They go to the SEPARATE unverified table, carrying which filter was
    // unproven — never into `shorts`, where a ranking would trust their views.
    const store = new MemoryShortsStore();
    await run(
      [
        rows(
          "instagram",
          aShort({ platform: "instagram", platform_video_id: "measured", view_count: 900_000 }),
          aShort({ platform: "instagram", platform_video_id: "nodur", duration_seconds: null }),
        ),
      ],
      { store },
    );

    // The measured table has only the measured one.
    expect(store.size).toBe(1);
    // The unverified table has the no-duration one, and names why.
    expect(store.unverifiedSize).toBe(1);
    const read = await store.readUnverified();
    if (!read.complete) throw new Error("unreachable");
    expect(read.shorts.map((s) => s.platform_video_id)).toEqual(["nodur"]);
    expect(read.shorts[0]?.unproven).toEqual(["duration"]);
  });

  it("carries the view-count caveat into the unverified table, so an estimate can be shown as one", async () => {
    // A derived Instagram view count must arrive in the Library marked as an
    // estimate, not a measurement — which means the caveat has to be persisted
    // beside the row, not left behind in the run.
    const store = new MemoryShortsStore();
    const estimated: ShortRecord & { measurement_caveat: unknown } = {
      ...aShort({ platform: "instagram", platform_video_id: "est", duration_seconds: null, view_count: 2_000_000 }),
      measurement_caveat: {
        field: "view_count",
        basis: "derived",
        reportedValue: null,
        note: "This view count is an ESTIMATE.",
      },
    };
    await run([rows("instagram", estimated)], { store });

    const read = await store.readUnverified();
    if (!read.complete) throw new Error("unreachable");
    expect(read.shorts[0]?.measurement_caveat?.basis).toBe("derived");
  });

  it("counts an unverified row in the drop tally exactly as before", async () => {
    // The arithmetic did not move when the destination did. `returned` still
    // equals kept plus duplicates plus every field of the breakdown.
    const report = await run([
      rows(
        "x",
        aShort({ platform: "x", platform_video_id: "keep", view_count: 900_000 }),
        aShort({ platform: "x", platform_video_id: "noviews", view_count: null }),
        aShort({ platform: "x", platform_video_id: "nodur", duration_seconds: null }),
      ),
    ]);

    const x = outcome(report, "x");
    if (x.status !== "ok") throw new Error("unreachable");
    expect(x.returned).toBe(3);
    expect(x.kept).toBe(1);
    expect(x.dropped.unknownViews).toBe(1);
    expect(x.dropped.unknownDuration).toBe(1);
    expect(x.kept + x.duplicates + totalDropped(x.dropped)).toBe(x.returned);
    expect(report.unverified).toHaveLength(2);
  });

  it("calls a row with no duration and eleven views under the threshold, not unmeasurable", async () => {
    // THE REORDERING, 2026-09-04. Every filter that CAN be applied is applied
    // first. This row was measured against the threshold and missed it by half
    // a million views; putting it on the page as "we could not tell" would be
    // the tool refusing to state a fact it holds.
    const report = await run([
      rows(
        "instagram",
        aShort({
          platform: "instagram",
          platform_video_id: "small",
          duration_seconds: null,
          view_count: 11,
        }),
      ),
    ]);

    const ig = outcome(report, "instagram");
    if (ig.status !== "ok") throw new Error("unreachable");
    expect(ig.dropped.belowThreshold).toBe(1);
    expect(ig.dropped.unknownDuration).toBe(0);
    expect(report.unverified).toHaveLength(0);
  });

  it("calls a row with no view count and a ten-minute runtime too long, not unmeasurable", async () => {
    const report = await run([
      rows(
        "x",
        aShort({ platform: "x", platform_video_id: "long", duration_seconds: 600, view_count: null }),
      ),
    ]);

    const x = outcome(report, "x");
    if (x.status !== "ok") throw new Error("unreachable");
    expect(x.dropped.tooLong).toBe(1);
    expect(x.dropped.unknownViews).toBe(0);
    expect(report.unverified).toHaveLength(0);
  });

  it("still refuses to file an unknown duration as a Short", async () => {
    // Unchanged and load-bearing: the row is surfaced, and it is surfaced as
    // something that has NOT been shown to be a Short. Duration is the only
    // thing that defines one.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "live", duration_seconds: null })),
    ]);
    expect(report.shorts).toHaveLength(0);
    expect(report.unverified?.[0]?.unproven).toContain("duration");
  });

  it("lists a repeated unverified row once while the tally counts both", async () => {
    // The tally is per row RETURNED, so the arithmetic sums; the list is per
    // DISTINCT short, so a page cannot render the same row twice under one key.
    const report = await run([
      rows(
        "x",
        aShort({ platform: "x", platform_video_id: "same", view_count: null }),
        aShort({ platform: "x", platform_video_id: "same", view_count: null }),
      ),
    ]);

    const x = outcome(report, "x");
    if (x.status !== "ok") throw new Error("unreachable");
    expect(x.dropped.unknownViews).toBe(2);
    expect(x.kept + x.duplicates + totalDropped(x.dropped)).toBe(x.returned);
    expect(report.unverified).toHaveLength(1);
    expect(new Set((report.unverified ?? []).map((u) => shortKey(u.short))).size).toBe(1);
  });

  it("groups the unverified list by platform and sorts a known count above an unknown one", async () => {
    // A row with no view count is not the smallest thing in the list, it is the
    // thing the list cannot rank. Sorting it as a zero would assert something
    // about it; last is the only position that asserts nothing.
    const report = await run([
      rows(
        "x",
        aShort({ platform: "x", platform_video_id: "x-none", view_count: null }),
        aShort({
          platform: "x",
          platform_video_id: "x-known",
          view_count: 4_000_000,
          duration_seconds: null,
        }),
      ),
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1", duration_seconds: null })),
    ]);

    expect(report.unverified?.map((u) => u.short.platform_video_id)).toEqual([
      "y1",
      "x-known",
      "x-none",
    ]);
  });

  it("reports an empty unverified list rather than leaving the field off", async () => {
    // Absent and empty mean different things — "nobody told us" against "we
    // checked and there were none" — and a real run always knows which.
    const report = await run([rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }))]);
    expect(report.unverified).toEqual([]);
  });

  it("counts the unjudged rows in the one-line summary", async () => {
    const report = await run([
      rows("x", aShort({ platform: "x", platform_video_id: "x1", view_count: null })),
    ]);
    expect(summariseRun(report)).toContain("1 could not be judged");
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe("what a run cost", () => {
  it("records a metered platform's spend and leaves the others absent, not zero", async () => {
    // "This adapter does not report a price" and "this adapter costs nothing"
    // are different claims and only one of them is ours to make. A zero here
    // would be this file inventing an invoice for yt-dlp.
    const report = await run([
      rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
      new AccountingOnlyAdapter(
        "x",
        { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
        { spend: { usdMicros: 250_000, note: "50 Post reads at $0.005 each." }, truncation: null },
      ),
    ]);

    expect(report.spend).toEqual([
      { platform: "x", usdMicros: 250_000, note: "50 Post reads at $0.005 each." },
    ]);
    expect(report.spend?.some((s) => s.platform === "youtube")).toBe(false);
  });

  it("records what a read spent before it threw", async () => {
    // A read that failed after paying for two pages still cost that. Dropping
    // the charge because the read failed would understate a bill in the
    // direction nobody checks.
    const report = await run([
      new AccountingOnlyAdapter(
        "x",
        { kind: "throws", message: "HTTP 500" },
        { spend: { usdMicros: 10_000, note: "2 Post reads before the failure." }, truncation: null },
      ),
    ]);

    expect(outcome(report, "x").status).toBe("failed");
    expect(report.spend).toEqual([
      { platform: "x", usdMicros: 10_000, note: "2 Post reads before the failure." },
    ]);
  });

  it("reports an empty spend list rather than leaving the field off", async () => {
    const report = await run([rows("youtube")]);
    expect(report.spend).toEqual([]);
  });

  it("detects the capability by the method and not by the platform", async () => {
    // The seam is structural on purpose — lib/platform/adapter.ts is four
    // methods and adding a fifth for one platform's billing model would make
    // four adapters carry an empty implementation forever.
    expect(asAccounting(rows("youtube"))).toBeNull();
    expect(asForecasting(rows("youtube"))).toBeNull();
    const metered = new MeteredFakeAdapter("x", { kind: "rows", rows: [] }, {});
    expect(asAccounting(metered)).toBe(metered);
    expect(asForecasting(metered)).toBe(metered);
  });
});

// ---------------------------------------------------------------------------
// What a run will cost, before it is made
// ---------------------------------------------------------------------------

async function forecast(adapters: readonly PlatformAdapter[], platforms?: readonly Platform[]) {
  return forecastLatestShortsSpend({
    adapters,
    limit: 50,
    minViews: 500_000,
    maxDurationSeconds: 120,
    ...(platforms === undefined ? {} : { platforms }),
    now: clock,
  });
}

describe("pricing a run before making it", () => {
  it("prices every one of the five, including the ones nothing can read", async () => {
    // Same rule as the run itself: a platform missing from the list is a
    // platform an operator cannot be told anything about, and "we could not
    // price it" would collapse into "it is free".
    const report = await forecast([]);
    expect(report.platforms.map((p) => p.platform)).toEqual([...PLATFORMS]);
    for (const entry of report.platforms) {
      expect(entry.kind).toBe("not-running");
      expect(entry.note.length).toBeGreaterThan(30);
    }
  });

  it("quotes an adapter's own figure and sums only the ones that quoted", async () => {
    const report = await forecast([
      new MeteredFakeAdapter(
        "x",
        { kind: "rows", rows: [] },
        { forecast: { usdMicros: 4_000_000, note: "About 800 posts match at $0.005 each." } },
      ),
      rows("youtube"),
    ]);

    const x = report.platforms.find((p) => p.platform === "x");
    expect(x?.kind).toBe("priced");
    expect(x?.usdMicros).toBe(4_000_000);
    expect(x?.note).toMatch(/800 posts/);
    expect(report.knownUsdMicros).toBe(4_000_000);
  });

  it("calls an adapter that cannot price itself unpriced, never free", async () => {
    // THE DISTINCTION THIS FUNCTION EXISTS FOR. yt-dlp costs no money as far as
    // anybody here knows, and nobody here has measured that. A $0.00 beside
    // YouTube would be a figure this app invented.
    const report = await forecast([rows("youtube")]);
    const youtube = report.platforms.find((p) => p.platform === "youtube");
    expect(youtube?.kind).toBe("unpriced");
    expect(youtube?.usdMicros).toBeNull();
    expect(youtube?.note).toMatch(/not the same as free/i);
    expect(report.unpriced).toBe(1);
  });

  it("keeps a platform that will not run out of the unpriced count", async () => {
    // "Will run and nobody can say what it costs" is the case to worry about.
    // "Nothing will happen here" is the case to ignore. Counting them together
    // would put the frightening one and the harmless one behind one number.
    const report = await forecast([
      new FakeAdapter("instagram", { kind: "unavailable", reason: "No Instagram key has been entered." }),
      rows("youtube"),
    ]);

    const instagram = report.platforms.find((p) => p.platform === "instagram");
    expect(instagram?.kind).toBe("not-running");
    expect(instagram?.note).toBe("No Instagram key has been entered.");
    expect(report.unpriced).toBe(1);
  });

  it("marks the total a floor by counting the platforms it could not price", async () => {
    const report = await forecast([
      new MeteredFakeAdapter(
        "x",
        { kind: "rows", rows: [] },
        { forecast: { usdMicros: 1_000_000, note: "priced" } },
      ),
      rows("youtube"),
      rows("tiktok"),
    ]);
    expect(report.knownUsdMicros).toBe(1_000_000);
    expect(report.unpriced).toBe(2);
  });

  it("never reads any shorts while pricing", async () => {
    // A "find out what this costs" that itself costs is the one behaviour that
    // would make an operator stop asking.
    const metered = new MeteredFakeAdapter(
      "x",
      { kind: "rows", rows: [aShort({ platform: "x", platform_video_id: "x1" })] },
      { forecast: { usdMicros: 5_000, note: "priced" } },
    );
    const plain = rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }));
    await forecast([metered, plain]);

    expect(metered.queries).toHaveLength(0);
    expect(plain.queries).toHaveLength(0);
    expect(metered.forecastCalls).toBe(1);
  });

  it("treats a forecast that throws as unpriced rather than as free or as a crash", async () => {
    const report = await forecast([
      new MeteredFakeAdapter("x", { kind: "rows", rows: [] }, { forecastThrows: "counts endpoint 503" }),
    ]);
    const x = report.platforms.find((p) => p.platform === "x");
    expect(x?.kind).toBe("unpriced");
    expect(x?.usdMicros).toBeNull();
    // And it does not quote the upstream: the message from a metered API
    // routinely carries the URL it called, key and all.
    expect(x?.note).not.toMatch(/503/);
  });

  it("treats an availability check that throws as not-running and does not quote it", async () => {
    const report = await forecast([
      new FakeAdapter("x", {
        kind: "unavailable-throws",
        message: "handshake failed at https://api.x.com?key=SECRET",
      }),
    ]);
    const x = report.platforms.find((p) => p.platform === "x");
    expect(x?.kind).toBe("not-running");
    expect(x?.note).not.toMatch(/SECRET/);
    expect(x?.note).not.toMatch(/api\.x\.com/);
  });

  it("records the query it priced, because a forecast for 500k is not one for 200k", async () => {
    const report = await forecast([]);
    expect(report.minViews).toBe(500_000);
    expect(report.limit).toBe(50);
    expect(report.maxDurationSeconds).toBe(120);
  });
});

// ===========================================================================
// The money contract, and the seam that was declared and never joined
// ===========================================================================
//
// WHY THIS SECTION EXISTS, IN ONE SENTENCE: everything above this line passes
// against a build where `report.spend` is structurally always empty.
//
// The seam was `typeof adapter.accountForLastRun === "function"`. The fakes in
// this file defined that method, so every assertion about spend was really an
// assertion about the fakes; a review found the name `accountForLastRun`
// appearing in exactly two files — lib/shorts/run.ts and this one — with
// nothing on the other side of it. X bills $0.005 per Post returned, and the
// admin screen's "Spent" figure could not have shown anything but an em dash.
//
// So these tests do two things the ones above cannot. They construct the REAL
// X client and the REAL X adapter, with a stubbed `fetch` and no key, and push
// them through `getLatestShorts` — the same entry point the server action uses.
// And they assert the two failures separately: a metered platform must report
// its spend, and a platform that ran WITHOUT metering must be named as
// unmetered rather than vanishing from a list that then reads as "free".

/** X's own documented media shape, trimmed to what the adapter reads. */
const X_MEDIA = {
  media_key: "13_1263145212760805376",
  type: "video",
  duration_ms: 46_947,
  preview_image_url: "https://pbs.twimg.com/media/EYeX7akWsAIP1_1.jpg",
  public_metrics: { view_count: 6_909_260 },
  variants: [{ bit_rate: 2_176_000, content_type: "video/mp4", url: "https://video.twimg.com/high.mp4" }],
};

const X_SEARCH_BODY = {
  data: [
    {
      id: "1263145271946551300",
      text: "A post with a video on it",
      created_at: "2026-09-03T10:00:00.000Z",
      author_id: "2244994945",
      attachments: { media_keys: ["13_1263145212760805376"] },
      public_metrics: { like_count: 100, reply_count: 5 },
    },
  ],
  includes: { media: [X_MEDIA], users: [{ id: "2244994945", username: "xdevelopers", name: "X" }] },
  meta: { result_count: 1 },
};

const X_COUNTS_BODY = { meta: { total_post_count: 1 } };

const X_QUERY = "min_likes:20000 has:video_link -is:retweet lang:en";
const X_NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");

/**
 * A `fetch` that answers X's two endpoints and records what it was asked for.
 *
 * It answers by PATH rather than from a queue, because these tests care about
 * whether a request was sent at all — the monthly-cap tests assert that a
 * refused run sent nothing — and a queue that runs out throws for the wrong
 * reason.
 */
function xFetch() {
  const paths: string[] = [];
  const fn = (async (input: string | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const body = url.pathname.includes("counts") ? X_COUNTS_BODY : X_SEARCH_BODY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fn, paths };
}

/** The X client the registry builds, with the network replaced and nothing else. */
function xClientWith(over: { ledger?: InMemoryXSpendLedger; cap?: number } = {}) {
  const { fn, paths } = xFetch();
  const client = new XClient({
    bearerToken: "AAAA-not-a-real-token",
    fetch: fn,
    now: () => X_NOW_MS,
    ledger: over.ledger,
    monthlyPostReadCap: over.cap,
  });
  return { client, paths };
}

/** The X adapter the registry builds, given that client. */
function xAdapterWith(client: XClient, maxPostsPerRun = 100): XAdapter {
  return new XAdapter({
    client,
    query: X_QUERY,
    maxPostsPerRun,
    windowHours: null,
    now: () => new Date(X_NOW_MS),
  });
}

describe("a metering adapter's spend reaches the report", () => {
  /**
   * THE TEST THAT WOULD HAVE CAUGHT IT.
   *
   * A real `XClient`, a real `XAdapter`, one stubbed HTTP round trip each for
   * the counts probe and the search, and the run's own entry point. Against the
   * build this round started from it fails on the first spend assertion,
   * because nothing implemented the contract and the duck type quietly returned
   * an empty list.
   */
  it("reports what X charged, in micro-dollars, with the rate in its own words", async () => {
    const { client, paths } = xClientWith();
    const adapter = meterWithX(xAdapterWith(client), client, {
      query: X_QUERY,
      maxPostsPerRun: 100,
    });

    const report = await run([adapter]);

    // Both requests were really made: the cheap counts probe, then the search.
    expect(paths).toEqual(["/2/tweets/counts/recent", "/2/tweets/search/recent"]);

    expect(report.spend).toHaveLength(1);
    const spend = (report.spend ?? [])[0];
    expect(spend.platform).toBe("x");
    // One Post returned and one counts request, both at $0.005 — the figure is
    // arithmetic over the published price table, not a number this test chose.
    expect(spend.usdMicros).toBe(MICROS_PER_POST_READ + MICROS_PER_COUNTS_REQUEST);
    expect(spend.note).toMatch(/1 Post reads at \$0\.005/);

    // And the platform really was read, so this is spend against a result and
    // not spend against a failure.
    expect(outcome(report, "x").status).toBe("ok");
    expect(report.shorts).toHaveLength(1);
  });

  it("counts the expanded User objects as an UNCONFIRMED extra, never inside the figure", async () => {
    const { client } = xClientWith();
    const report = await run([meterWithX(xAdapterWith(client), client)]);

    const spend = (report.spend ?? [])[0];
    // The search returned one user in `includes`. X's price table does not say
    // whether that is billed, so it may not be inside a figure presented as
    // what the run cost — it is named in the sentence beside it instead.
    expect(spend.usdMicros).toBe(MICROS_PER_POST_READ + MICROS_PER_COUNTS_REQUEST);
    expect(spend.note).toMatch(/expanded User objects/);
    expect(spend.note).toMatch(/what is certain, not a total/);
  });

  it("bills each run once when one client is used for two of them", async () => {
    // The contract is "what the LAST call cost". A client that reported its
    // running total would bill the first run's posts to the second one as
    // well — every figure right on its own and the sum twice the invoice.
    const { client } = xClientWith();
    const adapter = meterWithX(xAdapterWith(client), client);

    const first = await run([adapter]);
    const second = await run([adapter]);

    const one = MICROS_PER_POST_READ + MICROS_PER_COUNTS_REQUEST;
    expect((first.spend ?? [])[0].usdMicros).toBe(one);
    expect((second.spend ?? [])[0].usdMicros).toBe(one);
  });

  /**
   * THE OTHER HALF OF THE SAME BUG, AND THE ONE NOBODY WOULD HAVE NOTICED.
   *
   * A bare `XAdapter` — which is what the registry builds today — spends real
   * money and reports none. Before this round that was indistinguishable from a
   * free run, because the platform simply did not appear in `report.spend` and
   * nothing counted the platforms that were missing from it.
   */
  it("names a platform that ran and quoted no price, rather than letting it vanish", async () => {
    const { client } = xClientWith();
    const bare = xAdapterWith(client); // NOT wrapped: the money seam is not joined

    const report = await run([bare, rows("youtube")]);

    expect(report.spend).toEqual([]);
    const metering = meteringSummary(report);
    expect(metering.ran).toEqual(["youtube", "x"]);
    expect(metering.metered).toEqual([]);
    // Two platforms ran and neither said what it cost. That is a fact the page
    // can print; an empty spend list on its own is not.
    expect(metering.unmetered).toEqual(["youtube", "x"]);
  });

  it("counts only the platforms that ran as unmetered", async () => {
    const report = await run([
      new MeteredFakeAdapter(
        "x",
        { kind: "rows", rows: [] },
        { account: { spend: { usdMicros: 250_000, note: "50 Post reads." }, truncation: null } },
      ),
      rows("youtube"),
      new FakeAdapter("tiktok", { kind: "unavailable", reason: "No TikTok data provider." }),
    ]);

    const metering = meteringSummary(report);
    expect(metering.metered).toEqual(["x"]);
    // TikTok did not run, so it neither charged nor declined to say. Folding it
    // in would answer a question nobody asked with a number that looks like one.
    expect(metering.unmetered).toEqual(["youtube"]);
    expect(metering.ran).toEqual(["youtube", "x"]);
  });
});

describe("a half-built money contract stops the run instead of reporting zero", () => {
  /** The exact shape the old duck type accepted: a method, and no declaration. */
  class UnbrandedMeter extends FakeAdapter {
    accountForLastRun(): RunAccount | null {
      return { spend: { usdMicros: 4_000_000, note: "four dollars of somebody's money" }, truncation: null };
    }
  }

  /** The opposite mistake: a claim to meter, with nothing behind it. */
  class BrandOnly extends FakeAdapter {
    readonly [METERS_ITS_OWN_SPEND] = true as const;
  }

  it("refuses an adapter that reports money without declaring that it does", async () => {
    const adapter = new UnbrandedMeter("x", { kind: "rows", rows: [] });
    await expect(run([adapter])).rejects.toBeInstanceOf(SpendContractError);
    // BEFORE ANYTHING WAS READ. A run that discovered this after spending would
    // have spent it.
    expect(adapter.queries).toEqual([]);
  });

  it("refuses an adapter that declares it meters and then meters nothing", async () => {
    await expect(run([new BrandOnly("x", { kind: "rows", rows: [] })])).rejects.toBeInstanceOf(
      SpendContractError,
    );
  });

  it("refuses the same pair when only pricing a run, not just when making one", async () => {
    await expect(
      forecast([new UnbrandedMeter("x", { kind: "rows", rows: [] })]),
    ).rejects.toBeInstanceOf(SpendContractError);
  });

  it("says which platform and what to do about it", () => {
    try {
      spendCapabilities(new UnbrandedMeter("x", { kind: "rows", rows: [] }));
      throw new Error("expected a SpendContractError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(SpendContractError);
      expect((cause as SpendContractError).platform).toBe("x");
      expect((cause as Error).message).toMatch(/METERS_ITS_OWN_SPEND/);
    }
  });

  it("leaves an adapter that says nothing about money alone", () => {
    const capabilities = spendCapabilities(new FakeAdapter("youtube", { kind: "rows", rows: [] }));
    expect(capabilities.declared).toBe(false);
    expect(capabilities.accounting).toBeNull();
    expect(capabilities.forecasting).toBeNull();
  });
});

// ===========================================================================
// The monthly ceiling, which used to be a constant nothing read
// ===========================================================================

describe("X's monthly Post-read ceiling is enforced across runs, not just within one", () => {
  it("adds every run's posts to the same cycle", async () => {
    const ledger = new InMemoryXSpendLedger();

    for (let i = 0; i < 3; i++) {
      const { client } = xClientWith({ ledger, cap: 1_000 });
      await run([meterWithX(xAdapterWith(client), client)]);
    }

    // Three separate clients, three separate runs, one cycle. The per-run cap
    // could not have seen this; that is the whole point of the ledger.
    expect(await ledger.postReadsIn(billingCycle(new Date(X_NOW_MS)))).toBe(3);
  });

  it("refuses a run the cycle cannot afford, before a single request is sent", async () => {
    const ledger = new InMemoryXSpendLedger();
    const cycle = billingCycle(new Date(X_NOW_MS));
    await ledger.recordPostReads(cycle, 30);

    // A cap of 60 with 30 already spent leaves 30, and a 50-post run's worst
    // case is 50. The run must not start.
    const { client, paths } = xClientWith({ ledger, cap: 60 });
    const report = await run([meterWithX(xAdapterWith(client), client)]);

    // The counts probe is issued first and is not a Post read, so the ceiling
    // stops the search and nothing else. What matters is that no search — the
    // request that is billed per post — was ever sent.
    expect(paths).not.toContain("/2/tweets/search/recent");
    const x = outcome(report, "x");
    expect(x.status).toBe("failed");
    if (x.status !== "failed") throw new Error("unreachable");
    expect(x.error).toMatch(/billing cycle/i);
    expect(x.error).toMatch(/Nothing was sent/);
    // And the ledger did not move, because nothing was bought.
    expect(await ledger.postReadsIn(cycle)).toBe(30);
  });

  it("throws XMonthlyCapError, which is not the per-run cap wearing a hat", async () => {
    const ledger = new InMemoryXSpendLedger();
    await ledger.recordPostReads(billingCycle(new Date(X_NOW_MS)), 30);
    const { client } = xClientWith({ ledger, cap: 60 });

    await expect(client.searchRecent({ query: X_QUERY, maxPosts: 50 })).rejects.toBeInstanceOf(
      XMonthlyCapError,
    );
    // The two caps are fixed by different things on different timescales: one is
    // a setting, the other is a month. A single error type would send an
    // operator to the wrong one with the right complaint.
    expect(new XSpendCapError(1, 1, "detail")).not.toBeInstanceOf(XMonthlyCapError);
  });

  it("says out loud that a client with no ledger is not enforcing the ceiling", async () => {
    const { client } = xClientWith(); // no ledger
    expect(client.monthlyEnforcement).toBe("not-enforced");

    const report = await run([meterWithX(xAdapterWith(client), client)]);
    const spend = (report.spend ?? [])[0];
    // The dangerous version of this is silence: a monthly cap that reports
    // nothing looks exactly like a monthly cap that is holding.
    expect(spend.note).toMatch(/NOT being enforced/);
  });

  it("says how much of the cycle is gone when it IS enforcing it", async () => {
    const ledger = new InMemoryXSpendLedger();
    const { client } = xClientWith({ ledger, cap: 1_000 });
    expect(client.monthlyEnforcement).toBe("enforced");

    const report = await run([meterWithX(xAdapterWith(client), client)]);
    const spend = (report.spend ?? [])[0];
    expect(spend.note).toMatch(/1 of 1,000 Post reads used in cycle 2026-09/);
  });
});

// ===========================================================================
// Errors an adapter says are fit to print
// ===========================================================================

describe("a failed platform's message reaches the page only when the error says it may", () => {
  class SafeError extends Error {}
  markSafeToShow(SafeError);

  class ThrowsSafely extends FakeAdapter {
    async latestShorts(): Promise<ShortRecord[]> {
      throw new SafeError("X returned 40 video posts and not one carried a view count.");
    }
  }

  it("carries the message as safeMessage when the class declared it", async () => {
    const report = await run([new ThrowsSafely("x", { kind: "rows", rows: [] })]);

    const x = outcome(report, "x");
    expect(x.status).toBe("failed");
    if (x.status !== "failed") throw new Error("unreachable");
    expect(x.safeMessage).toMatch(/not one carried a view count/);
    // `error` is unchanged: a CLI and a log still get the same string they did.
    expect(x.error).toBe(x.safeMessage);
  });

  it("leaves safeMessage null for anything that did not declare itself", async () => {
    const report = await run([
      new FakeAdapter("x", {
        kind: "throws",
        message: "HTTP 403 for https://api.example.test/v3/videos?key=AIzaSyTOPSECRET",
      }),
    ]);

    const x = outcome(report, "x");
    if (x.status !== "failed") throw new Error("unreachable");
    // THE DEFAULT DID NOT MOVE. An exception from a metered API routinely quotes
    // the URL it was called with, key and all, and this page is open on around
    // forty screens.
    expect(x.safeMessage).toBeNull();
    expect(x.error).toMatch(/AIzaSyTOPSECRET/);
  });

  it("treats a marked error with nothing to say as unsafe rather than as blank", () => {
    expect(safeToShowMessage(new SafeError("   "))).toBeNull();
    expect(safeToShowMessage(new Error("unmarked"))).toBeNull();
    expect(safeToShowMessage("a string, not an error")).toBeNull();
  });

  it("shows X's own spend-cap refusal, which is the answer and not a leak", async () => {
    const { client } = xClientWith();
    // A cap below what the run asks for: the adapter refuses locally, before
    // spending, with a sentence composed for an operator.
    const report = await run([meterWithX(xAdapterWith(client, 10), client)]);

    const x = outcome(report, "x");
    if (x.status !== "failed") throw new Error("unreachable");
    expect(x.safeMessage).toMatch(/X_MAX_POSTS_PER_RUN authorises 10/);
    expect(x.safeMessage).not.toMatch(/not-a-real-token/);
  });
});

// ===========================================================================
// The count on the screen, and why it is not written down
// ===========================================================================

describe("the console does not hand-count platforms next to a figure about money", () => {
  /**
   * A SOURCE SCAN, IN THE SHAPE lib/platform/registry.test.ts ALREADY USES.
   *
   * The bug: /admin/shorts carried, in a tooltip on the "Spent" figure, the
   * sentence "four of the five adapters have no price to quote". It was five,
   * and had been since the X leg landed. Nothing went red, because a rendered
   * string is not an assertion — it is a comment that happens to be visible to
   * the client.
   *
   * A unit test of the component could not have caught it either: it would have
   * asserted the sentence, and the sentence was the thing that was wrong. What
   * catches it is a rule — no spelled-out count of platforms in anything this
   * page renders — and the fix that satisfies the rule is `meteringSummary()`,
   * which counts the run instead of counting the repository.
   *
   * COMMENTS ARE STRIPPED FIRST. Prose about a decision is allowed to say "four
   * of the five" about the day it was written; a string the operator reads is
   * not, and only one of the two ages badly in public.
   */
  const CONSOLE = "app/(admin)/admin/shorts/shorts-console.tsx";
  const HAND_COUNTED =
    /\b(one|two|three|four|five|1|2|3|4|5)\s+of\s+(the\s+)?(one|two|three|four|five|1|2|3|4|5)\b/i;

  it("spells no 'N of the five' anywhere it renders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(import.meta.dirname, "..", "..", CONSOLE);
    const source = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const offenders = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => HAND_COUNTED.test(entry.line));

    expect(
      offenders.map((o) => `${CONSOLE}:${o.number}  ${o.line}`),
      "a count of platforms written into a rendered string is a count that will be wrong the " +
        "next time the set changes, and this one sat next to the word Spent. Derive it from the " +
        "report — meteringSummary() in lib/shorts/run.ts.",
    ).toEqual([]);
  });

  it("gives meteringSummary the numbers that sentence needs", async () => {
    // The replacement has to be able to say the same thing truthfully, or the
    // rule above is just a ban. Two platforms read, one of them metered.
    const report = await run([
      new MeteredFakeAdapter(
        "x",
        { kind: "rows", rows: [] },
        { account: { spend: { usdMicros: 5_000, note: "one Post read" }, truncation: null } },
      ),
      rows("youtube"),
      new FakeAdapter("facebook", { kind: "unavailable", reason: "Facebook page reads are refused." }),
    ]);

    const metering = meteringSummary(report);
    expect(`${metering.metered.length} of the ${metering.ran.length} platforms that were read`).toBe(
      "1 of the 2 platforms that were read",
    );
  });
});

describe("pricing an X run before making it, through the same forecast the button calls", () => {
  it("quotes the cheap counts probe rather than guessing, and says what it just spent", async () => {
    const { client, paths } = xClientWith();
    const adapter = meterWithX(xAdapterWith(client), client, {
      query: X_QUERY,
      maxPostsPerRun: 100,
      windowHours: null,
    });

    const report = await forecast([adapter]);
    const x = report.platforms.find((p) => p.platform === "x");

    // The probe was really issued, and the SEARCH was not: pricing a run must
    // never be the expensive half of making one.
    expect(paths).toEqual(["/2/tweets/counts/recent"]);
    expect(x?.kind).toBe("priced");
    // One matching post, retrieved as a page of ten (recent search's documented
    // minimum), plus the counts request that found that out.
    expect(x?.usdMicros).toBe(10 * MICROS_PER_POST_READ + MICROS_PER_COUNTS_REQUEST);
    expect(x?.note).toMatch(/minimum page size of 10/);
    expect(report.unpriced).toBe(0);
  });

  it("is unpriced, never zero, when the query it would run is not configured", async () => {
    const { client, paths } = xClientWith();
    // The adapter itself is available in this fixture; what is missing is the
    // configuration the FORECAST needs to know what would be asked for.
    const adapter = meterWithX(xAdapterWith(client), client, { maxPostsPerRun: 100 });

    const report = await forecast([adapter]);
    const x = report.platforms.find((p) => p.platform === "x");

    expect(x?.kind).toBe("unpriced");
    expect(x?.usdMicros).toBeNull();
    expect(paths).toEqual([]);
    // A floor of $0.00 for a run nobody priced is the one number on that panel
    // an operator would act on without reading.
    expect(report.knownUsdMicros).toBe(0);
    expect(report.unpriced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Asking for some of the platforms and not all of them
// ---------------------------------------------------------------------------

/**
 * THE CHECKBOXES, AT THE LEVEL THAT SPENDS THE MONEY.
 *
 * Erik, 2026-09-05: *"checkboxes for the platforms to be used"*. Every case in
 * this block is a way of getting that wrong that would look fine on a screen:
 * a platform that was skipped but still read, a platform that was skipped and
 * then reported as unconfigured, and an empty tick-list quietly meaning "all".
 * The last is the expensive one.
 */
describe("a run reads the platforms it was asked for, and no others", () => {
  it("does not read, price or even ask an adapter for a platform nobody selected", async () => {
    const youtube = rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }));
    const tiktok = rows("tiktok", aShort({ platform: "tiktok", platform_video_id: "t1" }));

    // BOTH ADAPTERS ARE HANDED OVER. The selection is what decides, not the
    // caller's list — on X being read is being billed, so a run that trusted a
    // caller to have filtered would have one more place to get this wrong.
    const report = await run([youtube, tiktok], { platforms: ["youtube"] });

    expect(youtube.queries).toHaveLength(1);
    expect(tiktok.queries).toHaveLength(0);
    expect(tiktok.unavailableReasonCalls).toBe(0);
  });

  it("says a skipped platform was not asked for, which is not what a missing adapter says", async () => {
    const report = await run(
      [
        rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" })),
        rows("tiktok", aShort({ platform: "tiktok", platform_video_id: "t1" })),
      ],
      // Instagram is TICKED AND HAS NO ADAPTER; TikTok is unticked and has one.
      // That pairing is the whole case: two empty sections, two reasons.
      { platforms: ["youtube", "instagram"] },
    );

    // The distinction the whole outcome exists for. One is fixed by ticking a
    // box on the screen; the other is fixed by configuring a key. A screen that
    // told an operator nothing is configured to read TikTok, because they
    // unticked TikTok, would send them to the wrong place entirely.
    const skipped = outcome(report, "tiktok");
    expect(skipped.status).toBe("not-asked");
    expect(outcome(report, "instagram").status).toBe("no-adapter");
    if (skipped.status !== "not-asked") throw new Error("unreachable");
    expect(skipped.reason).toMatch(/not selected/i);
    expect(skipped.reason).not.toMatch(/no adapter is configured/i);
  });

  it("still reports all five platforms, in the vocabulary's order", async () => {
    const report = await run([rows("youtube")], { platforms: ["youtube"] });

    // A narrowed run does not narrow the report. Five sections, always: the two
    // an operator unticked say so, and the ones nothing can read still say so.
    expect(report.platforms.map((o) => o.platform)).toEqual([...PLATFORMS]);
  });

  it("treats an empty selection as a run of nothing, never as a run of everything", async () => {
    const youtube = rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }));

    const report = await run([youtube], { platforms: [] });

    // THE EXPENSIVE MISTAKE, AND THE REASON THIS CASE IS HERE. `platforms ?? PLATFORMS`
    // written as `platforms?.length ? platforms : PLATFORMS` would read an empty
    // array as "all five" — which is a five-platform bill for a caller that
    // computed an empty selection by accident.
    expect(youtube.queries).toHaveLength(0);
    expect(report.shorts).toHaveLength(0);
    expect(report.platforms.every((o) => o.status === "not-asked")).toBe(true);
  });

  it("reads every platform when no selection is given at all", async () => {
    // The scheduler, the CLI and the cron route all call it this way, and none
    // of them changed when the checkboxes arrived. Undefined is not empty.
    const youtube = rows("youtube", aShort({ platform: "youtube", platform_video_id: "y1" }));
    const report = await run([youtube]);

    expect(youtube.queries).toHaveLength(1);
    expect(outcome(report, "youtube").status).toBe("ok");
  });

  it("counts the skipped platforms in the one-line summary rather than dropping them", async () => {
    const report = await run([rows("youtube"), rows("tiktok")], { platforms: ["youtube"] });

    // The summary used to be built over a five-key object literal, so a sixth
    // status made it `undefined + 1` — NaN, in the line a cron log keeps, with
    // nothing red anywhere. Threads arriving on 2026-09-08 moved this number
    // from four to five without touching run.ts, which is that fix holding.
    const line = summariseRun(report);
    expect(line).toContain("5 not asked for");
    expect(line).not.toContain("NaN");
  });

  it("prices only what will run, and says which kind of will-not-run each platform is", async () => {
    const x = new MeteredFakeAdapter(
      "x",
      { kind: "rows", rows: [] },
      { forecast: { usdMicros: 250_000, note: "50 posts at $0.005" } },
    );
    const youtube = rows("youtube");

    // Facebook is ticked with nothing to read it; YouTube is unticked with an
    // adapter. Same pairing as the run's case above, for the same reason.
    const priced = await forecast([x, youtube], ["x", "facebook"]);

    expect(youtube.unavailableReasonCalls).toBe(0);
    const skipped = priced.platforms.find((entry) => entry.platform === "youtube")!;
    expect(skipped.kind).toBe("not-running");
    expect(skipped.note).toMatch(/not selected/i);
    // A platform nothing can read says something else, and the two must not
    // collapse — an operator reads the note to decide whether to tick a box.
    const nothingConfigured = priced.platforms.find((entry) => entry.platform === "facebook")!;
    expect(nothingConfigured.note).toMatch(/nothing is configured/i);
    expect(priced.knownUsdMicros).toBe(250_000);
  });

  it("does not ask an unselected metering adapter what it would cost", async () => {
    const x = new MeteredFakeAdapter(
      "x",
      { kind: "rows", rows: [] },
      { forecast: { usdMicros: 250_000, note: "50 posts at $0.005" } },
    );

    const priced = await forecast([x], ["youtube"]);

    // Pricing something nobody asked for is the estimate doing the one thing it
    // exists to prevent, and on X the forecast call is itself half a cent.
    expect(x.forecastCalls).toBe(0);
    expect(priced.knownUsdMicros).toBe(0);
    expect(priced.unpriced).toBe(0);
  });
});
