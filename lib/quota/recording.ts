/**
 * The quota RECORDING and the report derived from it.
 *
 * Stolen wholesale from `manhwa-tool/apps/watcher/verify/image-cost.ts`, which
 * solved this problem once: a number a client will be quoted must not be
 * hand-editable and must not go stale when the arithmetic under it changes. So
 * there are two files and one direction of travel —
 *
 *   verify/fixtures/quota.json         the RECORDING. Observations only.
 *   verify/fixtures/quota-report.json  the REPORT. Derived, byte-for-byte, from
 *                                      the recording by `renderReport` below.
 *
 * `verify/quota.ts --check` recomputes the report from the recording and exits
 * non-zero on any difference. Edit a figure in the report and the check goes
 * red; change the arithmetic without re-deriving and the check goes red.
 *
 * WHAT COUNTS AS AN OBSERVATION, AND WHAT DOES NOT
 *
 * The Data API does not tell you what a call cost. There is no units-consumed
 * header, no field in the body, nothing. So `observedUnits` can only be filled
 * by one of two methods, and the recording says which one was used:
 *
 *   calibration-burn   Issue the same operation until the API returns 403
 *                      quotaExceeded, then divide THAT BUCKET'S daily allowance
 *                      by the number of calls that succeeded. Destructive — it
 *                      spends the day.
 *   console-readback   Issue a known batch, then read the consumed-units figure
 *                      off the Google Cloud console's quota page and record it
 *                      with the URL it was read from.
 *
 * Anything else is a guess, and a guessed unit cost is worse than no unit cost,
 * because it will be quoted in a client meeting as though somebody had checked.
 * `observedUnits` is therefore `null` until one of the two above has happened,
 * and `--check` treats a `null` as a failure and says so in as many words.
 *
 * ---------------------------------------------------------------------------
 * SCAR, 2026-09-04 — schema 1 -> 2, and why the interesting figure changed.
 *
 * WHAT WAS WRONG. Schema 1 carried ONE `dailyQuota` and the report's headline
 * capacity figure was `searchToSeededRatio`: observed search cost over observed
 * playlistItems cost, described in this file as "the 100x, measured". Both of
 * those follow from a cost table that priced `search.list` at 100 units. It does
 * not: all four operations cost 1 unit, and `search.list` is rationed by CALLS
 * in a bucket of its own (lib/yt/cost.ts carries the correction and the source).
 *
 * WHAT IT WOULD HAVE CAUSED. Two failures, and the second is the dangerous one.
 * A ratio of observed unit costs would now measure 1 — a true number that reads
 * as "the two paths cost the same", when in fact one of them is capped at a few
 * thousand candidates a day and the other is not. And one `dailyQuota` cannot
 * describe two independent accounts: whichever bucket it was filled from, every
 * capacity figure derived from it would silently be about the wrong one. A
 * report is written to be quoted, so a wrong figure here leaves the building.
 *
 * WHAT STOPS IT NOW. `dailyQuota` is per bucket and both entries must be present
 * before anything is derived, the report states the ration alongside the unit
 * cost, and the ratio is now `seededReachMultiple` — how much further the seeded
 * path reaches in a day than the whole search ration can. The schema version
 * moved with the shape, and `parseRecording` refuses a schema-1 file outright
 * rather than reading its `dailyQuota` as a bucket map that happens to parse.
 */
import {
  DECLARED_SOURCE_READ_ON,
  DECLARED_SOURCE_URL,
  OPERATIONS,
  QUOTA_BUCKETS,
  bucketOf,
  bucketSpec,
  declaredDailyCallCeiling,
  declaredUnits,
  maxPageSize,
  type Operation,
  type QuotaBucket,
} from "../yt/cost";

/**
 * Bumped from 1 the day the shape changed. A recording is read by a script that
 * will happily do arithmetic on whatever it finds, so an old file must be
 * REFUSED rather than reinterpreted — see `parseRecording`.
 */
export const RECORDING_SCHEMA = 2 as const;

/** How an `observedUnits` figure was arrived at. Never optional, never absent. */
export type ObservationMethod = "calibration-burn" | "console-readback";

export interface Observation {
  readonly operation: Operation;
  /** What our cost table claims. Copied in so the recording stands alone. */
  readonly declaredUnits: number;
  /** Which account this operation is billed to. Copied in for the same reason. */
  readonly bucket: QuotaBucket;
  /** What was actually measured, or null if nothing has been. */
  readonly observedUnits: number | null;
  /** Null exactly when `observedUnits` is null. */
  readonly method: ObservationMethod | null;
  /**
   * Where the figure came from, in one line a human can check: the console URL,
   * or the burn's call count and the allowance it was divided by.
   */
  readonly source: string | null;
  /** ISO date of the measurement, or null. */
  readonly measuredAt: string | null;
  /**
   * Evidence that the operation was really exercised against the live API:
   * status, item counts and timings from `YouTubeClient`'s ledger. Present as
   * soon as `--probe` has run, even while `observedUnits` is still null. No
   * candidate without evidence — the `twitch-faceless` rule.
   */
  readonly probes: readonly ProbeEvidence[];
}

/** One real request, reduced to what is safe to commit. Never any parameter values. */
export interface ProbeEvidence {
  readonly at: string;
  readonly status: number;
  readonly reason: string | null;
  readonly items: number | null;
  readonly totalResults: number | null;
  readonly hasNextPage: boolean;
  readonly durationMs: number;
  readonly paramNames: readonly string[];
}

/**
 * WHOSE quota was measured.
 *
 * Quota is per Google Cloud project, and every operator brings their own key,
 * so a measurement is only ever a fact about ONE credential. Recording it
 * without saying whose would produce a number that reads as global and is not.
 *
 * Identity only — an id and a human label. The secret never enters a recording,
 * a report, a log line or an error message; see lib/credentials/mask.ts.
 */
export interface RecordingCredential {
  /** `api_credentials.id`, or null when the measurement predates the store. */
  readonly id: string | null;
  /** The operator-supplied label, e.g. "Lucky35 shared project". Never the key. */
  readonly label: string | null;
}

/**
 * One bucket's daily ceiling FOR THIS CREDENTIAL'S PROJECT, and where the figure
 * came from. Null until somebody reads it off the console — there is no default
 * anywhere in this repo (lib/config.ts:dailyQuotaUnits).
 *
 * Two buckets, two allowances, and they do not substitute for one another. The
 * search bucket's is stated in units so the arithmetic is uniform; because a
 * search costs one unit, that figure is also its call ceiling.
 */
export interface BucketAllowance {
  readonly units: number | null;
  readonly source: string | null;
}

export interface Recording {
  readonly schema: typeof RECORDING_SCHEMA;
  /** One line saying how this recording was produced. */
  readonly method: string;
  /** Which credential this measurement is about. */
  readonly credential: RecordingCredential;
  /** One entry per bucket. Both keys always present, values null until read. */
  readonly dailyQuota: Readonly<Record<QuotaBucket, BucketAllowance>>;
  readonly observations: readonly Observation[];
}

// ----------------------------------------------------------------- the report

export interface ReportRow {
  readonly operation: Operation;
  readonly declaredUnits: number;
  /** Which account it is billed to. Recomputed from the cost table, never trusted. */
  readonly bucket: QuotaBucket;
  /**
   * Calls a day the bucket declares, or null where the ceiling is the project's
   * own unit allowance. This is the ration, and it sits beside the unit price
   * because the unit price alone stopped describing the constraint.
   */
  readonly declaredDailyCalls: number | null;
  readonly observedUnits: number | null;
  /** true/false when measured, null when not. A false here invalidates the design. */
  readonly declarationHolds: boolean | null;
  readonly method: ObservationMethod | null;
  readonly source: string | null;
  readonly measuredAt: string | null;
  readonly probeCount: number;
}

export interface BucketReport {
  readonly bucket: QuotaBucket;
  /** From the cost table: the published per-method call ceiling, or null. */
  readonly declaredDailyCalls: number | null;
  /** From the recording: what this project's console says, or null. */
  readonly allowanceUnits: number | null;
  readonly allowanceSource: string | null;
}

export interface QuotaReport {
  readonly schema: typeof RECORDING_SCHEMA;
  readonly method: string;
  /** Whose key this report is about. A report is never a global statement. */
  readonly credential: RecordingCredential;
  readonly rows: readonly ReportRow[];
  /** True only when every operation is measured AND every declaration held. */
  readonly complete: boolean;
  /** One row per bucket, because a day has two ceilings and neither pays the other. */
  readonly buckets: readonly BucketReport[];
  /**
   * What a day buys, computed from OBSERVED costs only. Every field is null
   * until both the relevant bucket allowance and the relevant observed costs
   * exist.
   */
  readonly capacity: {
    /** Videos enumerable per day down the cheap path (playlistItems + videos). */
    readonly seededVideosPerDay: number | null;
    /** `search.list` calls affordable in a day, out of the search bucket alone. */
    readonly searchCallsPerDay: number | null;
    /** Those calls at a full page each: the most discovery can surface in a day. */
    readonly searchCandidatesPerDay: number | null;
    /**
     * seeded reach / search reach. The successor to the old "100x": not a price
     * ratio any more, but how many times further the seeded path gets in a day
     * than the entire search ration does.
     */
    readonly seededReachMultiple: number | null;
  };
  /** Everything still unknown, in plain words. Empty only when nothing is. */
  readonly unresolved: readonly string[];
}

/** Why an unmeasured bucket allowance matters, said once per bucket. */
const BUCKET_UNRESOLVED: Readonly<Record<QuotaBucket, string>> = Object.freeze({
  general:
    "general bucket allowance: unknown. Nobody has read the daily unit allowance off the Google " +
    "Cloud console for the project we bill, and this repo refuses to assume one " +
    "(lib/config.ts:dailyQuotaUnits).",
  search:
    "search bucket allowance: unknown. search.list is billed to a bucket of its own and is rationed " +
    "by calls, not priced by units, so the general allowance says nothing about it and cannot be " +
    "spent on it. Until this ceiling is read off the console, no discovery capacity figure is honest.",
});

/** An empty recording — what a fresh repo has, and what `--probe` fills in. */
export function emptyRecording(method: string, credential: RecordingCredential = { id: null, label: null }): Recording {
  return {
    schema: RECORDING_SCHEMA,
    method,
    credential,
    dailyQuota: emptyDailyQuota(),
    observations: OPERATIONS.map((operation) => ({
      operation,
      declaredUnits: declaredUnits(operation),
      bucket: bucketOf(operation),
      observedUnits: null,
      method: null,
      source: null,
      measuredAt: null,
      probes: [],
    })),
  };
}

/** Both buckets present, both unknown. The only honest starting point. */
export function emptyDailyQuota(): Record<QuotaBucket, BucketAllowance> {
  const out = {} as Record<QuotaBucket, BucketAllowance>;
  for (const bucket of QUOTA_BUCKETS) out[bucket] = { units: null, source: null };
  return out;
}

/**
 * The report, as a pure function of the recording.
 *
 * PURE. No clock, no environment, no filesystem. `--check` re-runs this and
 * compares bytes, so anything non-deterministic in here would make the check
 * fail forever for the wrong reason.
 */
export function renderReport(rec: Recording): QuotaReport {
  const byOp = new Map(rec.observations.map((o) => [o.operation, o]));

  const rows: ReportRow[] = OPERATIONS.map((operation) => {
    const o = byOp.get(operation);
    // Always recomputed from the live cost table, never trusted from the file.
    // That is what makes a hand-edited declaration fail the check.
    const declared = declaredUnits(operation);
    const bucket = bucketOf(operation);
    const dailyCalls = declaredDailyCallCeiling(operation);
    if (!o) {
      return {
        operation,
        declaredUnits: declared,
        bucket,
        declaredDailyCalls: dailyCalls,
        observedUnits: null,
        declarationHolds: null,
        method: null,
        source: null,
        measuredAt: null,
        probeCount: 0,
      };
    }
    return {
      operation,
      declaredUnits: declared,
      bucket,
      declaredDailyCalls: dailyCalls,
      observedUnits: o.observedUnits,
      declarationHolds: o.observedUnits === null ? null : o.observedUnits === declared,
      method: o.observedUnits === null ? null : o.method,
      source: o.observedUnits === null ? null : o.source,
      measuredAt: o.observedUnits === null ? null : o.measuredAt,
      probeCount: o.probes.length,
    };
  });

  const buckets: BucketReport[] = QUOTA_BUCKETS.map((bucket) => ({
    bucket,
    declaredDailyCalls: bucketSpec(bucket).declaredDailyCalls,
    allowanceUnits: rec.dailyQuota[bucket]?.units ?? null,
    allowanceSource: rec.dailyQuota[bucket]?.source ?? null,
  }));

  const observed = (op: Operation): number | null =>
    rows.find((r) => r.operation === op)?.observedUnits ?? null;
  const allowance = (bucket: QuotaBucket): number | null => rec.dailyQuota[bucket]?.units ?? null;

  const search = observed("search.list");
  const playlist = observed("playlistItems.list");
  const videos = observed("videos.list");

  // The seeded walk and the search are billed to different accounts, so each
  // capacity figure is divided into ITS OWN bucket's allowance. Crossing them
  // was the bug that made a single `dailyQuota` unsafe.
  const seededPer50 = playlist !== null && videos !== null ? playlist + videos : null;
  const seededAllowance = allowance(bucketOf("playlistItems.list"));
  const searchAllowance = allowance(bucketOf("search.list"));

  const seededVideosPerDay =
    seededAllowance !== null && seededPer50 !== null && seededPer50 > 0
      ? Math.floor((seededAllowance / seededPer50) * maxPageSize("playlistItems.list"))
      : null;
  const searchCallsPerDay =
    searchAllowance !== null && search !== null && search > 0 ? Math.floor(searchAllowance / search) : null;
  const searchCandidatesPerDay =
    searchCallsPerDay === null ? null : searchCallsPerDay * maxPageSize("search.list");

  const capacity = {
    seededVideosPerDay,
    searchCallsPerDay,
    searchCandidatesPerDay,
    seededReachMultiple:
      seededVideosPerDay !== null && searchCandidatesPerDay !== null && searchCandidatesPerDay > 0
        ? round4(seededVideosPerDay / searchCandidatesPerDay)
        : null,
  };

  const unresolved: string[] = [];
  for (const row of rows) {
    if (row.observedUnits === null) {
      unresolved.push(
        `${row.operation}: no observed unit cost. Declared ${row.declaredUnits} units/call ` +
          `(documentation — ${DECLARED_SOURCE_URL}, read ${DECLARED_SOURCE_READ_ON}), ` +
          "never measured against this project.",
      );
    } else if (row.declarationHolds === false) {
      unresolved.push(
        `${row.operation}: declared ${row.declaredUnits} units but observed ${row.observedUnits}. ` +
          "The cost table is wrong and every capacity figure derived from it is too.",
      );
    }
  }
  for (const bucket of QUOTA_BUCKETS) {
    if (allowance(bucket) === null) unresolved.push(BUCKET_UNRESOLVED[bucket]);
  }

  return {
    schema: RECORDING_SCHEMA,
    method: rec.method,
    credential: rec.credential,
    rows,
    complete: rows.every((r) => r.declarationHolds === true),
    buckets,
    capacity,
    unresolved,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Canonical serialisation. Both halves of `--check` must format identically. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ------------------------------------------------------------------ validation

export class RecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingError";
  }
}

/**
 * Parse a recording off disk, refusing anything malformed.
 *
 * Deliberately strict about two things. An `observedUnits` without a `method`
 * and a `source` is not an observation, it is a number somebody typed. And a
 * recording written under an older schema is refused outright: a schema-1 file
 * carries `dailyQuota: { units, source }`, which would read here as a bucket map
 * with neither bucket present — every allowance silently null, or worse, one
 * bucket's figure quietly standing in for the other's.
 */
export function parseRecording(raw: unknown): Recording {
  if (typeof raw !== "object" || raw === null) throw new RecordingError("recording is not an object");
  const r = raw as Partial<Recording> & { dailyQuota?: unknown };
  if (r.schema !== RECORDING_SCHEMA) {
    const extra =
      r.schema === 1
        ? " Schema 1 held a single `dailyQuota`, from before search.list was known to draw on a " +
          "separate bucket with its own ceiling. Re-measure; do not hand-migrate the file."
        : "";
    throw new RecordingError(
      `unsupported recording schema ${String(r.schema)} (expected ${RECORDING_SCHEMA}).${extra}`,
    );
  }
  if (typeof r.method !== "string" || !r.method.trim()) {
    throw new RecordingError("recording has no `method` — how it was produced must be stated");
  }
  if (typeof r.credential !== "object" || r.credential === null) {
    throw new RecordingError(
      "recording has no `credential` block — quota is per Google Cloud project, so a " +
        "measurement that does not say whose key it was taken with is not a measurement",
    );
  }
  if (!Array.isArray(r.observations)) throw new RecordingError("recording has no `observations` array");

  const dailyQuota = parseDailyQuota(r.dailyQuota);
  const observations = r.observations.map((o) => parseObservation(o));
  const seen = new Set(observations.map((o) => o.operation));
  for (const op of OPERATIONS) {
    if (!seen.has(op)) throw new RecordingError(`recording is missing an entry for ${op}`);
  }
  return {
    schema: RECORDING_SCHEMA,
    method: r.method,
    credential: {
      id: stringOrNull(r.credential.id, "credential.id"),
      label: stringOrNull(r.credential.label, "credential.label"),
    },
    dailyQuota,
    observations,
  };
}

function parseDailyQuota(raw: unknown): Record<QuotaBucket, BucketAllowance> {
  if (typeof raw !== "object" || raw === null) {
    throw new RecordingError("recording has no `dailyQuota` block");
  }
  const asRecord = raw as Record<string, unknown>;
  if ("units" in asRecord || "source" in asRecord) {
    throw new RecordingError(
      "`dailyQuota` looks like the schema-1 single-allowance shape. A day has two independent " +
        `ceilings (${QUOTA_BUCKETS.join(", ")}) and one figure cannot describe both.`,
    );
  }
  const out = {} as Record<QuotaBucket, BucketAllowance>;
  for (const bucket of QUOTA_BUCKETS) {
    const entry = asRecord[bucket];
    if (typeof entry !== "object" || entry === null) {
      throw new RecordingError(
        `dailyQuota.${bucket} is missing — every bucket must appear, even with a null allowance, ` +
          "so an unmeasured ceiling is visibly unmeasured rather than absent.",
      );
    }
    const e = entry as Record<string, unknown>;
    out[bucket] = {
      units: numberOrNull(e.units, `dailyQuota.${bucket}.units`),
      source: stringOrNull(e.source, `dailyQuota.${bucket}.source`),
    };
    if (out[bucket].units !== null && !out[bucket].source) {
      throw new RecordingError(
        `dailyQuota.${bucket}.units is set but source is empty. An allowance nobody can re-check ` +
          "is not an allowance, and every capacity figure in the report divides by it.",
      );
    }
  }
  return out;
}

function parseObservation(raw: unknown): Observation {
  if (typeof raw !== "object" || raw === null) throw new RecordingError("observation is not an object");
  const o = raw as Partial<Observation>;
  const operation = o.operation;
  if (typeof operation !== "string" || !(OPERATIONS as readonly string[]).includes(operation)) {
    throw new RecordingError(`observation names an unknown operation: ${String(operation)}`);
  }
  const observedUnits = numberOrNull(o.observedUnits, `${operation}.observedUnits`);
  const method = stringOrNull(o.method, `${operation}.method`);
  const source = stringOrNull(o.source, `${operation}.source`);
  const measuredAt = stringOrNull(o.measuredAt, `${operation}.measuredAt`);

  if (observedUnits !== null) {
    if (observedUnits <= 0) throw new RecordingError(`${operation}: observedUnits must be positive`);
    if (method !== "calibration-burn" && method !== "console-readback") {
      throw new RecordingError(
        `${operation}: observedUnits is set but method is ${JSON.stringify(method)}. ` +
          "An observation must say how it was measured — 'calibration-burn' or 'console-readback'.",
      );
    }
    if (!source) {
      throw new RecordingError(
        `${operation}: observedUnits is set but source is empty. ` +
          "A measurement nobody can re-check is not a measurement.",
      );
    }
    if (!measuredAt) throw new RecordingError(`${operation}: observedUnits is set but measuredAt is empty`);
  }

  return {
    operation: operation as Operation,
    declaredUnits: declaredUnits(operation as Operation),
    bucket: bucketOf(operation as Operation),
    observedUnits,
    method: observedUnits === null ? null : (method as ObservationMethod),
    source,
    measuredAt,
    probes: Array.isArray(o.probes) ? (o.probes as ProbeEvidence[]) : [],
  };
}

function numberOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RecordingError(`${what} is not a number`);
  return v;
}

function stringOrNull(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new RecordingError(`${what} is not a string`);
  const t = v.trim();
  return t ? t : null;
}
