/**
 * THE SCHEDULER HAD NO CALLER, AND 746 GREEN TESTS DID NOT NOTICE.
 *
 * `lib/shorts/schedule.ts` was built and tested a whole round before this file
 * existed. Its own suite calls `runOnSchedule()` directly and proves the pass:
 * the lock is taken once, every skip says why, every claimed lock comes back.
 * All of that was true and none of it was reachable — no route handler, no
 * script, no `vercel.json`, no workflow, and not one line in the tree reading
 * `CRON_SECRET`, which `.env.example` described at length as the thing that
 * makes the scheduled route refuse to run unauthenticated.
 *
 * That is the bug class this file exists to close. A test that calls a function
 * directly proves the function. It says NOTHING about whether the application
 * ever calls it. So the first block below does not test a function at all: it
 * WALKS THE TREE looking for a caller, the same way a reviewer had to. If the
 * route is deleted, renamed out of the routable tree, or quietly stops calling
 * `runOnSchedule`, that block goes red — and it would have been red on the
 * previous commit, when there was nothing to find.
 *
 * WHAT THE REST OF THE FILE COVERS, AND WHY IT IS ALL IN ONE FILE. The gate
 * (an unset secret is a refusal, a wrong secret is a 401, a constant-time
 * comparison), the bound (one fire starts one slice of work and says what it
 * left), the proxy question (a cron endpoint is not under /admin, so the
 * session gate does not touch it — CHECKED against the real proxy, not
 * assumed), and the lock's clock (Postgres', not the caller's).
 *
 * NOTHING HERE TOUCHES A NETWORK, A DATABASE OR AN API. The Supabase URL is
 * `.invalid`, which cannot resolve; the schedule store is driven against a
 * PostgREST double that models the filters and the `'now'` coercion this repo
 * depends on. What that double CANNOT prove is that a real PostgREST applies
 * that coercion — see the note on `DATABASE_CLOCK` in lib/shorts/schedule.ts,
 * which says so in as many words.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLATFORMS, type Platform, type ShortRecord } from "@/lib/platform/types";
import { MemoryShortsStore } from "@/lib/shorts/memory-store";
import {
  addSeconds,
  DEFAULT_LOCK_TTL_SECONDS,
  runOnSchedule,
  SupabaseScheduleStore,
  type ScheduledPlatformOutcome,
  type ScheduledRunReport,
} from "@/lib/shorts/schedule";
import { MemorySeedStore } from "@/lib/shorts/seeds";
import type { TenantClient } from "@/lib/supabase/config";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The URL a cron actually calls. Written once, used by every block below. */
const CRON_PATH = "/api/cron/run";

/** Long enough to satisfy the route's own minimum, and obviously not a secret. */
const SECRET = "not-a-real-cron-secret-0123456789";

const CONFIGURED = {
  NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.invalid",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_stub_not_a_real_key",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_stub_not_a_real_key",
  CRON_SECRET: SECRET,
};

// ---------------------------------------------------------------------------
// 1. THE ASSERTION THE LAST ROUND WAS MISSING: SOMETHING CALLS IT
// ---------------------------------------------------------------------------

/** Every source file in the tree, minus the places a build puts things. */
function sourceFiles(): string[] {
  const skip = new Set(["node_modules", ".next", ".git", "verify"]);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) found.push(path.join(dir, entry.name));
    }
  };
  walk(ROOT);
  return found;
}

describe("the scheduled run is reachable from outside its own test", () => {
  /**
   * Files that call `runOnSchedule`, excluding the module that defines it and
   * that module's own unit test — which are precisely the two places a caller
   * being present proves nothing about.
   */
  const callers = sourceFiles().filter((file) => {
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    if (relative.startsWith("lib/shorts/schedule")) return false;
    if (relative === "tests/cron-route.test.ts") return false;
    return /\brunOnSchedule\s*\(/.test(fs.readFileSync(file, "utf8"));
  });

  it("has at least one caller anywhere in the tree", () => {
    // THE REVIEW FINDING, AS A TEST. On the previous commit this list was
    // EMPTY: schedule.test.ts was the only thing that ever called the entry
    // point, so the feature was complete and unreachable at the same time and
    // the suite was green about it.
    expect(callers.length).toBeGreaterThan(0);
  });

  it("and that caller is a route handler the deployment actually serves", () => {
    // A script in scripts/ would satisfy the assertion above while still
    // leaving a deployment with no way to run on a schedule. This pins the
    // shape: the caller is a `route.ts` under `app/`, which is what Next serves
    // as a URL, and it is at the path the Vercel/systemd/GitHub callers use.
    const relative = callers.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(relative).toContain("app/api/cron/run/route.ts");
    expect(fs.existsSync(path.join(ROOT, "app", "api", "cron", "run", "route.ts"))).toBe(true);
  });

  it("reads CRON_SECRET, which until now existed only as prose in .env.example", () => {
    // `.env.example` promises: "WITHOUT IT THE SCHEDULED ROUTE IS A PUBLIC URL
    // ... Treat a missing CRON_SECRET as a refusal to run". Nothing read it. A
    // documented variable with no reader is a promise nobody is keeping.
    const readers = sourceFiles().filter((file) => {
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      if (relative === "tests/cron-route.test.ts") return false;
      return /CRON_SECRET/.test(fs.readFileSync(file, "utf8"));
    });
    expect(readers.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))).toContain(
      "app/api/cron/run/route.ts",
    );
  });

  it("compares the secret in constant time and never with ===", () => {
    // Constant time cannot be observed from a unit test on a laptop, so what is
    // pinned instead is the mechanism. `===` on strings short-circuits at the
    // first differing byte, which leaks the secret one character at a time to
    // anyone who can time the response; the digests keep the comparison the
    // same length whatever is presented.
    const source = fs.readFileSync(path.join(ROOT, "app", "api", "cron", "run", "route.ts"), "utf8");
    expect(source).toMatch(/timingSafeEqual/);
    expect(source).toMatch(/createHash\("sha256"\)/);
    // The shapes a well-meaning simplification would reach for.
    expect(source).not.toMatch(/presented\s*===\s*secret/);
    expect(source).not.toMatch(/secret\s*===\s*presented/);
  });
});

// ---------------------------------------------------------------------------
// 2. THE ROUTE ITSELF
// ---------------------------------------------------------------------------

type RouteModule = typeof import("@/app/api/cron/run/route");

/**
 * Load the route with an environment, optionally with the scheduled pass
 * replaced by a spy.
 *
 * `isSupabaseConfigured` is computed once at module load (lib/supabase/config),
 * so the env has to be stubbed before the route is first evaluated — hence
 * `resetModules` plus a dynamic import, the same shape tests/admin-routes.test.ts
 * uses and for the same reason.
 */
/** The scheduled pass, as a spy with a typed argument list. */
type PassSpy = ReturnType<typeof passSpy>;

function passSpy(report: () => ScheduledRunReport = cannedReport) {
  return vi.fn(async (_options: unknown): Promise<ScheduledRunReport> => report());
}

async function loadRoute(
  env: Record<string, string>,
  pass?: PassSpy,
): Promise<RouteModule> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  if (pass) {
    vi.doMock("@/lib/shorts/schedule", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/shorts/schedule")>();
      return { ...actual, runOnSchedule: pass };
    });
  }
  return (await import("@/app/api/cron/run/route")) as RouteModule;
}

function requestFor(url: string, init: { method?: string; secret?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.secret !== null && init.secret !== undefined) {
    headers.authorization = `Bearer ${init.secret}`;
  }
  return new Request(`https://shorts.example${url}`, { method: init.method ?? "GET", headers });
}

function short(platform: Platform): ShortRecord {
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
    discovered_at: "2026-09-04T12:00:00.000Z",
    discovered_by: "test",

    topic_slug: null,
  };
}

/** The one string that must never reach the response body. */
const KEY_IN_AN_ERROR = "https://api.x.invalid/2/tweets?bearer=SUPER-SECRET-OPERATOR-KEY";

/** A finished pass: one platform read, one left, one failed, one unavailable. */
function cannedReport(): ScheduledRunReport {
  const platforms: ScheduledPlatformOutcome[] = [
    {
      platform: "youtube",
      status: "skipped",
      reason: "left-for-the-next-fire",
      explanation: "YouTube was left for the next fire.",
    },
    {
      platform: "tiktok",
      status: "ran",
      lockReleased: true,
      outcome: {
        platform: "tiktok",
        status: "ok",
        description: "a fake reader",
        returned: 40,
        kept: 1,
        duplicates: 0,
        dropped: {
          wrongPlatform: 0,
          tooLong: 0,
          tooShort: 0,
          belowThreshold: 39,
          unknownDuration: 0,
          unknownViews: 0,
        },
        shorts: [short("tiktok")],
      },
    },
    {
      platform: "instagram",
      status: "ran",
      lockReleased: true,
      outcome: {
        platform: "instagram",
        status: "unavailable",
        description: "the official reader",
        reason: "Instagram needs a credential nobody has entered.",
      },
    },
    {
      platform: "x",
      status: "ran",
      lockReleased: true,
      outcome: {
        platform: "x",
        status: "failed",
        description: "the official reader",
        error: KEY_IN_AN_ERROR,
      },
    },
    {
      platform: "facebook",
      status: "skipped",
      reason: "disabled",
      explanation: "Facebook is not on a schedule.",
    },
    // Threads refuses an untargeted run by design rather than by configuration:
    // its keyword search needs terms, and the cron has no topic. That is an
    // `unavailable` with a sentence, never an empty `ran` — see
    // lib/platform/threads.ts.
    {
      platform: "threads",
      status: "ran",
      lockReleased: true,
      outcome: {
        platform: "threads",
        status: "unavailable",
        description: "the official reader",
        reason: "Threads can only be read for a subject, and this run named none.",
      },
    },
  ];

  return {
    startedAt: "2026-09-04T12:00:00.000Z",
    finishedAt: "2026-09-04T12:00:30.000Z",
    platforms,
    runReport: {
      startedAt: "2026-09-04T12:00:00.000Z",
      finishedAt: "2026-09-04T12:00:30.000Z",
      minViews: 500_000,
      minDurationSeconds: 0,
      maxDurationSeconds: 120,
      limit: 50,
      platforms: [],
      shorts: [short("tiktok")],
      spend: [{ platform: "x", usdMicros: 250_000, note: "50 posts at $0.005 each." }],
      persistence: { status: "written", rows: 1 },
    },
    proposals: { status: "filed", proposed: 0, written: 0 },
  };
}

describe("the cron route", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/shorts/schedule");
    vi.resetModules();
  });

  it("calls runOnSchedule when the secret matches, which is the whole point of the file", async () => {
    const pass = passSpy();
    const { POST } = await loadRoute(CONFIGURED, pass);

    const response = await POST(requestFor(CRON_PATH, { method: "POST", secret: SECRET }));

    expect(response.status).toBe(200);
    expect(pass).toHaveBeenCalledTimes(1);

    // Not just "it was called" — called with a real schedule store, the two
    // product thresholds, and a bound. A route that called it with no store
    // would satisfy a weaker assertion and fail in production.
    const options = pass.mock.calls[0][0] as Record<string, unknown>;
    expect((options.schedule as object).constructor.name).toBe("SupabaseScheduleStore");
    expect((options.seeds as object).constructor.name).toBe("SupabaseSeedStore");
    expect((options.store as object).constructor.name).toBe("SupabaseShortsStore");
    expect(options.minViews).toBe(500_000);
    expect(options.maxDurationSeconds).toBe(120);
    expect(options.limit).toBeGreaterThan(0);
    expect(options.maxPlatforms).toBe(1);
  });

  it("is reachable by GET, because that is what Vercel Cron sends", async () => {
    // Vercel invokes a cron job with GET and the bearer header. Accepting only
    // POST would mean the one host the variable is named after cannot call it.
    const pass = passSpy();
    const { GET } = await loadRoute(CONFIGURED, pass);

    const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
    expect(response.status).toBe(200);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  describe("the gate", () => {
    it("refuses to run at all when CRON_SECRET is unset, rather than running unauthenticated", async () => {
      // THE SENTENCE IN .env.example, MADE TRUE. An unset secret is a public URL
      // that spends the client's money on every enabled platform, so it is a
      // refusal and not a permissive default.
      const pass = passSpy();
      const { GET } = await loadRoute({ ...CONFIGURED, CRON_SECRET: "" }, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: null }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: "no-cron-secret" });
      expect(pass).not.toHaveBeenCalled();
    });

    it("refuses even when the caller presents the empty secret it was given", async () => {
      // The failure a naive comparison produces: unset === presented-nothing, so
      // an attacker sending `Authorization: Bearer ` would be let in on exactly
      // the deployment that forgot to set the variable.
      const pass = passSpy();
      const { GET } = await loadRoute({ ...CONFIGURED, CRON_SECRET: "" }, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: "" }));
      expect(response.status).toBe(503);
      expect(pass).not.toHaveBeenCalled();
    });

    it("refuses a secret too short to be one, and says so differently", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute({ ...CONFIGURED, CRON_SECRET: "hunter2" }, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: "hunter2" }));
      expect(response.status).toBe(503);
      // A different error id from the unset case: they need different fixes and
      // an operator reading a log should not have to guess which one they have.
      expect(await response.json()).toMatchObject({ error: "cron-secret-too-short" });
      expect(pass).not.toHaveBeenCalled();
    });

    it("turns away a request with no Authorization header", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: null }));
      expect(response.status).toBe(401);
      expect(pass).not.toHaveBeenCalled();
    });

    it("turns away a near-miss, and a value of a completely different length", async () => {
      // The second half is not padding. `timingSafeEqual` THROWS on buffers of
      // different lengths, so an implementation that compared the raw strings
      // would answer a one-character guess with a 500 — and a 500 that only
      // happens for wrong-length guesses is itself an oracle. Hashing first is
      // what makes both of these an ordinary 401.
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const nearMiss = await GET(requestFor(CRON_PATH, { secret: `${SECRET.slice(0, -1)}X` }));
      expect(nearMiss.status).toBe(401);

      const shorter = await GET(requestFor(CRON_PATH, { secret: "x" }));
      expect(shorter.status).toBe(401);

      const longer = await GET(requestFor(CRON_PATH, { secret: SECRET.repeat(40) }));
      expect(longer.status).toBe(401);

      expect(pass).not.toHaveBeenCalled();
    });

    it("does not accept the secret without the Bearer scheme Vercel sends", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const response = await GET(
        new Request(`https://shorts.example${CRON_PATH}`, { headers: { authorization: SECRET } }),
      );
      expect(response.status).toBe(401);
      expect(pass).not.toHaveBeenCalled();
    });

    it("refuses when there is no database, because there is then no lock", async () => {
      // A schedule with nowhere to record itself is not one: no lock means two
      // fires read every platform twice, which on X is billed twice.
      const pass = passSpy();
      const { GET } = await loadRoute(
        { ...CONFIGURED, NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" },
        pass,
      );

      const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "no-database" });
      expect(pass).not.toHaveBeenCalled();
    });

    it("refuses when there is no service-role key, because an unattended run has no session", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute({ ...CONFIGURED, SUPABASE_SERVICE_ROLE_KEY: "" }, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
      expect(response.status).toBe(503);
      expect(pass).not.toHaveBeenCalled();
    });
  });

  describe("the bound", () => {
    it("starts one platform by default, so a killed function loses at most one platform's work", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      await GET(requestFor(CRON_PATH, { secret: SECRET }));
      expect((pass.mock.calls[0][0] as { maxPlatforms: number }).maxPlatforms).toBe(1);
    });

    it("takes a bigger slice when the caller has the time for one", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      await GET(requestFor(`${CRON_PATH}?slice=${PLATFORMS.length}`, { secret: SECRET }));
      expect((pass.mock.calls[0][0] as { maxPlatforms: number }).maxPlatforms).toBe(
        PLATFORMS.length,
      );
    });

    it.each(["0", "-1", "abc", "2.5", String(PLATFORMS.length + 1), ""])(
      "refuses ?slice=%s rather than guessing what it meant",
      async (slice) => {
        // A mis-parsed bound that fell back to "all of them" would be the
        // expensive direction of a typo, on the one path that spends money
        // without a person watching. The empty string is included because
        // `?slice=` is what a shell writes when a variable is unset — and it
        // is the one value that is NOT refused, because it is indistinguishable
        // from leaving the parameter off.
        const pass = passSpy();
        const { GET } = await loadRoute(CONFIGURED, pass);

        const response = await GET(requestFor(`${CRON_PATH}?slice=${slice}`, { secret: SECRET }));
        if (slice === "") {
          expect(response.status).toBe(200);
          expect((pass.mock.calls[0][0] as { maxPlatforms: number }).maxPlatforms).toBe(1);
          return;
        }
        expect(response.status).toBe(400);
        expect(pass).not.toHaveBeenCalled();
      },
    );
  });

  describe("what it reports", () => {
    it("says what it did and what it left, and that it is safe to call again", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const body = (await (await GET(requestFor(CRON_PATH, { secret: SECRET }))).json()) as {
        read: string[];
        left: string[];
        callAgain: boolean;
        kept: number;
        stored: string;
        spend: { platform: string; usdMicros: number }[];
        platforms: { platform: string; status: string; reason?: string }[];
      };

      expect(body.read).toEqual(["tiktok", "instagram", "x", "threads"]);
      expect(body.left).toEqual(["youtube"]);
      expect(body.callAgain).toBe(true);
      expect(body.kept).toBe(1);
      expect(body.stored).toBe("written");
      // Money is reported per platform. A platform that quoted no price is
      // absent from this list, never present with a zero.
      expect(body.spend).toEqual([
        { platform: "x", usdMicros: 250_000, note: "50 posts at $0.005 each." },
      ]);

      // One line per platform, every one of them, so a platform cannot vanish
      // from a report by being uninteresting.
      expect(body.platforms.map((p) => p.platform)).toEqual([...PLATFORMS]);
    });

    it("does not put a provider's error message — which may hold an API key — in the body", async () => {
      // THE HOUSE RULE, ON THE ONE SURFACE WHOSE OUTPUT ENDS UP IN SOMEBODY
      // ELSE'S LOG AGGREGATOR. These adapters call metered APIs with the key in
      // the query string, so an exception's message can be a credential.
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
      const text = await response.text();

      expect(text).not.toContain(KEY_IN_AN_ERROR);
      expect(text).not.toContain("SUPER-SECRET-OPERATOR-KEY");
      // It is not silently dropped either: the words go to the server log.
      expect(logged.join("\n")).toContain(KEY_IN_AN_ERROR);
      expect(logged.join("\n")).toContain("[api/cron/run]");
    });

    it("still prints the adapter's own sentence for a platform that could not run", async () => {
      // The other half of the rule. An in-repo explanation is the whole product
      // — "could not be read" and "nothing over the threshold" are different
      // facts — and suppressing it would leave an empty list looking like news.
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const body = (await (await GET(requestFor(CRON_PATH, { secret: SECRET }))).json()) as {
        platforms: { platform: string; explanation?: string }[];
      };
      const instagram = body.platforms.find((p) => p.platform === "instagram");
      expect(instagram?.explanation).toBe("Instagram needs a credential nobody has entered.");
    });

    it("is never cached, so a previous fire's report cannot be served as this one's", async () => {
      const pass = passSpy();
      const { GET } = await loadRoute(CONFIGURED, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("turns a pass that could not be made into a 500 and a sentence, not a stack trace", async () => {
      const pass = passSpy(() => {
        throw new Error(KEY_IN_AN_ERROR);
      });
      const { GET } = await loadRoute(CONFIGURED, pass);

      const response = await GET(requestFor(CRON_PATH, { secret: SECRET }));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("SUPER-SECRET-OPERATOR-KEY");
      expect(logged.join("\n")).toContain("[api/cron/run]");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. THE PROXY QUESTION, CHECKED RATHER THAN ASSUMED
// ---------------------------------------------------------------------------

/**
 * tests/admin-routes.test.ts discovers routes by walking `app/(admin)` and
 * asserts every one of them redirects a signed-out visitor. `/api/cron/run` is
 * NOT under that group, so it is not covered by that file and is not behind the
 * session gate. That is deliberate — an unattended caller has no cookie to
 * present — and this block writes the reason down and proves the shape, because
 * "the proxy probably does not touch it" is exactly the kind of assumption that
 * ships an open door.
 */
describe("the cron endpoint is outside the admin gate, on purpose", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadProxy() {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", CONFIGURED.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      CONFIGURED.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.resetModules();
    return await import("../proxy");
  }

  it("is not one of the routes the admin gate discovers", () => {
    // Stated as a fact about the filesystem rather than about intentions: the
    // route is not inside the (admin) group, so no walk of that group will ever
    // find it and nobody should read that file as covering this URL.
    expect(fs.existsSync(path.join(ROOT, "app", "(admin)", "api"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "app", "api", "cron", "run", "route.ts"))).toBe(true);
  });

  it("is reached by the proxy's matcher, so the exemption is a decision and not an accident", async () => {
    // If the matcher did not reach it, the pass-through below would be true for
    // a reason nobody had chosen — and would silently change the day somebody
    // edited the matcher.
    const { config } = await loadProxy();
    const patterns = (config.matcher as readonly string[]).map((m) => new RegExp(`^${m}$`));
    expect(patterns.some((p) => p.test(CRON_PATH))).toBe(true);
  });

  it("is passed through rather than redirected to the login page", async () => {
    // The load-bearing one. A session redirect here would turn every cron fire
    // into a 307 to /admin/login: the schedule would silently never run, and
    // the only symptom would be a list that stopped being fresh.
    const { proxy } = await loadProxy();
    const response = await proxy(new NextRequest(`https://shorts.example${CRON_PATH}`));

    expect(response.headers.get("location")).toBeNull();
    expect([307, 308]).not.toContain(response.status);
  });

  it("is passed through on an unconfigured deployment too", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.resetModules();
    const { proxy } = await import("../proxy");

    const response = await proxy(new NextRequest(`https://shorts.example${CRON_PATH}`));
    expect(response.headers.get("location")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. THE LOCK IS COMPARED AGAINST THE DATABASE'S CLOCK
// ---------------------------------------------------------------------------

/**
 * A PostgREST double, faithful about the two things this fix turns on.
 *
 * It applies filters the way Postgres would (including the `'now'` literal that
 * `SupabaseScheduleStore` sends instead of a timestamp) and it renders times the
 * way PostgREST does — `+00:00`, with microseconds — rather than the way
 * JavaScript does, so a comparison that only works on `Z`-suffixed strings
 * fails here rather than in production.
 *
 * WHAT IT CANNOT PROVE, stated so this file is not read as more than it is:
 * that a real PostgREST coerces the string `now` to `now()`. That is Postgres'
 * documented input syntax for `timestamptz` and it is unverified against a live
 * server, because there is no database on this machine. See `DATABASE_CLOCK` in
 * lib/shorts/schedule.ts.
 */
class FakePostgrest {
  readonly rows = new Map<string, Record<string, unknown>>();
  /** What the DATABASE thinks the time is. No worker's clock may equal this. */
  clock: number;
  /** Runs before each statement, so a test can play the part of another fire. */
  beforeStatement: (() => void) | null = null;
  statements = 0;

  constructor(rows: readonly Record<string, unknown>[], clock: string) {
    for (const row of rows) this.rows.set(String(row.platform), { ...row });
    this.clock = Date.parse(clock);
  }

  /** PostgREST's rendering, which is not JavaScript's. */
  now(): string {
    return `${new Date(this.clock).toISOString().replace("Z", "")}123+00:00`;
  }

  advance(seconds: number): void {
    this.clock += seconds * 1000;
  }

  from(table: string) {
    if (table !== "platform_schedule") throw new Error(`unexpected table ${table}`);
    return new FakeQuery(this);
  }

  asClient(): TenantClient {
    return this as unknown as TenantClient;
  }
}

type Filter = { op: "eq" | "lte"; column: string; value: unknown };

class FakeQuery {
  private payload: Record<string, unknown> | null = null;
  private readonly filters: Filter[] = [];
  private single = false;

  constructor(private readonly db: FakePostgrest) {}

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  update(payload: Record<string, unknown>): this {
    this.payload = payload;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ op: "eq", column, value });
    return this;
  }
  lte(column: string, value: unknown): this {
    this.filters.push({ op: "lte", column, value });
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  /**
   * Awaited exactly the way supabase-js's builder is. Resolved through a real
   * promise rather than synchronously, so an interleaving that only works
   * because a fake resolved too early does not pass here.
   */
  then(
    onFulfilled: (value: { data: unknown; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }

  /** `'now'` is resolved by the DATABASE, which is the whole point. */
  private literal(value: unknown): unknown {
    return value === "now" ? this.db.now() : value;
  }

  private run(): { data: unknown; error: null } {
    this.db.statements += 1;
    this.db.beforeStatement?.();

    const matched = [...this.db.rows.values()].filter((row) =>
      this.filters.every((filter) => {
        const wanted = this.literal(filter.value);
        if (filter.op === "eq") return row[filter.column] === wanted;
        const left = Date.parse(String(row[filter.column]));
        const right = Date.parse(String(wanted));
        return left <= right;
      }),
    );

    if (this.payload) {
      for (const row of matched) {
        for (const [column, value] of Object.entries(this.payload)) {
          row[column] = this.literal(value);
        }
      }
    }

    const data = this.single ? (matched[0] ?? null) : matched;
    return { data, error: null };
  }
}

function scheduleRow(platform: Platform, over: Record<string, unknown> = {}) {
  return {
    platform,
    enabled: true,
    claimable_after: "2026-09-04T11:00:00.000000+00:00",
    min_interval_seconds: null,
    lock_token: null,
    locked_at: null,
    lock_expires_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_outcome: null,
    last_note: null,
    ...over,
  };
}

/** One pass over a fake database, with this worker's own (possibly wrong) clock. */
function passOptions(db: FakePostgrest, workerClock: string, over: Record<string, unknown> = {}) {
  return {
    schedule: new SupabaseScheduleStore(db.asClient()),
    seeds: new MemorySeedStore(),
    store: new MemoryShortsStore(),
    limit: 5,
    minViews: 500_000,
    maxDurationSeconds: 120,
    now: () => workerClock,
    adapters: () => [],
    proposeSeeds: false,
    ...over,
  } as Parameters<typeof runOnSchedule>[0];
}

function outcomeFor(
  report: ScheduledRunReport,
  platform: Platform,
): ScheduledPlatformOutcome {
  const found = report.platforms.find((p) => p.platform === platform);
  if (!found) throw new Error(`no outcome for ${platform}`);
  return found;
}

describe("two workers with disagreeing clocks cannot both hold one platform", () => {
  const DB_NOW = "2026-09-04T12:00:00.000Z";
  /** Twenty minutes ahead of the database. A cheap VM's clock, or a wrong TZ. */
  const FAST_WORKER = "2026-09-04T12:20:00.000Z";
  /** Twenty minutes behind it. */
  const SLOW_WORKER = "2026-09-04T11:40:00.000Z";

  it("refuses the fast worker a lock the database says is still held", async () => {
    // THE BUG, EXACTLY. The first worker claims at 12:00 and its lock runs to
    // 12:15. The second worker's clock says 12:20, so under the old code the
    // predicate `claimable_after <= 12:20` matched and it took the same row:
    // two workers reading one platform, and on X the same posts billed twice
    // with nothing going red anywhere.
    const db = new FakePostgrest([scheduleRow("tiktok")], DB_NOW);

    const first = await runOnSchedule(passOptions(db, DB_NOW));
    expect(outcomeFor(first, "tiktok").status).toBe("ran");

    // The first pass has finished and released — so put the row back into the
    // state a still-running worker leaves it in: locked, expiring at 12:15.
    const row = db.rows.get("tiktok") as Record<string, unknown>;
    row.lock_token = "the-worker-that-is-still-running";
    row.locked_at = DB_NOW;
    row.lock_expires_at = addSeconds(DB_NOW, DEFAULT_LOCK_TTL_SECONDS);
    row.claimable_after = addSeconds(DB_NOW, DEFAULT_LOCK_TTL_SECONDS);

    const second = await runOnSchedule(passOptions(db, FAST_WORKER));
    const tiktok = outcomeFor(second, "tiktok");

    expect(tiktok.status).toBe("skipped");
    if (tiktok.status !== "skipped") throw new Error("unreachable");
    expect(tiktok.reason).toBe("locked");
    // And it really did not take it: the first worker's token is untouched.
    expect(db.rows.get("tiktok")?.lock_token).toBe("the-worker-that-is-still-running");
  });

  it("stamps the lock from the database's clock, not from the worker's", async () => {
    // The other half. A worker whose clock is twenty minutes FAST used to write
    // a lock twenty minutes too long; one twenty minutes SLOW wrote a lock that
    // had already expired when it was taken, so the next fire claimed the row
    // immediately and both read the platform.
    const db = new FakePostgrest([scheduleRow("tiktok")], DB_NOW);
    await runOnSchedule(
      passOptions(db, SLOW_WORKER, {
        lockTtlSeconds: 900,
        // Park the pass so the row can be inspected while the lock is held.
        adapters: () => [],
      }),
    );

    // With no cadence floor a released lock is claimable immediately, so the
    // interesting evidence is what the claim itself wrote: `last_started_at` is
    // the database's clock and never the worker's.
    const row = db.rows.get("tiktok") as Record<string, unknown>;
    expect(Date.parse(String(row.last_started_at))).toBeGreaterThanOrEqual(Date.parse(DB_NOW));
    expect(Date.parse(String(row.last_started_at))).toBeLessThan(Date.parse(FAST_WORKER));
    expect(String(row.last_started_at)).not.toContain(SLOW_WORKER.slice(0, 16));
  });

  it("holds the lock into the database's future even when the worker's clock is behind", async () => {
    // Asserted on a claim that is still held, which is the state the TTL is
    // about. A lock whose expiry is in the database's past is not a lock: the
    // very next fire takes the row while this one is still reading.
    const db = new FakePostgrest([scheduleRow("tiktok")], DB_NOW);
    const store = new SupabaseScheduleStore(db.asClient());

    const claimed = await store.claim("tiktok", {
      token: "a-worker-whose-clock-is-wrong",
      now: SLOW_WORKER,
      ttlSeconds: 900,
    });

    expect(claimed).not.toBeNull();
    const expires = Date.parse(String(db.rows.get("tiktok")?.claimable_after));
    expect(expires).toBeGreaterThan(db.clock);
    expect(expires).toBe(Date.parse(db.now()) + 900_000);
  });

  it("measures a cadence floor from the database's finish time", async () => {
    // A floor is an operator's "never read this more often than X". Measured
    // from a slow worker's clock it silently becomes a shorter floor, and the
    // difference is paid for per post on X.
    const db = new FakePostgrest([scheduleRow("tiktok", { min_interval_seconds: 3600 })], DB_NOW);
    const store = new SupabaseScheduleStore(db.asClient());

    const claimed = await store.claim("tiktok", {
      token: "a-worker-whose-clock-is-wrong",
      now: SLOW_WORKER,
      ttlSeconds: 900,
    });
    if (!claimed) throw new Error("the claim should have been won");

    db.advance(30);
    const released = await store.release({
      claimed,
      finishedAt: SLOW_WORKER,
      outcome: "ok",
      note: null,
    });

    expect(released).toBe(true);
    const row = db.rows.get("tiktok") as Record<string, unknown>;
    expect(row.lock_token).toBeNull();
    expect(Date.parse(String(row.claimable_after))).toBe(Date.parse(String(row.last_finished_at)) + 3_600_000);
    // And that finish time is the database's, thirty seconds after the claim,
    // not the worker's twenty-minutes-ago.
    expect(Date.parse(String(row.last_finished_at))).toBe(Date.parse(DB_NOW) + 30_000);
  });

  it("gives up rather than reading a platform whose lock was taken while it was claiming", async () => {
    // The window the two-write claim opens, closed. Between parking the row on
    // `'now'` and pushing the expiry out, another fire can take it. That is safe
    // — this pass must then read nothing — and it is safe because the second
    // write is filtered on the token.
    const db = new FakePostgrest([scheduleRow("tiktok")], DB_NOW);
    let statements = 0;
    db.beforeStatement = () => {
      statements += 1;
      // Statement 1 is readSchedule, 2 is the claim; steal the row before 3.
      if (statements === 3) {
        const row = db.rows.get("tiktok") as Record<string, unknown>;
        row.lock_token = "another-fire-entirely";
      }
    };

    const report = await runOnSchedule(passOptions(db, DB_NOW));
    const tiktok = outcomeFor(report, "tiktok");

    expect(tiktok.status).toBe("skipped");
    if (tiktok.status !== "skipped") throw new Error("unreachable");
    expect(tiktok.reason).toBe("locked");
    expect(report.runReport).toBeNull();
    expect(db.rows.get("tiktok")?.lock_token).toBe("another-fire-entirely");
  });
});

// ---------------------------------------------------------------------------
// 5. THE SLICE, AGAINST THE REAL ENTRY POINT
// ---------------------------------------------------------------------------

describe("a bounded pass starts what it can finish and says what it left", () => {
  const DB_NOW = "2026-09-04T12:00:00.000Z";

  it("claims only as many platforms as it was allowed to start", async () => {
    const db = new FakePostgrest(
      PLATFORMS.map((platform) => scheduleRow(platform)),
      DB_NOW,
    );

    const report = await runOnSchedule(passOptions(db, DB_NOW, { maxPlatforms: 1 }));

    const started = report.platforms.filter((p) => p.status === "ran");
    expect(started).toHaveLength(1);

    const left = report.platforms.filter(
      (p) => p.status === "skipped" && p.reason === "left-for-the-next-fire",
    );
    expect(left).toHaveLength(PLATFORMS.length - 1);
    // A platform nobody asked about must not read as a platform with nothing on
    // it. This sentence is the difference.
    for (const outcome of left) {
      if (outcome.status !== "skipped") throw new Error("unreachable");
      expect(outcome.explanation).toMatch(/nothing looked/i);
    }
    // Four platforms were never touched, so four rows still have no lock and no
    // start time: a bounded pass is not a pass that claimed everything quietly.
    const untouched = [...db.rows.values()].filter((row) => row.last_started_at === null);
    expect(untouched).toHaveLength(PLATFORMS.length - 1);
  });

  it("does not starve the platforms that sort last, fire after fire", async () => {
    // The failure a naive slice produces: `PLATFORMS` order every time, so the
    // first platform is read on every fire and the last is read never — which
    // looks exactly like a broken adapter and would be debugged as one.
    const db = new FakePostgrest(
      PLATFORMS.map((platform) => scheduleRow(platform)),
      DB_NOW,
    );

    const readEach = new Set<Platform>();
    for (let fire = 0; fire < PLATFORMS.length; fire += 1) {
      db.advance(60);
      const report = await runOnSchedule(
        passOptions(db, new Date(db.clock).toISOString(), { maxPlatforms: 1 }),
      );
      for (const outcome of report.platforms) {
        if (outcome.status === "ran") readEach.add(outcome.platform);
      }
    }

    expect([...readEach].sort()).toEqual([...PLATFORMS].sort());
  });

  it("refuses a bound that is not a number of platforms rather than reading everything", async () => {
    const db = new FakePostgrest([scheduleRow("tiktok")], DB_NOW);
    await expect(runOnSchedule(passOptions(db, DB_NOW, { maxPlatforms: 0 }))).rejects.toThrow(
      /whole number of platforms/i,
    );
    // Nothing was claimed on the way to being refused.
    expect(db.statements).toBe(0);
  });
});
