-- ============================================================================
-- USED / UNUSED: A LIGHT DECISION LAYER OVER THE OBSERVATIONS
-- ============================================================================
--
-- `shorts` holds OBSERVATIONS. `upsertShorts` REPLACES a row every time a video
-- is seen again, because views climb, titles get edited and thumbnails are
-- re-encoded (lib/shorts/store.ts spells this out). A "used" flag kept ON that
-- row would therefore be wiped on the next run that re-found the clip.
--
-- So the DECISION "I have used this clip" lives in its own table, keyed by the
-- same identity as a short — (platform, platform_video_id) — and a re-run of
-- `shorts` never touches it. This is the same split the store's own header
-- argues for: an observation may be overwritten by a robot; a decision may not.
--
-- PRESENCE IS THE DECISION. A row here means used; no row means unused. Marking
-- used is an insert, marking unused is a delete, and there is no boolean column
-- that could fall out of step with whether the row exists.
--
-- NO FOREIGN KEY TO `shorts`, on purpose. A mark is a fact about a
-- (platform, video id) pair, and coupling it to a `shorts` row would make
-- marking depend on the observation still being present — which it need not be.
-- A mark with no matching short is harmless: the library reads `shorts` and
-- looks each row up here, so an orphan mark is simply never shown.
-- ============================================================================

create table shorts_scraper.used_shorts (
  platform            shorts_scraper.platform not null,
  platform_video_id   text not null check (btrim(platform_video_id) <> ''),
  used_at             timestamptz not null default now(),
  primary key (platform, platform_video_id)
);

alter table shorts_scraper.used_shorts enable row level security;

-- SERVICE_ROLE ONLY, and deliberately NOT `authenticated`. The admin console
-- reaches the database as `service_role` (there is no login — see repo/proxy.ts)
-- and service_role BYPASSES RLS, so these grants are the whole of the
-- enforcement. `authenticated` is left out on purpose: no code path touches this
-- table as a session, and a grant with no RLS policy to back it is a grant this
-- schema's discipline forbids (see migration 06). `api_credentials` is granted
-- the same way and for the same reason.
--
-- INSERT + UPDATE together because marking used is an upsert (insert, or on a
-- re-mark refresh `used_at`); DELETE because unmarking removes the row; SELECT
-- to list them.
grant select, insert, update, delete on shorts_scraper.used_shorts to service_role;
