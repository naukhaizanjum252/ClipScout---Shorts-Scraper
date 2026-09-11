-- The record of a "get latest shorts" run.
--
-- THIS IS THE HONESTY TABLE, AND IT IS NOT OPTIONAL.
--
-- The single most important rule in this repo is that "no results" and "this
-- platform could not be read" must never look the same. On the screen that is a
-- rendering decision. AFTER THE FACT it is a schema decision, because a list
-- with nothing under `instagram` in it is indistinguishable from a list where
-- Instagram was never reached — unless something wrote down which platforms
-- were attempted and what each one said.
--
-- So a run has one child row PER PLATFORM IT TRIED, and three states are
-- distinguishable by looking:
--
--   NO ROW AT ALL          the platform was not attempted on this run.
--   ROW, reason non-null   the platform was attempted and COULD NOT BE READ.
--                          `unavailable_reason` is the sentence the adapter
--                          gave, and it may not be blank.
--   ROW, reason null       the platform was read successfully. `kept` is then a
--                          real count, and `kept = 0` genuinely means "nothing
--                          this platform published lately clears the bar".
--
-- Three of the five platforms cannot be served at all right now — verified
-- against yt-dlp 2026.07.04: `instagram:user` is marked CURRENTLY BROKEN, and
-- x/twitter and facebook have no timeline enumerator — so the middle state is
-- the COMMON one today, not an edge case. It is the state the whole table is
-- shaped around.

-- ---------------------------------------------------------------------------
-- 1. The run
-- ---------------------------------------------------------------------------
--
-- THE FILTERS ARE RECORDED AS APPLIED, and that is what makes the counts below
-- readable later. "Dropped 240 rows under the threshold" is meaningless without
-- knowing which threshold; the same run replayed next month with MIN_VIEWS at
-- 100,000 would drop a different number for reasons that have nothing to do
-- with the platforms.
--
-- NEITHER FILTER HAS A DEFAULT HERE. The view threshold's default lives in
-- lib/config.ts (Erik named 500,000 directly) and the duration ceiling's lives
-- in `shorts_scraper.short_max_seconds()`. A default on this table would be a
-- third copy of a number that is only allowed to exist in one place per layer,
-- and it would let a row claim a threshold nobody applied.

create table shorts_scraper.runs (
  id                   uuid primary key default gen_random_uuid(),
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,

  -- The two filters, exactly as this run applied them.
  min_views            bigint  not null check (min_views >= 0),
  max_duration_seconds integer not null check (max_duration_seconds > 0),

  -- How many rows each adapter was asked for. Null when the caller set no cap.
  requested_limit      integer check (requested_limit is null or requested_limit > 0),

  -- Who pressed the button. Null for an unattended run, which has no session.
  started_by           uuid references auth.users(id) on delete set null,
  note                 text,

  constraint a_run_cannot_finish_before_it_starts
    check (finished_at is null or finished_at >= started_at)
);

create index runs_started_idx on shorts_scraper.runs (started_at desc);

comment on table shorts_scraper.runs is
  'One row per "get latest shorts" press. Records the filters as applied, so the per-platform counts in run_platforms can still be read months later.';

-- ---------------------------------------------------------------------------
-- 2. What each platform did
-- ---------------------------------------------------------------------------
--
-- THE ARITHMETIC IS ENFORCED, NOT TRUSTED. `rows_returned` must equal
-- `kept + dropped_below_min_views + dropped_over_duration`, so a bug in the
-- counting shows up as a FAILED INSERT rather than as a plausible number on a
-- page. That is the same choice the old schema made about a keyless run
-- claiming quota, and it is the only kind of check worth having on a count.
--
-- IT FORCES A DECISION THE FILTER WOULD OTHERWISE FUDGE: a row that is both too
-- long AND under the threshold has to land in exactly one bucket. The order is
-- DURATION FIRST, because duration is what makes something a Short at all — a
-- ten-minute video with 400 views was never a Short that failed on views, it
-- was never a Short. Whatever writes these rows must classify the same way.

create table shorts_scraper.run_platforms (
  run_id             uuid not null references shorts_scraper.runs(id) on delete cascade,
  platform           shorts_scraper.platform not null,

  -- NULL means the adapter ran. Non-null is why it could not, in words, and it
  -- may not be blank: "unavailable" with no reason is the answer that sends
  -- somebody digging through logs for an hour.
  unavailable_reason text check (unavailable_reason is null or btrim(unavailable_reason) <> ''),

  rows_returned           integer not null default 0 check (rows_returned >= 0),
  kept                    integer not null default 0 check (kept >= 0),
  dropped_below_min_views integer not null default 0 check (dropped_below_min_views >= 0),
  dropped_over_duration   integer not null default 0 check (dropped_over_duration >= 0),

  -- Which operator's key paid for this, when one was needed. No foreign key
  -- action beyond `set null`: deleting a credential must not delete the record
  -- of what it was used for.
  credential_id      uuid references shorts_scraper.api_credentials(id) on delete set null,
  units_spent        integer check (units_spent is null or units_spent >= 0),

  primary key (run_id, platform),

  -- An adapter that could not run returned nothing and therefore counted
  -- nothing. Without this, "unavailable" and "read it, found none" become the
  -- same row again by the back door.
  constraint an_unavailable_platform_counts_nothing
    check (
      unavailable_reason is null
      or (rows_returned = 0 and kept = 0 and dropped_below_min_views = 0 and dropped_over_duration = 0)
    ),

  constraint every_returned_row_is_accounted_for
    check (rows_returned = kept + dropped_below_min_views + dropped_over_duration),

  -- Spend belongs to a key. A run that names no credential cannot have cost
  -- anybody units, and the keyless path (yt-dlp) is exactly that case.
  constraint spend_needs_a_credential
    check (coalesce(units_spent, 0) = 0 or credential_id is not null)
);

create index run_platforms_platform_idx on shorts_scraper.run_platforms (platform, run_id);

comment on column shorts_scraper.run_platforms.unavailable_reason is
  'Null means this platform was read. Non-null is the adapter sentence explaining why it could not be, and the row is then required to count nothing. A platform with no row here was not attempted at all.';

comment on column shorts_scraper.run_platforms.dropped_over_duration is
  'Rows the source returned that were longer than the run max_duration_seconds. Duration is classified BEFORE views, so a long video with few views is counted here and not below the threshold.';

notify pgrst, 'reload schema';
