import { describe, expect, it } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "../platform/adapter";
import { PLATFORMS, type Platform, type ShortRecord } from "../platform/types";
import { MemoryShortsStore } from "./memory-store";
import {
  addSeconds,
  blankRow,
  DEFAULT_LOCK_TTL_SECONDS,
  MemoryScheduleStore,
  nextClaimableAfter,
  resolveScheduleStore,
  runOnSchedule,
  ScheduleError,
  type ScheduledPlatformOutcome,
  type ScheduleRow,
} from "./schedule";
import { MemorySeedStore, type Seed } from "./seeds";

/**
 * The scheduled run.
 *
 * The three properties worth proving, and they are all about the same thing —
 * a run costs somebody's money, so it must happen once:
 *
 *   1. TWO OVERLAPPING FIRES READ A PLATFORM ONCE. The lock is a conditional
 *      write and the second fire loses it while the first is still in flight.
 *   2. A SKIPPED PLATFORM SAYS WHY IT WAS SKIPPED. It must never read as
 *      "nothing found" and must never read as "nobody can read this platform" —
 *      the wrapped run report says `no-adapter` for a skipped platform, which is
 *      literally true of that run and is NOT the reason, so the schedule's own
 *      array is the authority.
 *   3. EVERY CLAIMED LOCK IS RELEASED, INCLUDING WHEN THE RUN THROWS. A lock
 *      released only on the happy path pins a platform for the whole TTL exactly
 *      when the next fire most needs to try.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-09-04T12:00:00.000Z";

function short(platform: Platform, over: Partial<ShortRecord> = {}): ShortRecord {
  return {
    platform,
    platform_video_id: `${platform}-1`,
    url: `https://example.invalid/${platform}/1`,
    title: "A post",
    creator_handle: "@someone",
    creator_id: null,
    creator_url: null,
    duration_seconds: 30,
    view_count: 900_001,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: NOW,
    discovered_by: "test",
    topic_slug: null,
    ...over,
  };
}

/**
 * An adapter that spawns nothing.
 *
 * `gate` is what makes the overlap test a real overlap: the first fire parks
 * inside `latestShorts` while the second fire runs to completion against the
 * same schedule store.
 */
class FakeAdapter implements PlatformAdapter {
  calls = 0;

  constructor(
    readonly platform: Platform,
    private readonly rows: readonly ShortRecord[] = [],
    private readonly reason: string | null = null,
    private readonly gate: Promise<void> | null = null,
  ) {}

  describe(): string {
    return `a fake reader for ${this.platform}`;
  }

  async unavailableReason(): Promise<string | null> {
    return this.reason;
  }

  async latestShorts(_query: LatestShortsQuery): Promise<ShortRecord[]> {
    this.calls += 1;
    if (this.gate) await this.gate;
    return [...this.rows];
  }

  async downloadUrl(): Promise<string | null> {
    return null;
  }
}

function runOptions(over: Partial<Parameters<typeof runOnSchedule>[0]> = {}) {
  return {
    schedule: MemoryScheduleStore.enabledForAll(),
    seeds: new MemorySeedStore(),
    store: new MemoryShortsStore(),
    limit: 5,
    minViews: 500_000,
    maxDurationSeconds: 120,
    now: () => NOW,
    adapters: () => [],
    ...over,
  } as Parameters<typeof runOnSchedule>[0];
}

function outcomeFor(
  platforms: readonly ScheduledPlatformOutcome[],
  platform: Platform,
): ScheduledPlatformOutcome {
  const found = platforms.find((p) => p.platform === platform);
  if (!found) throw new Error(`no outcome for ${platform}`);
  return found;
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe("the two time calculations", () => {
  it("refuses a time-to-live of zero or less", () => {
    // A lock that has already expired when it is taken is not a lock: every
    // fire would claim every platform at once and the double-read this whole
    // module exists to prevent would be the normal case.
    expect(() => addSeconds(NOW, 0)).toThrow(ScheduleError);
    expect(() => addSeconds(NOW, -1)).toThrow(ScheduleError);
    expect(() => addSeconds(NOW, 1.5)).toThrow(ScheduleError);
  });

  it("refuses a time it cannot parse rather than producing an Invalid Date", () => {
    expect(() => addSeconds("not a time", 60)).toThrow(ScheduleError);
  });

  it("treats no cadence floor as 'claimable the moment it finished'", () => {
    // Not as some default number of minutes. A default here would be this file
    // inventing an operator's decision and hiding it where nobody looks.
    expect(nextClaimableAfter(NOW, null)).toBe(NOW);
    expect(nextClaimableAfter(NOW, 60)).toBe("2026-09-04T12:01:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe("the claim", () => {
  it("gives nothing away for a platform nobody has turned on", async () => {
    const schedule = new MemoryScheduleStore([blankRow("tiktok")]);
    expect(await schedule.claim("tiktok", { token: "a", now: NOW, ttlSeconds: 60 })).toBeNull();
  });

  it("is won once; the second fire gets nothing", async () => {
    const schedule = MemoryScheduleStore.enabledForAll();
    expect(await schedule.claim("tiktok", { token: "a", now: NOW, ttlSeconds: 60 })).not.toBeNull();
    expect(await schedule.claim("tiktok", { token: "b", now: NOW, ttlSeconds: 60 })).toBeNull();
  });

  it("becomes claimable again once the lock lapses, so a dead worker does not pin a platform", async () => {
    const schedule = MemoryScheduleStore.enabledForAll();
    await schedule.claim("tiktok", { token: "a", now: NOW, ttlSeconds: 60 });
    const later = addSeconds(NOW, 61);
    expect(await schedule.claim("tiktok", { token: "b", now: later, ttlSeconds: 60 })).not.toBeNull();
  });

  it("holds the platform for the cadence floor after a run finishes", async () => {
    const schedule = new MemoryScheduleStore([
      { ...blankRow("tiktok"), enabled: true, min_interval_seconds: 3600 },
    ]);
    const claimed = (await schedule.claim("tiktok", { token: "a", now: NOW, ttlSeconds: 60 })) as ScheduleRow;
    await schedule.release({ claimed, finishedAt: NOW, outcome: "ok", note: null });

    const soon = addSeconds(NOW, 60);
    expect(await schedule.claim("tiktok", { token: "b", now: soon, ttlSeconds: 60 })).toBeNull();
    const past = addSeconds(NOW, 3601);
    expect(await schedule.claim("tiktok", { token: "b", now: past, ttlSeconds: 60 })).not.toBeNull();
  });
});

describe("the release", () => {
  it("cannot be done with a stale token", async () => {
    // The failure it stops: a run whose lock lapsed comes back, clears the NEW
    // holder's lock and stamps its own finish time over it — so two runs read
    // the platform at once and the row says everything went fine.
    const schedule = MemoryScheduleStore.enabledForAll();
    const stale = (await schedule.claim("x", { token: "old", now: NOW, ttlSeconds: 60 })) as ScheduleRow;

    const later = addSeconds(NOW, 61);
    await schedule.claim("x", { token: "new", now: later, ttlSeconds: 60 });

    expect(await schedule.release({ claimed: stale, finishedAt: later, outcome: "ok", note: null })).toBe(
      false,
    );
    const [row] = (await schedule.readSchedule()).filter((r) => r.platform === "x");
    expect(row.lock_token).toBe("new");
  });

  it("records what the last run said, in the report's own vocabulary", async () => {
    const schedule = MemoryScheduleStore.enabledForAll();
    const claimed = (await schedule.claim("youtube", { token: "a", now: NOW, ttlSeconds: 60 })) as ScheduleRow;
    await schedule.release({ claimed, finishedAt: NOW, outcome: "partial", note: "stopped early" });

    const [row] = (await schedule.readSchedule()).filter((r) => r.platform === "youtube");
    // `partial` is its own value. Folding it into `ok` would put a green tick on
    // a row whose list is missing a tail of unknown size.
    expect(row.last_outcome).toBe("partial");
    expect(row.last_finished_at).toBe(NOW);
    expect(row.lock_token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A pass
// ---------------------------------------------------------------------------

describe("one scheduled pass", () => {
  it("reports one entry for every platform, in the vocabulary's order", async () => {
    // A platform missing from the report is a platform nobody scrolls looking
    // for. The honesty rule, as a scheduled run's version of it.
    const report = await runOnSchedule(runOptions({ schedule: new MemoryScheduleStore([]) }));
    expect(report.platforms.map((p) => p.platform)).toEqual([...PLATFORMS]);
  });

  it("says a platform is off rather than letting it look like an empty result", async () => {
    const report = await runOnSchedule(
      runOptions({ schedule: new MemoryScheduleStore(PLATFORMS.map((platform) => blankRow(platform))) }),
    );
    const tiktok = outcomeFor(report.platforms, "tiktok");
    expect(tiktok.status).toBe("skipped");
    if (tiktok.status !== "skipped") throw new Error("unreachable");
    expect(tiktok.reason).toBe("disabled");
    expect(tiktok.explanation).toMatch(/bill per read|turns it on/i);
    // Nothing was claimed, so no run was made at all — which is different again
    // from a run that found nothing.
    expect(report.runReport).toBeNull();
  });

  it("says a platform has no schedule row, and does not confuse that with the platform being empty", async () => {
    const report = await runOnSchedule(runOptions({ schedule: new MemoryScheduleStore([]) }));
    const facebook = outcomeFor(report.platforms, "facebook");
    if (facebook.status !== "skipped") throw new Error("expected a skip");
    expect(facebook.reason).toBe("no-schedule-row");
    expect(facebook.explanation).toMatch(/nothing looked/i);
  });

  it("only builds adapters for the platforms it claimed", async () => {
    const claimedOnly = new MemoryScheduleStore([{ ...blankRow("tiktok"), enabled: true }]);
    const tiktok = new FakeAdapter("tiktok", [short("tiktok")]);
    const youtube = new FakeAdapter("youtube", [short("youtube")]);

    const report = await runOnSchedule(
      runOptions({ schedule: claimedOnly, adapters: () => [tiktok, youtube] }),
    );

    expect(tiktok.calls).toBe(1);
    // Not claimed, so not read. Reading it anyway would spend a platform's
    // quota outside its own cadence, which is what the whole row is for.
    expect(youtube.calls).toBe(0);
  });

  it("hands the adapters the seeds that are actually active", async () => {
    const seeds = new MemorySeedStore([
      { ...emptySeed("tiktok", "live") },
      { ...emptySeed("tiktok", "off"), active: false, deactivated_at: NOW },
    ]);
    let given: readonly string[] = ["never set"];

    await runOnSchedule(
      runOptions({
        schedule: new MemoryScheduleStore([{ ...blankRow("tiktok"), enabled: true }]),
        seeds,
        adapters: (grouped) => {
          given = grouped.tiktok;
          return [new FakeAdapter("tiktok")];
        },
      }),
    );

    expect(given).toEqual(["live"]);
  });

  it("stamps the seeds of a platform that ran, and not of one that could not", async () => {
    const seeds = new MemorySeedStore([emptySeed("tiktok", "live"), emptySeed("x", "handle")]);
    await runOnSchedule(
      runOptions({
        schedule: MemoryScheduleStore.enabledForAll(),
        seeds,
        adapters: () => [
          new FakeAdapter("tiktok", [short("tiktok")]),
          new FakeAdapter("x", [], "X needs a key nobody has entered."),
        ],
      }),
    );

    const rows = new Map((await seeds.listSeeds()).map((s) => [s.platform, s]));
    expect(rows.get("tiktok")?.last_fetched_ok_at).toBe(NOW);
    // An unavailable platform was never reached. Stamping it would turn this
    // column into "we tried", which is precisely the reading it refuses.
    expect(rows.get("x")?.last_fetched_ok_at).toBeNull();
  });

  it("releases every lock it took, so the next fire can try", async () => {
    const schedule = MemoryScheduleStore.enabledForAll();
    await runOnSchedule(
      runOptions({ schedule, adapters: () => [new FakeAdapter("tiktok", [short("tiktok")])] }),
    );
    for (const row of await schedule.readSchedule()) {
      expect(row.lock_token, `${row.platform} still holds a lock`).toBeNull();
    }
  });
});

describe("two overlapping fires read a platform once", () => {
  it("leaves the second fire holding nothing while the first is still in flight", async () => {
    // The real shape of the failure: a cron that fires every fifteen minutes
    // against a run that takes twenty. Without the lock, both read the platform
    // and a metered API is billed twice for the same rows.
    const schedule = MemoryScheduleStore.enabledForAll();
    let openTheGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });

    const slow = new FakeAdapter("tiktok", [short("tiktok")], null, gate);
    const first = runOnSchedule(
      runOptions({ schedule, adapters: () => [slow], now: () => NOW }),
    );

    // The first fire is parked inside the adapter with the lock held.
    await Promise.resolve();
    const second = new FakeAdapter("tiktok", [short("tiktok")]);
    const secondReport = await runOnSchedule(
      runOptions({ schedule, adapters: () => [second], now: () => NOW }),
    );

    const tiktok = outcomeFor(secondReport.platforms, "tiktok");
    if (tiktok.status !== "skipped") throw new Error("the second fire should have been locked out");
    expect(tiktok.reason).toBe("locked");
    expect(tiktok.explanation).toMatch(/another run already holds/i);
    expect(second.calls).toBe(0);
    expect(secondReport.runReport).toBeNull();

    openTheGate();
    const firstReport = await first;
    expect(outcomeFor(firstReport.platforms, "tiktok").status).toBe("ran");
    expect(slow.calls).toBe(1);
  });
});

describe("a run that cannot be made still gives the locks back", () => {
  it("reports run-not-made per claimed platform and clears every lock", async () => {
    const schedule = MemoryScheduleStore.enabledForAll();
    // Two adapters claiming one platform is the structural failure
    // `getLatestShorts` throws for. Every per-platform failure is inside the
    // report and never reaches here.
    const report = await runOnSchedule(
      runOptions({
        schedule,
        adapters: () => [new FakeAdapter("tiktok"), new FakeAdapter("tiktok")],
      }),
    );

    const tiktok = outcomeFor(report.platforms, "tiktok");
    expect(tiktok.status).toBe("run-not-made");
    if (tiktok.status !== "run-not-made") throw new Error("unreachable");
    expect(tiktok.lockReleased).toBe(true);

    for (const row of await schedule.readSchedule()) {
      expect(row.lock_token, `${row.platform} still holds a lock`).toBeNull();
      expect(row.last_outcome).toBe("failed");
    }
  });
});

describe("the wrapped run report is not the authority on why", () => {
  it("says no-adapter for a skipped platform while the schedule says the real reason", async () => {
    // THE FOOTGUN, PINNED. A surface that renders `runReport.platforms` for a
    // platform this pass skipped tells an operator that nobody can read it —
    // when in fact it ran eleven minutes ago and is inside its cadence floor.
    const schedule = new MemoryScheduleStore([
      { ...blankRow("tiktok"), enabled: true },
      blankRow("youtube"),
    ]);
    const report = await runOnSchedule(
      runOptions({ schedule, adapters: () => [new FakeAdapter("tiktok", [short("tiktok")])] }),
    );

    const fromRun = report.runReport?.platforms.find((p) => p.platform === "youtube");
    expect(fromRun?.status).toBe("no-adapter");

    const fromSchedule = outcomeFor(report.platforms, "youtube");
    if (fromSchedule.status !== "skipped") throw new Error("expected a skip");
    expect(fromSchedule.reason).toBe("disabled");
  });
});

describe("proposals come out of a pass but never become seeds in one", () => {
  it("files suggestions from the handles the run actually saw", async () => {
    const seeds = new MemorySeedStore();
    const report = await runOnSchedule(
      runOptions({
        schedule: MemoryScheduleStore.enabledForAll(),
        seeds,
        adapters: () => [new FakeAdapter("youtube", [short("youtube", { creator_handle: "@found" })])],
      }),
    );

    expect(report.proposals.status).toBe("filed");
    const proposals = await seeds.listProposals();
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.state === "pending")).toBe(true);
    // The whole point. A pass that observed a handle has added no seed.
    expect(await seeds.listSeeds()).toEqual([]);
  });

  it("does not turn a store that refuses suggestions into a failed run", async () => {
    // The shorts were read and stored before this. A convenience on top of a
    // finished run must not retroactively fail it.
    const seeds = new MemorySeedStore();
    seeds.addProposals = async () => {
      throw new Error("nowhere to write");
    };

    const report = await runOnSchedule(
      runOptions({
        schedule: MemoryScheduleStore.enabledForAll(),
        seeds,
        adapters: () => [new FakeAdapter("youtube", [short("youtube")])],
      }),
    );

    expect(report.proposals.status).toBe("failed");
    expect(outcomeFor(report.platforms, "youtube").status).toBe("ran");
  });

  it("can be turned off entirely", async () => {
    const seeds = new MemorySeedStore();
    const report = await runOnSchedule(
      runOptions({
        schedule: MemoryScheduleStore.enabledForAll(),
        seeds,
        proposeSeeds: false,
        adapters: () => [new FakeAdapter("youtube", [short("youtube")])],
      }),
    );
    expect(report.proposals.status).toBe("skipped");
    expect(await seeds.listProposals()).toEqual([]);
  });
});

describe("there is no schedule without a database", () => {
  it("refuses instead of pretending, and says what is missing", async () => {
    // The asymmetry with seeds is deliberate: seeds degrade to a read-only list,
    // which is still a list. A schedule degrades to no lock and no last-run
    // record, both of which are worse than not running.
    const resolved = await resolveScheduleStore({ databaseConfigured: false });
    expect(resolved.store).toBeNull();
    expect(resolved.explanation).toMatch(/lock/i);
  });

  it("has a lock time-to-live that is a ceiling and not a measurement", () => {
    // Stated here so the number cannot quietly become a claim. If somebody times
    // a real run, this moves and gets a citation in lib/config.ts.
    expect(DEFAULT_LOCK_TTL_SECONDS).toBeGreaterThan(0);
    expect(Number.isSafeInteger(DEFAULT_LOCK_TTL_SECONDS)).toBe(true);
  });
});

function emptySeed(platform: Platform, seed: string): Seed {
  return {
    platform,
    seed,
    active: true,
    note: null,
    added_at: NOW,
    added_by: null,
    deactivated_at: null,
    deactivated_by: null,
    last_fetched_ok_at: null,
  };
}
