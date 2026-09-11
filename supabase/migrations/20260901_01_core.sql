-- shorts-scraper core schema.
--
-- WHAT THIS TOOL IS, IN ONE SENTENCE. One action, "get latest shorts": read the
-- latest Shorts across every configured platform, keep the ones over a view
-- threshold and at or under the Shorts duration ceiling, and return one list
-- categorised by platform with the highest views first.
--
-- WHAT IT IS NOT, ANY MORE. Until 2026-09-04 this schema held a CHANNEL
-- inventory: a review queue, an approve/unlist state machine, per-finding
-- provenance and a subscriber-relative ranking. That was a misread of the
-- brief. Erik replaced it rather than extended it (2026-09-02, in his own
-- words: "I need a scraper that pulls in the shorts videos themselves too not
-- just the people that created them"). Nothing about curating creators
-- survives, and the exact-set assertions in tests/migrations.test.ts are what
-- stop it coming back a table at a time.
--
-- NOTHING HAD EVER BEEN APPLIED when this was rewritten. No Supabase project
-- reference has been handed over, so not one migration in this directory has
-- ever run against a database. That is why this is a clean set and not an
-- archaeology of drop-column statements. The `20260901_` prefix is kept as the
-- ORDERING KEY it is in Supabase — the numbering is what the setup guide and
-- tests/config-agreement.test.ts refer to, and churning it buys nothing.
--
-- METADATA ONLY, AND ONE SPECIFIC ABSENCE. There is no column anywhere here for
-- a direct media URL, a downloaded file or a storage key. The product does hand
-- the operator a way to fetch the video, but that URL is resolved ON DEMAND by
-- the platform adapter and never written down: a direct media URL from any of
-- these platforms is signed and expires in minutes to hours, so a column of
-- them is a table full of dead links that look alive. The canonical post `url`
-- is the thing that persists, and it is `not null` for exactly that reason.

-- ---------------------------------------------------------------------------
-- 0. The schema — and why NOTHING here lives in `public`
-- ---------------------------------------------------------------------------
--
-- DECISION, Erik, 2026-09-02: this lands on LookUp Media's own Supabase, in a
-- database SHARED with other projects, because a project per tool is $10/month
-- each and there are a lot of tools. The client's own account also keeps the
-- data, the billing and the terms-of-service exposure on the client's side,
-- which is the same principle as the bring-your-own-API-key design in
-- migration 02.
--
-- A shared database only works if each tenant is a SEPARATE SCHEMA. Two things
-- follow, and both are load-bearing rather than tidiness:
--
--   1. NOTHING in this repo may write to `public`, and nothing may touch
--      `public`'s default privileges. An earlier draft of the grant-locking
--      migration ran `revoke all on all tables in schema public from anon`,
--      which in a shared database would have silently broken every OTHER
--      project in it. tests/migrations.test.ts fails the build if `public`
--      reappears.
--
--   2. `anon` never gets USAGE on this schema. PostgREST connects as `anon` for
--      an unauthenticated request, and without schema USAGE it cannot see a
--      table here at all — a grant fact, not a policy fact, and therefore one
--      that survives somebody adding a permissive policy later.
--
-- WHAT IS STILL SHARED, stated plainly rather than discovered later:
--
--   `auth.users` is per-DATABASE, so it is shared with every co-tenant project.
--   Somebody who signs up for another app in this database gets a valid JWT
--   here too. They get NOTHING, because authorisation in this schema runs off
--   `shorts_scraper.profiles`, there is deliberately no trigger that
--   auto-creates a profile on signup, and `role_of()` returns null without one
--   — so `can_read()` is false and every policy denies. That is the isolation
--   boundary, it is one function deep, and verify/db.ts proves it against a
--   real database rather than asserting it here.
--
--   The service-role key is also per-project, so a co-tenant holding it can
--   read `shorts_scraper.api_credentials`. What they get is CIPHERTEXT:
--   `CREDENTIALS_ENCRYPTION_KEY` lives in this app's environment and never in
--   the database. See lib/credentials/secret-box.ts for the full trust
--   statement.

create schema if not exists shorts_scraper;

comment on schema shorts_scraper is
  'shorts-scraper (Lucky35 / LookUp Media). One tenant in a shared database; nothing here may touch schema public.';

-- USAGE to the two roles that need it, and to nobody else. `anon` is omitted on
-- purpose and `revoke` says so out loud rather than relying on the default.
grant usage on schema shorts_scraper to authenticated, service_role;
revoke usage on schema shorts_scraper from public, anon;

-- ---------------------------------------------------------------------------
-- 1. The Shorts ceiling — the ONLY thing that defines a Short
-- ---------------------------------------------------------------------------
--
-- SOURCE: Luka, Discord #shorts, 2026-09-01, asked directly for the longest a
-- Short can be — "2 minutes max is length".
--
-- No platform in this tool exposes an "is this a Short" flag that can be
-- trusted across all five, and several expose nothing of the kind at all.
-- Duration is the only definition there is, so it is the only one used, and it
-- is applied by the DATABASE rather than by whatever wrote the row.
--
-- A function rather than a literal, so the number lives in ONE place in SQL and
-- moving it is a migration rather than a search-and-replace. IMMUTABLE so it can
-- be used in the generated column below.
--
-- It must agree with SHORT_MAX_SECONDS_DEFAULT in lib/config.ts.
-- tests/config-agreement.test.ts parses this file and fails if they drift —
-- because a ceiling that disagrees between the fetch filter and the stored
-- column silently produces two different lists and neither is wrong-looking.
create function shorts_scraper.short_max_seconds()
  returns integer
  language sql
  immutable
  parallel safe
as $$ select 120 $$;

comment on function shorts_scraper.short_max_seconds() is
  'Shorts ceiling in seconds. Client instruction, 2026-09-01: "2 minutes max is length". Mirrored by SHORT_MAX_SECONDS_DEFAULT in lib/config.ts.';

-- ---------------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------------
--
-- ALL FIVE PLATFORMS ARE FIRST-CLASS HERE, INCLUDING THE ONES NO ADAPTER CAN
-- SERVE YET. Verified on this machine against yt-dlp 2026.07.04: `youtube` and
-- `tiktok:user` have working enumerators, `instagram:user` is labelled
-- CURRENTLY BROKEN by yt-dlp itself, and there is no user-timeline or page
-- enumerator at all for x/twitter or facebook. Those three need a third-party
-- data provider that has not been chosen yet.
--
-- The enum still names them, because the alternative is a data model that has
-- to be widened the day the answer arrives — and because a platform that cannot
-- be read must be able to SAY SO on a run row (see migration 03), which
-- requires the value to exist. The single-platform assumption is what this
-- rewrite removes; it does not get to come back as a missing enum value.
--
-- This is also the exact vocabulary in lib/platform/types.ts. The two lists are
-- the same list, in two languages.
create type shorts_scraper.platform as enum ('youtube', 'tiktok', 'instagram', 'x', 'facebook');

create type shorts_scraper.app_role as enum ('owner', 'admin', 'member');

-- ---------------------------------------------------------------------------
-- 3. Who is asking
-- ---------------------------------------------------------------------------
--
-- Minimal on purpose. This is the least that lets RLS say "a signed-in member
-- of this workspace" instead of "anyone", and it is what keeps a co-tenant's
-- valid JWT from reading a single row of this tool's data.

create table shorts_scraper.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  app_role    shorts_scraper.app_role not null default 'member',
  created_at  timestamptz not null default now()
);

create function shorts_scraper.role_of()
  returns shorts_scraper.app_role
  language sql
  stable
  security definer
  set search_path = shorts_scraper, public
as $$ select p.app_role from shorts_scraper.profiles p where p.id = auth.uid() $$;

create function shorts_scraper.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = shorts_scraper, public
as $$ select shorts_scraper.role_of() in ('owner', 'admin') $$;

create function shorts_scraper.can_read()
  returns boolean
  language sql
  stable
  security definer
  set search_path = shorts_scraper, public
as $$ select shorts_scraper.role_of() is not null $$;

-- ---------------------------------------------------------------------------
-- 4. `shorts` — the whole inventory, one row per video
-- ---------------------------------------------------------------------------
--
-- IDENTITY IS (platform, platform_video_id), AND IT IS THE PRIMARY KEY.
--
-- There is no global id format and no regex constraint on an id anywhere in
-- this schema. The old `channels` table checked its key against
-- '^UC[A-Za-z0-9_-]{22}$' — a YouTube-shaped assumption baked into a
-- constraint, which is precisely what made the previous design single-platform.
-- TikTok issues 19-digit numeric ids, Instagram issues base64-ish shortcodes,
-- X issues snowflake integers, and none of them is knowable in advance for a
-- provider nobody has chosen yet. So the id is stored AS THAT PLATFORM ISSUES
-- IT, checked only for being non-blank, and the platform column is what makes
-- it unambiguous. tests/migrations.test.ts asserts there is no regex on it.
--
-- The columns are exactly the ShortRecord contract in lib/platform/types.ts,
-- plus `is_short`, which the database derives rather than accepts.

create table shorts_scraper.shorts (
  platform          shorts_scraper.platform not null,
  platform_video_id text not null check (btrim(platform_video_id) <> ''),

  -- ALWAYS PRESENT. This is the link the operator actually clicks, and it is
  -- the only durable address a video has here. Checked for a scheme and nothing
  -- more: every platform lays its post URLs out differently and a tighter
  -- pattern would be a second single-platform assumption.
  url               text not null check (url ~ '^https?://'),

  title             text,
  creator_handle    text,
  creator_id        text,
  creator_url       text,

  -- NULL is a real answer, not a zero. A live or upcoming broadcast has no
  -- duration yet, and some sources simply do not report one. The generated
  -- column below is careful about that: unknown duration is NOT a Short.
  duration_seconds  integer check (duration_seconds is null or duration_seconds > 0),

  view_count        bigint check (view_count is null or view_count >= 0),
  like_count        bigint check (like_count is null or like_count >= 0),
  comment_count     bigint check (comment_count is null or comment_count >= 0),
  published_at      timestamptz,
  thumbnail_url     text,

  discovered_at     timestamptz not null default now(),
  -- Which adapter or run found it. Non-blank, because "this row came from
  -- somewhere" with no name on it is the shape of a row nobody can audit.
  discovered_by     text not null check (btrim(discovered_by) <> ''),

  -- DERIVED, NOT WRITTEN. Duration is the only thing that defines a Short, and
  -- this is the one place in the system where that is decided. It cannot drift
  -- from `duration_seconds`, because it is not stored independently of it.
  is_short          boolean generated always as
                      (duration_seconds is not null and duration_seconds <= shorts_scraper.short_max_seconds())
                      stored,

  primary key (platform, platform_video_id)
);

comment on table shorts_scraper.shorts is
  'One row per Short, keyed by the platform and the id that platform issued. No global id format, and no direct media URL: those expire, the post URL does not.';

comment on column shorts_scraper.shorts.url is
  'Canonical post URL. The durable address of this video, and the reason no expiring media URL is stored beside it.';

-- ---------------------------------------------------------------------------
-- 5. WHY THE VIEW THRESHOLD IS NOT A GENERATED COLUMN
-- ---------------------------------------------------------------------------
--
-- The obvious symmetry would be an `is_popular` column generated off a
-- `short_min_views()` function, matching `is_short`. IT IS WRONG, TWICE, AND
-- THE REASONS ARE DIFFERENT FROM EACH OTHER.
--
--   1. IT WOULD FREEZE 500,000 INTO THE SCHEMA. Erik named that number
--      directly, so unlike the daily-quota figures it has a real default — but
--      it is still CONFIG (MIN_VIEWS in lib/config.ts), and a client who wants
--      to see everything over 100,000 next week should not need a migration and
--      a full table rewrite to ask a different question. There is no 500000
--      anywhere in this directory, and tests/migrations.test.ts asserts that.
--
--   2. MORE SERIOUSLY: A STORED GENERATED COLUMN WOULD GO STALE AND LOOK FINE.
--      `duration_seconds` is a fact about a video that does not change, so
--      `is_short` is correct forever once written. `view_count` is a moving
--      number — a video crosses 500,000 views some time AFTER it was stored —
--      and a STORED generated column only recomputes when its row is written.
--      So the boolean would answer "was this over the threshold at the moment
--      we last touched the row", while reading exactly like "is this over the
--      threshold". A wrong answer that looks right is the failure mode this
--      repo is most careful about, and it is the same one that keeps expiring
--      media URLs out of the table above.
--
-- So the threshold is a QUERY-TIME FILTER: `where is_short and view_count >=
-- $1`. What makes that auditable afterwards is that the threshold actually
-- applied is recorded on the run row (`runs.min_views`, migration 03) together
-- with how many rows it dropped. Without that, a count of kept rows means
-- nothing six weeks later.
--
-- ONE HONEST CAVEAT ABOUT `is_short` ITSELF, since it is the same mechanism:
-- moving `short_max_seconds()` does NOT recompute rows already stored, because
-- STORED generated columns are computed on write. Changing the ceiling means
-- rewriting the affected rows in the same migration that changes the function.
-- Nothing enforces that today, and pretending otherwise would be worse than
-- writing it here.

-- ---------------------------------------------------------------------------
-- 6. Indexes — shaped by the one query this product runs
-- ---------------------------------------------------------------------------
--
-- "One list, categorised by platform, highest views first, Shorts only." That
-- is the entire read pattern, so it is the index. Partial on `is_short` because
-- a non-Short is never in an answer, and `desc nulls last` because a video
-- whose view count is unknown must never sort above one that is known to have
-- a million.

create index shorts_platform_views_idx
  on shorts_scraper.shorts (platform, view_count desc nulls last)
  where is_short;

-- "What did the last run turn up", which is the other thing anybody asks.
create index shorts_discovered_idx
  on shorts_scraper.shorts (discovered_at desc);

notify pgrst, 'reload schema';
