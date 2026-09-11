/**
 * Where the stored run comes from, for the two places that need it.
 *
 * ./actions.ts writes one at the end of a run; ./page.tsx reads the newest one
 * to seed the screen. Both need the same decision — is there a database, and
 * what happens when there is not — and this is the one place it is made.
 *
 * IT IS A SEPARATE MODULE RATHER THAN A FOURTH EXPORT OF ./actions.ts, and the
 * rule is stricter than it looks. Next turns EVERY export of a `"use server"`
 * module into a callable public endpoint, so an export there is a deployment
 * decision. The scar is lib/actions/decide.ts, where a pure helper was exported
 * from an action module to make a test easier and thereby published an endpoint
 * nobody had decided to publish. This file has no directive and therefore
 * cannot become one.
 *
 * IT IS ALSO NOT ./view.ts, which is the other shared module on this screen.
 * That one is imported by the client component, so everything in it ships to a
 * browser; this imports `createSupabaseAdminClient`, which reads the
 * service-role key. Putting the two in one file would be one import away from
 * the key being reachable from a client bundle.
 *
 * READING THE LAST RUN IS FREE AND WRITING IT IS NOT A RUN, which is what makes
 * both of these compatible with ./page.tsx's rule that nothing is fetched on
 * load. That rule is about an EXPENSIVE VERB — a run spends somebody's API
 * quota and, on X, real money per Post returned, so it stays behind a button.
 * One indexed row of stored JSON costs nothing and spends nobody's quota.
 */
import { SupabaseRunReportStore, type RunReportStore, type StoredRun } from "@/lib/shorts/report-store";
import type { LatestShortsReport } from "@/lib/shorts/run";
import { ShortsStoreError } from "@/lib/shorts/store";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const LOG_TAG = "[admin/shorts]";

/**
 * The store for a deployment that has no database.
 *
 * IT REFUSES RATHER THAN PRETENDING, which is the same call `NoDatabaseStore`
 * makes in ./actions.ts and it is worth restating because the tempting
 * alternative is worse here than it is there. An in-memory version of this
 * would accept a report into an object discarded when the request ends and
 * report success — so the screen would say the run was kept, and the next page
 * load would show the empty state anyway. That is the bug this whole feature
 * was added to fix, reintroduced with a green light on it.
 *
 * `latestReport` returns null rather than throwing, because "there is no
 * database" and "there is a database with nothing in it" have the same honest
 * answer for a page seeding itself: NOTHING TO RESTORE. Neither is a statement
 * about any platform, and the empty state says only that.
 */
class NoDatabaseReportStore implements RunReportStore {
  async saveReport(): Promise<void> {
    throw new ShortsStoreError(
      "No Supabase project is configured for this deployment, so there is nowhere to keep the run.",
    );
  }

  async latestReport(): Promise<StoredRun | null> {
    return null;
  }
}

function resolveReportStore(): RunReportStore {
  if (!isSupabaseConfigured) return new NoDatabaseReportStore();
  return new SupabaseRunReportStore(createSupabaseAdminClient());
}

/**
 * Keep a finished report, so the next page load can put it back.
 *
 * NEVER THROWS, AND NEVER CHANGES WHAT THE RUN REPORTS. The run has already
 * happened by the time this is called: the platforms were read, somebody's
 * quota was spent, and the shorts are in `shorts` with their own
 * `persistence` outcome. Failing the action because a convenience copy could
 * not be written would throw away a list that was paid for, in order to
 * complain about the mechanism that saves people from re-paying for it.
 *
 * So a failure is logged under `[admin/shorts]`, where the rest of this
 * screen's failures go, and the operator gets their run. What they lose is the
 * restore, which they find out about the ordinary way — by reloading and seeing
 * the empty state, which is exactly as true as it was before this existed.
 */
export async function keepRun(report: LatestShortsReport): Promise<void> {
  try {
    await resolveReportStore().saveReport(report);
  } catch (cause) {
    console.error(`${LOG_TAG} the run was made but could not be kept for the next page load:`, cause);
  }
}

/**
 * The newest stored run, or null.
 *
 * NULL FOR EVERY REASON, ON PURPOSE — nothing stored, no database, a row that
 * would not parse, PostgREST refusing. A page seeding itself does the same
 * thing in all four cases, and the one thing it must never do is turn any of
 * them into a claim about what the platforms contain. The empty state is a
 * sentence about this deployment's history and says nothing else.
 *
 * The reasons are not interchangeable to somebody FIXING one, which is why the
 * failing cases are logged with their cause rather than swallowed silently.
 */
export async function lastRun(): Promise<StoredRun | null> {
  try {
    return await resolveReportStore().latestReport();
  } catch (cause) {
    console.error(`${LOG_TAG} the last run could not be read back:`, cause);
    return null;
  }
}
