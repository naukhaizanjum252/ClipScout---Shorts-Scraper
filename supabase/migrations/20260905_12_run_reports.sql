-- The last run, kept so the screen survives a reload.
--
-- Erik, 2026-09-05: *"The run should not disappear after a while."*
--
-- WHAT WAS ACTUALLY WRONG. `LatestShortsReport` lived in React state on
-- /admin/shorts and nowhere else. Nothing expired it and nothing was broken —
-- it simply went with the component, so a refresh, a walk to /admin/credentials
-- and back, or a restored tab put the operator back on "Nothing has been
-- fetched yet". That sentence is the page's way of saying NO RUN HAS HAPPENED,
-- and it was being shown minutes after one had, which makes it the same class
-- of lie this whole product is built to avoid: an absence rendered as a result.
--
-- SO THE REPORT IS WRITTEN DOWN, VERBATIM, AND READ BACK ON PAGE LOAD.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT `runs` AND `run_platforms`
-- ---------------------------------------------------------------------------
--
-- The obvious move was to give migration 03's two tables their first writer and
-- rebuild the screen from them. They cannot hold a modern report, and the
-- reason is a CHECK constraint doing its job:
--
--     constraint every_returned_row_is_accounted_for
--       check (rows_returned = kept + dropped_below_min_views + dropped_over_duration)
--
-- `DroppedBreakdown` in lib/shorts/run.ts has SIX buckets today — wrongPlatform,
-- tooLong, tooShort, belowThreshold, unknownDuration, unknownViews — and an
-- outcome also carries `duplicates`, which that table has no column for. Any
-- real run with one unknown view count fails that insert. The constraint is not
-- wrong; it is older than the report, and reconciling the two is a schema change
-- to the evidence tables that deserves its own decision rather than being done
-- in passing to fix a refresh.
--
-- The distinction this table therefore keeps: `runs` and `run_platforms` are the
-- NORMALISED EVIDENCE, still unwritten, still the right home for "what did
-- Instagram say on the 4th". This is THE SCREEN, kept whole, so a page can put
-- back exactly what it had. One is queryable and lossy; this one is neither, and
-- pretending a jsonb blob is an analytics record would be the worse mistake.
--
-- ---------------------------------------------------------------------------
-- THE REPORT IS STORED WHOLE, NOT UNPACKED, AND THAT IS THE POINT
-- ---------------------------------------------------------------------------
--
-- The honesty rule on this product is enforced by a TYPE: `PlatformOutcome` is a
-- discriminated union, so a `no-adapter` outcome has no row count and rendering
-- one does not compile. Every unpacking into columns and every rebuild out of
-- them is a chance to flatten that back into a status string beside some
-- nullable integers — which is exactly the shape the union exists to forbid.
-- What goes in here is the object the browser had, and what comes out is parsed
-- back against that same union before anything renders it.
--
-- IT FOLLOWS THAT THIS TABLE CANNOT BE QUERIED FOR ANSWERS. Nobody may write
-- `where report->>'...'` against it and call the result a finding; the shape
-- inside is the application's, it has changed twice already (`unverified` and
-- `spend` both arrived after the type was first written), and the type says in
-- as many words that a stored report from before a field existed is still a
-- valid report. Read it whole or leave it alone.
--
-- ---------------------------------------------------------------------------
-- IT IS SHARED, AND THAT IS A DECISION RATHER THAN A SIDE EFFECT
-- ---------------------------------------------------------------------------
--
-- Erik chose the shared form over a per-browser one (2026-09-05). A run costs
-- somebody's API quota and, on X, real money per Post returned — so the second
-- person to open this page today should see what the first person paid for
-- rather than press the button again. The price of that is that an operator can
-- be looking at a list they did not fetch, so `saved_at` is NOT NULL and the
-- page is required to print it: a restored run says whose day it is a report of
-- before it says anything about the internet.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table shorts_scraper.run_reports (
  id          uuid primary key default gen_random_uuid(),

  -- When this was written down. THE READ ORDERS BY THIS AND THE PAGE PRINTS IT.
  -- Not derivable from the blob for the purpose it serves: the report's own
  -- `startedAt` is when the platforms were read, and a page that says "as at"
  -- must not quote a time from a document to explain how old the document is.
  saved_at    timestamptz not null default now(),

  -- Lifted out of the report so the newest row can be found without parsing
  -- every blob in the table. Duplicates of `report.startedAt` / `finishedAt`,
  -- and duplicated on purpose: an index cannot be built on a field the
  -- application is free to reshape. The blob stays the source of truth for
  -- everything a person reads.
  started_at  timestamptz not null,
  finished_at timestamptz not null,

  -- Who pressed it. Null for an unattended run and null for this deployment,
  -- which has no sign-in (Erik, 2026-09-04) — kept because the column costs
  -- nothing and re-adding it after the fact would leave every row before the
  -- change unattributable.
  saved_by    uuid references auth.users(id) on delete set null,

  -- `LatestShortsReport`, exactly as lib/shorts/run.ts produced it.
  report      jsonb not null,

  constraint a_report_cannot_finish_before_it_starts
    check (finished_at >= started_at)
);

-- The read is always "the newest one", so this is the only index it needs.
create index run_reports_saved_idx on shorts_scraper.run_reports (saved_at desc);

comment on table shorts_scraper.run_reports is
  'The last runs of /admin/shorts, each stored as the whole LatestShortsReport, so the screen survives a reload. Read whole and never queried into: the shape inside belongs to lib/shorts/run.ts and has changed twice. The normalised evidence is runs/run_platforms.';

comment on column shorts_scraper.run_reports.saved_at is
  'When the report was written down, not when the platforms were read. The page prints this, so a restored list can never be mistaken for a fresh one.';

comment on column shorts_scraper.run_reports.report is
  'A whole LatestShortsReport as JSON. Do not read individual keys out of it in SQL — the union inside is what keeps "found nothing" and "could not be read" distinguishable, and it is the application that enforces that.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
--
-- Same shape as `runs` in migration 04, with ONE DIFFERENCE THAT IS ARGUED FOR
-- RATHER THAN COPIED: this table has a DELETE policy and `runs` deliberately
-- does not.
--
-- The reason `runs` has none is that its rows are the only thing separating
-- "this platform returned nothing" from "this platform could not be read" once
-- the screen is gone, so a session that can tidy them away can erase the
-- difference. That argument is about EVIDENCE. This table is a screen that was
-- kept, it is bounded on purpose (lib/shorts/report-store.ts trims to the
-- newest few hundred, and says why), and an unbounded column of ~150KB blobs in
-- a database this account shares between projects is a cost with nobody's name
-- on it. Deleting the 201st-newest copy of a page destroys no fact that the
-- evidence tables were ever meant to hold.
--
-- No UPDATE anywhere. A report is written once, when the run ends. There is no
-- moment at which a stored report legitimately changes, and a table that cannot
-- be edited is one fewer way for the list on a screen to stop matching the run
-- it claims to be.

alter table shorts_scraper.run_reports enable row level security;

create policy "run_reports: members read"
  on shorts_scraper.run_reports for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "run_reports: admins insert"
  on shorts_scraper.run_reports for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "run_reports: admins delete"
  on shorts_scraper.run_reports for delete
  to authenticated
  using (shorts_scraper.is_admin());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- `shorts_scraper` is not `public`, so a new table arrives with NO privileges at
-- all and fails EARLIER than RLS — "permission denied for table run_reports",
-- not zero rows. That is migration 06's whole scar and it applies to every table
-- added after it, which is why these two lines are here and not left to be
-- noticed later.
--
-- Table-wide rather than column-by-column, which is the rule migration 06 sets:
-- `api_credentials` is the only narrowed table in this schema, because a
-- column-level grant makes every future column arrive unreadable and silent.
--
-- No UPDATE for either role, matching the absent policy above.

grant select, insert, delete on shorts_scraper.run_reports to authenticated;
grant select, insert, delete on shorts_scraper.run_reports to service_role;

-- Belt, in the same position and for the same reason as migration 06's: a
-- revoke placed AFTER the grants is the one that survives somebody adding
-- `anon` to a list above.
revoke all on shorts_scraper.run_reports from anon;

notify pgrst, 'reload schema';
