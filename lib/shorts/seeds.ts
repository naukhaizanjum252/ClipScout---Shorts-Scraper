/**
 * SEEDS ARE DATA, NOT DEPLOYMENT.
 *
 * Two of the five adapters cannot browse their platform at all and read a named
 * list of creators instead. Until now that list was `PLATFORM_SEEDS_YOUTUBE`
 * and `PLATFORM_SEEDS_TIKTOK`, environment variables read by
 * lib/platform/registry.ts. Two things follow from that which nobody chose:
 * the ops team cannot add a creator without a commit and a redeploy, and a seed
 * has no provenance — no who, no when, no note, no record of whether it has ever
 * been read successfully. This module makes a seed a row with all four.
 *
 * WHICH SOURCE WINS, AND WHY IT IS NOT A MERGE
 *
 *   Supabase configured  -> the database, ALONE. The environment is ignored.
 *   otherwise            -> the environment, read-only.
 *
 * The tempting version is a union of the two. It is wrong, and specifically it
 * is wrong in the direction that costs money and lies on screen: an operator
 * deactivates a seed on /admin/seeds, the environment still names it, the union
 * keeps fetching it, and the page shows it as inactive. A seed that is switched
 * off has to stop being fetched or the switch is decoration.
 *
 * The same argument settles the other tempting version — "fall back to the
 * environment when the database has no seeds for a platform". Zero seeds is a
 * legitimate state that somebody reached by turning the last one off, and
 * resurrecting the environment's list at that exact moment would undo the last
 * deactivation with nothing anywhere saying so. Zero means zero.
 *
 * A deployment that HAS environment seeds and then gains a database therefore
 * starts with nothing, which would be a nasty surprise if it happened quietly.
 * It does not: `environmentSeedsAwaitingImport()` reports exactly which seeds
 * the environment names that the database does not hold, and /admin/seeds shows
 * them with a button that copies them in. A person presses it once.
 *
 * WHAT A SEED LOOKS LIKE IS NOT DECIDED HERE
 *
 * There is no validation of a seed's shape in this file and there must not be
 * one. A YouTube seed is a channel id or an @handle; a TikTok seed is a
 * 76-character sec_uid and yt-dlp cannot start from an @handle at all; an
 * Instagram Business Discovery seed is a professional account's @username. One
 * validator that admits all of those admits nearly anything — the same mistake
 * as the 11-character video-id constraint that made this repo single-platform
 * (lib/platform/types.ts). Shape is a per-platform fact and it lives behind the
 * per-platform seam, where the adapter can refuse a bad seed in a sentence
 * naming what is wrong with it. The TikTok adapter already does exactly that.
 *
 * THE PROPOSAL QUEUE, AND THE PART THAT IS NOT AUTOMATABLE
 *
 * Erik asked whether TikTok creators can be seeded automatically. Key-lessly
 * they cannot be DISCOVERED: yt-dlp 2026.07.04 marks tiktok:tag, tiktok:sound
 * and tiktok:effect CURRENTLY BROKEN, there is no trending extractor, and all
 * three official TikTok APIs are closed to this use. A scheduler can refresh a
 * list it was given; nothing available here can grow one.
 *
 * What is available is one weaker signal: a creator found on one platform very
 * often uses the same handle on another. `proposeSeedsFrom` turns the handles a
 * run actually saw into suggestions for the other platforms, each carrying the
 * post it was read off. THEY ARE NEVER PROMOTED AUTOMATICALLY, and the reason is
 * that a proposal is a guess about IDENTITY. @coffee on TikTok and @coffee on
 * Instagram are frequently two unrelated people, and a wrong guess does not
 * fail — it fills the inventory with somebody else's videos under a name the
 * operator trusts, and the only way to find out is for a human to notice. So
 * the human step is the mechanism, not a review of it: `addProposals` writes to
 * a different table from `addSeed`, and the migration gives the unattended
 * worker INSERT on the first and not the second, so the promotion cannot happen
 * by an oversight in this file either.
 */
import { PLATFORMS, type Platform, type ShortRecord } from "../platform/types";
import { seedEnvKey, seedsFor, type Env } from "../platform/registry";
import type { TenantClient } from "../supabase/config";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * One seeded creator.
 *
 * snake_case because this shape crosses the wire into the database, and a
 * rename in the middle is a bug waiting to happen — the same rule
 * `ShortRecord` follows.
 */
export interface Seed {
  readonly platform: Platform;
  /** Whatever that platform's adapter takes. Stored and handed on verbatim. */
  readonly seed: string;
  readonly active: boolean;
  readonly note: string | null;
  /**
   * NULL MEANS NOBODY RECORDED IT, which is the state of every seed that came
   * from an environment variable. The database column is `not null` with a
   * default, so a database seed always has one; the environment records neither
   * a person nor a moment, and a fabricated `added_at` would read on the page as
   * somebody having added it today. An unmeasured figure is an em dash and never
   * a value that looks measured.
   */
  readonly added_at: string | null;
  readonly added_by: string | null;
  readonly deactivated_at: string | null;
  readonly deactivated_by: string | null;
  /**
   * The last time a run of THIS PLATFORM finished without throwing while this
   * seed was active.
   *
   * IT IS NOT EVIDENCE THAT THIS SEED PRODUCED ANYTHING. No adapter reports a
   * per-seed outcome — each loops its own seeds and returns one list — so
   * per-seed success is not a fact this module is in a position to hold.
   * Reading this column as a health check on a creator is the mistake it is
   * most likely to invite, which is why it is spelled out here, on the column
   * comment in the migration, and in the words on the page.
   */
  readonly last_fetched_ok_at: string | null;
}

export type ProposalState = "pending" | "accepted" | "rejected";

/** A cross-platform guess about a creator's identity, awaiting a person. */
export interface SeedProposal {
  readonly id: string;
  /** The platform this seed is proposed FOR. */
  readonly platform: Platform;
  readonly seed: string;
  readonly state: ProposalState;
  /** Where the handle was actually seen. Never the same as `platform`. */
  readonly observed_platform: Platform;
  readonly observed_handle: string;
  /** The canonical post the handle was read off. Permanent; never a media URL. */
  readonly evidence_url: string;
  readonly evidence_note: string | null;
  readonly proposed_at: string;
  /** Which run or adapter observed it. Provenance recorded, never inferred. */
  readonly proposed_by: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
}

export interface NewSeed {
  readonly platform: Platform;
  readonly seed: string;
  readonly note?: string | null;
  readonly addedBy?: string | null;
  readonly addedAt?: string;
}

/**
 * How far back the automatic ranking looks, and how many creators it keeps.
 *
 * SEVEN DAYS IS ERIK'S OWN FIGURE — "the 200 on a weekly basis" — and 200 is
 * his too. They are defaults rather than constants because the run path may
 * want a different window one day and because a test must be able to use a
 * window it can construct rows inside.
 */
export interface AutoSeedOptions {
  readonly windowDays?: number;
  readonly perPlatform?: number;
}

export const AUTO_SEED_WINDOW_DAYS = 7;
export const AUTO_SEED_PER_PLATFORM = 200;

/** A proposal before it has an id or a state. What `proposeSeedsFrom` returns. */
export interface ProposalCandidate {
  readonly platform: Platform;
  readonly seed: string;
  readonly observed_platform: Platform;
  readonly observed_handle: string;
  readonly evidence_url: string;
  readonly evidence_note: string | null;
  readonly proposed_by: string;
}

export class SeedStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedStoreError";
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Where seeds and proposals live.
 *
 * `readOnlyReason` follows `PlatformAdapter.unavailableReason` deliberately:
 * NULL MEANS WRITABLE, and a string is the sentence a page prints when a
 * control is missing. A boolean would let a surface render a disabled button
 * with nothing beside it explaining why, which is the shape of every "is this
 * broken or am I not allowed" support question this tool could generate.
 *
 * A READ IS ALL OF THEM OR IT THROWS. There is no partial-list branch here,
 * which is a departure from `ShortsStore.readShorts` and a deliberate one. A
 * truncated list of shorts is still a useful list with a notice beside it. A
 * truncated list of SEEDS is a run that silently reads fewer creators and then
 * reports "ok, found 3" — the honesty rule broken by arithmetic rather than by
 * an empty array, and nothing on the screen could show it. So a read that
 * cannot be completed refuses.
 */
export interface SeedStore {
  /** Null when this store can be written to. A sentence when it cannot. */
  readonly readOnlyReason: string | null;

  /**
   * Recompute the automatic seed list from what runs have actually seen.
   *
   * SEEDS ARE NOT A MANUAL TASK ANY MORE. Erik, 2026-09-05: *"Seeds is not
   * suppose to be a manual task, can you fully automate 200 top seeds for each
   * and then remove the front end"*, and on the number: *"this 200 should be
   * dynamic... not just the 200 now but the 200 on a weekly basis"*.
   *
   * That second sentence is the one that makes this honest. A fixed list of
   * "the top 200 creators" is not obtainable — nobody sells one, and typing one
   * out would be inventing a ranking. A ROLLING top 200 is a fact about what
   * this deployment fetched in the last seven days, and that is what this
   * computes: sum of views per creator inside the window, highest first, top N
   * per platform, written back as `source = 'auto'` rows.
   *
   * RETURNS THE NUMBER OF ROWS IT TOUCHED, and it is idempotent — calling it
   * twice changes nothing the second time, which is what lets the run path call
   * it every time instead of it needing a scheduler of its own. The week rolls
   * because the window does.
   *
   * IT NEVER TOUCHES A ROW A PERSON ADDED. Manual rows keep `source = 'manual'`
   * and are excluded from both the activation and the retirement sweep; see the
   * 11 migration for why that guard exists and what it protects.
   */
  refreshAutoSeeds(options?: AutoSeedOptions): Promise<number>;

  /** Every seed, active and inactive, for every platform. */
  listSeeds(): Promise<Seed[]>;

  addSeed(input: NewSeed): Promise<Seed>;

  /** Deactivate or reactivate. There is no delete: see the migration. */
  setSeedActive(
    platform: Platform,
    seed: string,
    active: boolean,
    by: string | null,
    at?: string,
  ): Promise<Seed>;

  /**
   * Stamp every ACTIVE seed of one platform as asked-for.
   *
   * Called after a platform's adapter ran without throwing. See the note on
   * `Seed.last_fetched_ok_at` for what that does and does not prove.
   */
  noteSeedsFetched(platform: Platform, at: string): Promise<void>;

  listProposals(): Promise<SeedProposal[]>;

  /**
   * File new proposals, skipping any (platform, seed) already ruled on.
   *
   * Returns the rows actually written. It never returns a `Seed`, and there is
   * no method here that turns a proposal into one in a single call — accepting
   * is `decideProposal` followed by `addSeed`, two writes a person authorised.
   */
  addProposals(candidates: readonly ProposalCandidate[]): Promise<SeedProposal[]>;

  decideProposal(
    id: string,
    state: Exclude<ProposalState, "pending">,
    by: string | null,
    at?: string,
  ): Promise<SeedProposal>;

  /** Remove a ruling so the guess can be made again. Deliberate, and a person's. */
  deleteProposal(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reading a seed list into the shape the registry takes
// ---------------------------------------------------------------------------

/**
 * The active seeds, grouped, ready for `buildAdapters({ seeds })`.
 *
 * ALL FIVE KEYS ARE ALWAYS PRESENT, most of them empty. `Record<Platform, ...>`
 * rather than a partial map because the compiler then checks the set: add a
 * sixth platform to PLATFORMS and this stops compiling until somebody says what
 * its seeds are, instead of that platform silently arriving with none. Nothing
 * here branches on which platform is which — see lib/platform/registry.test.ts,
 * which fails the build if any module outside lib/platform does.
 */
export function activeSeedsByPlatform(seeds: readonly Seed[]): Record<Platform, readonly string[]> {
  const grouped = {} as Record<Platform, string[]>;
  for (const platform of PLATFORMS) grouped[platform] = [];
  for (const seed of seeds) {
    if (!seed.active) continue;
    const value = seed.seed.trim();
    if (value === "") continue;
    grouped[seed.platform]?.push(value);
  }
  return grouped;
}

/**
 * Seeds named in the environment that the database does not hold.
 *
 * The migration path, made visible instead of magic. See the header: the
 * database wins outright, so a deployment that gains one starts empty, and this
 * is what /admin/seeds shows so a person can copy them across once.
 *
 * The comparison is `normaliseForComparison`, not string equality, so an
 * environment entry that differs only by case or a leading `@` is correctly
 * recognised as already held rather than offered again.
 */
export function environmentSeedsAwaitingImport(
  held: readonly Seed[],
  env: Env = process.env,
): Record<Platform, readonly string[]> {
  const alreadyHeld = new Set(held.map((s) => `${s.platform}\u0000${normaliseForComparison(s.seed)}`));
  const pending = {} as Record<Platform, string[]>;
  for (const platform of PLATFORMS) {
    pending[platform] = seedsFor(platform, { env }).filter(
      (value) => !alreadyHeld.has(`${platform}\u0000${normaliseForComparison(value)}`),
    );
  }
  return pending;
}

/** The `PLATFORM_SEEDS_*` variable a platform's seeds would come from. Re-exported so a page can name it. */
export { seedEnvKey };

// ---------------------------------------------------------------------------
// Comparing handles WITHOUT deciding what a handle is
// ---------------------------------------------------------------------------

/**
 * The form two seeds are compared in — and NEVER the form one is stored in.
 *
 * Lowercase, `@` stripped, whitespace trimmed. That is a guess about handle
 * equality on platforms whose case rules this repo has not verified, so the
 * important part is where it is allowed to be wrong. It is used for exactly two
 * things: not offering an environment seed that is already held, and not
 * proposing a guess that has already been ruled on. If it is too aggressive an
 * operator sees one fewer duplicate suggestion; if it is too lax they see a
 * duplicate and delete it. It NEVER decides what goes into the `seed` column,
 * which is stored exactly as it was typed or observed, because a normalised
 * seed handed to an adapter is this module editing somebody else's identifier.
 */
export function normaliseForComparison(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// The proposal engine
// ---------------------------------------------------------------------------

export interface ProposeOptions {
  /** The rows a run actually kept. Handles are read from these and nowhere else. */
  readonly shorts: readonly ShortRecord[];
  /** Every seed already held, active or not. A held seed is never proposed. */
  readonly existingSeeds: readonly Pick<Seed, "platform" | "seed">[];
  /** Every proposal already ruled on, in any state. A ruling is never reopened. */
  readonly existingProposals: readonly Pick<SeedProposal, "platform" | "seed">[];
  /** Which run observed this. Goes on the row as provenance. */
  readonly proposedBy: string;
  /**
   * Platforms a handle may be proposed FOR. Defaults to all five.
   *
   * IT IS A PARAMETER AND NOT A TABLE IN THIS FILE. Deciding here which
   * platforms take a seed would be this module holding per-platform knowledge,
   * which is the seam lib/platform owns. The honest consequence, written down
   * rather than hidden: the default proposes a handle for every other platform,
   * including ones whose adapter does not read a seed list at all, so some
   * proposals are noise a person rejects. Narrowing that properly needs the
   * adapter contract to say whether it takes seeds and of what kind, which is a
   * change to lib/platform/adapter.ts and not to this file.
   */
  readonly targets?: readonly Platform[];
}

/**
 * Turn the handles a run saw into cross-platform seed suggestions.
 *
 * The rule is one sentence: a creator seen on platform A under handle H is
 * suggested as a seed H on every other platform, once, with the post H was read
 * off as the evidence.
 *
 * WHAT IT REFUSES TO DO, EACH FOR A REASON
 *
 *   - A short with no `creator_handle` produces nothing. Null means the source
 *     did not say, and a proposal built on a blank is a row a person cannot
 *     rule on.
 *   - A handle is never proposed for the platform it was seen on. That is not a
 *     cross-platform guess, it is a duplicate of what the run already had, and
 *     the database refuses it too.
 *   - A (platform, seed) already held as a seed, or already ruled on as a
 *     proposal in ANY state, produces nothing. A rejected guess that comes back
 *     every night is a human's "no" turned into a recurring notification, and
 *     the queue people stop reading is the queue that stops working.
 *   - The same suggestion twice in one batch collapses to one, keeping the
 *     first evidence. Ten of a creator's videos in one run is one proposal.
 *
 * The returned candidates are ordered by target platform in `PLATFORMS` order,
 * then by the order the shorts arrived, so two identical runs produce identical
 * output and a diff of the queue means something.
 */
export function proposeSeedsFrom(options: ProposeOptions): ProposalCandidate[] {
  const targets = options.targets ?? PLATFORMS;

  const ruledOut = new Set<string>();
  for (const held of options.existingSeeds) {
    ruledOut.add(`${held.platform}\u0000${normaliseForComparison(held.seed)}`);
  }
  for (const proposal of options.existingProposals) {
    ruledOut.add(`${proposal.platform}\u0000${normaliseForComparison(proposal.seed)}`);
  }

  const byTarget = new Map<Platform, ProposalCandidate[]>();
  const claimed = new Set<string>();

  for (const short of options.shorts) {
    const handle = short.creator_handle?.trim() ?? "";
    if (handle === "") continue;
    const url = short.url?.trim() ?? "";
    if (url === "") continue;

    for (const target of targets) {
      if (target === short.platform) continue;
      const key = `${target}\u0000${normaliseForComparison(handle)}`;
      if (ruledOut.has(key) || claimed.has(key)) continue;
      claimed.add(key);

      const list = byTarget.get(target) ?? [];
      list.push({
        platform: target,
        // VERBATIM. `normaliseForComparison` decided whether to offer this at
        // all; it does not get to decide what the operator is offered.
        seed: handle,
        observed_platform: short.platform,
        observed_handle: handle,
        evidence_url: url,
        evidence_note:
          short.title === null
            ? null
            : `Seen on a post titled ${JSON.stringify(short.title)}.`,
        proposed_by: options.proposedBy,
      });
      byTarget.set(target, list);
    }
  }

  return PLATFORMS.flatMap((platform) => byTarget.get(platform) ?? []);
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * A real `SeedStore` with no database.
 *
 * IT IS NOT A STUB. It applies the same identity — (platform, seed) — the same
 * one-ruling-per-guess rule as the unique index, and the same refusal to
 * promote a proposal in one call. The tests that prove "a rejected guess is
 * never proposed again" are proving it about the production rule.
 */
export class MemorySeedStore implements SeedStore {
  readonly readOnlyReason = null;

  private readonly seeds = new Map<string, Seed>();
  private readonly proposals = new Map<string, SeedProposal>();
  private nextId = 1;

  constructor(seed: readonly Seed[] = [], proposals: readonly SeedProposal[] = []) {
    for (const row of seed) this.seeds.set(keyOf(row.platform, row.seed), row);
    for (const row of proposals) this.proposals.set(row.id, row);
  }

  /**
   * NOTHING TO RANK, SO NOTHING HAPPENS. Returns 0.
   *
   * THERE IS EXACTLY ONE IMPLEMENTATION OF THE RANKING AND IT IS THE SQL IN
   * supabase/migrations/20260905_11_auto_seeds.sql. That is deliberate: the
   * ranking reads `shorts_scraper.shorts`, the table of everything runs have
   * observed, and a second implementation in TypeScript would be a second
   * answer to "who are the top creators" — with the two free to disagree and
   * only one of them on screen. This repo has a standing rule about exactly
   * that shape of mistake.
   *
   * This store holds seeds in a Map for tests. It has no observation history
   * to rank — no `shorts` table, no view counts, no `discovered_at` — so
   * there is no question here for a ranking to answer.
   *
   * IT RETURNS 0 RATHER THAN THROWING because the run path calls this before
   * every run, and a deployment with no database is a supported, deliberate
   * state (see README "Deploying"). A refresh that refused would turn "no
   * database" into "no run".
   */
  async refreshAutoSeeds(): Promise<number> {
    return 0;
  }

  async listSeeds(): Promise<Seed[]> {
    return [...this.seeds.values()].sort(bySeedKey);
  }

  async addSeed(input: NewSeed): Promise<Seed> {
    const value = input.seed.trim();
    if (value === "") throw new SeedStoreError("A seed cannot be blank.");
    const key = keyOf(input.platform, value);
    const existing = this.seeds.get(key);
    if (existing) {
      throw new SeedStoreError(
        `${input.platform} already has the seed ${JSON.stringify(value)}. ` +
          (existing.active
            ? "It is active."
            : "It is inactive — reactivate it rather than adding it again, so its history survives."),
      );
    }
    const row: Seed = {
      platform: input.platform,
      seed: value,
      active: true,
      note: input.note?.trim() || null,
      added_at: input.addedAt ?? new Date().toISOString(),
      added_by: input.addedBy ?? null,
      deactivated_at: null,
      deactivated_by: null,
      last_fetched_ok_at: null,
    };
    this.seeds.set(key, row);
    return row;
  }

  async setSeedActive(
    platform: Platform,
    seed: string,
    active: boolean,
    by: string | null,
    at: string = new Date().toISOString(),
  ): Promise<Seed> {
    const key = keyOf(platform, seed);
    const existing = this.seeds.get(key);
    if (!existing) throw new SeedStoreError(missingSeedMessage(platform, seed));
    // A reactivation keeps the previous deactivation stamped on the row. That is
    // the history the migration refuses to delete rows in order to preserve;
    // clearing it here would throw it away by the back door.
    const row: Seed = active
      ? { ...existing, active: true }
      : { ...existing, active: false, deactivated_at: at, deactivated_by: by };
    this.seeds.set(key, row);
    return row;
  }

  async noteSeedsFetched(platform: Platform, at: string): Promise<void> {
    for (const [key, row] of this.seeds) {
      if (row.platform !== platform || !row.active) continue;
      this.seeds.set(key, { ...row, last_fetched_ok_at: at });
    }
  }

  async listProposals(): Promise<SeedProposal[]> {
    return [...this.proposals.values()].sort((a, b) =>
      a.proposed_at === b.proposed_at ? a.id.localeCompare(b.id) : a.proposed_at < b.proposed_at ? 1 : -1,
    );
  }

  async addProposals(candidates: readonly ProposalCandidate[]): Promise<SeedProposal[]> {
    const ruled = new Set(
      [...this.proposals.values()].map((p) => keyOf(p.platform, normaliseForComparison(p.seed))),
    );
    const written: SeedProposal[] = [];
    for (const candidate of candidates) {
      const key = keyOf(candidate.platform, normaliseForComparison(candidate.seed));
      if (ruled.has(key)) continue;
      ruled.add(key);
      const row: SeedProposal = {
        ...candidate,
        id: `proposal-${this.nextId++}`,
        state: "pending",
        proposed_at: new Date().toISOString(),
        decided_at: null,
        decided_by: null,
      };
      this.proposals.set(row.id, row);
      written.push(row);
    }
    return written;
  }

  async decideProposal(
    id: string,
    state: Exclude<ProposalState, "pending">,
    by: string | null,
    at: string = new Date().toISOString(),
  ): Promise<SeedProposal> {
    const existing = this.proposals.get(id);
    if (!existing) throw new SeedStoreError(`No proposal ${JSON.stringify(id)}.`);
    const row: SeedProposal = { ...existing, state, decided_at: at, decided_by: by };
    this.proposals.set(id, row);
    return row;
  }

  async deleteProposal(id: string): Promise<void> {
    this.proposals.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The environment implementation
// ---------------------------------------------------------------------------

/**
 * The seeds a deployment with no database has: whatever `PLATFORM_SEEDS_*` says.
 *
 * READ-ONLY, AND IT SAYS SO IN A SENTENCE. Every write throws that same
 * sentence rather than returning false or doing nothing, because the caller is
 * a form submission and a person is waiting to find out whether their seed was
 * saved. `readOnlyReason` is what the page prints instead of the form.
 *
 * `last_fetched_ok_at` is null on every row and always will be. There is
 * nowhere to write it, and inventing a value — "now", say, or the process start
 * time — would be a timestamp that looks measured and is not.
 */
export class EnvSeedStore implements SeedStore {
  readonly readOnlyReason: string;

  constructor(private readonly env: Env = process.env) {
    this.readOnlyReason =
      "This deployment has no database, so its seeds come from the PLATFORM_SEEDS_* environment " +
      "variables and can only be changed by editing them and redeploying. Configure Supabase to " +
      "manage seeds here.";
  }

  /**
   * NOTHING TO RANK, SO NOTHING HAPPENS. Returns 0.
   *
   * THERE IS EXACTLY ONE IMPLEMENTATION OF THE RANKING AND IT IS THE SQL IN
   * supabase/migrations/20260905_11_auto_seeds.sql. That is deliberate: the
   * ranking reads `shorts_scraper.shorts`, the table of everything runs have
   * observed, and a second implementation in TypeScript would be a second
   * answer to "who are the top creators" — with the two free to disagree and
   * only one of them on screen. This repo has a standing rule about exactly
   * that shape of mistake.
   *
   * This store reads a fixed list out of PLATFORM_SEEDS_*, and its
   * `readOnlyReason` already says it cannot be written to. An environment
   * variable is changed by a redeploy, never by a run.
   *
   * IT RETURNS 0 RATHER THAN THROWING because the run path calls this before
   * every run, and a deployment with no database is a supported, deliberate
   * state (see README "Deploying"). A refresh that refused would turn "no
   * database" into "no run".
   */
  async refreshAutoSeeds(): Promise<number> {
    return 0;
  }

  async listSeeds(): Promise<Seed[]> {
    const rows: Seed[] = [];
    for (const platform of PLATFORMS) {
      for (const value of seedsFor(platform, { env: this.env })) {
        rows.push({
          platform,
          seed: value,
          active: true,
          note: `From ${seedEnvKey(platform)}.`,
          // The environment carries no history at all. Null rather than a
          // stand-in moment, so the page shows an em dash that says why instead
          // of a date somebody could read as "added today".
          added_at: null,
          added_by: null,
          deactivated_at: null,
          deactivated_by: null,
          last_fetched_ok_at: null,
        });
      }
    }
    return rows.sort(bySeedKey);
  }

  // The parameters are declared even though every one of these throws. A
  // narrower signature satisfies the interface but not a CALLER holding an
  // `EnvSeedStore` — including the tests that prove these refuse — and the
  // repair people reach for then is a cast, which would hide a real mismatch
  // later.
  async addSeed(_input: NewSeed): Promise<Seed> {
    throw new SeedStoreError(this.readOnlyReason);
  }

  async setSeedActive(
    _platform: Platform,
    _seed: string,
    _active: boolean,
    _by: string | null,
    _at?: string,
  ): Promise<Seed> {
    throw new SeedStoreError(this.readOnlyReason);
  }

  async noteSeedsFetched(_platform: Platform, _at: string): Promise<void> {
    // Deliberately a no-op rather than a throw. This one is called by a run
    // rather than by a person, and failing a whole scheduled run because a
    // bookkeeping column has nowhere to go would be the tail wagging the dog.
  }

  async listProposals(): Promise<SeedProposal[]> {
    return [];
  }

  async addProposals(_candidates: readonly ProposalCandidate[]): Promise<SeedProposal[]> {
    throw new SeedStoreError(
      "There is nowhere to record a seed proposal: this deployment has no database. The run " +
        "still read every platform it could; only the suggestions were dropped.",
    );
  }

  async decideProposal(
    _id: string,
    _state: Exclude<ProposalState, "pending">,
    _by: string | null,
    _at?: string,
  ): Promise<SeedProposal> {
    throw new SeedStoreError(this.readOnlyReason);
  }

  async deleteProposal(_id: string): Promise<void> {
    throw new SeedStoreError(this.readOnlyReason);
  }
}

// ---------------------------------------------------------------------------
// The Supabase implementation
// ---------------------------------------------------------------------------

export const SEEDS_TABLE = "platform_seeds" as const;
export const PROPOSALS_TABLE = "seed_proposals" as const;

/**
 * Rows asked for per read request. 1000 is PostgREST's default `Max rows`, so a
 * healthy page costs one round trip.
 */
export const READ_PAGE_ROWS = 1000;

/** A hard stop on requests per read, so a misbehaving server cannot spin the loop. */
export const MAX_REQUESTS_PER_READ = 64;

/** The slice of PostgREST's builder the pager needs. Structural, so a test can drive it. */
interface PagedQuery<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  range(from: number, to: number): PagedQuery<T>;
}

/**
 * Read a table to the end, or throw.
 *
 * THE SCAR THIS CARRIES FORWARD. PostgREST caps every response at the project's
 * `Max rows` and does it with a 200, a `Content-Range` header and NO ERROR
 * OBJECT — the failure that computed a median from 1000 of 1096 rows in the code
 * this repo replaced. The stopping rule is therefore NOT "a page shorter than I
 * asked for": if the project's cap is below `READ_PAGE_ROWS`, every page is
 * short and that rule stops after the first one. It stops on a page shorter than
 * the widest page this read has actually seen, and on an empty page.
 *
 * IT THROWS RATHER THAN RETURNING A PARTIAL LIST WITH A NOTICE, which is where
 * it differs from the shorts pager. See `SeedStore`: a truncated seed list makes
 * a run read fewer creators and then report success, and no page could show
 * that.
 *
 * (This is a second copy of a loop that also lives in
 * lib/shorts/supabase-store.ts, where it is private to that file. One shared
 * pager would be better; it is recorded here rather than left as a surprise.)
 */
async function readAll<T>(table: string, newQuery: () => PagedQuery<T>): Promise<T[]> {
  const rows: T[] = [];
  let widestPage = 0;

  for (let request = 0; request < MAX_REQUESTS_PER_READ; request += 1) {
    const { data, error } = await newQuery().range(rows.length, rows.length + READ_PAGE_ROWS - 1);
    if (error) throw new SeedStoreError(`${table}: ${error.message}`);

    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page);
    if (page.length < widestPage) return rows;
    widestPage = page.length;
  }

  throw new SeedStoreError(
    `The ${table} read used all ${MAX_REQUESTS_PER_READ} of its requests without reaching the end ` +
      `of the table, having read ${rows.length} rows. A partial seed list is not returned: a run ` +
      "made with one reads fewer creators than it was configured to and still reports success.",
  );
}

export class SupabaseSeedStore implements SeedStore {
  readonly readOnlyReason = null;

  constructor(private readonly client: TenantClient) {}

  /**
   * One RPC. The ranking and the write are both in
   * `shorts_scraper.refresh_auto_seeds`, deliberately.
   *
   * WHY NOT RANK IN TYPESCRIPT. It would mean reading every short of the last
   * seven days across five platforms into this process to group them — the
   * whole table, over the wire, to compute a number Postgres can compute where
   * the rows already are. It would also make the ranking and the write two
   * round trips with a gap in the middle, during which a concurrent run would
   * see a half-refreshed seed list.
   */
  async refreshAutoSeeds(options: AutoSeedOptions = {}): Promise<number> {
    const { data, error } = await this.client.rpc("refresh_auto_seeds", {
      in_window_days: options.windowDays ?? AUTO_SEED_WINDOW_DAYS,
      in_per_platform: options.perPlatform ?? AUTO_SEED_PER_PLATFORM,
    });

    if (error) throw new SeedStoreError(`refreshAutoSeeds: ${error.message}`);
    return typeof data === "number" ? data : 0;
  }

  async listSeeds(): Promise<Seed[]> {
    const rows = await readAll<Seed>(SEEDS_TABLE, () =>
      this.client
        .from(SEEDS_TABLE)
        .select("*")
        // Both key columns, in key order. `platform` alone takes five distinct
        // values across the whole table, so range-paging over it would put tied
        // rows on either side of a page boundary and drop and repeat them with
        // no error at all.
        .order("platform", { ascending: true })
        .order("seed", { ascending: true }) as unknown as PagedQuery<Seed>,
    );
    return rows;
  }

  async addSeed(input: NewSeed): Promise<Seed> {
    const value = input.seed.trim();
    if (value === "") throw new SeedStoreError("A seed cannot be blank.");

    const { data, error } = await this.client
      .from(SEEDS_TABLE)
      .insert({
        platform: input.platform,
        seed: value,
        active: true,
        note: input.note?.trim() || null,
        added_by: input.addedBy ?? null,
        ...(input.addedAt ? { added_at: input.addedAt } : {}),
      })
      .select()
      .single();

    if (error) throw new SeedStoreError(`addSeed: ${error.message}`);
    return data as Seed;
  }

  async setSeedActive(
    platform: Platform,
    seed: string,
    active: boolean,
    by: string | null,
    at: string = new Date().toISOString(),
  ): Promise<Seed> {
    const patch = active
      ? { active: true }
      : { active: false, deactivated_at: at, deactivated_by: by };

    const { data, error } = await this.client
      .from(SEEDS_TABLE)
      .update(patch)
      .eq("platform", platform)
      .eq("seed", seed)
      .select()
      .maybeSingle();

    if (error) throw new SeedStoreError(`setSeedActive: ${error.message}`);
    // A row that matched nothing comes back null with no error — the same shape
    // as success on a table that happens to be empty. Refused rather than
    // returned, because a page that showed "deactivated" for a seed that is
    // still being fetched is the exact lie this whole module is about.
    if (!data) throw new SeedStoreError(missingSeedMessage(platform, seed));
    return data as Seed;
  }

  async noteSeedsFetched(platform: Platform, at: string): Promise<void> {
    const { error } = await this.client
      .from(SEEDS_TABLE)
      .update({ last_fetched_ok_at: at })
      .eq("platform", platform)
      .eq("active", true);
    if (error) throw new SeedStoreError(`noteSeedsFetched: ${error.message}`);
  }

  async listProposals(): Promise<SeedProposal[]> {
    return readAll<SeedProposal>(PROPOSALS_TABLE, () =>
      this.client
        .from(PROPOSALS_TABLE)
        .select("*")
        .order("platform", { ascending: true })
        .order("seed", { ascending: true }) as unknown as PagedQuery<SeedProposal>,
    );
  }

  /**
   * File proposals, skipping the ones already ruled on.
   *
   * The skip is done here AND by a unique index, and both are load-bearing. The
   * index is the guarantee — two runs racing cannot both insert the same guess.
   * The filter is what stops the common case from being an error: without it,
   * every nightly run would insert a batch containing yesterday's suggestions
   * and the whole insert would fail on the first conflict, losing the new ones
   * with it.
   */
  async addProposals(candidates: readonly ProposalCandidate[]): Promise<SeedProposal[]> {
    if (candidates.length === 0) return [];

    const held = await this.listProposals();
    const ruled = new Set(held.map((p) => keyOf(p.platform, normaliseForComparison(p.seed))));

    const fresh: ProposalCandidate[] = [];
    const claimed = new Set<string>();
    for (const candidate of candidates) {
      const key = keyOf(candidate.platform, normaliseForComparison(candidate.seed));
      if (ruled.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      fresh.push(candidate);
    }
    if (fresh.length === 0) return [];

    const { data, error } = await this.client.from(PROPOSALS_TABLE).insert(fresh).select();
    if (error) throw new SeedStoreError(`addProposals: ${error.message}`);
    return (data ?? []) as SeedProposal[];
  }

  async decideProposal(
    id: string,
    state: Exclude<ProposalState, "pending">,
    by: string | null,
    at: string = new Date().toISOString(),
  ): Promise<SeedProposal> {
    const { data, error } = await this.client
      .from(PROPOSALS_TABLE)
      .update({ state, decided_at: at, decided_by: by })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) throw new SeedStoreError(`decideProposal: ${error.message}`);
    if (!data) throw new SeedStoreError(`No proposal ${JSON.stringify(id)} was updated.`);
    return data as SeedProposal;
  }

  async deleteProposal(id: string): Promise<void> {
    const { error } = await this.client.from(PROPOSALS_TABLE).delete().eq("id", id);
    if (error) throw new SeedStoreError(`deleteProposal: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Which store is in play
// ---------------------------------------------------------------------------

export type SeedStoreOrigin = "database" | "environment";

export interface ResolvedSeedStore {
  readonly store: SeedStore;
  readonly origin: SeedStoreOrigin;
  /** One line for the page and the run log. */
  readonly explanation: string;
}

export interface ResolveSeedStoreOptions {
  readonly env?: Env;
  /** Supplied by a caller that already has one. Tests pass a fake. */
  readonly client?: TenantClient | null;
  /** Overrides `isSupabaseConfigured`. Tests only. */
  readonly databaseConfigured?: boolean;
}

/**
 * ONE place decides where seeds come from.
 *
 * There is no `origin: "none"` here, and that is the difference from
 * `resolveCredentialStore`. A deployment with no key has genuinely no
 * credential store; a deployment with no database still has seeds — whatever
 * the environment names, possibly nothing — and answering "no store" would make
 * the page unable to say even that. `EnvSeedStore` with zero rows is an honest
 * answer; a null store is a shrug.
 */
export async function resolveSeedStore(
  options: ResolveSeedStoreOptions = {},
): Promise<ResolvedSeedStore> {
  const env = options.env ?? process.env;

  let configured = options.databaseConfigured;
  if (configured === undefined) {
    const { isSupabaseConfigured } = await import("../supabase/config");
    configured = isSupabaseConfigured;
  }

  if (configured) {
    // `../supabase/server` pulls in `next/headers`, which only exists inside a
    // Next request. Deferred to the branch that needs it so a CLI or a test can
    // import this module at all.
    const client =
      options.client ?? (await import("../supabase/server")).createSupabaseAdminClient();
    return {
      store: new SupabaseSeedStore(client),
      origin: "database",
      explanation:
        "Seeds are rows in this project's database and are edited here. The PLATFORM_SEEDS_* " +
        "environment variables are IGNORED while a database is configured — a seed switched off " +
        "on this page has to stop being fetched, and merging the two lists would keep fetching it.",
    };
  }

  return {
    store: new EnvSeedStore(env),
    origin: "environment",
    explanation:
      "No database is configured, so seeds come from the PLATFORM_SEEDS_* environment variables " +
      "and are read-only here. They carry no history: who added one and when is not recorded " +
      "anywhere, which is the thing a database fixes.",
  };
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * The identity, as one string.
 *
 * NUL as the separator for the same reason `shortKey` uses it: it is the one
 * byte that cannot appear inside a seed — Postgres `text` cannot hold it — so a
 * seed containing the separator cannot be made to collide with a different
 * (platform, seed) pair. Nothing prints this value, so readability buys nothing.
 */
function keyOf(platform: Platform, seed: string): string {
  return `${platform}\u0000${seed}`;
}

/** Primary-key order, shared so the two stores cannot disagree about it. */
function bySeedKey(a: Seed, b: Seed): number {
  if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
  if (a.seed === b.seed) return 0;
  return a.seed < b.seed ? -1 : 1;
}

function missingSeedMessage(platform: Platform, seed: string): string {
  return (
    `${platform} has no seed ${JSON.stringify(seed)}, so nothing was changed. A seed is matched ` +
    "exactly as it was stored — this tool never rewrites somebody else's identifier."
  );
}
