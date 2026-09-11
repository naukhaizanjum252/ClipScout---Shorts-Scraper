/**
 * The quota measurement harness. Plan l35-shorts-scraper-2026-004, Phase 0.
 *
 *   pnpm exec tsx verify/quota.ts --selftest    offline arithmetic, no key, no network
 *   pnpm exec tsx verify/quota.ts --check       recompute the report; non-zero on mismatch
 *   pnpm exec tsx verify/quota.ts --probe       one real call of each operation (needs a key)
 *   pnpm exec tsx verify/quota.ts --calibrate <op>   spend that BUCKET's day to measure one cost
 *   pnpm exec tsx verify/quota.ts --calibrate search.list --allowance <units> --source "..."
 *   pnpm exec tsx verify/quota.ts --observe <op>=<units> --source "..."   record a console readback
 *   pnpm exec tsx verify/quota.ts               re-derive the report from the recording
 *
 * WHY THIS EXISTS
 *
 * The whole design of this tool rests on one claim: that finding channels with
 * `search.list` is the constrained path and walking a known channel's uploads is
 * not. That claim has a shape as well as a size. `search.list` is billed to a
 * bucket of its own and rationed by CALLS — a published default of 100 a day,
 * which no amount of unit budget extends — while the uploads walk draws on the
 * project's shared unit allowance at 1 unit per 50 videos. Both figures come
 * from Google's documentation (lib/yt/cost.ts cites the page and the date), which
 * is a statement about the API in general and not a measurement of the project we
 * bill. Phase 0's job is to replace the claims with observations, and then to
 * make the observations impossible to hand-edit — `--check` recomputes the report
 * from the recording and exits non-zero on any difference, exactly as
 * `manhwa-tool/apps/watcher/verify/image-cost.ts` does for image spend.
 *
 * SCAR, 2026-09-04. This header used to say the design rested on `search.list`
 * costing "about 100x" an uploads page, and the report's headline figure was that
 * ratio. Google prices all four operations at 1 unit; search is scarce, not
 * expensive. Read literally, the old reasoning would have had this harness go
 * green on a measured ratio of 1 — the correct number for the wrong quantity —
 * while the real ceiling, a hundred calls in a separate bucket, went unmeasured
 * and unmentioned. What changed today is the DECLARED figure and the shape of the
 * recording, and NOTHING ELSE. Nothing has been measured, there is still no key,
 * and the API still reports no units-consumed figure. This file is exactly as red
 * and as inert as it was yesterday, and must not be read as though it now knows
 * something it did not.
 *
 * WHAT IT WILL NOT DO
 *
 * Write a plausible number. The API does not report what a call cost, so
 * `observedUnits` can only come from a calibration burn or a console readback,
 * and the recording says which. Until one of those has happened the fixture does
 * not exist and `--check --strict` is RED. That red is the honest state of the
 * project, not a broken test.
 *
 * IT IS INERT ON THE KEYLESS PATH
 *
 * The default source adapter is `ytdlp`, which spends no quota, needs no key and
 * bills nobody. Quota accounting is meaningless there, so `--check` reports
 * INERT and exits 0 unless `SOURCE_ADAPTER=api` or `--strict` is passed. That is
 * stated out loud on every run rather than silently skipped, because "the check
 * passed" and "the check did not apply" must never look the same.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sourceAdapterName } from "../lib/config";
import { resolveCredentialStore } from "../lib/credentials/resolve";
import { scrub } from "../lib/credentials/mask";
import {
  RECORDING_SCHEMA,
  emptyDailyQuota,
  emptyRecording,
  parseRecording,
  renderReport,
  serialise,
  type BucketAllowance,
  type Observation,
  type ObservationMethod,
  type ProbeEvidence,
  type Recording,
} from "../lib/quota/recording";
import {
  OPERATIONS,
  QUOTA_BUCKETS,
  bucketOf,
  bucketSpec,
  declaredUnits,
  isOperation,
  type Operation,
  type QuotaBucket,
} from "../lib/yt/cost";
import { QuotaExceededError, YouTubeClient, type CallRecord } from "../lib/yt/client";

const DEFAULT_DIR = path.resolve(import.meta.dirname, "fixtures");

export function quotaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QUOTA_DIR?.trim();
  return override ? path.resolve(override) : DEFAULT_DIR;
}

export const recordingPath = (dir: string) => path.join(dir, "quota.json");
export const reportPath = (dir: string) => path.join(dir, "quota-report.json");

// --------------------------------------------------------------- file helpers

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function loadRecording(dir: string): Recording | null {
  const raw = readJson(recordingPath(dir));
  return raw === null ? null : parseRecording(raw);
}

export function writeReport(dir: string, rec: Recording): string {
  const body = serialise(renderReport(rec));
  writeAtomic(reportPath(dir), body);
  return body;
}

/**
 * Merge one observation into the recording on disk, creating it if absent.
 *
 * `dailyQuota` is merged PER BUCKET rather than replaced wholesale. A run that
 * measures the search ration must not blank out a general allowance somebody
 * read off the console last week — they are separate facts about separate
 * accounts, and losing one silently would null out half the report's capacity.
 */
export function mergeObservation(
  dir: string,
  patch: Pick<Observation, "operation" | "observedUnits" | "method" | "source" | "measuredAt"> & {
    probes?: readonly ProbeEvidence[];
  },
  meta: Partial<Pick<Recording, "method" | "credential">> & {
    dailyQuota?: Partial<Record<QuotaBucket, BucketAllowance>>;
  } = {},
): Recording {
  const existing = loadRecording(dir);
  const base = existing ?? emptyRecording(meta.method ?? "unrecorded");
  const observations = base.observations.map((o) =>
    o.operation !== patch.operation
      ? o
      : {
          ...o,
          observedUnits: patch.observedUnits,
          method: patch.method,
          source: patch.source,
          measuredAt: patch.measuredAt,
          probes: patch.probes ?? o.probes,
        },
  );
  const dailyQuota = emptyDailyQuota();
  for (const bucket of QUOTA_BUCKETS) {
    dailyQuota[bucket] = meta.dailyQuota?.[bucket] ?? base.dailyQuota[bucket];
  }
  const next: Recording = {
    schema: RECORDING_SCHEMA,
    method: meta.method ?? base.method,
    credential: meta.credential ?? base.credential,
    dailyQuota,
    observations,
  };
  writeAtomic(recordingPath(dir), serialise(next));
  writeReport(dir, next);
  return next;
}

// ------------------------------------------------------------------- --check

export interface CheckOutcome {
  readonly ok: boolean;
  readonly inert: boolean;
  readonly problems: readonly string[];
}

export function check(dir: string, opts: { strict: boolean; adapter: string }): CheckOutcome {
  if (!opts.strict && opts.adapter !== "api") {
    return {
      ok: true,
      inert: true,
      problems: [
        `SOURCE_ADAPTER=${opts.adapter} — the keyless path spends no API quota, so there is nothing to check.`,
        "Run with --strict, or set SOURCE_ADAPTER=api, to require a real measurement.",
      ],
    };
  }

  const problems: string[] = [];
  let rec: Recording | null = null;
  try {
    rec = loadRecording(dir);
  } catch (cause) {
    problems.push(`recording is malformed: ${(cause as Error).message}`);
  }

  if (!rec) {
    if (problems.length === 0) {
      problems.push(
        `no recording at ${recordingPath(dir)} — nothing has been measured. ` +
          "Run `--probe` with a key, then `--calibrate <op>` or `--observe <op>=<units>`.",
      );
    }
    return { ok: false, inert: false, problems };
  }

  const expected = serialise(renderReport(rec));
  const onDisk = (() => {
    try {
      return fs.readFileSync(reportPath(dir), "utf8");
    } catch {
      return null;
    }
  })();

  if (onDisk === null) {
    problems.push(`no report at ${reportPath(dir)} — run the script with no flags to derive one.`);
  } else if (onDisk !== expected) {
    // The whole point of the check. Either somebody edited the report, or the
    // arithmetic changed and nobody re-derived it. Both are the same failure.
    problems.push(
      `${reportPath(dir)} does not match what the recording produces. ` +
        "Either a figure was hand-edited, or the arithmetic changed and the report is stale. " +
        "Re-derive it by running this script with no flags — and look at the diff first.",
    );
  }

  const report = renderReport(rec);
  for (const line of report.unresolved) problems.push(line);

  return { ok: problems.length === 0, inert: false, problems };
}

// ---------------------------------------------------------------- --selftest

/**
 * Invariants that hold with no key, no network and no recording.
 *
 * These are the checks that make the harness itself trustworthy, and they must
 * pass on a clean checkout — which is the state this repo is in today.
 */
export async function selftest(): Promise<void> {
  const failures: string[] = [];
  const check_ = (name: string, fn: () => boolean | void) => {
    try {
      const r = fn();
      if (r === false) failures.push(name);
    } catch (cause) {
      failures.push(`${name} — threw: ${(cause as Error).message}`);
    }
  };

  check_("every operation has a declared cost", () => OPERATIONS.every((op) => declaredUnits(op) > 0));

  check_("every operation names the bucket it is billed to", () =>
    OPERATIONS.every((op) => QUOTA_BUCKETS.includes(bucketOf(op))),
  );

  check_("search.list is rationed in a bucket of its own, and the seeded walk is not", () => {
    // The constraint the whole seeded/autonomous split now rests on. A unit
    // price alone stopped expressing it on 2026-09-04; this is what replaced it.
    const searchBucket = bucketOf("search.list");
    const seededBucket = bucketOf("playlistItems.list");
    return (
      searchBucket !== seededBucket &&
      bucketSpec(searchBucket).declaredDailyCalls !== null &&
      // The shared pool's ceiling is the operator's own allowance, and this repo
      // holds no default for it. Null here is the honest answer, not a gap.
      bucketSpec(seededBucket).declaredDailyCalls === null &&
      bucketOf("videos.list") === seededBucket
    );
  });

  check_("the report of an empty recording is incomplete", () => {
    const r = renderReport(emptyRecording("selftest"));
    return r.complete === false && r.rows.every((row) => row.observedUnits === null);
  });

  check_("an empty recording resolves nothing and says so, once per operation plus once per bucket", () => {
    const r = renderReport(emptyRecording("selftest"));
    return r.unresolved.length === OPERATIONS.length + QUOTA_BUCKETS.length;
  });

  check_("capacity is null when nothing has been measured", () => {
    const c = renderReport(emptyRecording("selftest")).capacity;
    return (
      c.seededVideosPerDay === null &&
      c.searchCallsPerDay === null &&
      c.searchCandidatesPerDay === null &&
      c.seededReachMultiple === null
    );
  });

  check_("rendering is pure — same recording, same bytes", () => {
    const rec = emptyRecording("selftest");
    return serialise(renderReport(rec)) === serialise(renderReport(rec));
  });

  check_("an observation without a method is refused", () => {
    const rec = emptyRecording("selftest");
    const bad = {
      ...rec,
      observations: rec.observations.map((o) =>
        o.operation === "search.list" ? { ...o, observedUnits: 100 } : o,
      ),
    };
    try {
      parseRecording(JSON.parse(JSON.stringify(bad)));
      return false; // should have thrown
    } catch {
      return true;
    }
  });

  check_("an observation without a source is refused", () => {
    const rec = emptyRecording("selftest");
    const bad = {
      ...rec,
      observations: rec.observations.map((o) =>
        o.operation === "search.list"
          ? { ...o, observedUnits: 100, method: "console-readback", measuredAt: "1970-01-01" }
          : o,
      ),
    };
    try {
      parseRecording(JSON.parse(JSON.stringify(bad)));
      return false;
    } catch {
      return true;
    }
  });

  check_("a recording with no credential block is refused", () => {
    const rec = JSON.parse(JSON.stringify(emptyRecording("selftest"))) as Record<string, unknown>;
    delete rec.credential;
    try {
      parseRecording(rec);
      return false;
    } catch {
      return true;
    }
  });

  check_("a schema-1 recording is refused rather than half-read", () => {
    // Schema 1 carried one `dailyQuota`, from before search.list was known to
    // draw on a bucket of its own. Reading it here would leave both bucket
    // allowances null and the report silently empty of capacity.
    const rec = JSON.parse(JSON.stringify(emptyRecording("selftest"))) as Record<string, unknown>;
    rec.schema = 1;
    rec.dailyQuota = { units: 1234, source: "selftest — the old single-allowance shape" };
    try {
      parseRecording(rec);
      return false;
    } catch {
      return true;
    }
  });

  // The end-to-end behaviour of --check, in a throwaway directory, with a
  // synthetic recording that is explicitly labelled as synthetic. Nothing here
  // is written into verify/fixtures and nothing here is a measurement.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-selftest-"));
  try {
    check_("--check fails with no recording", () => {
      const outcome = check(dir, { strict: true, adapter: "api" });
      return outcome.ok === false && outcome.inert === false;
    });

    check_("--check is inert, and says so, on the keyless path", () => {
      const outcome = check(dir, { strict: false, adapter: "ytdlp" });
      return outcome.ok === true && outcome.inert === true;
    });

    const synthetic: Recording = {
      schema: RECORDING_SCHEMA,
      method: "SELFTEST FIXTURE — synthetic, not a measurement of anything",
      credential: { id: "selftest", label: "selftest" },
      // Two accounts, two arbitrary numbers, both deliberately implausible so
      // neither can be mistaken for a real allowance if it ever leaks into prose.
      dailyQuota: {
        general: { units: 1234, source: "selftest — an arbitrary number, deliberately not a plausible allowance" },
        search: { units: 8, source: "selftest — an arbitrary ration, deliberately not a plausible one" },
      },
      observations: OPERATIONS.map((operation) => ({
        operation,
        declaredUnits: declaredUnits(operation),
        bucket: bucketOf(operation),
        observedUnits: declaredUnits(operation),
        method: "console-readback" as ObservationMethod,
        source: "selftest — arbitrary, not a real measurement",
        measuredAt: "1970-01-01",
        probes: [],
      })),
    };
    writeAtomic(recordingPath(dir), serialise(synthetic));
    writeReport(dir, synthetic);

    check_("--check passes over a complete recording", () => check(dir, { strict: true, adapter: "api" }).ok);

    check_("hand-editing the report makes --check fail", () => {
      const file = reportPath(dir);
      const original = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, original.replace('"observedUnits": 1,', '"observedUnits": 7,'));
      const failed = check(dir, { strict: true, adapter: "api" }).ok === false;
      fs.writeFileSync(file, original);
      const restored = check(dir, { strict: true, adapter: "api" }).ok === true;
      return failed && restored;
    });

    check_("each capacity figure is divided into ITS OWN bucket's allowance", () => {
      const r = renderReport(synthetic);
      // general: 1234 units / (1 playlistItems + 1 videos) * 50 videos = 30850
      // search:  8 units / 1 per search = 8 calls, at 50 results each = 400
      // and the reach multiple is 30850 / 400.
      return (
        r.capacity.seededVideosPerDay === 30850 &&
        r.capacity.searchCallsPerDay === 8 &&
        r.capacity.searchCandidatesPerDay === 400 &&
        r.capacity.seededReachMultiple === 77.125
      );
    });

    check_("the general allowance cannot buy a single extra search", () => {
      // The failure the old units-only model could not express: a huge unit pool
      // beside an exhausted search ration changes nothing about discovery.
      const rich: Recording = {
        ...synthetic,
        dailyQuota: {
          ...synthetic.dailyQuota,
          general: { units: 999_999, source: "selftest — arbitrary, deliberately absurd" },
        },
      };
      const r = renderReport(rich);
      return (
        r.capacity.searchCallsPerDay === 8 &&
        r.capacity.searchCandidatesPerDay === 400 &&
        (r.capacity.seededVideosPerDay ?? 0) > 400
      );
    });

    check_("an unmeasured search ration is called out on its own, not covered by the unit allowance", () => {
      const halfKnown: Recording = {
        ...synthetic,
        dailyQuota: { ...synthetic.dailyQuota, search: { units: null, source: null } },
      };
      const r = renderReport(halfKnown);
      return (
        r.capacity.searchCallsPerDay === null &&
        r.capacity.searchCandidatesPerDay === null &&
        r.capacity.seededVideosPerDay !== null &&
        r.unresolved.some((u) => u.startsWith("search bucket allowance: unknown"))
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(`selftest failed:\n  - ${failures.join("\n  - ")}`);
  }
}

// ------------------------------------------------------------------- --probe

/** The cheapest real call of each operation that still exercises it properly. */
const PROBE_PARAMS: Record<Operation, Record<string, string | number>> = {
  // A channel that has existed since 2005 and is not going anywhere, used only
  // as a stable target so a probe is reproducible.
  "channels.list": { part: "id", id: "UCBR8-60-B28hp2BmDPdntcQ", maxResults: 1 },
  "playlistItems.list": { part: "contentDetails", playlistId: "UUBR8-60-B28hp2BmDPdntcQ", maxResults: 1 },
  "videos.list": { part: "id", chart: "mostPopular", maxResults: 1 },
  "search.list": { part: "id", type: "video", q: "shorts", maxResults: 1 },
};

function toEvidence(c: CallRecord): ProbeEvidence {
  return {
    at: c.at,
    status: c.status,
    reason: c.reason,
    items: c.items,
    totalResults: c.totalResults,
    hasNextPage: c.hasNextPage,
    durationMs: c.durationMs,
    paramNames: c.paramNames,
  };
}

async function probe(dir: string): Promise<number> {
  const { store, origin, explanation } = await resolveCredentialStore();
  const lease = store ? await store.lease("youtube") : null;
  if (!lease) {
    console.error(`No YouTube credential available (${origin}). ${explanation}`);
    console.error(
      "Phase 0's measurement needs a key. Save one on /admin/credentials, or for local work put " +
        "one in .env.local as YOUTUBE_API_KEY. Nothing in this repo contains a key value.",
    );
    return 2;
  }

  const client = new YouTubeClient({ apiKey: lease.secret });
  for (const op of OPERATIONS) {
    try {
      await client.call(op, PROBE_PARAMS[op]);
      console.log(`  ${op.padEnd(20)} ok`);
    } catch (cause) {
      console.log(`  ${op.padEnd(20)} FAILED — ${scrub(String((cause as Error).message), lease.secret)}`);
      if (cause instanceof QuotaExceededError) {
        console.error("  quota is already exhausted for today; stopping.");
        break;
      }
    }
  }

  const byOp = new Map<Operation, ProbeEvidence[]>();
  for (const c of client.calls) {
    const list = byOp.get(c.operation) ?? [];
    list.push(toEvidence(c));
    byOp.set(c.operation, list);
  }

  let rec = loadRecording(dir) ?? emptyRecording("probe only — costs claimed, not yet observed");
  for (const op of OPERATIONS) {
    rec = mergeObservation(
      dir,
      {
        operation: op,
        // STILL NULL. A probe proves the call was made; it does not reveal what
        // it cost, because the API does not say. Filling this in needs
        // `--calibrate` or `--observe`.
        observedUnits: rec.observations.find((o) => o.operation === op)?.observedUnits ?? null,
        method: rec.observations.find((o) => o.operation === op)?.method ?? null,
        source: rec.observations.find((o) => o.operation === op)?.source ?? null,
        measuredAt: rec.observations.find((o) => o.operation === op)?.measuredAt ?? null,
        probes: byOp.get(op) ?? [],
      },
      { credential: { id: lease.credentialId, label: lease.label } },
    );
  }
  await store?.noteUse(lease.credentialId);

  console.log(`\nEvidence written to ${recordingPath(dir)}.`);
  console.log(
    "observedUnits is still null for every operation, and that is correct: a probe proves the call\n" +
      "happened, not what it cost. The API reports no units-consumed figure. Fill the costs in with\n" +
      "  --calibrate <op>            (spends that BUCKET's day; divides its allowance by calls made)\n" +
      "  --observe <op>=<units> --source '<console url>'   (a Cloud console readback)\n" +
      "Both bucket allowances are still unread, and search.list's is not the unit allowance — it is a\n" +
      "separate ration in a separate account, and no capacity figure is honest until it is read.",
  );
  return 0;
}

// --------------------------------------------------------------- --calibrate

/**
 * Measure one operation's cost by exhausting ITS BUCKET'S quota with it.
 *
 * DESTRUCTIVE, and gated behind an explicit flag. It is also the only method
 * that needs nothing but a key: call the operation until 403 quotaExceeded, then
 * divide that bucket's daily allowance by the number of calls that succeeded.
 *
 * WHICH allowance is the whole difficulty, and getting it wrong would produce a
 * confident wrong number rather than an error. `search.list` is billed to its own
 * bucket, so dividing the project's configured UNIT allowance by a count of
 * search calls measures nothing at all — the burn would stop at the search
 * ration with the unit pool barely touched. lib/config holds one figure, the unit
 * allowance, so a search-bucket calibration must be handed its bucket's ceiling
 * explicitly with `--allowance <units> --source "<where you read it>"`. This repo
 * still assumes no allowance of its own, for either bucket.
 */
async function calibrate(
  dir: string,
  op: Operation,
  confirmed: boolean,
  override: { units: number | null; source: string | null },
): Promise<number> {
  if (!confirmed) {
    console.error(
      `Calibrating ${op} SPENDS THE WHOLE DAY'S ${bucketOf(op).toUpperCase()} BUDGET on that ` +
        "credential's project, on purpose.\n" +
        "Re-run with --i-understand-this-spends-the-days-quota if that is what you want.",
    );
    return 2;
  }

  const { store } = await resolveCredentialStore();
  const lease = store ? await store.lease("youtube") : null;
  if (!lease) {
    console.error("No YouTube credential available. Nothing to calibrate.");
    return 2;
  }

  const bucket = bucketOf(op);
  let allowance: number;
  let allowanceSource: string;
  if (override.units !== null) {
    if (!override.source) {
      console.error(
        "--allowance needs --source: where that ceiling was read from. A ceiling nobody can " +
          "re-check makes every figure divided by it unverifiable.",
      );
      return 2;
    }
    allowance = override.units;
    allowanceSource = override.source;
  } else if (bucket !== "general") {
    console.error(
      `${op} is billed to the "${bucket}" bucket: ${bucketSpec(bucket).meters}\n` +
        "The configured YOUTUBE_DAILY_QUOTA_UNITS is the UNIT pool's allowance and says nothing " +
        `about this one, so calibrating ${op} against it would divide by the wrong number.\n` +
        "Read this bucket's ceiling off Google Cloud console -> APIs & Services -> YouTube Data " +
        "API v3 -> Quotas and pass it: --allowance <units> --source \"<url, date>\".",
    );
    return 2;
  } else {
    const { requireDailyQuotaUnits } = await import("../lib/config");
    try {
      allowance = requireDailyQuotaUnits();
    } catch (cause) {
      console.error((cause as Error).message);
      return 2;
    }
    allowanceSource = "operator-configured (credential daily_quota_units or YOUTUBE_DAILY_QUOTA_UNITS)";
  }

  const client = new YouTubeClient({ apiKey: lease.secret });
  let succeeded = 0;
  const started = new Date().toISOString();
  try {
    // Bounded so a misconfigured allowance cannot loop forever. Reaching the
    // bound means the calibration did NOT complete, and it is recorded as such.
    for (let i = 0; i < allowance + 1; i++) {
      await client.call(op, PROBE_PARAMS[op]);
      succeeded++;
    }
    console.error(
      `Made ${succeeded} calls without hitting quotaExceeded. The allowance figure is wrong, or ` +
        "this operation is cheaper than the allowance suggests. Nothing recorded.",
    );
    return 1;
  } catch (cause) {
    if (!(cause instanceof QuotaExceededError)) {
      console.error(`Calibration aborted: ${scrub(String((cause as Error).message), lease.secret)}`);
      return 1;
    }
  }

  if (succeeded === 0) {
    console.error("Quota was already exhausted before calibration started. Nothing recorded.");
    return 1;
  }

  const observed = allowance / succeeded;
  mergeObservation(
    dir,
    {
      operation: op,
      observedUnits: observed,
      method: "calibration-burn",
      source:
        `${succeeded} successful ${op} calls before 403 quotaExceeded, against a daily allowance of ` +
        `${allowance} units for the "${bucket}" bucket (${allowanceSource}). ` +
        `${allowance} / ${succeeded} = ${observed}.`,
      measuredAt: started.slice(0, 10),
    },
    {
      credential: { id: lease.credentialId, label: lease.label },
      // Only this bucket's allowance is asserted. The other one is a separate
      // fact about a separate account and is left exactly as it was found.
      dailyQuota: { [bucket]: { units: allowance, source: allowanceSource } },
    },
  );
  console.log(
    `${op}: observed ${observed} units/call in the "${bucket}" bucket ` +
      `(${succeeded} calls before quotaExceeded).`,
  );
  return 0;
}

// ----------------------------------------------------------------- --observe

function observe(dir: string, spec: string, source: string | null): number {
  const [rawOp, rawUnits] = spec.split("=");
  if (!rawOp || !rawUnits || !isOperation(rawOp)) {
    console.error(`--observe expects <operation>=<units>, one of: ${OPERATIONS.join(", ")}`);
    return 2;
  }
  const units = Number(rawUnits);
  if (!Number.isFinite(units) || units <= 0) {
    console.error(`--observe: ${JSON.stringify(rawUnits)} is not a positive number of units.`);
    return 2;
  }
  if (!source) {
    console.error(
      "--observe needs --source: where the figure was read from, e.g. the Cloud console quota page URL " +
        "and the batch of calls it was measured over. A measurement nobody can re-check is not a measurement.",
    );
    return 2;
  }
  mergeObservation(dir, {
    operation: rawOp,
    observedUnits: units,
    method: "console-readback",
    source,
    measuredAt: new Date().toISOString().slice(0, 10),
  });
  console.log(`${rawOp}: recorded ${units} units/call (console readback).`);
  return 0;
}

// --------------------------------------------------------------------- main

function flagValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const dir = quotaDir();

  if (argv.includes("--selftest")) {
    await selftest();
    console.log("quota selftest: all checks passed (no API key used, no network touched).");
    return 0;
  }

  if (argv.includes("--probe")) return probe(dir);

  const calibrateOp = flagValue(argv, "--calibrate");
  if (calibrateOp !== null) {
    if (!isOperation(calibrateOp)) {
      console.error(`--calibrate expects one of: ${OPERATIONS.join(", ")}`);
      return 2;
    }
    const rawAllowance = flagValue(argv, "--allowance");
    let allowance: number | null = null;
    if (rawAllowance !== null) {
      allowance = Number(rawAllowance);
      if (!Number.isFinite(allowance) || allowance <= 0) {
        console.error(`--allowance: ${JSON.stringify(rawAllowance)} is not a positive number of units.`);
        return 2;
      }
    }
    return calibrate(dir, calibrateOp, argv.includes("--i-understand-this-spends-the-days-quota"), {
      units: allowance,
      source: flagValue(argv, "--source"),
    });
  }

  const observeSpec = flagValue(argv, "--observe");
  if (observeSpec !== null) return observe(dir, observeSpec, flagValue(argv, "--source"));

  if (argv.includes("--check")) {
    const adapter = sourceAdapterName();
    const outcome = check(dir, { strict: argv.includes("--strict"), adapter });
    if (outcome.inert) {
      console.log("quota check: INERT — not applicable to the selected source.");
      for (const p of outcome.problems) console.log(`  ${p}`);
      return 0;
    }
    if (outcome.ok) {
      console.log("quota check: OK — the report recomputes from the recording, and nothing is unmeasured.");
      return 0;
    }
    console.error("quota check: FAILED");
    for (const p of outcome.problems) console.error(`  - ${p}`);
    return 1;
  }

  // No flags: re-derive the report from the recording.
  const rec = loadRecording(dir);
  if (!rec) {
    console.error(
      `No recording at ${recordingPath(dir)}. Nothing has been measured yet — that is the honest\n` +
        "state of this project, not a bug. See --probe / --calibrate / --observe above.",
    );
    return 1;
  }
  writeReport(dir, rec);
  console.log(`Report re-derived from the recording -> ${reportPath(dir)}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(import.meta.filename).toLowerCase();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (cause) => {
      console.error(String((cause as Error).stack ?? cause));
      process.exit(1);
    },
  );
}
