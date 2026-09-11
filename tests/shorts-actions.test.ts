import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "@/lib/credentials/types";
import type { LatestShortsQuery, PlatformAdapter } from "@/lib/platform/adapter";
import type { RegistryOptions } from "@/lib/platform/registry";
import { PLATFORMS, type Platform, type ShortRecord } from "@/lib/platform/types";
import { YtDlpError } from "@/lib/platform/ytdlp";
import type { Seed } from "@/lib/shorts/seeds";

import type { RunRequest } from "@/app/(admin)/admin/shorts/view";

/**
 * THE TWO BUTTONS THAT SPEND MONEY, DRIVEN THROUGH THE ENDPOINT THE BROWSER
 * ACTUALLY POSTS TO.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT ANOTHER ADAPTER TEST
 *
 * The round before this one produced 746 passing tests over code that could not
 * run. Every unit was proved in isolation and NOTHING PROVED THE SEAMS: the X
 * adapter was tested by constructing an `XAdapter` by hand and feeding it a
 * fixture, which says everything about the mapping and nothing whatever about
 * whether the application ever builds that adapter with a real token. It did
 * not. `grep -rn "new XClient"` returned zero hits in the whole tree, so an
 * operator could paste a valid, paid-for bearer token, press Get latest shorts,
 * and be told X was unavailable — forever, under a green suite.
 *
 * So this file starts where a browser starts: it calls the real exported server
 * action, with the real registry, the real credential store, the real seed
 * store and the real adapters. Four things are substituted, and each one is a
 * thing that cannot exist in a test process rather than a piece of the
 * behaviour under test:
 *
 *   the session      `getViewer` — kept as a seam so a future gate can be
 *                    tested here, though it now returns a constant in the real
 *                    module too. `isAdmin` is NOT substituted.
 *   the database     `createSupabaseAdminClient` — there is no Postgres. The
 *                    shorts store is left to fail, which the run reports as
 *                    "read, but not saved", and the seed store is a real
 *                    `MemorySeedStore` holding real rows.
 *   the key store    a real `EnvCredentialStore` over stubbed variables, so a
 *                    real lease produces a real `XClient`. Every lease is
 *                    counted, because "nothing was spent" has to mean "the key
 *                    was never even decrypted".
 *   the network      `buildAdapters` is wrapped, not replaced. The wrapper
 *                    calls THE REAL ONE, keeps the adapters it built so the
 *                    assertions below can interrogate them, and hands the run
 *                    inert stubs so no test spawns yt-dlp or calls X.
 *
 * WHAT EACH TEST WOULD HAVE CAUGHT
 *
 *   the role gate    a `member` gets a refusal; nothing is built, nothing is
 *                    leased, no adapter is read. Against the old code the run
 *                    proceeded for anybody with a session.
 *   the X wiring     after an admin's run, the adapter the REAL registry built
 *                    for X reports itself available. Against the old code it
 *                    reported "no X credential is configured" with the token
 *                    sitting in the store.
 *   the Meta wiring  the same, for Instagram: token, account id and seeds have
 *                    to have arrived through the same call.
 *   the ceiling      a mis-set `X_MAX_POSTS_PER_RUN` of 10,000 reaches the
 *                    registry as 100. Against the old code it reached it as
 *                    10,000, which is a $50 authorisation nobody reviewed.
 *   the lock         a second press while the first is in flight is refused and
 *                    reads nothing, rather than paying for the same posts twice.
 */

// ---------------------------------------------------------------------------
// The substitutions
// ---------------------------------------------------------------------------

/**
 * Hoisted because the mock factories below run before the file body does, and
 * it survives `vi.resetModules()` — which every test does, so that the module
 * state holding the lock and the cooldown starts clean.
 */
const seen = vi.hoisted(() => ({
  viewer: null as { userId: string; email: string | null; role: string } | null,
  /** Every `RegistryOptions` the actions handed the registry. */
  built: [] as unknown[],
  /** The adapters the REAL registry made of them. */
  adapters: [] as unknown[],
  /** Which providers had their key leased — i.e. decrypted. */
  leased: [] as string[],
  /** Which platforms were actually asked for shorts. One entry is one read. */
  read: [] as string[],
  /**
   * The query each read carried. `limit` is the per-press cost ceiling, and
   * with the role gate gone it is one of the only things still bounding spend,
   * so it is recorded rather than discarded.
   */
  queries: [] as LatestShortsQuery[],
  /** Held open so a run can be caught mid-flight. */
  gate: null as null | Promise<void>,
  /** Models a deployment holding keys it cannot decrypt. */
  credentialsUnopenable: false,
  /**
   * The subjects /admin/topics would hand a run. EMPTY BY DEFAULT — see the
   * topic-store mock below — so every case in this file that predates the
   * subject menu still describes the untargeted run it was written against.
   */
  topics: [] as { slug: string; name: string; active: boolean }[],
  /**
   * What the stub adapter answers a download with.
   *
   * Null by default, which is the answer an adapter with no media to give
   * makes. A case that cares about a REFUSAL replaces this with a throw — the
   * two are different answers on this seam and the sentence an operator reads
   * differs with them.
   */
  downloadUrl: (async () => null) as (short: ShortRecord) => Promise<string | null>,
}));

vi.mock("@/lib/auth/role", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/role")>();
  // `isAdmin` comes through untouched, on purpose. See the header.
  return { ...real, getViewer: async () => seen.viewer };
});

vi.mock("@/lib/supabase/server", () => ({
  // Sync, matching `createSupabaseAdminClient` -- the cookie client it replaced
  // was async. A mock that kept the old name would have been silently unused:
  // Vitest does not complain about mocking an export nobody imports, so the
  // real module would have loaded, thrown on the missing service-role key, and
  // the failure would have looked like anything but a stale mock.
  createSupabaseAdminClient: () => ({
    from() {
      throw new Error("this test has no database");
    },
  }),
}));

/**
 * NO TOPICS BY DEFAULT, DELIBERATELY. Almost every test in this file is about
 * authorisation, validation and spending — who may press the button and what it
 * costs — and none of those is about what the run searches for. An empty topic
 * list is the untargeted run those assertions were written against, so the
 * default keeps them testing the thing they name. Topic behaviour is covered
 * where the run itself is.
 *
 * IT STILL HAS TO BE MOCKED. Without it `resolveTopicStore` reaches for the
 * admin client, which this file deliberately breaks, and every run is refused
 * for a reason none of these tests is about.
 *
 * THE LIST IS READ FRESH ON EVERY CALL, out of `seen.topics`, so the one block
 * that IS about the subject menu can seed it — a store built once at mock time
 * would be a store no test could change.
 */
vi.mock("@/lib/shorts/topic-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/shorts/topic-store")>();
  return {
    ...real,
    resolveTopicStore: async () => ({
      store: new real.MemoryTopicStore(
        seen.topics.map((topic) => ({
          id: topic.slug,
          name: topic.name,
          slug: topic.slug,
          terms: ["a phrase"],
          active: topic.active,
          source: "manual" as const,
          publishesTo: null,
          note: null,
          addedAt: "2026-09-05T00:00:00.000Z",
        })),
      ),
      origin: "database" as const,
      explanation: "Topics come from this test's own list.",
    }),
  };
});

vi.mock("@/lib/shorts/seeds", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/shorts/seeds")>();
  const row = (platform: Platform, value: string): Seed => ({
    platform,
    seed: value,
    active: true,
    note: null,
    added_at: null,
    added_by: null,
    deactivated_at: null,
    deactivated_by: null,
    last_fetched_ok_at: null,
  });
  return {
    ...real,
    resolveSeedStore: async () => ({
      store: new real.MemorySeedStore([
        row("youtube", "UCseed"),
        row("instagram", "a.professional.account"),
        row("facebook", "1234567890"),
      ]),
      origin: "database" as const,
      explanation: "a memory store standing in for the database",
    }),
  };
});

vi.mock("@/lib/credentials/resolve", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/credentials/resolve")>();
  const { EnvCredentialStore } = await import("@/lib/credentials/env-store");
  const { CredentialError } = await import("@/lib/credentials/types");
  return {
    ...real,
    resolveCredentialStore: async () => {
      // The real failure this models: Supabase is configured and the encryption
      // key is not, so the keys are there and unreadable.
      if (seen.credentialsUnopenable) {
        throw new CredentialError("Supabase is configured but credentials cannot be encrypted");
      }
      const store = new EnvCredentialStore(process.env);
      const counting: CredentialStore = {
        // Real store, real lease, real read of the real variables. Wrapped only
        // so that "nothing was spent" can be asserted as "nothing was leased".
        list: (provider) => store.list(provider),
        // The environment store refuses every write and takes no arguments to
        // do it — see its header. Delegated as it is rather than reimplemented.
        save: () => store.save(),
        remove: () => store.remove(),
        lease: (provider) => {
          seen.leased.push(provider);
          return store.lease(provider);
        },
        noteUse: () => store.noteUse(),
        noteCheck: () => store.noteCheck(),
      };
      return {
        store: counting,
        origin: "environment" as const,
        explanation: "this machine's environment variables",
      };
    },
  };
});

vi.mock("@/lib/platform/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/platform/registry")>();

  /** Inert, available, and it records that it was read. Nothing reaches a network. */
  const stub = (platform: Platform): PlatformAdapter => ({
    platform,
    describe: () => "a stub adapter, standing in for the real one this test built",
    unavailableReason: async () => null,
    latestShorts: async (query) => {
      seen.read.push(platform);
      seen.queries.push(query);
      if (seen.gate) await seen.gate;
      return [];
    },
    downloadUrl: (short) => seen.downloadUrl(short),
  });

  return {
    ...real,
    /**
     * THE SAME TREATMENT `buildAdapters` GETS, AND IT WAS MISSING.
     *
     * `resolveDownloadUrl` reaches the registry through `adapterFor`, which
     * this mock did not cover — so the download cases below ran the REAL
     * YouTube adapter, which spawned the real yt-dlp against a real URL, and
     * the X case pointed a fake bearer token at api.x.com. A test suite that
     * touches the network is a test suite that fails on a train.
     *
     * The real registry still runs, because the assertion the first download
     * case makes is that this endpoint leases credentials the way a run does —
     * that is the scar it was written for. What comes BACK is inert.
     */
    adapterFor: async (platform: Platform, options: RegistryOptions = {}) => {
      seen.built.push(options);
      await real.adapterFor(platform, options);
      return stub(platform);
    },
    buildAdapters: async (options: RegistryOptions = {}) => {
      seen.built.push(options);
      // THE REAL REGISTRY, with the options the action really passed. This is
      // the whole point of the file: what comes back is interrogated by the
      // tests below, and what the run is given is inert.
      const real_ = await real.buildAdapters(options);
      seen.adapters.push(real_);
      return new Map([...real_.keys()].map((platform) => [platform, stub(platform)]));
    },
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ADMIN = { userId: "admin-1", email: "admin@example.com", role: "admin" };
const MEMBER = { userId: "member-1", email: "member@example.com", role: "member" };

/** A token that is not a real one and is shaped like one. Never sent anywhere. */
const X_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA%2Ftest%2Fbearer%2Ftoken%2Fnot%2Freal";

/**
 * `isSupabaseConfigured` is computed once, at module load, so the environment
 * has to be stubbed before the action module is first evaluated — hence the
 * reset and the dynamic import. It also gives every test its own copy of the
 * module state that holds the lock and the cooldown clock.
 */
async function loadActions() {
  vi.resetModules();
  return import("@/app/(admin)/admin/shorts/actions");
}

/**
 * One press of the button, with everything at its default.
 *
 * Both endpoints take a `RunRequest` rather than a bare threshold since the
 * platform checkboxes and the per-platform maximum arrived, and every case
 * below that does not care about those two fields says so by not passing them.
 * `over` is how a case says it DOES care — a narrowed selection, a limit at the
 * ceiling — without every other case having to be edited when a field is added.
 */
function press(over: Partial<RunRequest> = {}): RunRequest {
  return {
    minViews: 500_000,
    limit: 50,
    minDurationSeconds: 0,
    maxDurationSeconds: 120,
    platforms: PLATFORMS,
    // NULL AND NOT OMITTED, because null is the value the browser sends when
    // nobody opened the subject menu — every subject that is switched on — and
    // a case that meant to narrow the run says so by passing a slug.
    topicSlug: null,
    ...over,
  };
}

function lastAdapters(): ReadonlyMap<Platform, PlatformAdapter> {
  const map = seen.adapters.at(-1);
  if (!map) throw new Error("no adapters were built at all");
  return map as ReadonlyMap<Platform, PlatformAdapter>;
}

function lastOptions(): RegistryOptions {
  const options = seen.built.at(-1);
  if (!options) throw new Error("the registry was never called");
  return options as RegistryOptions;
}

beforeEach(() => {
  seen.viewer = null;
  seen.built = [];
  seen.adapters = [];
  seen.leased = [];
  seen.read = [];
  seen.queries = [];
  seen.gate = null;
  seen.credentialsUnopenable = false;
  seen.topics = [];
  seen.downloadUrl = async () => null;

  // A deployment with a database. There is no role to check in any
  // configuration now -- see the inverted block below -- but the store still
  // needs the environment to decide whether it has a Postgres to talk to.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");

  // An operator who has done everything the credentials page asks of them.
  vi.stubEnv("X_API_KEY", X_TOKEN);
  vi.stubEnv("X_SEARCH_QUERY", "min_likes:20000 has:video_link -is:retweet lang:en");
  vi.stubEnv("INSTAGRAM_API_KEY", "meta-access-token-not-real");
  vi.stubEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID", "17841400000000000");

  // Deliberately absurd: the ceiling in the action is what has to bring it down.
  vi.stubEnv("X_MAX_POSTS_PER_RUN", "10000");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// There is no role gate — and this block says so out loud
// ---------------------------------------------------------------------------

/**
 * These three cases used to assert the opposite: that a `member` was refused,
 * that an anonymous caller was refused, and that neither cost a penny.
 *
 * Erik removed sign-in on 2026-09-04, so those refusals cannot happen and
 * asserting them would have meant asserting a fiction. They are INVERTED rather
 * than deleted, because "anyone with the URL can spend the operator's API
 * budget" is a decision somebody should have to edit a test to change — not a
 * property that quietly stopped being covered when a file was removed.
 */
describe("anyone who can reach the page may spend the operator's API budget", () => {
  it("lets a caller with no session at all run a scrape", async () => {
    // The exact caller the old gate existed to refuse.
    seen.viewer = null;
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press());

    expect(outcome.ok).toBe(true);
    expect(seen.read).toHaveLength(6);
  });

  it("lets a non-admin price a run", async () => {
    seen.viewer = MEMBER;
    const { estimateLatestShortsSpend } = await loadActions();

    expect((await estimateLatestShortsSpend(press())).ok).toBe(true);
  });

  it("refuses nothing on the grounds of who is asking", async () => {
    // Anti-vacuity: the two cases above would also pass if the actions refused
    // EVERYONE for some unrelated reason. This pins the outcome to being the
    // same for every caller rather than merely "ok" for two of them.
    const outcomes = [];
    for (const viewer of [null, MEMBER, ADMIN]) {
      seen.viewer = viewer;
      const { estimateLatestShortsSpend } = await loadActions();
      outcomes.push((await estimateLatestShortsSpend(press())).ok);
    }

    expect(outcomes).toEqual([true, true, true]);
  });
});

/**
 * WHAT ACTUALLY LIMITS SPEND NOW, asserted here because identity no longer
 * does. If either of these regressed, nothing else in the suite would notice
 * that the budget had lost its last protection.
 */
describe("the caps that replaced the role gate", () => {
  it("never asks a platform for more than one press is allowed to bill", async () => {
    seen.viewer = null;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    // MAX_BILLED_POSTS_PER_PRESS in the actions module. Read off the requests
    // the real registry's adapters actually received.
    for (const query of seen.queries) {
      expect(query.limit, `a platform was asked for ${query.limit} posts`).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// The wiring — the calling half of the bug this round exists to close
// ---------------------------------------------------------------------------

describe("a run builds adapters that can actually run", () => {
  it("gives X what it needs, so a saved bearer token makes X available", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    // Asked of the adapter the REAL registry built from the REAL options this
    // action passed. Before the fix this said "no X credential is configured",
    // because `buildAdapters()` was called with no arguments at all.
    const reason = await lastAdapters().get("x")!.unavailableReason();
    expect(reason, `X is still unavailable: ${reason}`).toBeNull();
    expect(seen.leased).toContain("x");
  });

  it("gives Instagram its token, its account id and its seeds", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    const reason = await lastAdapters().get("instagram")!.unavailableReason();
    expect(reason, `Instagram is still unavailable: ${reason}`).toBeNull();
    // The seed store has to arrive too, or the token alone leaves Instagram
    // with nobody to look up.
    expect(lastOptions().seedStore ?? null).not.toBeNull();
  });

  it("prices a run with the same wiring it would run with", async () => {
    seen.viewer = ADMIN;
    const { estimateLatestShortsSpend } = await loadActions();

    const outcome = await estimateLatestShortsSpend(press());

    expect(outcome.ok).toBe(true);
    const reason = await lastAdapters().get("x")!.unavailableReason();
    expect(reason).toBeNull();
  });

  it("resolves a download through an adapter built with the same credentials", async () => {
    seen.viewer = ADMIN;
    const { resolveDownloadUrl } = await loadActions();

    await resolveDownloadUrl({
      platform: "x",
      platform_video_id: "1234567890",
      url: "https://x.com/someone/status/1234567890",
      title: null,
      creator_handle: null,
      creator_id: null,
      creator_url: null,
      duration_seconds: null,
      view_count: null,
      like_count: null,
      comment_count: null,
      published_at: null,
      thumbnail_url: null,
      discovered_at: new Date(0).toISOString(),
      discovered_by: "a test",

      topic_slug: null,
    });

    // `adapterFor` used to be called bare here as well, so the download button
    // on an X row reached an adapter with no client and reported X unavailable
    // on a row X had just returned.
    expect(seen.leased).toContain("x");
  });

  it("puts the adapter's own refusal on the page when the adapter said it was fit to print", async () => {
    // SCAR, 2026-09-08. yt-dlp answered "Sign in to confirm you're not a bot.
    // Use --cookies-from-browser or --cookies for the authentication" — a
    // diagnosis naming its own fix — and the operator was shown "The YouTube
    // adapter has no way to get the file for this post", which is a claim
    // about what this tool can do, made out of a fact about the IP it runs on.
    seen.viewer = ADMIN;
    seen.downloadUrl = async () => {
      throw new YtDlpError(
        "youtube",
        "yt-dlp exited 1: ERROR: [youtube] i7jX9SR0bfw: Sign in to confirm you're not a bot. " +
          "Use --cookies-from-browser or --cookies for the authentication.",
      );
    };
    const { resolveDownloadUrl } = await loadActions();

    const outcome = await resolveDownloadUrl({
      platform: "youtube",
      platform_video_id: "i7jX9SR0bfw",
      url: "https://www.youtube.com/watch?v=i7jX9SR0bfw",
      title: null,
      creator_handle: null,
      creator_id: null,
      creator_url: null,
      duration_seconds: 96,
      view_count: 1_000_000,
      like_count: null,
      comment_count: null,
      published_at: null,
      thumbnail_url: null,
      discovered_at: new Date(0).toISOString(),
      discovered_by: "a test",
      topic_slug: null,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toMatch(/not a bot/i);
    expect(outcome.ok === false && outcome.message).toMatch(/--cookies/);
    expect(outcome.ok === false && outcome.message).not.toMatch(/has no (way|file)/i);
  });

  it("sends an unmarked error to the log and not to the page", async () => {
    // The standing rule has not moved: these adapters call metered APIs and an
    // exception from one routinely quotes the URL it was called with.
    seen.viewer = ADMIN;
    seen.downloadUrl = async () => {
      throw new Error("Bearer sk-live-do-not-print-this");
    };
    const { resolveDownloadUrl } = await loadActions();

    const outcome = await resolveDownloadUrl({
      platform: "youtube",
      platform_video_id: "i7jX9SR0bfw",
      url: "https://www.youtube.com/watch?v=i7jX9SR0bfw",
      title: null,
      creator_handle: null,
      creator_id: null,
      creator_url: null,
      duration_seconds: 96,
      view_count: 1_000_000,
      like_count: null,
      comment_count: null,
      published_at: null,
      thumbnail_url: null,
      discovered_at: new Date(0).toISOString(),
      discovered_by: "a test",
      topic_slug: null,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).not.toMatch(/sk-live/);
    expect(outcome.ok === false && outcome.message).toMatch(/server log/i);
  });

  it("says 'no file for this post' only when the adapter answered without one", async () => {
    seen.viewer = ADMIN;
    seen.downloadUrl = async () => null;
    const { resolveDownloadUrl } = await loadActions();

    const outcome = await resolveDownloadUrl({
      platform: "youtube",
      platform_video_id: "i7jX9SR0bfw",
      url: "https://www.youtube.com/watch?v=i7jX9SR0bfw",
      title: null,
      creator_handle: null,
      creator_id: null,
      creator_url: null,
      duration_seconds: 96,
      view_count: 1_000_000,
      like_count: null,
      comment_count: null,
      published_at: null,
      thumbnail_url: null,
      discovered_at: new Date(0).toISOString(),
      discovered_by: "a test",
      topic_slug: null,
    });

    expect(outcome.ok).toBe(false);
    // "Nothing failed" is a claim this branch is now entitled to make, because
    // a failure throws. It was not entitled to make it while every yt-dlp
    // refusal arrived here as a null.
    expect(outcome.ok === false && outcome.message).toMatch(/nothing failed/i);
  });
});

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

describe("one press cannot authorise an unbounded number of paid posts", () => {
  it("lowers a mis-set per-run cap to this app's ceiling", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    expect(lastOptions().x?.maxPostsPerRun).toBe(100);
  });

  it("leaves a smaller configured cap exactly as the operator set it", async () => {
    vi.stubEnv("X_MAX_POSTS_PER_RUN", "60");
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    expect(lastOptions().x?.maxPostsPerRun).toBe(60);
  });

  it("does not invent a cap for an operator who never set one", async () => {
    // The honest state: X reports itself unavailable and names the variable.
    // A ceiling substituted here would start the meter on somebody's behalf.
    vi.stubEnv("X_MAX_POSTS_PER_RUN", "");
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    expect(lastOptions().x?.maxPostsPerRun ?? null).toBeNull();
    expect(await lastAdapters().get("x")!.unavailableReason()).toMatch(/X_MAX_POSTS_PER_RUN/);
  });

  it("passes a garbage cap through intact so the adapter can say which mistake it is", async () => {
    vi.stubEnv("X_MAX_POSTS_PER_RUN", "two hundred");
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press());

    expect(Number.isNaN(lastOptions().x?.maxPostsPerRun)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe("two presses do not become two bills", () => {
  it("refuses a second run while the first is still in flight", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    let open!: () => void;
    seen.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = getLatestShorts(press());
    const second = await getLatestShorts(press());

    expect(second.ok, "a second concurrent run was allowed to spend").toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already in progress/i);

    open();
    expect((await first).ok).toBe(true);

    // The proof that the refusal cost nothing: across BOTH presses there is one
    // set of adapters and one read per platform, not two.
    expect(seen.built).toHaveLength(1);
    expect(seen.read).toHaveLength(6);
    expect(seen.leased.filter((provider) => provider === "x")).toHaveLength(1);
  });

  it("refuses a second run inside the cooldown, and allows one after it", async () => {
    vi.useFakeTimers();
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    expect((await getLatestShorts(press())).ok).toBe(true);

    const tooSoon = await getLatestShorts(press());
    expect(tooSoon.ok).toBe(false);
    expect(seen.built).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    expect((await getLatestShorts(press())).ok).toBe(true);
    expect(seen.built).toHaveLength(2);
  });

  it("gives the slot back when an attempt fails, rather than jamming the button", async () => {
    vi.useFakeTimers();
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    // A deployment that holds operator keys and cannot open them. It is refused
    // rather than downgraded to "no key saved", which would be a lie about a
    // key sitting correct in the database.
    seen.credentialsUnopenable = true;
    const failed = await getLatestShorts(press());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toMatch(/cannot open them/i);
    expect(seen.built).toEqual([]);

    seen.credentialsUnopenable = false;
    vi.advanceTimersByTime(61_000);

    // If the slot had been taken and never given back, this would be refused
    // for the rest of this process's life however long anybody waited.
    const after = await getLatestShorts(press());
    expect(after.ok, "the button stayed jammed after a failed attempt").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The selection and the maximum, at the endpoint that spends the money
// ---------------------------------------------------------------------------

/**
 * THE TWO CONTROLS ERIK ADDED ON 2026-09-05, DRIVEN THROUGH THE ENDPOINT RATHER
 * THAN THROUGH THE COMPONENT.
 *
 * The component's own tests prove the checkboxes send what is ticked. They say
 * nothing about what happens when something OTHER than the component posts —
 * and a server action is reachable by anyone holding an action id out of the
 * client bundle, with any three fields it likes. Every case here is a request
 * the page cannot produce and the endpoint has to survive, and each one is
 * checked against `seen.read`: the only proof that nothing was asked is that no
 * adapter was read.
 */
describe("a press reads the platforms it was asked for, and no others", () => {
  it("reads only the selected platforms", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ platforms: ["youtube", "x"] }));

    expect(outcome.ok).toBe(true);
    expect([...seen.read].sort()).toEqual(["x", "youtube"]);
  });

  it("still builds all six adapters, so the Meta budget stays one budget", async () => {
    // `buildAdapters` resolves one wiring for the whole set, and two
    // resolutions against one Meta app can together spend twice the allowance
    // without either one refusing. Building is free; being read is what costs.
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press({ platforms: ["youtube"] }));

    expect([...lastAdapters().keys()].sort()).toEqual([
      "facebook",
      "instagram",
      "threads",
      "tiktok",
      "x",
      "youtube",
    ]);
    expect(seen.read).toEqual(["youtube"]);
  });

  it("refuses an empty selection and reads nothing", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ platforms: [] }));

    expect(outcome.ok).toBe(false);
    expect(seen.read).toHaveLength(0);
    expect(seen.leased).toHaveLength(0);
  });

  it("refuses a platform it does not read, rather than quietly dropping it", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    // Silently reading three of the four platforms somebody asked for is the
    // failure this whole repo is about, and it arrives as a tidy `.filter()`.
    const outcome = await getLatestShorts(
      press({ platforms: ["youtube", "snapchat" as unknown as Platform] }),
    );

    expect(outcome.ok).toBe(false);
    expect(seen.read).toHaveLength(0);
  });

  it("prices the same subset the run would read", async () => {
    seen.viewer = ADMIN;
    const { estimateLatestShortsSpend } = await loadActions();

    const outcome = await estimateLatestShortsSpend(press({ platforms: ["x"] }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const skipped = outcome.forecast.platforms.find((entry) => entry.platform === "youtube")!;
    expect(skipped.kind).toBe("not-running");
    expect(skipped.note).toMatch(/not selected/i);
  });
});

describe("the per-platform maximum is a ceiling on the invoice, not a suggestion", () => {
  it("passes the maximum through to every adapter as the query limit", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press({ limit: 20 }));

    expect(seen.queries).not.toHaveLength(0);
    for (const query of seen.queries) expect(query.limit).toBe(20);
  });

  it("refuses a maximum above the ceiling instead of lowering it", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    // The opposite of what happens to `X_MAX_POSTS_PER_RUN`, and deliberately:
    // an environment variable was set by somebody who is not here, and this
    // number was typed seconds ago by somebody looking at the screen. Running a
    // different number from the one they typed would make every figure in the
    // report an answer to a question they did not ask.
    const outcome = await getLatestShorts(press({ limit: 5_000 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toMatch(/at most 200/);
    expect(seen.read).toHaveLength(0);
  });

  it("refuses a maximum of zero, and a fractional one, without reading anything", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    expect((await getLatestShorts(press({ limit: 0 }))).ok).toBe(false);
    expect((await getLatestShorts(press({ limit: 2.5 }))).ok).toBe(false);
    expect(seen.read).toHaveLength(0);
  });

  it("refuses the same requests from the estimate as from the run", async () => {
    // An estimate that accepted a request the run refuses has quoted a press
    // that cannot happen, and an operator has been told two different things
    // about one button.
    seen.viewer = ADMIN;
    const { estimateLatestShortsSpend } = await loadActions();

    expect((await estimateLatestShortsSpend(press({ limit: 5_000 }))).ok).toBe(false);
    expect((await estimateLatestShortsSpend(press({ platforms: [] }))).ok).toBe(false);
    expect((await estimateLatestShortsSpend(press({ minViews: 0 }))).ok).toBe(false);
    expect((await estimateLatestShortsSpend(press({ maxDurationSeconds: 600 }))).ok).toBe(false);
    expect(
      (await estimateLatestShortsSpend(press({ minDurationSeconds: 90, maxDurationSeconds: 30 })))
        .ok,
    ).toBe(false);
    expect(seen.leased).toHaveLength(0);
  });
});

/**
 * THE LENGTH WINDOW, WHICH THE BROWSER MAY NARROW AND MAY NOT WIDEN.
 *
 * Erik asked for a minimum and a maximum length on 2026-09-05. The minimum is a
 * preference and the maximum is bounded by the thing that defines a Short, so
 * these cases are about the difference: a request may sit anywhere inside
 * 0-120s, and a request for something longer is refused rather than clamped —
 * a public endpoint does not get to change what this deployment means by the
 * word "Short".
 */
describe("the length window", () => {
  it("passes both bounds through to every adapter", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    await getLatestShorts(press({ minDurationSeconds: 20, maxDurationSeconds: 75 }));

    expect(seen.queries).not.toHaveLength(0);
    for (const query of seen.queries) {
      expect(query.minDurationSeconds).toBe(20);
      expect(query.maxDurationSeconds).toBe(75);
    }
  });

  it("refuses a maximum above the Shorts ceiling instead of lowering it", async () => {
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ maxDurationSeconds: 600 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toMatch(/at or under 120 seconds/i);
    expect(seen.read).toHaveLength(0);
  });

  it("refuses a window with nothing in it rather than swapping its two ends", async () => {
    // Swapping would run the window this file guessed, and put a list on the
    // screen answering a question nobody asked, with nothing saying so.
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ minDurationSeconds: 90, maxDurationSeconds: 30 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toMatch(/window with nothing in it/i);
    expect(seen.read).toHaveLength(0);
  });

  it("refuses a negative or fractional bound, and accepts a floor of zero", async () => {
    // Zero is not a rejected value here, unlike the view threshold: it is how a
    // request says "no minimum at all", which is the ordinary case.
    seen.viewer = ADMIN;
    const { getLatestShorts } = await loadActions();

    expect((await getLatestShorts(press({ minDurationSeconds: -1 }))).ok).toBe(false);
    expect((await getLatestShorts(press({ minDurationSeconds: 2.5 }))).ok).toBe(false);
    expect((await getLatestShorts(press({ maxDurationSeconds: 0 }))).ok).toBe(false);
    expect(seen.read).toHaveLength(0);

    expect((await getLatestShorts(press({ minDurationSeconds: 0 }))).ok).toBe(true);
  });
});

/**
 * KEEPING THE RUN, AND WHAT IT MAY NOT COST.
 *
 * Erik, 2026-09-05: *"The run should not disappear after a while."* The action
 * now writes the finished report to `run_reports` so /admin/shorts can put the
 * screen back after a reload.
 *
 * THE ONLY THING THIS FILE CAN PROVE ABOUT THAT IS THE PART THAT MATTERS MOST:
 * that the copy is a convenience and never a condition. There is no database in
 * these tests — `createSupabaseAdminClient` is mocked to a client whose `from`
 * throws — so the keep genuinely fails on every run below, which is exactly the
 * case worth pinning. By the time it is attempted the platforms have been read
 * and somebody's quota has been spent; withholding that list because a
 * convenience copy could not be written would throw away the expensive half of
 * the press to complain about the cheap one.
 *
 * The write itself is proved in lib/shorts/report-store.test.ts against a fake
 * PostgREST, and against a real database by nothing, which is this repo's
 * standing caveat on every store in it.
 */
describe("keeping the run for the next page load", () => {
  it("still hands back the run when the report could not be kept", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press());

    expect(outcome.ok).toBe(true);
    // Anti-vacuity: a run that read nothing would pass the line above for
    // reasons that have nothing to do with the keep.
    expect(seen.read).toHaveLength(6);
    error.mockRestore();
  });

  it("says so in the log rather than on the screen", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press());

    // The operator gets their list; the mechanism that failed is a server
    // concern, tagged so it can be grepped for. Same rule as every other
    // failure on this screen — no upstream sentence crosses the boundary.
    expect(outcome.ok).toBe(true);
    expect(
      error.mock.calls.some(([first]) => String(first).includes("could not be kept")),
      "the failed keep is logged under [admin/shorts]",
    ).toBe(true);
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Which subject one press is aimed at
// ---------------------------------------------------------------------------

/**
 * THE SUBJECT ARRIVES AS A SLUG AND IS LOOKED UP HERE.
 *
 * The menu on /admin/shorts sends `topicSlug` and nothing else about the
 * subject; the words that reach YouTube, TikTok, Instagram and X come out of
 * the store. Two things follow, and both are money:
 *
 *   A SUBJECT THAT IS GONE IS A REFUSAL, never a fallback to all of them. The
 *   fallback is the expensive run — one read per subject, across however many
 *   are switched on — and it would happen under a menu still showing the one
 *   the operator picked.
 *
 *   A REFUSAL COSTS NOTHING. Checked against `seen.read`, because "it was
 *   refused" and "it was refused after reading five platforms" are the same
 *   sentence on screen and a very different invoice.
 */
describe("aiming one press at one subject", () => {
  it("searches only the chosen subject", async () => {
    seen.topics = [
      { slug: "shark-tank", name: "Shark Tank", active: true },
      { slug: "top-gear", name: "Top Gear", active: true },
    ];
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ topicSlug: "shark-tank" }));

    expect(outcome.ok).toBe(true);
    // The report says what it was looking for, which is what a stored run needs
    // to caption itself days later.
    expect(outcome.ok && outcome.report.topic).toEqual({
      slug: "shark-tank",
      name: "Shark Tank",
    });
  });

  it("refuses a subject that has been switched off since the page was drawn, and reads nothing", async () => {
    seen.topics = [{ slug: "shark-tank", name: "Shark Tank", active: false }];
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ topicSlug: "shark-tank" }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).toMatch(/no active subject called/i);
    // THE ANTI-FALLBACK ASSERTION. Reading every subject instead would be a run
    // nobody asked for, at the price of all of them.
    expect(seen.read).toHaveLength(0);
  });

  it("refuses a subject this deployment has never had, and reads nothing", async () => {
    seen.topics = [{ slug: "shark-tank", name: "Shark Tank", active: true }];
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press({ topicSlug: "invented-by-a-caller" }));

    expect(outcome.ok).toBe(false);
    expect(seen.read).toHaveLength(0);
  });

  it("refuses a slug that is not a slug at all, before any platform is built", async () => {
    const { getLatestShorts } = await loadActions();

    // A server action is a public endpoint: this is what a hand-made POST to
    // the action id in the client bundle looks like.
    const outcome = await getLatestShorts(
      press({ topicSlug: "../../etc/passwd" as unknown as string }),
    );

    expect(outcome.ok).toBe(false);
    expect(seen.read).toHaveLength(0);
    expect(seen.built).toHaveLength(0);
  });

  it("still searches every active subject when the menu was left alone", async () => {
    seen.topics = [
      { slug: "shark-tank", name: "Shark Tank", active: true },
      { slug: "top-gear", name: "Top Gear", active: true },
    ];
    const { getLatestShorts } = await loadActions();

    const outcome = await getLatestShorts(press());

    expect(outcome.ok).toBe(true);
    // ABSENT, not null. Nobody narrowed anything, so the report has no subject
    // to name and the screen prints no caption claiming one.
    expect(outcome.ok && "topic" in outcome.report).toBe(false);
  });

  it("refuses the ESTIMATE for a subject the run would refuse, so one press is not quoted two ways", async () => {
    seen.topics = [{ slug: "shark-tank", name: "Shark Tank", active: false }];
    const { estimateLatestShortsSpend } = await loadActions();

    const outcome = await estimateLatestShortsSpend(press({ topicSlug: "shark-tank" }));

    expect(outcome.ok).toBe(false);
  });
});
