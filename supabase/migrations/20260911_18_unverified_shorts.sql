-- ============================================================================
-- UNVERIFIED SHORTS: THE ROWS THAT PASSED LESS THAN EVERYTHING
-- ============================================================================
--
-- `shorts` means one thing and the whole tool rests on it: a row there was
-- MEASURED against both filters and cleared them. The auto-seed ranking reads
-- that table and trusts every view count in it (see lib/shorts/seeds.ts), so a
-- row whose views were ESTIMATED, or whose duration was never reported, cannot
-- live there without quietly corrupting a ranking and breaking the promise the
-- word "shorts" makes everywhere else.
--
-- But those rows are real finds. Instagram's keyword search publishes no
-- duration for anyone and no view count at all — the tool estimates views from
-- likes — so EVERY Instagram keyword reel lands here rather than in `shorts`.
-- Asad, 2026-09-10: he wants them in the Library regardless of duration. So they
-- get a table of their own, keyed by the same identity as a short, kept apart
-- from the measured ones exactly as the run report keeps `shorts` apart from
-- `unverified`. The Library reads both and marks these for what they are.
--
-- WHAT MAKES A ROW BELONG HERE, CARRIED ON THE ROW:
--   `unproven`           which filters could not be evaluated ("views",
--                        "duration"). Never empty — a row with nothing unproven
--                        is a measured short and belongs in `shorts`.
--   `measurement_caveat` the health warning on a figure that is not a plain
--                        measurement (an estimate, or a number the tool refuses
--                        to compare), as JSON. Null when there is none. This is
--                        what lets the Library print "≈" on an estimated view
--                        count instead of passing it off as measured.
--
-- NO `is_short` COLUMN, on purpose: the point of this table is the rows whose
-- shortness could NOT be decided, so a generated boolean claiming to have
-- decided it would be a lie in a column.
--
-- NO FOREIGN KEY TO `shorts`, same as `used_shorts`: identity here is a
-- (platform, video id) pair and nothing else, and a row here is not a claim
-- that the same clip is or is not also in `shorts`.
-- ============================================================================

create table shorts_scraper.unverified_shorts (
  platform          shorts_scraper.platform not null,
  platform_video_id text not null check (btrim(platform_video_id) <> ''),

  url               text not null check (url ~ '^https?://'),

  title             text,
  creator_handle    text,
  creator_id        text,
  creator_url       text,

  -- Nullable, and here that is the normal case rather than the exception: a row
  -- with a known duration that cleared the ceiling would be a measured short.
  duration_seconds  integer check (duration_seconds is null or duration_seconds > 0),

  view_count        bigint check (view_count is null or view_count >= 0),
  like_count        bigint check (like_count is null or like_count >= 0),
  comment_count     bigint check (comment_count is null or comment_count >= 0),
  published_at      timestamptz,
  thumbnail_url     text,

  discovered_at     timestamptz not null default now(),
  discovered_by     text not null check (btrim(discovered_by) <> ''),

  topic_slug        text,

  -- WHICH FILTERS WERE UNPROVEN. Never empty — enforced, because an empty array
  -- would describe a measured short, and a measured short does not belong here.
  unproven          text[] not null check (array_length(unproven, 1) >= 1),

  -- The caveat on a non-measurement figure, as written by the adapter that
  -- produced it (lib/platform/caveat.ts). Null when the row carries none.
  measurement_caveat jsonb,

  primary key (platform, platform_video_id)
);

comment on table shorts_scraper.unverified_shorts is
  'Rows a run found that could not be judged against both filters — kept for the Library, apart from the measured shorts, so a ranking that trusts view counts never reads an estimate.';

alter table shorts_scraper.unverified_shorts enable row level security;

-- SERVICE_ROLE ONLY, and deliberately NOT `authenticated`, for the same reason
-- `used_shorts` and `api_credentials` are: the admin console reaches the
-- database as service_role (there is no login — see repo/proxy.ts), which
-- bypasses RLS, so these grants are the whole of the enforcement. A grant to
-- `authenticated` with no policy to back it is what migration 06's discipline
-- forbids.
--
-- SELECT to list them in the Library; INSERT + UPDATE because writing them is an
-- upsert (a re-run re-observes the same reel); DELETE so a table that turns out
-- to hold junk can be cleared.
grant select, insert, update, delete on shorts_scraper.unverified_shorts to service_role;
