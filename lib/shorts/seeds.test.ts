import { describe, expect, it } from "vitest";

import { PLATFORMS, type Platform, type ShortRecord } from "../platform/types";
import type { TenantClient } from "../supabase/config";
import {
  activeSeedsByPlatform,
  environmentSeedsAwaitingImport,
  EnvSeedStore,
  MAX_REQUESTS_PER_READ,
  MemorySeedStore,
  normaliseForComparison,
  proposeSeedsFrom,
  resolveSeedStore,
  SeedStoreError,
  SupabaseSeedStore,
  type Seed,
  type SeedProposal,
} from "./seeds";

/**
 * Seeds, and the part of them that is a judgement rather than a CRUD form.
 *
 * Three things here are worth a test and the rest is plumbing:
 *
 *   1. THE DATABASE WINS OUTRIGHT. Not a merge, not a fallback-when-empty. A
 *      seed deactivated on the page has to stop being fetched, and both of the
 *      tempting alternatives keep fetching it while the page says otherwise.
 *   2. NOTHING IS EVER AUTO-ADDED. A proposal is a guess about identity and a
 *      wrong one fills the inventory with the wrong creator's videos under a
 *      name the operator trusts. Accepting is two calls a person authorised.
 *   3. A PARTIAL SEED LIST IS NEVER RETURNED. PostgREST truncates with a 200 and
 *      no error object; a run made against 900 of 1200 seeds reads fewer
 *      creators and still reports success, and nothing on any page could show
 *      it. So the read refuses.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedRow(platform: Platform, seed: string, over: Partial<Seed> = {}): Seed {
  return {
    platform,
    seed,
    active: true,
    note: null,
    added_at: "2026-09-04T00:00:00.000Z",
    added_by: null,
    deactivated_at: null,
    deactivated_by: null,
    last_fetched_ok_at: null,
    ...over,
  };
}

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
    discovered_at: "2026-09-04T00:00:00.000Z",
    discovered_by: "test",
    topic_slug: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Grouping for the registry
// ---------------------------------------------------------------------------

describe("the seeds an adapter is actually given", () => {
  it("has a key for every platform, so one can never silently be absent", () => {
    // `buildAdapters({ seeds })` takes a partial map, and a platform missing
    // from it looks exactly like a platform with no seeds. Producing all five
    // keys means a platform whose seeds were dropped by a bug shows as an empty
    // list rather than as an absence nothing can distinguish from one.
    const grouped = activeSeedsByPlatform([]);
    expect(Object.keys(grouped).sort()).toEqual([...PLATFORMS].sort());
  });

  it("leaves out a deactivated seed, because that is the whole point of the switch", () => {
    const grouped = activeSeedsByPlatform([
      seedRow("tiktok", "live-one"),
      seedRow("tiktok", "switched-off", { active: false, deactivated_at: "2026-09-04T01:00:00.000Z" }),
    ]);
    expect(grouped.tiktok).toEqual(["live-one"]);
  });

  it("drops a seed that is only whitespace rather than handing an adapter a blank", () => {
    const grouped = activeSeedsByPlatform([seedRow("youtube", "   ")]);
    expect(grouped.youtube).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which source wins
// ---------------------------------------------------------------------------

describe("where seeds come from", () => {
  it("uses the database when there is one, and says the environment is ignored", async () => {
    const resolved = await resolveSeedStore({
      databaseConfigured: true,
      client: {} as TenantClient,
      env: { PLATFORM_SEEDS_TIKTOK: "from-env" },
    });
    expect(resolved.origin).toBe("database");
    expect(resolved.store.readOnlyReason).toBeNull();
    // The word matters: an operator who has both needs to know which one the
    // run will actually use, and "ignored" is the only unambiguous way to say it.
    expect(resolved.explanation).toMatch(/IGNORED/);
  });

  it("falls back to the environment only when there is no database, read-only", async () => {
    const resolved = await resolveSeedStore({
      databaseConfigured: false,
      env: { PLATFORM_SEEDS_TIKTOK: "from-env" },
    });
    expect(resolved.origin).toBe("environment");
    expect(resolved.store.readOnlyReason).not.toBeNull();
    expect(await resolved.store.listSeeds()).toEqual([
      expect.objectContaining({ platform: "tiktok", seed: "from-env" }),
    ]);
  });

  it("refuses a write against the environment with the reason a form can print", async () => {
    const store = new EnvSeedStore({ PLATFORM_SEEDS_TIKTOK: "from-env" });
    await expect(store.addSeed({ platform: "tiktok", seed: "x" })).rejects.toThrow(SeedStoreError);
    // Not silence and not `false`. A person pressed a button and is waiting to
    // find out whether their seed was saved.
    await expect(store.addSeed({ platform: "tiktok", seed: "x" })).rejects.toThrow(
      /no database/i,
    );
  });

  it("gives an environment seed no invented history", async () => {
    const [row] = await new EnvSeedStore({ PLATFORM_SEEDS_YOUTUBE: "@someone" }).listSeeds();
    // The environment records nobody and no moment. A fabricated `added_at` of
    // "now" would read on the page as somebody having added it today.
    expect(row.added_by).toBeNull();
    expect(row.last_fetched_ok_at).toBeNull();
    // Null, not a stand-in moment. A fabricated `added_at` reads on the page as
    // somebody having added this today; an em dash reads as nobody knowing.
    expect(row.added_at).toBeNull();
  });
});

describe("the migration path off the environment is visible, not magic", () => {
  it("names the environment seeds a database does not already hold", () => {
    const pending = environmentSeedsAwaitingImport([seedRow("tiktok", "held")], {
      PLATFORM_SEEDS_TIKTOK: "held, missing",
    });
    expect(pending.tiktok).toEqual(["missing"]);
  });

  it("treats a seed that differs only by case or a leading @ as already held, BOTH WAYS ROUND", () => {
    // Otherwise the import banner never goes away: it would offer @Someone
    // forever against a stored someone, and a banner that cannot be cleared is
    // a banner people stop reading.
    //
    // BOTH SIDES ARE ASSERTED, and that is a mutation-check finding rather than
    // thoroughness for its own sake. The first case alone passed with the
    // normalisation removed from the HELD side — normalising only the
    // environment value is enough to match a stored bare handle, so half the
    // comparison was untested and a stored "@Someone" against an environment
    // "someone" would have gone on being offered forever.
    expect(
      environmentSeedsAwaitingImport([seedRow("youtube", "someone")], {
        PLATFORM_SEEDS_YOUTUBE: "@Someone",
      }).youtube,
    ).toEqual([]);

    expect(
      environmentSeedsAwaitingImport([seedRow("youtube", "@Someone")], {
        PLATFORM_SEEDS_YOUTUBE: "someone",
      }).youtube,
    ).toEqual([]);
  });

  it("offers nothing when the environment names nothing", () => {
    const pending = environmentSeedsAwaitingImport([], {});
    for (const platform of PLATFORMS) expect(pending[platform]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The proposal engine
// ---------------------------------------------------------------------------

describe("cross-platform seed proposals", () => {
  const base = {
    existingSeeds: [] as Pick<Seed, "platform" | "seed">[],
    existingProposals: [] as Pick<SeedProposal, "platform" | "seed">[],
    proposedBy: "test",
  };

  it("suggests a handle for every other platform and never for its own", () => {
    const candidates = proposeSeedsFrom({ ...base, shorts: [short("youtube")] });
    expect(candidates.map((c) => c.platform)).toEqual(
      PLATFORMS.filter((p) => p !== "youtube"),
    );
    // Proposing a YouTube handle as a YouTube seed is not a cross-platform
    // guess; it is a duplicate of what the run already had, and the database
    // refuses it too.
    expect(candidates.some((c) => c.platform === c.observed_platform)).toBe(false);
  });

  it("carries the post the handle was read off, because a guess with no evidence cannot be ruled on", () => {
    const [candidate] = proposeSeedsFrom({
      ...base,
      shorts: [short("tiktok", { url: "https://example.invalid/tiktok/42" })],
    });
    expect(candidate.evidence_url).toBe("https://example.invalid/tiktok/42");
    expect(candidate.observed_platform).toBe("tiktok");
    expect(candidate.proposed_by).toBe("test");
  });

  it("stores the handle exactly as observed, never the normalised form", () => {
    // `normaliseForComparison` decides whether to OFFER a guess. It does not get
    // to decide what the operator is offered: a seed is somebody else's
    // identifier and this tool does not rewrite one.
    const [candidate] = proposeSeedsFrom({
      ...base,
      shorts: [short("youtube", { creator_handle: "@Khaby.Lame" })],
    });
    expect(candidate.seed).toBe("@Khaby.Lame");
    expect(normaliseForComparison(candidate.seed)).toBe("khaby.lame");
  });

  it("says nothing about a short whose source did not give a handle", () => {
    const candidates = proposeSeedsFrom({
      ...base,
      shorts: [short("youtube", { creator_handle: null }), short("x", { creator_handle: "  " })],
    });
    expect(candidates).toEqual([]);
  });

  it("never re-proposes a guess a person already rejected", () => {
    // The failure this prevents is a queue nobody reads: a nightly run that
    // re-files every "no" turns a decision into a recurring notification.
    const candidates = proposeSeedsFrom({
      ...base,
      shorts: [short("youtube", { creator_handle: "@taken" })],
      existingProposals: [{ platform: "tiktok", seed: "taken" }],
    });
    expect(candidates.some((c) => c.platform === "tiktok")).toBe(false);
    expect(candidates.some((c) => c.platform === "instagram")).toBe(true);
  });

  it("never proposes a seed that is already held, active or not", () => {
    const candidates = proposeSeedsFrom({
      ...base,
      shorts: [short("youtube", { creator_handle: "@already" })],
      existingSeeds: [{ platform: "tiktok", seed: "@already" }],
    });
    expect(candidates.some((c) => c.platform === "tiktok")).toBe(false);
  });

  it("collapses ten videos by one creator into one suggestion per platform", () => {
    const shorts = Array.from({ length: 10 }, (_, i) =>
      short("youtube", { platform_video_id: `v${i}`, creator_handle: "@prolific" }),
    );
    const candidates = proposeSeedsFrom({ ...base, shorts });
    expect(candidates).toHaveLength(PLATFORMS.length - 1);
  });

  it("returns the same order for the same run, so a diff of the queue means something", () => {
    const shorts = [short("youtube", { creator_handle: "@b" }), short("x", { creator_handle: "@a" })];
    const once = proposeSeedsFrom({ ...base, shorts });
    const twice = proposeSeedsFrom({ ...base, shorts });
    expect(once).toEqual(twice);
    // Grouped by target platform in the vocabulary's order.
    const order = once.map((c) => c.platform);
    expect(order).toEqual([...order].sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b)));
  });

  it("can be pointed at a narrower set of targets by its caller", () => {
    // Which platforms take a seed is a per-platform fact and lives behind the
    // per-platform seam. This module takes it as an argument rather than
    // holding a table of it.
    const candidates = proposeSeedsFrom({
      ...base,
      shorts: [short("youtube")],
      targets: ["tiktok"],
    });
    expect(candidates.map((c) => c.platform)).toEqual(["tiktok"]);
  });
});

// ---------------------------------------------------------------------------
// The store, against the in-memory implementation
// ---------------------------------------------------------------------------

describe("a seed is deactivated, never deleted", () => {
  it("keeps who switched it off and when", async () => {
    const store = new MemorySeedStore();
    await store.addSeed({ platform: "tiktok", seed: "MS4w", addedBy: "adder" });
    const off = await store.setSeedActive("tiktok", "MS4w", false, "switcher", "2026-09-05T00:00:00.000Z");

    expect(off.active).toBe(false);
    expect(off.deactivated_by).toBe("switcher");
    expect(off.deactivated_at).toBe("2026-09-05T00:00:00.000Z");
    // The provenance of the original decision survives the reversal of it.
    expect(off.added_by).toBe("adder");
  });

  it("keeps the deactivation stamped on the row after it is switched back on", async () => {
    const store = new MemorySeedStore();
    await store.addSeed({ platform: "tiktok", seed: "MS4w" });
    await store.setSeedActive("tiktok", "MS4w", false, "switcher", "2026-09-05T00:00:00.000Z");
    const on = await store.setSeedActive("tiktok", "MS4w", true, "switcher");

    expect(on.active).toBe(true);
    // Clearing this would throw away by the back door exactly the history the
    // refusal to delete rows exists to preserve.
    expect(on.deactivated_at).toBe("2026-09-05T00:00:00.000Z");
  });

  it("points at reactivation rather than letting a duplicate be added", async () => {
    const store = new MemorySeedStore();
    await store.addSeed({ platform: "tiktok", seed: "MS4w" });
    await store.setSeedActive("tiktok", "MS4w", false, null);
    await expect(store.addSeed({ platform: "tiktok", seed: "MS4w" })).rejects.toThrow(/reactivate/i);
  });

  it("refuses a change to a seed it does not hold instead of reporting success", async () => {
    const store = new MemorySeedStore();
    await expect(store.setSeedActive("tiktok", "nope", false, null)).rejects.toThrow(SeedStoreError);
  });
});

describe("what last_fetched_ok_at is allowed to claim", () => {
  it("stamps the active seeds of one platform and nothing else", async () => {
    const store = new MemorySeedStore([
      seedRow("tiktok", "live"),
      seedRow("tiktok", "off", { active: false, deactivated_at: "2026-09-04T00:00:00.000Z" }),
      seedRow("youtube", "other"),
    ]);
    await store.noteSeedsFetched("tiktok", "2026-09-06T00:00:00.000Z");
    const byKey = new Map((await store.listSeeds()).map((s) => [`${s.platform}/${s.seed}`, s]));

    expect(byKey.get("tiktok/live")?.last_fetched_ok_at).toBe("2026-09-06T00:00:00.000Z");
    // A seed that was switched off was not asked, so it did not get asked.
    expect(byKey.get("tiktok/off")?.last_fetched_ok_at).toBeNull();
    // And a run of one platform says nothing whatsoever about another.
    expect(byKey.get("youtube/other")?.last_fetched_ok_at).toBeNull();
  });
});

describe("a proposal is never promoted by the store", () => {
  it("files a suggestion as pending and puts nothing in the seed list", async () => {
    const store = new MemorySeedStore();
    const written = await store.addProposals([
      {
        platform: "tiktok",
        seed: "@guess",
        observed_platform: "youtube",
        observed_handle: "@guess",
        evidence_url: "https://example.invalid/youtube/1",
        evidence_note: null,
        proposed_by: "test",
      },
    ]);

    expect(written).toHaveLength(1);
    expect(written[0].state).toBe("pending");
    // THE ASSERTION THAT MATTERS. Filing a guess must not add a seed. Accepting
    // is a second call that a person authorised, and the migration backs this
    // up with grants: the unattended worker has INSERT on proposals and not on
    // seeds, so it holds even if this file is edited badly.
    expect(await store.listSeeds()).toEqual([]);
  });

  it("skips a guess it has already ruled on, in any state", async () => {
    const store = new MemorySeedStore();
    const candidate = {
      platform: "tiktok" as Platform,
      seed: "@guess",
      observed_platform: "youtube" as Platform,
      observed_handle: "@guess",
      evidence_url: "https://example.invalid/youtube/1",
      evidence_note: null,
      proposed_by: "test",
    };
    const [first] = await store.addProposals([candidate]);
    await store.decideProposal(first.id, "rejected", "a person");

    expect(await store.addProposals([candidate])).toEqual([]);
    expect(await store.listProposals()).toHaveLength(1);
  });

  it("records who decided and when", async () => {
    const store = new MemorySeedStore();
    const [proposal] = await store.addProposals([
      {
        platform: "instagram",
        seed: "@guess",
        observed_platform: "youtube",
        observed_handle: "@guess",
        evidence_url: "https://example.invalid/youtube/1",
        evidence_note: null,
        proposed_by: "test",
      },
    ]);
    const decided = await store.decideProposal(proposal.id, "accepted", "erik", "2026-09-07T00:00:00.000Z");
    expect(decided.state).toBe("accepted");
    expect(decided.decided_by).toBe("erik");
    expect(decided.decided_at).toBe("2026-09-07T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// The pager, which is a scar
// ---------------------------------------------------------------------------

/**
 * A PostgREST-shaped fake with a `Max rows` cap.
 *
 * The cap is the point. PostgREST truncates every response at the project's
 * `Max rows` with a 200, a `Content-Range` header and NO ERROR OBJECT, and the
 * code this repo replaced believed a short page meant the end of the table.
 */
function cappedClient(rows: unknown[], cap: number): TenantClient {
  const query = () => {
    const q = {
      order: () => q,
      range: (from: number, to: number) =>
        Promise.resolve({
          data: rows.slice(from, from + Math.min(cap, to - from + 1)),
          error: null,
        }),
    };
    return q;
  };
  return { from: () => ({ select: query }) } as unknown as TenantClient;
}

/** A server that always answers with one row and never says it is done. */
function neverEndingClient(): TenantClient {
  const query = () => {
    const q = {
      order: () => q,
      range: (from: number) =>
        Promise.resolve({ data: [seedRow("tiktok", `seed-${from}`)], error: null }),
    };
    return q;
  };
  return { from: () => ({ select: query }) } as unknown as TenantClient;
}

describe("a seed read reaches the end of the table or refuses", () => {
  it("keeps paging when every page is shorter than it asked for", async () => {
    // A project whose `Max rows` is below the page size answers EVERY request
    // short. "Stop when a page is shorter than I asked for" would stop after
    // the first one and report 7 seeds out of 30 as the whole list.
    const rows = Array.from({ length: 30 }, (_, i) => seedRow("tiktok", `seed-${String(i).padStart(3, "0")}`));
    const store = new SupabaseSeedStore(cappedClient(rows, 7));
    expect(await store.listSeeds()).toHaveLength(30);
  });

  it("refuses rather than handing back a partial seed list", async () => {
    // The refusal is the design. A run made against a truncated seed list reads
    // fewer creators than it was configured to and then reports "ok, found 3",
    // and no page anywhere could show that. A partial list of shorts is worth
    // printing with a notice; a partial list of seeds is not worth having.
    const store = new SupabaseSeedStore(neverEndingClient());
    await expect(store.listSeeds()).rejects.toThrow(SeedStoreError);
    await expect(store.listSeeds()).rejects.toThrow(
      new RegExp(String(MAX_REQUESTS_PER_READ)),
    );
  });

  it("surfaces a PostgREST error instead of treating it as an empty table", async () => {
    const client = {
      from: () => ({
        select: () => {
          const q = {
            order: () => q,
            range: () => Promise.resolve({ data: null, error: { message: "PGRST106" } }),
          };
          return q;
        },
      }),
    } as unknown as TenantClient;
    await expect(new SupabaseSeedStore(client).listSeeds()).rejects.toThrow(/PGRST106/);
  });
});
