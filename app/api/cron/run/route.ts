/**
 * THE DOOR `runOnSchedule()` DID NOT HAVE.
 *
 * lib/shorts/schedule.ts has been a complete, tested scheduled run for a while:
 * it claims a platform, reads it, releases the lock and reports what happened.
 * A review then found that NOTHING CALLED IT. No route, no script, no
 * `vercel.json`, no workflow — and nothing anywhere read `CRON_SECRET`, whose
 * only appearance in the tree was a paragraph in `.env.example` describing a
 * refusal that did not exist. Every test of that module called the function
 * directly, so the suite was green about a feature the deployment could not
 * reach. This file is the reachable end of it, and tests/cron-route.test.ts
 * asserts the route EXISTS and calls that function, which is the assertion the
 * whole round was missing.
 *
 * ---------------------------------------------------------------------------
 * THE SECRET, AND WHY AN UNSET ONE IS A REFUSAL RATHER THAN A DEFAULT
 * ---------------------------------------------------------------------------
 *
 * A fire spends money. X's published rate is $0.005 per post RETURNED, so an
 * unauthenticated URL that starts a run is a URL that bills the client's card
 * for anyone who can guess a path. `.env.example` already promised, in prose,
 * that a missing `CRON_SECRET` is a refusal to run; this file is what makes
 * that sentence true.
 *
 *   - `CRON_SECRET` unset, blank, or shorter than 16 characters -> 503. It never
 *     runs unauthenticated, and it does not quietly accept a two-character
 *     secret that somebody typed as a placeholder.
 *   - The presented value is compared in CONSTANT TIME, over SHA-256 digests
 *     rather than the strings themselves, so neither the content NOR THE LENGTH
 *     of the real secret can be recovered by timing the response. `===` on
 *     strings short-circuits at the first differing byte, which is the whole
 *     attack.
 *   - The comparison runs even when the header is missing or malformed, so a
 *     well-formed guess and a blank request take the same path.
 *
 * THE NAME IS VERCEL'S AND IS NOT A PREFERENCE. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` automatically when a cron job it
 * declares invokes a route, so the variable has to be called this for the two
 * ends to agree. Every other host sends the same header by hand:
 *
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<deployment>/api/cron/run?slice=1"
 *
 * which is the line for a systemd timer's ExecStart, for a GitHub Actions
 * `schedule:` step, or for a person checking that the thing works. GET and POST
 * are both accepted for exactly that reason: POST is the honest method for a
 * call that spends money and writes rows, and GET is what Vercel Cron sends.
 * Refusing GET would mean refusing the host the variable is named after.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE IS NOT BEHIND THE ADMIN GATE, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * proxy.ts closes `/admin` and everything under it. `/api/cron/run` is not
 * under `/admin`, so — CHECKED, NOT ASSUMED, in tests/cron-route.test.ts
 * against the real proxy and its real matcher — the proxy runs on this URL and
 * passes it through without a session check. That is correct and it is the only
 * arrangement that works: an unattended caller has no browser, no cookie and no
 * Supabase session to present, so a session gate would lock out the only client
 * this endpoint has. The bearer secret above IS the gate, it is the only gate,
 * and it fails closed.
 *
 * IT IS ALSO NOT AN ADMIN SESSION IN DISGUISE. The run reaches the database as
 * `service_role`, because `platform_schedule` is granted to `authenticated`
 * only behind `is_admin()` and there is no admin here to be. Migration 07
 * anticipates exactly this caller — "the unattended run" — and grants it
 * `select, update` on the schedule, `select, update` on seeds and `insert` on
 * proposals, and nothing else. THIS IS THE SECOND USE OF THE SERVICE-ROLE KEY
 * IN THE REPO; lib/supabase/config.ts says the first (leasing a credential's
 * plaintext) should be the only one, and that comment now understates the
 * count. The alternative was a SECURITY DEFINER claim function, which is a
 * migration this change does not own — noted rather than done.
 *
 * ---------------------------------------------------------------------------
 * IT DOES A SLICE OF WORK AND SAYS WHAT IT LEFT
 * ---------------------------------------------------------------------------
 *
 * Serverless functions are killed at a wall-clock ceiling this code cannot
 * discover, and the plan already records that quota-paced work will not survive
 * one. So a fire does not start work it cannot finish: `?slice=N` bounds how
 * many platforms a single invocation will CLAIM, and it defaults to ONE.
 *
 * ONE, RATHER THAN ALL FIVE, BECAUSE OF WHERE THE WRITE IS. `getLatestShorts`
 * stores everything it read in a single write at the END of the pass, so a pass
 * cut off halfway through five platforms loses the results of the platforms
 * that had already finished — including, on X, results that were paid for. With
 * one platform per fire, the unit of loss is one platform. A host with real
 * time (a systemd timer, a GitHub runner) should ask for more: `?slice=5`.
 *
 * WHAT HAPPENS WHEN IT IS CUT OFF MID-RUN, PLAINLY. The platform it had claimed
 * stays locked until the claim's time-to-live lapses (fifteen minutes,
 * `DEFAULT_LOCK_TTL_SECONDS`), because a killed process releases nothing. No
 * report is written and no shorts are stored — a run that did not reach its
 * write stored nothing, not part of something. Nothing is corrupted and nothing
 * is double-read: the next fire finds that platform locked, says so, and takes
 * a different one. The platform comes back on its own once the lock expires.
 * The cost of being cut off is therefore wasted API spend and one platform idle
 * for up to fifteen minutes, and never a duplicate charge.
 *
 * SAFE TO CALL AGAIN, IMMEDIATELY AND CONCURRENTLY. Two fires racing cannot
 * read one platform twice — that is what the conditional claim in
 * lib/shorts/schedule.ts is for, and it is now evaluated against POSTGRES'
 * clock rather than the caller's, so two hosts whose clocks disagree cannot
 * both hold the same row. The response says what was left, so a caller that
 * wants the rest can simply fire again.
 *
 * WHAT ONE FIRE CAN COST, AT THE PUBLISHED RATE AND NOT AS A MEASUREMENT. At
 * most `slice` platforms are read, each asked for at most `ROWS_PER_PLATFORM`
 * (50) rows. Of the five platforms only X bills, at $0.005 per post returned,
 * so the ceiling for a default fire that happens to pick X is 50 x $0.005 =
 * $0.25. Every platform starts DISABLED in the schedule table and only a person
 * turns one on, so a deployment that has enabled nothing spends nothing however
 * often this is called.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO vercel.json IN THIS COMMIT
 * ---------------------------------------------------------------------------
 *
 * A Vercel cron job must be declared in `vercel.json` under `crons` — the route
 * alone does not create a schedule there. It is deliberately NOT added, for
 * three reasons that are about honesty rather than effort. Erik has not chosen
 * a host, and a `crons` entry commits the repo to Vercel's cadence rules
 * (on the Hobby plan, once per day, at an unpredictable minute in the hour, and
 * a more frequent expression fails the deploy outright). `vercel.json` is
 * strict JSON with no comment syntax, so the reasoning could not travel with
 * the file, and this repo's rule is that a file says why it exists. And this
 * route is host-agnostic today: a systemd timer or a GitHub Action needs no
 * file in the repo at all.
 *
 * WHEN SOMEBODY DOES CHOOSE VERCEL, this is the whole of it, at the root:
 *
 *   { "crons": [{ "path": "/api/cron/run?slice=1", "schedule": "0 * * * *" }] }
 *
 * plus `CRON_SECRET` set in the project's PRODUCTION environment, which is what
 * makes Vercel send the bearer token this file checks.
 *
 * ---------------------------------------------------------------------------
 * NO UPSTREAM SENTENCE CROSSES THIS BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * The same rule the admin actions hold. A message composed inside this repo —
 * an adapter's "no creators have been seeded", the schedule's reason for a skip
 * — is returned, because that is the whole point of the report. A message that
 * came from a provider, a subprocess or PostgREST is LOGGED under
 * `[api/cron/run]` and replaced in the response by a sentence saying where to
 * look. These adapters call metered APIs with the key in the query string, so a
 * failing URL quoted in an exception is an operator's own API key, and a cron
 * response ends up in whatever log the caller keeps.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { minViews, shortMaxSeconds } from "@/lib/config";
import { PLATFORMS, type Platform } from "@/lib/platform/types";
import {
  runOnSchedule,
  SupabaseScheduleStore,
  type ScheduledPlatformOutcome,
  type ScheduledRunReport,
} from "@/lib/shorts/schedule";
import { SupabaseSeedStore } from "@/lib/shorts/seeds";
import { SupabaseTopicStore } from "@/lib/shorts/topic-store";
import { SupabaseTopicChannelStore } from "@/lib/shorts/topic-channels";
import { SupabaseShortsStore } from "@/lib/shorts/supabase-store";
import {
  DB_SCHEMA,
  isSupabaseConfigured,
  supabaseServiceRoleKey,
  supabaseUrl,
  type TenantClient,
} from "@/lib/supabase/config";

/** The tag every line this file writes to the deployment's server log carries. */
const LOG_TAG = "[api/cron/run]";

/**
 * How many rows a scheduled fire asks each platform for.
 *
 * FIFTY, TO MATCH THE BUTTON. app/(admin)/admin/shorts/actions.ts uses the same
 * number and says at length that nobody has set it: it is a cost ceiling, not a
 * measurement, and it is not in lib/config.ts because everything there cites a
 * person and a date. It is repeated here rather than imported because that file
 * is a "use server" module, where every export becomes a public endpoint. If
 * the two ever need to differ, that is a decision somebody should have to write
 * down twice.
 */
const ROWS_PER_PLATFORM = 50;

/**
 * The shortest secret this route will accept.
 *
 * `.env.example` asks for "at least 16 characters" and this is that sentence
 * enforced. A one-character secret is not a smaller amount of protection, it is
 * a public URL with a formality in front of it, and the refusal names itself so
 * it cannot be mistaken for the unset case.
 */
const MIN_SECRET_LENGTH = 16;

/** Vercel Cron sends GET. A person or a timer should send POST. Both work. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

async function handle(request: Request): Promise<Response> {
  const secret = (process.env.CRON_SECRET ?? "").trim();

  if (secret === "") {
    // NOT a permissive default. An unset secret means anybody who guesses this
    // path can spend the operator's API budget, so the route turns itself off.
    return refuse(503, {
      error: "no-cron-secret",
      message:
        "CRON_SECRET is not set on this deployment, so this endpoint refuses to run. An unset " +
        "secret would make this a public URL that spends money on every platform that is " +
        "enabled. Set it on the server and in the caller, and nothing ran.",
    });
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    return refuse(503, {
      error: "cron-secret-too-short",
      message:
        `CRON_SECRET is set but is shorter than ${MIN_SECRET_LENGTH} characters, so this endpoint ` +
        "refuses to run. This is a different problem from an unset secret and needs a different " +
        "fix: generate a real random value. Nothing ran.",
    });
  }

  // Deliberately unconditional. Returning early for a missing or malformed
  // header would make "no header" and "wrong secret" take measurably different
  // amounts of work.
  if (!presentedSecretMatches(request, secret)) {
    return refuse(
      401,
      {
        error: "unauthorized",
        message:
          "This endpoint is called with an Authorization: Bearer header carrying the " +
          "deployment's CRON_SECRET. Nothing ran and no platform was read.",
      },
      { "www-authenticate": "Bearer" },
    );
  }

  const slice = parseSlice(new URL(request.url).searchParams.get("slice"));
  if (slice === null) {
    return refuse(400, {
      error: "bad-slice",
      message:
        `?slice= is how many platforms one fire may start: a whole number from 1 to ` +
        `${PLATFORMS.length}, or leave it off for 1. Nothing ran.`,
    });
  }

  const client = serviceClient();
  if (client === null) {
    // Two different missing things, one refusal, because the caller's next step
    // is the same in both cases: give this deployment a database it can reach
    // without a browser session.
    return refuse(503, {
      error: "no-database",
      message: isSupabaseConfigured
        ? "SUPABASE_SERVICE_ROLE_KEY is not set on this deployment. An unattended run has no " +
          "session, so without it there is no way to claim the schedule lock — and without the " +
          "lock two fires would read the same platform and be billed twice. Nothing ran."
        : "No Supabase project is configured for this deployment, so there is nowhere to hold the " +
          "lock that stops two fires reading a platform at once and nowhere to record when a " +
          "platform last ran. Nothing ran. Use the button on /admin/shorts until there is one.",
    });
  }

  let report: ScheduledRunReport;
  try {
    report = await runOnSchedule({
      schedule: new SupabaseScheduleStore(client),
      seeds: new SupabaseSeedStore(client),
      // The unattended pass searches for the same subjects the button does.
      // Without this it would keep making the untargeted run, so the scheduled
      // results and the manual ones would answer different questions while
      // looking identical on the page.
      topics: new SupabaseTopicStore(client),
      // Each topic's own channels — searched alongside its keywords, and grown
      // from what performs, so the unattended pass keeps the lists current
      // between manual runs. Tolerant of migration 19 being unapplied.
      channels: new SupabaseTopicChannelStore(client),
      store: new SupabaseShortsStore(client),
      limit: ROWS_PER_PLATFORM,
      minViews: minViews(),
      maxDurationSeconds: shortMaxSeconds(),
      maxPlatforms: slice,
      proposedBy: "cron",
    });
  } catch (cause) {
    // A pass only throws for something structural — a bad configuration number,
    // a schedule table that cannot be read. Every per-platform failure is inside
    // the report and never reaches here.
    console.error(`${LOG_TAG} the pass could not be made:`, cause);
    return refuse(500, {
      error: "pass-not-made",
      message:
        "The scheduled pass could not be made. This deployment's server log has the reason, " +
        "tagged [api/cron/run]. Nothing below is a statement about any platform.",
    });
  }

  logTheWordsThatDoNotTravel(report);
  return json(200, summarise(report, slice));
}

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

/**
 * Whether the request carries the deployment's secret, in constant time.
 *
 * The digests are compared rather than the strings, which does two things at
 * once: `timingSafeEqual` needs equal lengths and SHA-256 always gives it 32
 * bytes, and hashing first means the work done is the same whether the
 * presented value is one character or a megabyte. Comparing raw strings with
 * `===` short-circuits at the first differing byte and leaks the secret one
 * character at a time to anyone patient enough to time it.
 */
function presentedSecretMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.*)$/i.exec(header.trim());
  const presented = bearer ? bearer[1].trim() : "";
  return timingSafeEqual(sha256(presented), sha256(secret));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/**
 * How many platforms this fire may start. Null means the caller asked for
 * something that is not a number of platforms, which is refused rather than
 * rounded — a mistyped bound that silently became "all of them" would be the
 * expensive direction of a typo.
 */
function parseSlice(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return 1;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > PLATFORMS.length) return null;
  return value;
}

/**
 * A client that reaches the database as the unattended worker.
 *
 * Null when this deployment has no database or no service-role key, which are
 * different problems with the same answer: there is no lock, so there is no
 * safe run. `persistSession: false` because there is no session and nowhere to
 * put one; `db.schema` because a client that defaults to `public` in a SHARED
 * database is a client pointed at somebody else's project.
 */
function serviceClient(): TenantClient | null {
  const key = supabaseServiceRoleKey();
  if (!isSupabaseConfigured || key === null) return null;
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false },
    db: { schema: DB_SCHEMA },
  }) as TenantClient;
}

/** The words the response will not carry. An operator greps the log for these. */
function logTheWordsThatDoNotTravel(report: ScheduledRunReport): void {
  for (const outcome of report.platforms) {
    if (outcome.status === "run-not-made") {
      console.error(`${LOG_TAG} the run could not be made for ${outcome.platform}:`, outcome.error);
    }
    if (outcome.status === "ran" && outcome.outcome.status === "failed") {
      console.error(`${LOG_TAG} ${outcome.platform} threw while being read:`, outcome.outcome.error);
    }
  }
  if (report.runReport?.persistence.status === "failed") {
    console.error(
      `${LOG_TAG} the pass was read but not stored (${report.runReport.persistence.rows} rows):`,
      report.runReport.persistence.error,
    );
  }
  if (report.proposals.status === "failed") {
    console.error(`${LOG_TAG} seed suggestions were not filed:`, report.proposals.error);
  }
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

interface PlatformLine {
  readonly platform: Platform;
  readonly status: ScheduledPlatformOutcome["status"];
  /** The schedule's own reason for a skip. Absent on a platform that ran. */
  readonly reason?: string;
  /** In-repo prose, written to be read by a person. Never an upstream message. */
  readonly explanation?: string;
  /** The run's verdict for a platform that was read. */
  readonly outcome?: string;
  readonly returned?: number;
  readonly kept?: number;
  /** False when this fire's lock had already lapsed and been taken by another. */
  readonly lockReleased?: boolean;
}

/**
 * The whole report, small enough to read in a log.
 *
 * NOT `report` itself. That object carries every kept `ShortRecord`, which is
 * the inventory and belongs in the database rather than in the body of a cron
 * response — and it carries provider error strings, which are the one thing
 * that may not cross this boundary.
 *
 * `left` is the part a caller acts on: it is the platforms this fire did not
 * start because of `?slice=`, and it is the answer to "should I call again".
 */
function summarise(report: ScheduledRunReport, slice: number) {
  const lines = report.platforms.map(lineFor);
  const left = report.platforms
    .filter((o) => o.status === "skipped" && o.reason === "left-for-the-next-fire")
    .map((o) => o.platform);

  return {
    ok: true,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    slice,
    read: report.platforms.filter((o) => o.status === "ran").map((o) => o.platform),
    left,
    /**
     * TRUE MEANS THERE IS WORK THIS FIRE DID NOT START, not that anything
     * failed. A caller with time may fire again at once; a cron may simply wait
     * for its next tick.
     */
    callAgain: left.length > 0,
    platforms: lines,
    kept: report.runReport?.shorts.length ?? 0,
    /**
     * "not-run" is not "written" and is not "failed". Nothing was read, so
     * there was nothing to store — a zero here would read as a run that saved
     * nothing.
     */
    stored: report.runReport?.persistence.status ?? "not-run",
    /**
     * Only platforms that reported a price appear. A platform missing from this
     * list DID NOT SAY what it cost; it is not free, and nothing may print it
     * as a zero.
     */
    spend: (report.runReport?.spend ?? []).map((row) => ({
      platform: row.platform,
      usdMicros: row.usdMicros,
      note: row.note,
    })),
    proposals: report.proposals,
  };
}

function lineFor(outcome: ScheduledPlatformOutcome): PlatformLine {
  if (outcome.status === "skipped") {
    return {
      platform: outcome.platform,
      status: outcome.status,
      reason: outcome.reason,
      explanation: outcome.explanation,
    };
  }

  if (outcome.status === "run-not-made") {
    return {
      platform: outcome.platform,
      status: outcome.status,
      lockReleased: outcome.lockReleased,
      explanation:
        "This platform was claimed, but the run could not be made at all. The reason is in this " +
        "deployment's server log, tagged [api/cron/run]. Nothing was read.",
    };
  }

  const ran = outcome.outcome;
  const line: PlatformLine = {
    platform: outcome.platform,
    status: outcome.status,
    outcome: ran.status,
    lockReleased: outcome.lockReleased,
  };

  if (ran.status === "ok" || ran.status === "partial") {
    return { ...line, returned: ran.returned, kept: ran.kept };
  }
  if (ran.status === "unavailable" || ran.status === "no-adapter" || ran.status === "not-asked") {
    // The adapter's own sentence, composed in this repo, and the only thing an
    // operator can act on. It is never an empty list dressed up as one.
    //
    // `not-asked` cannot happen on this route as it stands — a scheduled run
    // passes no platform selection, so every platform is asked. It is handled
    // rather than left to fall through to the "it threw" branch below, which is
    // where an unhandled status would have landed and which would have reported
    // a platform nobody asked for as one that broke.
    return { ...line, explanation: ran.reason };
  }
  return {
    ...line,
    explanation:
      "This platform threw while being read. The message is in this deployment's server log, " +
      "tagged [api/cron/run]. This is not a report that the platform is empty.",
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    // A scheduled run's answer is about the moment it was asked. Nothing between
    // the caller and this route may serve a previous fire's report back as this
    // fire's, which would make a run that never happened look like one that did.
    headers: { "cache-control": "no-store", ...headers },
  });
}

function refuse(
  status: number,
  body: { error: string; message: string },
  headers: Record<string, string> = {},
): Response {
  return json(status, { ok: false, ...body }, headers);
}
