/**
 * A RUN THAT FIRES ON A CLOCK INSTEAD OF ON A BUTTON.
 *
 * /admin/shorts is a button because a run is an expensive verb — it spends
 * somebody's API quota and spawns subprocesses against five services. That is
 * the right shape for a person browsing. It is the wrong shape for the thing
 * Erik actually wants, which is the list being fresh when somebody opens it, so
 * this module is the same run with three things a scheduled one needs and an
 * attended one does not: a record of when each platform last ran, a lock so two
 * overlapping fires cannot read the same platform twice, and a floor on how
 * often a platform may be read.
 *
 * WHAT THIS MODULE DELIBERATELY IS NOT: A SCHEDULER.
 *
 * There is no cron expression here, no timer, no `setInterval`, and no HTTP
 * route. `runOnSchedule()` is an ordinary async function that does one pass and
 * returns. Something outside calls it. That is not indecision — Erik has not
 * chosen a host, and the plan already records that quota-paced work will not
 * survive a serverless function, so a scheduler baked in here would be a bet on
 * a decision nobody has made. A plain function can be called by all three
 * candidates:
 *
 *   Vercel Cron        -> a route handler that calls this. WORKS ONLY IF A RUN
 *                         FITS INSIDE THAT DEPLOYMENT'S FUNCTION TIMEOUT. A run
 *                         that is cut off mid-flight leaves its lock held until
 *                         the TTL lapses; nothing is corrupted, but the platform
 *                         sits idle until then and the report is never written.
 *   GitHub Actions     -> a workflow on a `schedule:` trigger running a small
 *                         script that calls this. A job is a process rather than
 *                         a request, so the wall-clock shape of a metered,
 *                         paced run is not fighting the host.
 *   systemd timer      -> the same script on a box somebody owns.
 *
 * WHICH ONE I WOULD PICK, AND WHY: THE GITHUB ACTION.
 *
 * Not because it is the fastest or the cheapest, but because it is the only one
 * of the three that does not require the hosting question to be answered first.
 * The repo is already on GitHub; a scheduled workflow needs no server, no
 * always-on box and no serverless request budget, and it keeps working
 * unchanged whether the app itself later lands on Vercel or on a VPS. Secrets
 * are already a first-class thing there, which matters because an unattended
 * run has no session and must authenticate as something. And the output of a
 * run is a log a person can open, which is exactly what you want the first time
 * a metered platform behaves unexpectedly.
 *
 * The systemd timer is the better answer the day Erik has a box, because a job
 * with no wall-clock ceiling at all is the honest shape for quota-paced work.
 * Vercel Cron is the one I would not pick, for the reason above and already
 * recorded in the plan.
 *
 * THE EXACT CEILINGS ARE UNVERIFIED. No vendor documentation was read for this
 * file, so nothing here quotes a timeout, a minutes allowance or a delivery
 * guarantee. Check each host's own docs before committing; the structural
 * argument above does not depend on the numbers, but a deployment does.
 *
 * SCAR — FOR ONE WHOLE ROUND THIS FUNCTION HAD NO CALLER AT ALL.
 *
 * The paragraphs above describe three hosts that could call `runOnSchedule()`,
 * and a review found that none of them did: no route handler, no script, no
 * `vercel.json`, no workflow, and nothing anywhere reading `CRON_SECRET` — the
 * only mention of that variable in the tree was a paragraph in `.env.example`
 * promising behaviour that did not exist. The suite was green because
 * schedule.test.ts calls this function directly, which proves the pass and says
 * nothing about whether the deployment ever reaches it. That is the bug class:
 * a unit tested through its own front door while the building has no door.
 *
 * `app/api/cron/run/route.ts` is the door. It is deliberately thin — a secret
 * compared in constant time, the three stores, and one call to this function —
 * because everything interesting is here and a second copy of it in a route
 * handler would be a second place for the cadence rules to drift. It bounds a
 * fire to `maxPlatforms` (see `ScheduledRunOptions`) so that a host with a
 * wall-clock ceiling does not start work it cannot finish.
 *
 * SCAR — THE LOCK WAS COMPARED AGAINST THE WORKER'S OWN CLOCK.
 *
 * `SupabaseScheduleStore.claim()` used to send the caller's `now` as the value
 * in `claimable_after <= now` AND as the base for `now + ttl`. Both are the
 * clock of whichever machine happened to fire, so two workers whose clocks
 * disagree — a laptop, a GitHub runner and a serverless region are three
 * different clocks — could both hold one platform:
 *
 *   worker A (correct clock) claims tiktok at 12:00, lock to 12:15
 *   worker B (clock 20 minutes fast) says it is 12:22, so `claimable_after`
 *     (12:15) is in ITS past, the predicate matches, and B claims the same row
 *   both read TikTok; on X the same overlap is billed twice
 *
 * and the reverse skew is worse: a worker 20 minutes SLOW writes a lock that
 * expires before it is taken, so the platform is claimable the instant it is
 * locked. Nothing goes red in either case. The fix is below: every timestamp
 * the gate is compared against or written from is now computed by POSTGRES, and
 * the worker's clock is used for nothing that another worker can see.
 *
 * WHY THE LOCK IS ONE COLUMN AND NOT TWO
 *
 * `platform_schedule.claimable_after` carries both "a run is in flight" and
 * "the last run was too recent", so claiming is a single conditional UPDATE
 * with one predicate. Postgres re-evaluates that predicate against the updated
 * snapshot under a row lock, so of two fires racing on one row exactly one gets
 * a row back. Split across two nullable columns joined by OR, the same claim
 * needs a filter shape that is awkward to express through PostgREST and easy to
 * get subtly wrong — and getting it wrong means double-reading a metered API
 * with nothing going red. The migration has the full reasoning.
 *
 * THE LOCK EXPIRES, AND THE DIRECTION OF THE ERROR IS CHOSEN. A worker that is
 * killed never releases, so a claim also pushes `claimable_after` out by a
 * time-to-live and a later fire may take the row once that passes. Too short and
 * a slow run is overtaken and the platform is read twice; too long and a crashed
 * platform is idle until it lapses. The second is recoverable by pressing the
 * button on /admin/shorts, the first costs money, so the TTL is generous — and
 * `lock_token` means a run whose lock was taken cannot write over the new
 * holder's state when it finally returns.
 */
import type { PlatformAdapter } from "../platform/adapter";
import { buildAdapters } from "../platform/registry";
import { PLATFORMS, platformLabel, type Platform } from "../platform/types";
import type { TenantClient } from "../supabase/config";
import {
  getLatestShorts,
  ran,
  type LatestShortsReport,
  type PlatformOutcome,
} from "./run";
import {
  activeSeedsByPlatform,
  proposeSeedsFrom,
  type SeedStore,
} from "./seeds";
import { activeTopics, TopicsNotInstalledError, type TopicStore } from "./topic-store";
import type { Topic } from "./topics";
import type { ShortsStore } from "./store";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * What the last finished run said about a platform, in the report's OWN words.
 *
 * Four values, mirroring `PlatformOutcome` rather than compressing it. `partial`
 * is the one worth naming: a platform that was read but stopped short — a spend
 * cap, a rate limit — has not had its latest shorts read, and folding it into
 * `ok` would put a green tick on a row whose list is missing an unknown tail.
 * The migration's check constraint carries the same four.
 */
export type LastOutcome = "ok" | "partial" | "unavailable" | "failed";

/** One platform's schedule row. snake_case: it crosses the wire to the database. */
export interface ScheduleRow {
  readonly platform: Platform;
  /** False for every platform until a person turns it on. See the migration. */
  readonly enabled: boolean;
  /** The single claim gate. In the past means claimable now. */
  readonly claimable_after: string;
  /** An operator's floor on cadence. Null means nobody has set one. */
  readonly min_interval_seconds: number | null;
  readonly lock_token: string | null;
  readonly locked_at: string | null;
  readonly lock_expires_at: string | null;
  readonly last_started_at: string | null;
  readonly last_finished_at: string | null;
  readonly last_outcome: LastOutcome | null;
  readonly last_note: string | null;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/**
 * How long a claim is held before any other fire may take it, in seconds.
 *
 * NOT A MEASUREMENT. Nobody has timed a run of this tool against five real
 * platforms, and this number is not pretending otherwise — it is a ceiling
 * chosen in the safe direction (see the header). It is a constant here rather
 * than in lib/config.ts because everything in that file cites a person and a
 * date, and this cites neither. When somebody times a run, it moves and gets a
 * citation.
 */
export const DEFAULT_LOCK_TTL_SECONDS = 900;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  /** This worker's identity for the life of the claim. Release checks it. */
  readonly token: string;
  /**
   * THE CALLER'S CLOCK, AND ONLY A STORE WITH NO CLOCK OF ITS OWN MAY USE IT.
   *
   * `MemoryScheduleStore` uses it, because it is one object in one process and
   * the caller's clock is the only clock there is. `SupabaseScheduleStore`
   * IGNORES IT — a claim it makes is compared against, and stamped from,
   * Postgres' clock, because two workers with skewed clocks reading the same
   * row is precisely the failure the lock exists to stop. See that class.
   *
   * It stays in the port rather than being deleted because the in-memory store
   * needs it and because a test that wants a fixed time must be able to say so.
   */
  readonly now: string;
  readonly ttlSeconds: number;
}

export interface ReleaseRequest {
  /** The row `claim` handed back. Its token and cadence floor are both needed. */
  readonly claimed: ScheduleRow;
  readonly finishedAt: string;
  readonly outcome: LastOutcome;
  readonly note: string | null;
}

export interface ScheduleStore {
  /** Every platform's row. May be missing rows; the caller must say so. */
  readSchedule(): Promise<ScheduleRow[]>;

  /**
   * Take the lock for one platform, or return null.
   *
   * NULL IS NOT AN ERROR. It is the normal answer for a platform that is
   * disabled, still inside its cadence floor, or already held by another fire —
   * which is most platforms on most passes. The caller reads the row it already
   * has to tell those apart for the report; the claim itself does not, because
   * the whole point is that it is one atomic predicate.
   */
  claim(platform: Platform, request: ClaimRequest): Promise<ScheduleRow | null>;

  /**
   * Give the lock back and record what happened.
   *
   * FALSE means the lock was no longer ours — it lapsed and somebody else took
   * it. That is reported, never thrown: the run really happened and its results
   * are real, and losing a lock does not unhappen them.
   */
  release(request: ReleaseRequest): Promise<boolean>;

  setEnabled(platform: Platform, enabled: boolean): Promise<ScheduleRow>;

  /** Null clears the floor: whatever calls the entry point decides the cadence. */
  setMinInterval(platform: Platform, seconds: number | null): Promise<ScheduleRow>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * A real `ScheduleStore` with no database.
 *
 * IT IS NOT A STUB. The claim applies the same one predicate the conditional
 * UPDATE does, and the release applies the same token check, so the tests that
 * prove "two overlapping fires read a platform once" prove it about the rule
 * the SQL implements rather than about a look-alike. What it does not exercise
 * is the atomicity, which is Postgres' and cannot be shown in one process.
 */
export class MemoryScheduleStore implements ScheduleStore {
  private readonly rows = new Map<Platform, ScheduleRow>();

  constructor(rows: readonly Partial<ScheduleRow>[] = []) {
    for (const row of rows) {
      if (row.platform === undefined) continue;
      this.rows.set(row.platform, { ...blankRow(row.platform), ...row });
    }
  }

  /** Every platform, enabled, claimable now. The shape a test usually wants. */
  static enabledForAll(now = new Date(0).toISOString()): MemoryScheduleStore {
    return new MemoryScheduleStore(
      PLATFORMS.map((platform) => ({ platform, enabled: true, claimable_after: now })),
    );
  }

  async readSchedule(): Promise<ScheduleRow[]> {
    return PLATFORMS.map((platform) => this.rows.get(platform)).filter(
      (row): row is ScheduleRow => row !== undefined,
    );
  }

  async claim(platform: Platform, request: ClaimRequest): Promise<ScheduleRow | null> {
    const row = this.rows.get(platform);
    if (!row) return null;
    if (!row.enabled) return null;
    if (row.claimable_after > request.now) return null;

    const expires = addSeconds(request.now, request.ttlSeconds);
    const claimed: ScheduleRow = {
      ...row,
      lock_token: request.token,
      locked_at: request.now,
      lock_expires_at: expires,
      claimable_after: expires,
      last_started_at: request.now,
    };
    this.rows.set(platform, claimed);
    return claimed;
  }

  async release(request: ReleaseRequest): Promise<boolean> {
    const { claimed } = request;
    const row = this.rows.get(claimed.platform);
    if (!row || row.lock_token === null || row.lock_token !== claimed.lock_token) return false;

    this.rows.set(claimed.platform, {
      ...row,
      lock_token: null,
      locked_at: null,
      lock_expires_at: null,
      claimable_after: nextClaimableAfter(request.finishedAt, claimed.min_interval_seconds),
      last_finished_at: request.finishedAt,
      last_outcome: request.outcome,
      last_note: request.note,
    });
    return true;
  }

  async setEnabled(platform: Platform, enabled: boolean): Promise<ScheduleRow> {
    return this.patch(platform, { enabled });
  }

  async setMinInterval(platform: Platform, seconds: number | null): Promise<ScheduleRow> {
    if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 1)) {
      throw new ScheduleError("A cadence floor is a whole number of seconds, one or more, or none at all.");
    }
    return this.patch(platform, { min_interval_seconds: seconds });
  }

  private patch(platform: Platform, fields: Partial<ScheduleRow>): ScheduleRow {
    const row = this.rows.get(platform);
    if (!row) throw new ScheduleError(missingRowMessage(platform));
    const next = { ...row, ...fields };
    this.rows.set(platform, next);
    return next;
  }
}

/** A never-run, disabled row. The state migration 07 inserts. */
export function blankRow(platform: Platform): ScheduleRow {
  return {
    platform,
    enabled: false,
    claimable_after: new Date(0).toISOString(),
    min_interval_seconds: null,
    lock_token: null,
    locked_at: null,
    lock_expires_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_outcome: null,
    last_note: null,
  };
}

// ---------------------------------------------------------------------------
// The Supabase implementation
// ---------------------------------------------------------------------------

export const SCHEDULE_TABLE = "platform_schedule" as const;

/**
 * The value that makes Postgres, and not this process, decide what time it is.
 *
 * `now` is one of Postgres' documented special date/time inputs: converting the
 * string `now` to `timestamptz` yields the current transaction's timestamp. So
 * sending it as a filter value produces `claimable_after <= 'now'` and sending
 * it in an update body produces `claimable_after = 'now'` — in both cases the
 * database's clock, evaluated inside the same statement, identical for every
 * worker that connects to that database no matter what its own clock says.
 *
 * REASONED FROM POSTGRES' INPUT SYNTAX, NOT VERIFIED AGAINST A LIVE POSTGREST.
 * There is no database and no credential on the machine this was written on, so
 * nothing here has been run. What is asserted in the tests is this module's
 * behaviour given a PostgREST that applies the documented coercion; what is NOT
 * asserted is that PostgREST applies it. That is one `pnpm db:roundtrip` away
 * and it is worth doing before trusting an unattended run with a metered API.
 *
 * IF THE COERCION EVER FAILS IT FAILS LOUDLY. PostgREST returns an error for a
 * timestamp it cannot parse, `claim` turns that into a `ScheduleError`, and the
 * pass reports the platform as unread. The failure mode that was NOT acceptable
 * — a lock silently taken against the wrong clock — is the one this replaces.
 */
const DATABASE_CLOCK = "now";

export class SupabaseScheduleStore implements ScheduleStore {
  constructor(private readonly client: TenantClient) {}

  /**
   * No paging here, and it is safe for one specific reason rather than by
   * assumption: this table holds one row per platform and there are five of
   * them, inserted by the migration from the enum itself. It cannot grow past
   * PostgREST's row cap without the platform vocabulary growing past it first,
   * which would be a change to lib/platform/types.ts that nothing here could
   * miss.
   */
  async readSchedule(): Promise<ScheduleRow[]> {
    const { data, error } = await this.client
      .from(SCHEDULE_TABLE)
      .select("*")
      .order("platform", { ascending: true });
    if (error) throw new ScheduleError(`readSchedule: ${error.message}`);
    return (data ?? []) as ScheduleRow[];
  }

  /**
   * A conditional UPDATE against the database's clock, then a second write that
   * sets how long the lock lasts. This is the whole locking mechanism.
   *
   * `eq("enabled", true)` and `lte("claimable_after", 'now')` are evaluated by
   * Postgres against the row it has locked for the update, so two fires racing
   * on the same row cannot both match: the second sees the first's already-moved
   * `claimable_after`. Doing the same check by SELECT-then-UPDATE would be a
   * read-modify-write with a window in the middle wide enough to drive a second
   * cron through.
   *
   * WHY THERE ARE TWO WRITES AND NOT ONE, WHICH IS THE PART THAT LOOKS WRONG
   *
   * The lock needs `claimable_after = <the database's now> + ttl`. PostgREST can
   * send a value and it can send `'now'`, but it cannot send an EXPRESSION —
   * there is no way to write `now() + interval` through it without a SQL
   * function, and adding one is a migration this change does not own. So:
   *
   *   1. The conditional UPDATE claims the row and parks every timestamp on
   *      `'now'`, returning the row — which now carries the database's clock in
   *      `locked_at`, computed by Postgres, exact.
   *   2. A second UPDATE, filtered on `lock_token`, pushes `claimable_after` and
   *      `lock_expires_at` out to that returned time plus the TTL.
   *
   * BETWEEN THEM THE ROW IS CLAIMABLE, AND THAT IS SAFE RATHER THAN LUCKY. If
   * another fire takes the row in that window, step 2 matches nothing, this
   * method returns null, and the platform is reported as locked — which is the
   * truth. The thief holds the only lock and reads the platform once. The
   * alternative shape, parking step 1 on `'infinity'` so nothing could take it,
   * was rejected: a worker killed between the two writes would then pin the
   * platform FOREVER, and a pass claims every platform before it reads any of
   * them, so a crash in this window has read nothing that a second reader could
   * duplicate.
   *
   * `maybeSingle()` and not `single()`: no row is the ordinary outcome, and
   * `single()` turns it into an error that would have to be inspected and
   * un-errored. `request.now` is deliberately unused — see `ClaimRequest.now`.
   */
  async claim(platform: Platform, request: ClaimRequest): Promise<ScheduleRow | null> {
    const { data: taken, error } = await this.client
      .from(SCHEDULE_TABLE)
      .update({
        lock_token: request.token,
        locked_at: DATABASE_CLOCK,
        lock_expires_at: DATABASE_CLOCK,
        claimable_after: DATABASE_CLOCK,
        last_started_at: DATABASE_CLOCK,
      })
      .eq("platform", platform)
      .eq("enabled", true)
      .lte("claimable_after", DATABASE_CLOCK)
      .select()
      .maybeSingle();

    if (error) throw new ScheduleError(`claim ${platform}: ${error.message}`);
    const row = (taken as ScheduleRow | null) ?? null;
    if (!row) return null;

    // The database's answer to "what time is it", read back off the row it just
    // wrote. Checked rather than trusted: if this is not a time, the coercion
    // this file depends on did not happen, and a lock with an unparseable
    // expiry is worse than no lock at all.
    const claimedAt = row.locked_at;
    if (claimedAt === null || Number.isNaN(Date.parse(claimedAt))) {
      throw new ScheduleError(
        `claim ${platform}: the database returned ${JSON.stringify(claimedAt)} as the moment the ` +
          "lock was taken, which is not a time. The claim is held with an expiry it cannot " +
          "compute, so nothing was read.",
      );
    }

    const expires = addSeconds(claimedAt, request.ttlSeconds);
    const { data: held, error: holdError } = await this.client
      .from(SCHEDULE_TABLE)
      .update({ claimable_after: expires, lock_expires_at: expires })
      .eq("platform", platform)
      .eq("lock_token", request.token)
      .select()
      .maybeSingle();

    if (holdError) throw new ScheduleError(`claim ${platform}: ${holdError.message}`);
    // Null means another fire took the row in the window above. Not an error:
    // the other fire is reading the platform and this one must not.
    return (held as ScheduleRow | null) ?? null;
  }

  /**
   * `eq("lock_token", token)` is the part that matters.
   *
   * Without it, a run whose lock lapsed and was taken by a later fire would
   * come back, clear that fire's lock and stamp its own finish time over it —
   * so two runs would read the platform at once and the row would say
   * everything was fine.
   *
   * THE FINISH TIME IS THE DATABASE'S, NOT THE CALLER'S, FOR THE SAME REASON
   * THE CLAIM'S IS. A release writes the gate: with no cadence floor it opens
   * the platform "now", and a worker whose clock is twenty minutes slow would
   * write a `claimable_after` twenty minutes in the past — turning an operator's
   * one-hour floor into a forty-minute one and paying for the difference. So
   * `request.finishedAt` is recorded by the in-memory store and IGNORED here.
   *
   * WITH NO FLOOR THIS IS ONE WRITE. `claimable_after` and `last_finished_at`
   * are both `'now'`, which is exactly `nextClaimableAfter(finishedAt, null)`
   * evaluated on the right clock. A floor needs `now + seconds`, which PostgREST
   * cannot express, so it costs a second write — done while the lock is STILL
   * HELD, so unlike the claim there is no window in which another fire can take
   * the row. A worker killed between the two leaves the lock held until its TTL
   * lapses, which is the recoverable direction.
   */
  async release(request: ReleaseRequest): Promise<boolean> {
    const { claimed } = request;
    if (claimed.lock_token === null) return false;

    const floor = claimed.min_interval_seconds;
    const holdsFloor = floor !== null && floor >= 1;

    if (!holdsFloor) {
      const { data, error } = await this.client
        .from(SCHEDULE_TABLE)
        .update({
          lock_token: null,
          locked_at: null,
          lock_expires_at: null,
          claimable_after: DATABASE_CLOCK,
          last_finished_at: DATABASE_CLOCK,
          last_outcome: request.outcome,
          last_note: request.note,
        })
        .eq("platform", claimed.platform)
        .eq("lock_token", claimed.lock_token)
        .select()
        .maybeSingle();

      if (error) throw new ScheduleError(`release ${claimed.platform}: ${error.message}`);
      return data !== null;
    }

    // Step one: record the finish on the database's clock and read it back. The
    // lock is untouched, so nothing can claim the row while this happens.
    const { data: finished, error: finishError } = await this.client
      .from(SCHEDULE_TABLE)
      .update({
        last_finished_at: DATABASE_CLOCK,
        last_outcome: request.outcome,
        last_note: request.note,
      })
      .eq("platform", claimed.platform)
      .eq("lock_token", claimed.lock_token)
      .select()
      .maybeSingle();

    if (finishError) throw new ScheduleError(`release ${claimed.platform}: ${finishError.message}`);
    const finishedRow = (finished as ScheduleRow | null) ?? null;
    if (!finishedRow) return false;

    const finishedAt = finishedRow.last_finished_at;
    if (finishedAt === null || Number.isNaN(Date.parse(finishedAt))) {
      throw new ScheduleError(
        `release ${claimed.platform}: the database returned ${JSON.stringify(finishedAt)} as the ` +
          "moment the run finished, which is not a time, so this platform's cadence floor cannot " +
          "be applied. The lock is still held and lapses on its own.",
      );
    }

    // Step two: give the lock back, with the floor measured from the database's
    // finish time rather than from whatever this machine believes the time is.
    const { data, error } = await this.client
      .from(SCHEDULE_TABLE)
      .update({
        lock_token: null,
        locked_at: null,
        lock_expires_at: null,
        claimable_after: nextClaimableAfter(finishedAt, floor),
      })
      .eq("platform", claimed.platform)
      .eq("lock_token", claimed.lock_token)
      .select()
      .maybeSingle();

    if (error) throw new ScheduleError(`release ${claimed.platform}: ${error.message}`);
    return data !== null;
  }

  async setEnabled(platform: Platform, enabled: boolean): Promise<ScheduleRow> {
    return this.patch(platform, { enabled });
  }

  async setMinInterval(platform: Platform, seconds: number | null): Promise<ScheduleRow> {
    if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 1)) {
      throw new ScheduleError("A cadence floor is a whole number of seconds, one or more, or none at all.");
    }
    return this.patch(platform, { min_interval_seconds: seconds });
  }

  private async patch(platform: Platform, fields: Partial<ScheduleRow>): Promise<ScheduleRow> {
    const { data, error } = await this.client
      .from(SCHEDULE_TABLE)
      .update(fields)
      .eq("platform", platform)
      .select()
      .maybeSingle();
    if (error) throw new ScheduleError(`update ${platform}: ${error.message}`);
    if (!data) throw new ScheduleError(missingRowMessage(platform));
    return data as ScheduleRow;
  }
}

// ---------------------------------------------------------------------------
// Which store is in play
// ---------------------------------------------------------------------------

export interface ResolvedScheduleStore {
  /** Null when there is no database. A schedule with nowhere to record itself is not one. */
  readonly store: ScheduleStore | null;
  readonly explanation: string;
}

/**
 * There is no environment fallback here, and the asymmetry with seeds is the
 * point.
 *
 * Seeds without a database degrade to a read-only list, which is still a list.
 * A SCHEDULE without a database degrades to nothing at all: no lock, so two
 * fires read every platform twice, and no last-run record, so no fire can tell
 * whether the previous one happened. Both of those are worse than not running,
 * so this refuses instead of pretending.
 */
export async function resolveScheduleStore(options: {
  readonly client?: TenantClient | null;
  readonly databaseConfigured?: boolean;
} = {}): Promise<ResolvedScheduleStore> {
  let configured = options.databaseConfigured;
  if (configured === undefined) {
    const { isSupabaseConfigured } = await import("../supabase/config");
    configured = isSupabaseConfigured;
  }

  if (!configured) {
    return {
      store: null,
      explanation:
        "No database is configured, so nothing can run on a schedule: there is nowhere to hold " +
        "the lock that stops two fires reading a platform at once, and nowhere to record when a " +
        "platform last ran. Use the button on the shorts page until a Supabase project exists.",
    };
  }

  const client =
    options.client ?? (await import("../supabase/server")).createSupabaseAdminClient();
  return {
    store: new SupabaseScheduleStore(client),
    explanation:
      "Schedule state is held in this project's database. Every platform starts disabled and only " +
      "a person turns one on.",
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Why a platform was not read on this pass.
 *
 * `left-for-the-next-fire` is the only one that is not a statement about the
 * platform at all: the pass had already taken as many platforms as it was
 * allowed to start, so it never asked. It is a separate value rather than
 * folded into `too-soon` because they call for opposite actions — one says wait,
 * the other says fire again now.
 */
export type SkipReason =
  | "no-schedule-row"
  | "disabled"
  | "locked"
  | "too-soon"
  | "left-for-the-next-fire";

/**
 * What happened to one platform on one scheduled pass.
 *
 * A discriminated union, for the same reason `PlatformOutcome` is one: a caller
 * that renders an explanation has been made by the compiler to check which kind
 * of thing it is holding.
 */
export type ScheduledPlatformOutcome =
  | {
      readonly platform: Platform;
      readonly status: "ran";
      /** What the run itself said about this platform. */
      readonly outcome: PlatformOutcome;
      /** False when the lock had already lapsed and been taken by another fire. */
      readonly lockReleased: boolean;
    }
  | {
      readonly platform: Platform;
      readonly status: "skipped";
      readonly reason: SkipReason;
      /** One sentence for a person. Rendered as written. */
      readonly explanation: string;
    }
  | {
      readonly platform: Platform;
      readonly status: "run-not-made";
      /** The run threw before any platform was read. This one was claimed and released. */
      readonly error: string;
      readonly lockReleased: boolean;
    };

/** What came of turning this run's handles into cross-platform suggestions. */
export type ProposalOutcome =
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "filed"; readonly proposed: number; readonly written: number }
  | { readonly status: "failed"; readonly error: string };

export interface ScheduledRunReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  /**
   * ONE ENTRY PER PLATFORM, ALWAYS ALL FIVE, IN `PLATFORMS` ORDER. THIS ARRAY IS
   * THE AUTHORITY ON WHY A PLATFORM WAS OR WAS NOT READ — not `runReport`.
   */
  readonly platforms: readonly ScheduledPlatformOutcome[];
  /**
   * The underlying run, or null when nothing was claimed and none was made.
   *
   * READ THIS FOR THE SHORTS, NOT FOR THE REASONS. It was given adapters only
   * for the platforms this pass claimed, so a skipped platform appears in
   * `runReport.platforms` as `no-adapter`. That is literally true of that run —
   * no adapter was passed for it — and it is NOT why it was skipped. The reason
   * is in `platforms` above, and a surface that renders the wrong one will tell
   * an operator that a platform nobody has a reader for is a platform that ran
   * eleven minutes ago.
   */
  readonly runReport: LatestShortsReport | null;
  readonly proposals: ProposalOutcome;
}

/**
 * Builds the adapters for a set of seeds. Injectable so a test needs no yt-dlp.
 *
 * IT MAY RETURN A PROMISE, AND THE REGISTRY'S ONE DOES. Building an adapter now
 * means leasing whatever credential that platform needs, which is a round trip;
 * the awaited return type is what lets this module keep calling the ONE place
 * that knows which adapters exist instead of constructing its own. A test that
 * hands back a plain array still type-checks, which is the point of the union.
 */
export type AdapterFactory = (
  seeds: Record<Platform, readonly string[]>,
) => readonly PlatformAdapter[] | Promise<readonly PlatformAdapter[]>;

/**
 * The subjects this pass will search for.
 *
 * A DEPLOYMENT THAT HAS NOT RUN MIGRATION 14 HAS ZERO TOPICS, not a fault —
 * see `TopicsNotInstalledError`. Any other failure is left to throw, which the
 * caller catches as a run failure and which releases every lock.
 */
async function topicsFor(store: TopicStore | undefined): Promise<readonly Topic[]> {
  if (!store) return [];
  try {
    return activeTopics(await store.listTopics());
  } catch (cause) {
    if (cause instanceof TopicsNotInstalledError) {
      console.warn("[shorts/schedule]", cause.message);
      return [];
    }
    throw cause;
  }
}

export interface ScheduledRunOptions {
  readonly schedule: ScheduleStore;
  readonly seeds: SeedStore;
  /**
   * WHAT KIND OF SHORT THIS PASS IS LOOKING FOR.
   *
   * OPTIONAL, AND ITS ABSENCE IS AN UNTARGETED RUN — the run this module made
   * before topics existed. Optional rather than required because the unattended
   * worker and the tests are two different callers with two different ideas of
   * how much wiring is reasonable, and a required store would have made every
   * existing test construct one to say it wants nothing.
   *
   * A FAILURE TO READ IT STOPS THE PASS, unlike the seed refresh above, and the
   * asymmetry is the point. A stale seed ranking still names real creators, so
   * running on it is worse-but-honest. An unread topic list means running with
   * NO subject, which is not a degraded version of the same question — it is a
   * different question, and its answer is the everything-that-is-big list this
   * deployment stopped wanting on 2026-09-05.
   */
  readonly topics?: TopicStore;
  readonly store: ShortsStore;
  readonly limit: number;
  readonly minViews: number;
  readonly maxDurationSeconds: number;
  /** This fire's identity. Defaults to a fresh UUID. */
  readonly token?: string;
  readonly lockTtlSeconds?: number;
  readonly now?: () => string;
  /**
   * THE MOST PLATFORMS THIS PASS MAY START. Unset means all five.
   *
   * A HOST WITH A WALL-CLOCK CEILING IS THE REASON THIS EXISTS. A serverless
   * function is killed at its timeout with no warning and no chance to finish;
   * `getLatestShorts` stores everything it read in ONE write at the end, so a
   * pass cut off halfway through five platforms loses the results of the ones
   * that had already completed — including, on X, results that were paid for.
   * Reading one platform per fire makes the unit of loss one platform.
   *
   * The platforms this pass does not start are reported as skipped with reason
   * `left-for-the-next-fire`, and they are NOT the same platforms every time:
   * claims are attempted least-recently-claimable first when this is set, so a
   * fire that can only take one platform still gets round all five instead of
   * starving whichever ones sort last in `PLATFORMS`.
   */
  readonly maxPlatforms?: number;
  /**
   * Defaults to the registry, which is the ONE place that knows which adapters
   * exist. Overridden only in tests, and only to avoid spawning yt-dlp.
   */
  readonly adapters?: AdapterFactory;
  /**
   * Turn this run's handles into cross-platform seed suggestions. Default true.
   *
   * Safe to leave on, because a proposal changes nothing: it is a row in a
   * different table that a person has to act on, and the unattended worker has
   * no grant that would let it promote one. Turning it off is for a deployment
   * that does not want the queue at all.
   */
  readonly proposeSeeds?: boolean;
  /** Recorded on every proposal as provenance. */
  readonly proposedBy?: string;
}

/**
 * One scheduled pass: claim what is due, run it, release, report.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN.
 *
 * Claims happen BEFORE the seed list is read and before any adapter is built,
 * so a pass that wins nothing costs one round trip and stops. Releases happen
 * for every platform this pass claimed, INCLUDING when the run itself throws —
 * a lock that is only released on the happy path is a lock that pins a platform
 * for the whole TTL every time something goes wrong, which is exactly when you
 * want the next fire to be able to try.
 *
 * A platform is only stamped as fetched when its outcome is `ok`. An
 * `unavailable` platform was never read, and stamping it would make
 * `last_fetched_ok_at` mean "we tried", which is the reading the column's own
 * documentation spends a paragraph refusing.
 */
export async function runOnSchedule(options: ScheduledRunOptions): Promise<ScheduledRunReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const token = options.token ?? newLockToken();
  const ttlSeconds = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
  const buildFor: AdapterFactory =
    options.adapters ?? (async (seeds) => [...(await buildAdapters({ seeds })).values()]);

  // Validated BEFORE the schedule is read, so a nonsense bound costs no round
  // trip and cannot half-claim anything on its way to being refused.
  const slice = sliceSize(options.maxPlatforms);

  const rows = new Map((await options.schedule.readSchedule()).map((row) => [row.platform, row]));

  const claimed = new Map<Platform, ScheduleRow>();
  const skipped = new Map<Platform, ScheduledPlatformOutcome>();
  const lost: Platform[] = [];

  // Unbounded passes keep the vocabulary's order, so nothing about the existing
  // shape of a full pass changes. A BOUNDED pass tries the platform that has
  // been claimable longest first, because taking the first N of a fixed order
  // means the last of the five is read when the first four are all disabled and
  // never otherwise — starvation that looks exactly like a broken adapter.
  const order =
    options.maxPlatforms === undefined ? [...PLATFORMS] : claimableLongestFirst(rows);

  for (const platform of order) {
    const row = rows.get(platform);
    if (!row) {
      skipped.set(platform, {
        platform,
        status: "skipped",
        reason: "no-schedule-row",
        explanation: missingRowMessage(platform),
      });
      continue;
    }

    if (claimed.size >= slice) {
      skipped.set(platform, {
        platform,
        status: "skipped",
        reason: "left-for-the-next-fire",
        explanation: leftForNextFireMessage(platform, slice),
      });
      continue;
    }

    const won = await options.schedule.claim(platform, { token, now: startedAt, ttlSeconds });
    if (won) {
      claimed.set(platform, won);
      continue;
    }
    lost.push(platform);
  }

  // THE EXPLANATIONS FOR LOST CLAIMS COME FROM A SECOND READ, AND THAT IS A
  // SCAR RATHER THAN A REFINEMENT.
  //
  // The claim itself does not say why it lost — it is one predicate on purpose,
  // because that is what makes it atomic. Building the sentence from the row
  // read at the top of this function was the obvious thing and it was WRONG in
  // the exact case that matters: two fires overlapping. The second fire reads
  // the schedule while the first has not claimed yet (unlocked, claimable),
  // loses the claim a moment later, and then explains the loss from the stale
  // row as "this platform ran too recently" — when the truth is "another run is
  // reading it right now". Those are different problems with different fixes,
  // and the wrong one sends somebody looking at a cadence setting while a run is
  // wedged.
  //
  // The overlap test in schedule.test.ts is what caught it, and it is the case
  // this costs one extra read to get right. Only paid when something was
  // actually lost, which on a healthy schedule is never.
  if (lost.length > 0) {
    let fresh = rows;
    try {
      fresh = new Map((await options.schedule.readSchedule()).map((row) => [row.platform, row]));
    } catch {
      // The re-read is for a better sentence, not for correctness. If it fails,
      // the stale row still produces a true-as-of-a-moment-ago explanation, and
      // losing the whole pass over the wording would be the tail wagging the dog.
    }
    for (const platform of lost) {
      const row = fresh.get(platform) ?? rows.get(platform);
      if (!row) {
        skipped.set(platform, {
          platform,
          status: "skipped",
          reason: "no-schedule-row",
          explanation: missingRowMessage(platform),
        });
        continue;
      }
      skipped.set(platform, { platform, status: "skipped", ...whyNotClaimed(row, startedAt) });
    }
  }

  if (claimed.size === 0) {
    return {
      startedAt,
      finishedAt: now(),
      platforms: PLATFORMS.map((platform) => skipped.get(platform) as ScheduledPlatformOutcome),
      runReport: null,
      proposals: {
        status: "skipped",
        reason: "No platform was claimed on this pass, so there was nothing to observe a handle in.",
      },
    };
  }

  // REFRESH THE AUTOMATIC SEED LIST BEFORE READING IT. Seeds stopped being a
  // manual task on 2026-09-05; they are now the rolling seven-day top 200
  // creators per platform, computed from the rows previous runs stored. The
  // refresh is idempotent and one RPC, so it belongs here — immediately before
  // the read it feeds — rather than behind a scheduler entry of its own that
  // could drift out of step with the run.
  //
  // A FAILED REFRESH IS NOT A FAILED RUN. If the ranking cannot be recomputed,
  // the seed list from the previous refresh is still there and is still the
  // best answer available; refusing to run would turn a stale ranking into no
  // shorts at all. It is logged and the run continues on the existing list.
  try {
    await options.seeds.refreshAutoSeeds();
  } catch (cause) {
    console.error("[shorts/schedule] the automatic seed list could not be refreshed:", cause);
  }

  const seedRows = await options.seeds.listSeeds();
  const adapters = (await buildFor(activeSeedsByPlatform(seedRows))).filter((adapter) =>
    claimed.has(adapter.platform),
  );

  let runReport: LatestShortsReport | null = null;
  let runError: string | null = null;
  try {
    runReport = await getLatestShorts({
      adapters,
      store: options.store,
      limit: options.limit,
      minViews: options.minViews,
      maxDurationSeconds: options.maxDurationSeconds,
      // Read INSIDE the try, so a store that throws is caught by the same
      // handler that catches a structural run failure and every lock below is
      // still released. See the option's comment for why this stops the pass
      // rather than falling back to an untargeted read.
      topics: await topicsFor(options.topics),
    });
  } catch (cause) {
    // Structural only — two adapters claiming one platform, say. A per-platform
    // failure never reaches here; it is inside the report. Caught rather than
    // propagated so every lock below still gets released.
    runError = cause instanceof Error ? cause.message : String(cause);
  }

  const finishedAt = now();
  const outcomeFor = new Map((runReport?.platforms ?? []).map((o) => [o.platform, o]));
  // Not named `ran`: that is the imported narrowing helper from ./run, and
  // shadowing it here is how `ran(outcome)` below would silently become a Map.
  const wasRead = new Map<Platform, ScheduledPlatformOutcome>();

  for (const [platform, row] of claimed) {
    if (runReport === null) {
      const lockReleased = await options.schedule.release({
        claimed: row,
        finishedAt,
        outcome: "failed",
        note: runError,
      });
      wasRead.set(platform, {
        platform,
        status: "run-not-made",
        error: runError ?? "The run could not be made.",
        lockReleased,
      });
      continue;
    }

    const outcome = outcomeFor.get(platform);
    if (!outcome) {
      // Cannot happen: `getLatestShorts` returns one entry for every one of the
      // five platforms. Handled rather than asserted because the alternative is
      // a lock that is never released if it ever does.
      const lockReleased = await options.schedule.release({
        claimed: row,
        finishedAt,
        outcome: "failed",
        note: "The run report carried no entry for this platform.",
      });
      wasRead.set(platform, {
        platform,
        status: "run-not-made",
        error: `The run report carried no entry for ${platformLabel(platform)}.`,
        lockReleased,
      });
      continue;
    }

    if (ran(outcome)) {
      // `ran()` and not `status === "ok"`, which is the literal that would have
      // stopped stamping the moment `partial` was added to the report — a
      // platform read to a spend cap DID ask every one of its seeds, and the
      // column says "we asked". An `unavailable` platform was never reached at
      // all, and stamping that would turn this column into "we tried", which is
      // the reading its own documentation spends a paragraph refusing.
      await options.seeds.noteSeedsFetched(platform, finishedAt);
    }

    const lockReleased = await options.schedule.release({
      claimed: row,
      finishedAt,
      outcome: lastOutcomeOf(outcome),
      note: noteFor(outcome),
    });
    wasRead.set(platform, { platform, status: "ran", outcome, lockReleased });
  }

  return {
    startedAt,
    finishedAt,
    platforms: PLATFORMS.map(
      (platform) =>
        (wasRead.get(platform) ?? skipped.get(platform)) as ScheduledPlatformOutcome,
    ),
    runReport,
    proposals: await fileProposals(options, runReport, seedRows),
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * Turn the handles this run saw into suggestions, and never into seeds.
 *
 * Every failure here is CONTAINED. The suggestions are a convenience on top of
 * a run that has already happened and already stored its shorts; a store that
 * refuses them must not turn a successful scheduled run into a failed one.
 */
async function fileProposals(
  options: ScheduledRunOptions,
  runReport: LatestShortsReport | null,
  seedRows: Awaited<ReturnType<SeedStore["listSeeds"]>>,
): Promise<ProposalOutcome> {
  if (options.proposeSeeds === false) {
    return { status: "skipped", reason: "This run was asked not to make seed suggestions." };
  }
  if (runReport === null || runReport.shorts.length === 0) {
    return {
      status: "skipped",
      reason: "This run kept no shorts, so there was no handle to suggest anything from.",
    };
  }

  try {
    const existingProposals = await options.seeds.listProposals();
    const candidates = proposeSeedsFrom({
      shorts: runReport.shorts,
      existingSeeds: seedRows,
      existingProposals,
      proposedBy: options.proposedBy ?? "schedule",
    });
    if (candidates.length === 0) {
      return {
        status: "filed",
        proposed: 0,
        written: 0,
      };
    }
    const written = await options.seeds.addProposals(candidates);
    return { status: "filed", proposed: candidates.length, written: written.length };
  } catch (cause) {
    return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * How many platforms this pass may start, validated rather than clamped.
 *
 * A clamp would turn `maxPlatforms: 0` — which is what an off-by-one or a
 * mis-parsed query parameter produces — into "read everything", which is the
 * expensive direction. Nothing is guessed at: a number that is not a whole
 * number of platforms is refused and the pass does not happen.
 */
function sliceSize(maxPlatforms: number | undefined): number {
  if (maxPlatforms === undefined) return PLATFORMS.length;
  if (!Number.isSafeInteger(maxPlatforms) || maxPlatforms < 1) {
    throw new ScheduleError(
      `A pass may start a whole number of platforms, one or more. Got ${JSON.stringify(maxPlatforms)}. ` +
        "Nothing was claimed and no platform was read.",
    );
  }
  return Math.min(maxPlatforms, PLATFORMS.length);
}

/**
 * The platforms in the order a bounded pass should try them: the one that has
 * been claimable longest first.
 *
 * `Date.parse` rather than a string comparison, because these values come back
 * from PostgREST in Postgres' rendering (`+00:00`) and are written by this
 * module in JavaScript's (`Z`), and those two do not sort against each other
 * lexicographically. A row with no readable time sorts last, then the
 * vocabulary's order breaks every remaining tie so a pass is reproducible.
 */
function claimableLongestFirst(rows: ReadonlyMap<Platform, ScheduleRow>): Platform[] {
  const at = (platform: Platform): number => {
    const row = rows.get(platform);
    if (!row) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(row.claimable_after);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return [...PLATFORMS].sort((a, b) => at(a) - at(b) || PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b));
}

/** Said about a platform this pass never asked about. Not a verdict on it. */
function leftForNextFireMessage(platform: Platform, slice: number): string {
  return (
    `${platformLabel(platform)} was left for the next fire: this pass was allowed to start ` +
    `${slice} platform${slice === 1 ? "" : "s"} and had already started ${slice === 1 ? "one" : "them"}. ` +
    "Nothing looked, so this says nothing about whether it is due, and it is safe to fire again " +
    "immediately — a bounded pass tries the platforms that have been claimable longest first, so " +
    "the ones left here are the ones the next fire reaches for."
  );
}

/**
 * Why a claim lost, worked out from the row this pass read a moment earlier.
 *
 * A LOCK AND A CADENCE FLOOR LOOK THE SAME TO THE CLAIM — both are
 * `claimable_after` in the future — and they mean very different things to a
 * person: one is "something is running right now", the other is "it ran
 * recently enough". Telling them apart is what `lock_token` is for on the read
 * side, and it is the only reason this function is not one line.
 */
function whyNotClaimed(
  row: ScheduleRow,
  now: string,
): { reason: SkipReason; explanation: string } {
  const label = platformLabel(row.platform);

  if (!row.enabled) {
    return {
      reason: "disabled",
      explanation:
        `${label} is not on a schedule. Every platform starts off, and a person turns it on — ` +
        "some of these APIs bill per read, so nothing enables itself.",
    };
  }

  if (row.lock_token !== null) {
    return {
      reason: "locked",
      explanation:
        `Another run already holds ${label}${row.locked_at ? ` — it took it at ${row.locked_at}` : ""}. ` +
        "This pass left it alone rather than reading the platform twice. If that run has died, the " +
        `lock lapses on its own${row.lock_expires_at ? ` at ${row.lock_expires_at}` : ""}.`,
    };
  }

  return {
    reason: "too-soon",
    explanation:
      `${label} ran too recently to run again: it may next be read at ${row.claimable_after}, and ` +
      `it is ${now}. The floor is this platform's own ` +
      (row.min_interval_seconds === null
        ? "— no floor is set, so this is the tail of the previous run's lock."
        : `${row.min_interval_seconds} seconds.`),
  };
}

/** The report's five outcomes, narrowed to the four a schedule row records. */
function lastOutcomeOf(outcome: PlatformOutcome): LastOutcome {
  if (outcome.status === "ok") return "ok";
  if (outcome.status === "partial") return "partial";
  if (outcome.status === "unavailable") return "unavailable";
  // `failed` and `no-adapter` both record as failed. A claimed platform that
  // came back `no-adapter` means the registry did not build one for a platform
  // this pass had just locked, which is a fault in this process and not a
  // statement about the platform — the very confusion `no-adapter` exists to
  // prevent, so it is not recorded as an ordinary outcome.
  return "failed";
}

/** The one line the schedule row keeps about the last run. Never a whole error. */
function noteFor(outcome: PlatformOutcome): string | null {
  if (outcome.status === "ok") {
    return `Kept ${outcome.kept} of ${outcome.returned} returned.`;
  }
  if (outcome.status === "partial") {
    // The truncation sentence comes FIRST, because the counts after it are the
    // half of the story that looks fine. A row reading "Kept 12 of 40" with the
    // reason it stopped tucked behind them is a row nobody reads to the end.
    return `${outcome.truncation.message} Kept ${outcome.kept} of ${outcome.returned} returned.`;
  }
  if (outcome.status === "unavailable") return outcome.reason;
  if (outcome.status === "failed") return outcome.error;
  return outcome.reason;
}

/**
 * A claim's identity.
 *
 * A UUID and not a counter: two fires on two machines would issue the same
 * counter value and each would then be able to release the other's lock, which
 * is the one failure the token exists to stop.
 */
function newLockToken(): string {
  return globalThis.crypto.randomUUID();
}

/** ISO time, `seconds` later. Rejects a nonsense TTL rather than producing one. */
export function addSeconds(iso: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new ScheduleError(
      `A lock lasts a whole number of seconds, one or more. Got ${JSON.stringify(seconds)}. ` +
        "A zero or negative time-to-live is a lock that is already expired when it is taken, so " +
        "every fire would claim every platform at once.",
    );
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new ScheduleError(`Not a time: ${JSON.stringify(iso)}.`);
  return new Date(at + seconds * 1000).toISOString();
}

/**
 * When a platform may next be claimed after a run finishes.
 *
 * A null floor means "the moment it finished" — whatever calls the entry point
 * decides the cadence, which is what a cron expression already is. It is NOT
 * treated as some default number of minutes, because a default here would be
 * this file inventing an operator's decision and hiding it where nobody looks.
 */
export function nextClaimableAfter(finishedAt: string, minIntervalSeconds: number | null): string {
  if (minIntervalSeconds === null || minIntervalSeconds < 1) return finishedAt;
  return addSeconds(finishedAt, minIntervalSeconds);
}

function missingRowMessage(platform: Platform): string {
  return (
    `${platformLabel(platform)} has no row in the schedule table, so it cannot be scheduled and ` +
    "was not read. Migration 20260901_07 inserts one row per platform from the platform enum; a " +
    "platform added to the vocabulary afterwards needs a row of its own. This is not a statement " +
    `about ${platformLabel(platform)} — nothing looked.`
  );
}
