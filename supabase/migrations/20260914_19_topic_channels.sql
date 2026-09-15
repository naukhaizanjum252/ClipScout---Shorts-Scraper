-- ============================================================================
-- TOPIC CHANNELS: PER-TOPIC CREATOR/CHANNEL SETS
-- ============================================================================
--
-- This REVISITS a decision made in 20260905_14_topics.sql ("WHY THERE IS NO
-- `topic_id` ON `platform_seeds`: a seed is a CREATOR and a creator is not about
-- one subject … Topics search; seeds enumerate"). That stance still holds for
-- `platform_seeds`, which stay GLOBAL. This table is the deliberate, scoped
-- exception Asad asked for (2026-09-14): a topic that also owns a set of
-- channels, searched ONLY when that topic runs, and grown over time.
--
-- A row links one topic (by slug) to one channel on one platform. `channel` is
-- verbatim whatever that platform's adapter enumerates — a YouTube channel id or
-- @handle, an Instagram handle, a TikTok sec_uid — stored and handed on
-- unvalidated, exactly like `platform_seeds.seed`. Scope in practice is YouTube,
-- Instagram and TikTok (the platforms that can enumerate a creator); the column
-- is the full platform enum, and other platforms simply never get rows.
--
-- `source` manual|auto: a person added it, or the self-growing loop did.
-- DEACTIVATED, NEVER DELETED, like `platform_seeds`: an auto-added dud is
-- switched off and the record of having tried it survives. Presence + `active`
-- is the decision; DELETE exists only for hard cleanup.
--
-- `topic_slug` is a SLUG, NOT A FOREIGN KEY — the same choice as
-- `shorts.topic_slug`: provenance that survives a topic row's churn, and a
-- channel attached to a topic that no longer exists is simply never read.
-- ============================================================================

create table shorts_scraper.topic_channels (
  topic_slug         text not null check (btrim(topic_slug) <> ''),
  platform           shorts_scraper.platform not null,
  -- Verbatim per-platform id/handle. Checked only for being non-blank; the shape
  -- is the adapter's business, exactly as with platform_seeds.seed.
  channel            text not null check (btrim(channel) <> ''),

  active             boolean not null default true,
  source             text not null default 'manual' check (source in ('manual', 'auto')),
  note               text,

  added_at           timestamptz not null default now(),
  added_by           uuid references auth.users(id),
  deactivated_at     timestamptz,
  deactivated_by     uuid references auth.users(id),

  -- The last time a run of this topic on this platform finished without throwing
  -- while this channel was active. NOT evidence the channel produced anything —
  -- the same caveat as platform_seeds.last_fetched_ok_at.
  last_fetched_ok_at timestamptz,

  -- When this channel was last used as a NexLev "find similar channels" SEED.
  -- Null means never. It is how the optional NexLev booster
  -- (lib/shorts/nexlev-boost.ts) rations a ~250-call/month quota: a channel is
  -- seeded at most once, so total calls track how many NEW channels appear
  -- rather than how often a run fires. YouTube only, since NexLev is YouTube-only.
  nexlev_seeded_at   timestamptz,

  primary key (topic_slug, platform, channel)
);

comment on table shorts_scraper.topic_channels is
  'Creators/channels attached to one topic and enumerated only when that topic runs. Distinct from platform_seeds (global). channel is verbatim per-platform, like a seed; deactivated never deleted.';

-- The common read: one topic''s channels, in key order for stable paging.
create index topic_channels_by_topic
  on shorts_scraper.topic_channels (topic_slug, platform, channel);

alter table shorts_scraper.topic_channels enable row level security;

-- SERVICE_ROLE ONLY, and deliberately NOT `authenticated` — the same as
-- `platform_seeds`, `used_shorts` and `api_credentials`. The admin console
-- reaches the database as service_role (there is no login — see repo/proxy.ts),
-- which bypasses RLS, so these grants are the whole of the enforcement. A grant
-- to `authenticated` with no policy to back it is what migration 06 forbids.
--
-- SELECT to list; INSERT + UPDATE because adding is an upsert and
-- toggling/retiring is an update; DELETE for hard cleanup of a mistake.
grant select, insert, update, delete on shorts_scraper.topic_channels to service_role;
