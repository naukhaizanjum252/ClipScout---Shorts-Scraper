import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { AUTO_SEED_PER_PLATFORM, AUTO_SEED_WINDOW_DAYS, MemorySeedStore } from "@/lib/shorts/seeds";

/**
 * SEEDS ARE DERIVED STATE NOW, AND THIS IS WHAT KEEPS THEM HONEST.
 *
 * Erik, 2026-09-05: *"Seeds is not suppose to be a manual task, can you fully
 * automate 200 top seeds for each and then remove the front end. We don't want
 * to see or use it we just want the scraper to work."* And, on the number:
 * *"this 200 should be dynamic... not just the 200 now but the 200 on a weekly
 * basis"*.
 *
 * THAT SECOND SENTENCE IS WHY THIS FEATURE IS BUILDABLE AT ALL. A fixed list of
 * "the top 200 creators" is not something this repo can obtain — nobody sells
 * one, and writing one out by hand would be inventing a ranking and shipping it
 * as data. A ROLLING top 200 is a claim about what THIS deployment fetched in
 * the last seven days, computed from `shorts_scraper.shorts`, and every row in
 * it was observed.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The ranking is SQL, and the suite is
 * offline by design (vitest.config.mts says so), so nothing here executes it.
 * What is checked instead is the half that a green suite can actually
 * establish: that the migration says what the code assumes it says, and that
 * the run path refreshes before it reads and survives a refresh that fails.
 * A test that mocked the RPC and asserted the mock was called would prove the
 * mock.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260905_11_auto_seeds.sql"),
  "utf8",
);

/**
 * The migration with its comments removed.
 *
 * THE SAME TRAP tests/admin-routes.test.ts and tests/migrations.test.ts both
 * record: this migration's header EXPLAINS the manual-row guard at length, so a
 * check that searched the raw file for `source = 'auto'` would pass on a
 * migration whose SQL had lost it entirely. Prose describing a safeguard is not
 * the safeguard.
 */
const SQL = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])--.*/g, "$1");

describe("the migration actually does what the TypeScript assumes", () => {
  it("strips comments, so the assertions below are not vacuous", () => {
    // Anti-vacuity. The header names 'auto', 'manual' and the window in prose;
    // if the stripper silently returned its input every case here would pass on
    // a migration that had been gutted.
    expect(MIGRATION).toMatch(/rolling top 200/i);
    expect(SQL).not.toMatch(/rolling top 200/i);
    expect(SQL).toMatch(/create or replace function shorts_scraper\.refresh_auto_seeds/i);
  });

  it("defaults to the window and size the TypeScript defaults to", () => {
    // TWO PLACES DECLARE THESE NUMBERS — the SQL signature and lib/shorts/seeds.ts
    // — because the RPC has to work when called from psql with no arguments and
    // the client has to send something explicit. Two declarations of one number
    // is exactly the drift this repo keeps writing scars about, so they are
    // pinned to each other here.
    expect(AUTO_SEED_WINDOW_DAYS).toBe(7);
    expect(AUTO_SEED_PER_PLATFORM).toBe(200);
    expect(SQL).toMatch(
      new RegExp(`in_window_days\\s+integer\\s+default\\s+${AUTO_SEED_WINDOW_DAYS}`, "i"),
    );
    expect(SQL).toMatch(
      new RegExp(`in_per_platform\\s+integer\\s+default\\s+${AUTO_SEED_PER_PLATFORM}`, "i"),
    );
  });

  it("never deactivates a seed a person added", () => {
    // THE ONE DESTRUCTIVE THING THIS FEATURE COULD DO. The refresh retires
    // automatic seeds that fell out of the top 200; without the `source` guard
    // that sweep would also switch off a creator somebody deliberately chose,
    // silently, on a page that no longer exists to switch it back on.
    const sweep = /update\s+shorts_scraper\.platform_seeds[\s\S]*?;/i.exec(SQL)?.[0] ?? "";
    expect(sweep, "no retirement sweep found — has the refresh changed shape?").not.toBe("");
    expect(sweep).toMatch(/source\s*=\s*'auto'/i);
  });

  it("does not let the upsert reactivate a manual row through the back door", () => {
    // The other half of the same guard, and the easier one to lose: the INSERT
    // ... ON CONFLICT sets active = true, and without the CASE it would switch
    // a manual seed back on that a person had switched off.
    const upsert = /on conflict[\s\S]*?;/i.exec(SQL)?.[0] ?? "";
    expect(upsert).toMatch(/source\s*=\s*'auto'/i);
    expect(upsert).toMatch(/case/i);
  });

  it("defaults existing rows to manual, so nothing already there is adopted", () => {
    // Every row in this table today was added by a person through the page this
    // change deletes. A default of 'auto' would hand all of them to the sweep.
    expect(SQL).toMatch(/add column if not exists source text not null default 'manual'/i);
  });

  it("refuses to turn a weekly window into a lifetime one", () => {
    // greatest(1, ...) on the window. A zero or negative argument would make
    // `now() - interval '0 days'` match nothing, or worse, and a ranking that
    // silently covered all of history would stop being weekly without saying so.
    expect(SQL).toMatch(/greatest\(1,\s*in_window_days\)/i);
  });

  it("skips rows whose creator was never identified", () => {
    // A short with no creator_handle is not evidence about any creator, and
    // grouping them together would invent one made of everybody.
    expect(SQL).toMatch(/creator_handle is not null/i);
  });

  it("keeps EXECUTE away from public and anon, like every other function here", () => {
    for (const fn of ["top_creators", "refresh_auto_seeds"]) {
      const revoke = new RegExp(`revoke execute on function shorts_scraper\\.${fn}\\(`, "i");
      expect(SQL, `${fn} is not revoked`).toMatch(revoke);
    }
    expect(SQL).toMatch(/grant execute on function shorts_scraper\.refresh_auto_seeds\([^)]*\) to service_role/i);
  });
});

describe("the stores that cannot rank say so by doing nothing", () => {
  it("returns zero from the in-memory store rather than inventing a ranking", async () => {
    // THERE IS EXACTLY ONE IMPLEMENTATION OF THE RANKING and it is the SQL. A
    // second one in TypeScript would be a second answer to "who are the top
    // creators", free to disagree with the one the run actually uses. The
    // in-memory store has no observation history at all — no view counts, no
    // discovered_at — so 0 is the truthful return, not a stub.
    const store = new MemorySeedStore();
    await expect(store.refreshAutoSeeds()).resolves.toBe(0);
  });

  it("does not add, remove or alter any seed while doing nothing", async () => {
    const store = new MemorySeedStore();
    await store.addSeed({ platform: "youtube", seed: "@someone", note: null, addedBy: null });
    const before = await store.listSeeds();

    await store.refreshAutoSeeds();

    expect(await store.listSeeds()).toEqual(before);
  });
});

describe("the run path refreshes before it reads", () => {
  it("recomputes the ranking before listing seeds on a scheduled run", () => {
    // ORDER IS THE WHOLE POINT. Refreshing after the read would mean every run
    // used the previous run's ranking, so the "weekly" list would always be one
    // run stale — and on a deployment that runs weekly, a week stale.
    const source = read("lib/shorts/schedule.ts");
    const refresh = source.indexOf("refreshAutoSeeds()");
    const list = source.indexOf("options.seeds.listSeeds()");
    expect(refresh, "the scheduled run never refreshes the seed list").toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(refresh, "the refresh runs after the read, so the run uses a stale ranking").toBeLessThan(
      list,
    );
  });

  it("refreshes on the button path too, so both paths read the same list", () => {
    const source = read("app/(admin)/admin/shorts/actions.ts");
    expect(source).toContain("refreshAutoSeeds()");
  });

  it("does not let a failed refresh stop a run, on either path", () => {
    // A ranking that cannot be recomputed still has last time's answer sitting
    // in the table, and that is a better run than no run. Both call sites wrap
    // the refresh and log rather than throwing.
    for (const rel of ["lib/shorts/schedule.ts", "app/(admin)/admin/shorts/actions.ts"]) {
      const source = read(rel);
      const at = source.indexOf("refreshAutoSeeds()");
      const window = source.slice(Math.max(0, at - 400), at + 400);
      expect(window, `${rel} does not guard the refresh`).toMatch(/try\s*\{/);
      expect(window, `${rel} does not log the failure`).toMatch(/catch/);
    }
  });
});

/**
 * A SEED IS AN ADDRESS, NOT A DISPLAY NAME.
 *
 * SCAR, live database, 2026-09-05, one day after the ranking above shipped:
 * every platform on /admin/shorts read "will not run". The ranking seeds
 * `shorts.creator_handle`, and the keyless YouTube path fills that column with
 * the channel's DISPLAY NAME for some rows — so "Cocomelon - Nursery Rhymes",
 * "Ian Gunther", "Jose.elCook" and "The BN Brothers" were seeded beside
 * seventeen good handles, and the YouTube adapter refused the whole platform on
 * the first of them. TikTok was worse: thirteen @names, and a TikTok seed can
 * only ever be a sec_uid.
 *
 * Migration 13 makes the ranking emit the value the platform's own adapter can
 * ADDRESS, and nothing when it has none. The same offline limits apply as
 * above — nothing here executes the SQL — so what is checked is that the
 * migration says what the TypeScript assumes, and that the two declarations of
 * each seed format have not drifted apart.
 */
const SHAPES = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260905_13_seed_shapes.sql"),
  "utf8",
);
const SHAPES_SQL = SHAPES.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])--.*/g, "$1");

describe("the ranking seeds an address the adapter can use", () => {
  it("strips comments, so the assertions below are not vacuous", () => {
    expect(SHAPES).toMatch(/Cocomelon/);
    expect(SHAPES_SQL).not.toMatch(/Cocomelon/);
    expect(SHAPES_SQL).toMatch(/create or replace function shorts_scraper\.seed_from_short/i);
  });

  it("ranks by the address and not by the name the extractor happened to report", () => {
    // The whole bug in one line: `group by creator_handle` ranked display names.
    expect(SHAPES_SQL).toMatch(/seed_from_short\(\s*s\.platform\s*,\s*s\.creator_handle\s*,\s*s\.creator_id\s*\)/i);
    expect(SHAPES_SQL).toMatch(/group by x\.addr/i);
  });

  it("seeds nothing for an observation it cannot address", () => {
    // Null is "this row names no creator this tool can go back to". Storing it
    // would put a seed in the table that nothing can ever read.
    expect(SHAPES_SQL).toMatch(/where x\.addr is not null/i);
  });

  it("uses the SAME YouTube channel-id pattern the TypeScript parses with", () => {
    // TWO DECLARATIONS OF ONE FORMAT, pinned to each other. lib/yt/channel-ref.ts
    // is the one the adapter parses with; a ranking that seeded a shape that
    // file rejects is exactly what this migration exists to stop.
    const ts = /const CHANNEL_ID = \/(.+?)\/;/.exec(read("lib/yt/channel-ref.ts"))?.[1] ?? "";
    expect(ts, "CHANNEL_ID not found in lib/yt/channel-ref.ts").not.toBe("");
    expect(SHAPES_SQL).toContain(`'${ts}'`);
  });

  it("emits a YouTube handle WITH its @, which is what makes a dotted handle parse", () => {
    // `Jose.elCook` was one of the four. `parseChannelRef` reads a bare token
    // containing a dot as a URL and rejects it; `@Jose.elCook` is unambiguous.
    expect(SHAPES_SQL).toMatch(/'@'\s*\|\|\s*ltrim\(btrim\(in_creator_handle\), '@'\)/i);
  });

  it("will seed TikTok with a sec_uid and with nothing else", () => {
    // Neither of the columns this deployment stores for TikTok is a sec_uid, so
    // today this yields no TikTok seeds at all. An empty list says "seed one";
    // thirteen @names said "this platform is broken".
    const secUid = /const SEC_UID = \/\^MS4wLjABAAAA\[[^\]]+\]\{(\d+)\}\$\/;/.exec(
      read("lib/platform/tiktok.ts"),
    );
    expect(secUid, "SEC_UID not found in lib/platform/tiktok.ts").not.toBeNull();
    expect(SHAPES_SQL).toContain(`MS4wLjABAAAA[A-Za-z0-9_-]{${secUid?.[1]}}`);
  });

  it("seeds X with nothing, because the X adapter has no seed input", () => {
    // X is read by search query. A ranked X seed was a row nothing could read.
    const fn = /create or replace function shorts_scraper\.seed_from_short[\s\S]*?\$\$;/i.exec(SHAPES_SQL)?.[0] ?? "";
    expect(fn, "seed_from_short not found").not.toBe("");
    expect(fn).not.toMatch(/when 'x' then\s+case/i);
  });

  it("keeps the manual-row guard through the rewrite", () => {
    // The refresh is rewritten in this migration, and the guard migration 11's
    // tests protect lives inside it. A rewrite is exactly how that guard would
    // be lost.
    const upsert = /on conflict[\s\S]*?;/i.exec(SHAPES_SQL)?.[0] ?? "";
    expect(upsert).toMatch(/source\s*=\s*'auto'/i);
    const sweeps = SHAPES_SQL.match(/update\s+shorts_scraper\.platform_seeds[\s\S]*?;/gi) ?? [];
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) expect(sweep).toMatch(/source\s*=\s*'auto'/i);
  });

  it("retires the rows already written using the rule itself, not a copy of it", () => {
    // A second copy of the regexes in the cleanup would be free to disagree
    // with the function above it. Feeding a seed back through `seed_from_short`
    // and asking whether it comes out unchanged is the same rule, once.
    expect(SHAPES_SQL).toMatch(
      /seed_from_short\(ps\.platform, ps\.seed, ps\.seed\) is distinct from ps\.seed/i,
    );
  });

  it("keeps EXECUTE away from public and anon on all three functions", () => {
    for (const fn of ["seed_from_short", "top_creators", "refresh_auto_seeds"]) {
      expect(SHAPES_SQL, `${fn} is not revoked`).toContain(
        `revoke execute on function shorts_scraper.${fn}(`,
      );
      expect(SHAPES_SQL, `${fn} is not granted to service_role`).toMatch(
        new RegExp(String.raw`grant execute on function shorts_scraper\.${fn}\([^)]*\) to service_role`, "i"),
      );
    }
  });
});

describe("the front end is gone", () => {
  it("has no seeds page, panel or actions left in the tree", () => {
    // Erik: "We don't want to see or use it we just want the scraper to work."
    expect(fs.existsSync(path.join(ROOT, "app/(admin)/admin/seeds"))).toBe(false);
  });

  it("does not offer a link to it in the rail", () => {
    // A nav item pointing at a deleted route is a 404 with a chip on it.
    const layout = read("app/(admin)/admin/layout.tsx");
    const nav = /const NAV = \[[\s\S]*?\] as const;/.exec(layout)?.[0] ?? "";
    expect(nav, "the NAV array could not be found").not.toBe("");
    expect(nav).not.toContain("/admin/seeds");
    // And the two that remain are still there.
    expect(nav).toContain("/admin/shorts");
    expect(nav).toContain("/admin/credentials");
  });
});
