/**
 * The last run, kept so the screen survives a reload.
 *
 * Erik, 2026-09-05: *"The run should not disappear after a while."* Nothing was
 * expiring it. `LatestShortsReport` lived in React state on /admin/shorts and
 * nowhere else, so it went with the component — a refresh, a walk to
 * /admin/credentials and back, or a restored tab put the operator in front of
 * "Nothing has been fetched yet", which is the page's sentence for NO RUN HAS
 * HAPPENED, minutes after one had. An absence rendered as a result is the one
 * failure this product exists to avoid, so the report is now written down.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT GOES IN WHOLE, AND COMES BACK WHOLE OR NOT AT ALL
 * ---------------------------------------------------------------------------
 *
 * No columns are made out of it and no view model is built from it. The honesty
 * rule on this product is enforced by a TYPE — `PlatformOutcome` is a
 * discriminated union, so a `no-adapter` outcome carries no row count and
 * printing one does not compile — and every unpack-and-rebuild is a chance to
 * flatten that into a status string beside some nullable integers, which is
 * precisely the shape the union exists to forbid. So: `JSON` in, `JSON` out,
 * and `parseStoredReport` below re-establishes the union before anything
 * renders it.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROW THAT DOES NOT PARSE IS DROPPED RATHER THAN PATCHED
 * ---------------------------------------------------------------------------
 *
 * `LatestShortsReport` has grown twice already — `unverified` and `spend` both
 * arrived after it was first written — and it will grow again. A row stored
 * before a field existed is still a report, and the type says so: those fields
 * are optional for exactly this reason, and their absence reads as "nothing was
 * said", which every consumer already handles in the safe direction.
 *
 * What is NOT tolerated is a row whose platform outcomes do not answer to the
 * union. A blob with `status: "ok"` and no `dropped` would render a page of
 * `undefined`s, or worse, a zero — and a zero next to "dropped under the
 * threshold" is a claim about the internet. So the check below is structural
 * and it fails closed: a report that cannot be trusted whole is not shown at
 * all, and the page falls back to its honest empty state.
 *
 * ---------------------------------------------------------------------------
 * IT IS BOUNDED, AND THE BOUND IS NOT A TIDY-UP
 * ---------------------------------------------------------------------------
 *
 * A full run is five platforms of fifty rows plus the unverified ones — on the
 * order of 150KB of JSON — and this tool lives in a Supabase project shared
 * with the account's other work (Erik, 2026-09-02), where storage is a cost
 * with nobody's name on it. Left alone, a button forty people press would grow
 * this table without limit for the sake of one row anybody ever reads.
 *
 * So a write trims to `KEPT_REPORTS`. That is a DELETE, in a repo whose
 * evidence tables deliberately have no DELETE policy at all, and the difference
 * is what is being deleted: `runs` and `run_platforms` are the record of what
 * each platform said, and this is a copy of a screen. Nothing here is the only
 * home of a fact — which is also why a failed trim is logged and swallowed
 * rather than failing the write. The newest report being stored matters; the
 * two-hundredth-oldest being gone does not.
 */
import type { TenantClient } from "../supabase/config";
import type { LatestShortsReport, PlatformOutcome } from "./run";
import { ShortsStoreError } from "./store";

/** The one table this module touches. */
export const RUN_REPORTS_TABLE = "run_reports" as const;

/**
 * How many stored reports survive a write.
 *
 * TWO HUNDRED, and both directions were costed. Only the newest is ever read,
 * so one would do for the feature — and one would mean that the moment anybody
 * pressed the button, every earlier screen in the deployment was gone, with no
 * way to answer "what did this look like on Tuesday" while `runs` and
 * `run_platforms` still have no writer. Two hundred is roughly 30MB at the
 * worst case above, which is bounded, cheap, and far more history than a tool
 * one small team presses a button on will ever be asked for.
 */
export const KEPT_REPORTS = 200;

/**
 * A stored run, on its way back to the screen.
 *
 * `savedAt` is separate from anything inside `report` ON PURPOSE. The report's
 * own `startedAt` is when the platforms were read; this is when the row was
 * written, and it is what the page prints to say how old the thing in front of
 * the operator is. Quoting a timestamp from inside a document to explain the
 * age of the document is the sort of thing that is right until the day it is
 * not, and this figure sits next to a list somebody might act on.
 */
export interface StoredRun {
  /** ISO 8601, from the database. */
  readonly savedAt: string;
  readonly report: LatestShortsReport;
}

/**
 * Reading and writing the last run. Two methods, both allowed to fail.
 *
 * A port rather than the Supabase class directly, so that the deployment with
 * no database has something to be — see `NoReportStore` in the shorts actions —
 * and so the tests beside this file can drive the parsing without a server.
 */
export interface RunReportStore {
  /** Write one report and trim the table. Throws `ShortsStoreError` on failure. */
  saveReport(report: LatestShortsReport): Promise<void>;
  /**
   * The most recently saved run, or null when there is not one.
   *
   * NULL MEANS "NOTHING TO SHOW", AND IT MEANS ONLY THAT. A row that failed to
   * parse is also null, because a half-trusted report is not a report — but a
   * caller may not turn either into a sentence about what the platforms
   * contain. The page's empty state is a statement about this deployment's
   * history, not about the internet, and that is the only claim null supports.
   */
  latestReport(): Promise<StoredRun | null>;
}

// ---------------------------------------------------------------------------
// Parsing back
// ---------------------------------------------------------------------------

/**
 * Every `status` the union admits. Kept as a literal set rather than derived,
 * because deriving it would need a value that does not exist — the union is a
 * type — and a hand-written list that goes stale fails CLOSED here: an outcome
 * with a status this does not know is rejected, so the page shows its empty
 * state rather than a section it has no branch for.
 */
const OUTCOME_STATUSES = new Set([
  "ok",
  "partial",
  "unavailable",
  "failed",
  "no-adapter",
  "not-asked",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether one platform outcome carries the fields its own branch promises.
 *
 * THE POINT IS THE PER-BRANCH CHECK, not the presence of `status`. `ok` and
 * `partial` are the two that a page prints numbers for, so they are the two
 * whose numbers are verified — a stored `ok` with no `dropped` would render
 * either `undefined` or, after one well-meaning `?? 0`, a zero beside the words
 * "dropped under the threshold", which is a claim about what a platform
 * published, invented by a parser.
 *
 * The other four carry a sentence and no arithmetic, so a sentence is what is
 * checked. `no-adapter` and `not-asked` are the same shape and are still listed
 * separately, because they are separate answers and folding them here is how
 * they would come to be folded elsewhere.
 */
function isPlatformOutcome(value: unknown): value is PlatformOutcome {
  if (!isObject(value)) return false;
  if (typeof value.platform !== "string") return false;
  if (typeof value.status !== "string" || !OUTCOME_STATUSES.has(value.status)) return false;

  switch (value.status) {
    case "ok":
    case "partial":
      return (
        typeof value.description === "string" &&
        typeof value.returned === "number" &&
        typeof value.kept === "number" &&
        typeof value.duplicates === "number" &&
        isObject(value.dropped) &&
        Array.isArray(value.shorts) &&
        // `partial` IS the truncation branch — an outcome that says it stopped
        // early and cannot say what stopped it is the one that would render as
        // a complete read with a missing caveat.
        (value.status === "ok" || isObject(value.truncation))
      );
    case "unavailable":
      return typeof value.description === "string" && typeof value.reason === "string";
    case "failed":
      return typeof value.description === "string" && typeof value.error === "string";
    case "no-adapter":
    case "not-asked":
      return typeof value.reason === "string";
    default:
      return false;
  }
}

/**
 * A stored blob as a report, or null.
 *
 * ONLY THE FIELDS A PAGE CANNOT RENDER WITHOUT ARE REQUIRED. `unverified` and
 * `spend` are optional on the type because a report stored before they existed
 * is still a report, and their absence already reads as "nothing was said"
 * everywhere they are consumed — see `unverifiedTotal` and `spentUsdMicros` in
 * the shorts view module, both of which coalesce rather than assert. Requiring
 * them here would throw away last week's runs to enforce a field nobody needs.
 *
 * `platforms` is checked ELEMENT BY ELEMENT rather than as "an array". That is
 * the check that matters: the array is what the screen loops over, and one bad
 * entry in it is one section of the page rendering a shape it has no branch
 * for. All or nothing.
 */
export function parseStoredReport(value: unknown): LatestShortsReport | null {
  if (!isObject(value)) return null;
  if (typeof value.startedAt !== "string" || typeof value.finishedAt !== "string") return null;
  // THE FOUR FILTERS, ALL REQUIRED, because every one of them is a control the
  // console puts back — a missing number seeds an input with the string
  // "undefined" — and, more importantly, all four are printed as the terms the
  // list underneath was gathered on. A report that cannot say what floor it
  // applied is a list that cannot be read.
  if (
    typeof value.minViews !== "number" ||
    typeof value.minDurationSeconds !== "number" ||
    typeof value.maxDurationSeconds !== "number" ||
    typeof value.limit !== "number"
  ) {
    return null;
  }
  // THE SUBJECT, WHEN THERE IS ONE. Optional because a report stored before
  // this field existed is still a report, and absent already reads as "nobody
  // narrowed this" everywhere it is consumed. Present-and-malformed is the case
  // that fails the whole report rather than being dropped: it is printed as the
  // subject the list below was gathered for AND it seeds the control that
  // narrows the next run, so a half-read one is a screen making a claim about a
  // subject out of a shape nobody wrote.
  if (value.topic !== undefined && value.topic !== null) {
    if (!isObject(value.topic)) return null;
    if (typeof value.topic.slug !== "string" || typeof value.topic.name !== "string") return null;
  }
  if (!Array.isArray(value.shorts)) return null;
  if (!isObject(value.persistence) || typeof value.persistence.status !== "string") return null;
  if (!Array.isArray(value.platforms) || !value.platforms.every(isPlatformOutcome)) return null;
  return value as unknown as LatestShortsReport;
}

// ---------------------------------------------------------------------------
// The Supabase implementation
// ---------------------------------------------------------------------------

/** The columns read back. `report` last because it is the large one. */
const SELECT = "saved_at, report" as const;

interface ReportRow {
  readonly saved_at: string;
  readonly report: unknown;
}

/**
 * `RunReportStore` against PostgREST.
 *
 * NO PAGING HERE, AND THE ABSENCE IS DELIBERATE RATHER THAN AN OVERSIGHT. The
 * scar in lib/shorts/supabase-store.ts is that PostgREST truncates a large
 * response at `Max rows` with a 200 and no error, so every read there pages to
 * the end or reports that it could not. Both reads below are bounded by
 * construction — `limit(1)` for the newest report, one row for the trim cutoff
 * — so there is no window for a cap to silently close. A read here that ever
 * grows past one row needs that header read first.
 */
export class SupabaseRunReportStore implements RunReportStore {
  constructor(private readonly client: TenantClient) {}

  async saveReport(report: LatestShortsReport): Promise<void> {
    const { error } = await this.client.from(RUN_REPORTS_TABLE).insert({
      started_at: report.startedAt,
      finished_at: report.finishedAt,
      report,
    });
    if (error) throw new ShortsStoreError(`saveReport: ${error.message}`);

    // AFTER THE INSERT AND NEVER INSTEAD OF IT. A trim that ran first could
    // delete the only stored run and then fail to write the new one, which is
    // the exact bug this whole module was added to fix, arriving by the back
    // door. A trim that fails after a successful write costs disk.
    try {
      await this.trim();
    } catch (cause) {
      console.error(`[run-reports] the stored reports could not be trimmed:`, cause);
    }
  }

  async latestReport(): Promise<StoredRun | null> {
    const { data, error } = await this.client
      .from(RUN_REPORTS_TABLE)
      .select(SELECT)
      .order("saved_at", { ascending: false })
      .limit(1);
    if (error) throw new ShortsStoreError(`latestReport: ${error.message}`);

    const row = (data ?? [])[0] as ReportRow | undefined;
    if (!row) return null;

    const report = parseStoredReport(row.report);
    if (report === null) {
      // LOUD, BECAUSE THE PAGE WILL BE QUIET. The operator sees the empty
      // state, which is honest and says nothing about why; this is the only
      // place that says a stored run was rejected rather than absent.
      console.error(
        `[run-reports] the newest stored report (saved ${row.saved_at}) does not parse as a ` +
          `LatestShortsReport and was not shown.`,
      );
      return null;
    }
    return { savedAt: row.saved_at, report };
  }

  /**
   * Delete everything older than the newest `KEPT_REPORTS`.
   *
   * TWO QUERIES RATHER THAN A SUBQUERY because PostgREST has no subqueries: ask
   * for the `saved_at` of the row one past the ceiling, then delete everything
   * at or older than it. The `range(KEPT_REPORTS, KEPT_REPORTS)` is that one
   * row — no such row means the table is under the ceiling and there is nothing
   * to do, which is the ordinary case and costs one cheap read.
   *
   * `lte` rather than `lt` on a timestamptz that is only a default: two rows
   * written in the same microsecond would otherwise leave the ceiling one row
   * over, for ever, each time it happened. Deleting the tie takes one extra
   * copy of a screen, which is the harmless direction.
   */
  private async trim(): Promise<void> {
    const { data, error } = await this.client
      .from(RUN_REPORTS_TABLE)
      .select("saved_at")
      .order("saved_at", { ascending: false })
      .range(KEPT_REPORTS, KEPT_REPORTS);
    if (error) throw new ShortsStoreError(`trim: ${error.message}`);

    const cutoff = (data ?? [])[0] as { readonly saved_at: string } | undefined;
    if (!cutoff) return;

    const { error: deleteError } = await this.client
      .from(RUN_REPORTS_TABLE)
      .delete()
      .lte("saved_at", cutoff.saved_at);
    if (deleteError) throw new ShortsStoreError(`trim: ${deleteError.message}`);
  }
}
