-- ============================================================================
-- A SEED IS AN ADDRESS, NOT A NAME
-- ============================================================================
--
-- SCAR, live database, 2026-09-05, found because /admin/shorts reported all
-- five platforms as "will not run" the day after migration 11 shipped.
--
-- Migration 11 ranks creators out of `shorts_scraper.shorts` and writes the
-- winners into `platform_seeds` as `source = 'auto'`. It writes
-- `creator_handle`. That column is filled by whatever the extractor reported,
-- and for the keyless YouTube path yt-dlp reports the channel's DISPLAY NAME —
-- so the ranking cheerfully seeded "Cocomelon - Nursery Rhymes", "Ian Gunther",
-- "Jose.elCook" and "The BN Brothers" alongside seventeen perfectly good
-- handles. None of those four is a channel reference: two contain spaces, one
-- contains a dot that `parseChannelRef` reads as a URL, and the YouTube adapter
-- refused the whole platform on the first one it saw.
--
-- The same shape of mistake was live on TikTok for a different reason. A TikTok
-- seed is a `sec_uid` — MS4wLjABAAAA plus 64 characters, TikTok's internal key
-- for a creator. `creator_handle` there is an @name and `creator_id` is a
-- numeric author id, and NEITHER of them is a sec_uid. Thirteen @names had been
-- ranked into the seed list, and every one of them was unusable.
--
-- ---------------------------------------------------------------------------
-- THE RULE THIS MIGRATION ADDS
-- ---------------------------------------------------------------------------
--
-- The ranking now emits the value the platform's own adapter can ADDRESS, and
-- emits nothing when it has none. That is `seed_from_short` below, and it is
-- the SQL half of the seed formats declared in TypeScript:
--
--   YouTube   lib/yt/channel-ref.ts   `UC` + 22, or a 3-30 char handle.
--                                     `creator_id` is preferred because this
--                                     deployment records it for every YouTube
--                                     row and it needs no resolve call; the
--                                     handle is the fallback and is emitted
--                                     WITH its `@`, which is what stops a
--                                     legitimate dotted handle like
--                                     `Jose.elCook` being parsed as a URL.
--   TikTok    lib/platform/tiktok.ts  a sec_uid and nothing else. Today this
--                                     yields no rows at all, and that is the
--                                     honest answer: nothing this deployment
--                                     stores is a sec_uid, so nothing it has
--                                     seen can be turned into a TikTok seed.
--                                     An empty list says "seed one" — thirteen
--                                     @names said "this platform is broken".
--   Instagram lib/platform/instagram.ts  the professional-account username,
--                                     lowercased, without the `@` the adapter
--                                     strips anyway.
--   Facebook  lib/platform/facebook.ts  a Page id, or a page name; the adapter
--                                     addresses the Page node directly.
--   X         lib/platform/x.ts       NOTHING, deliberately. X is read by
--                                     search query and the adapter has no seed
--                                     input at all, so a ranked X seed was a
--                                     row nothing could ever read.
--
-- WHY IN SQL AND NOT IN THE CLIENT. The ranking is a SECURITY DEFINER function
-- that writes seeds without a round trip, which is what makes it callable
-- before every run. Filtering afterwards in TypeScript would leave the bad rows
-- in the table, where the next reader finds them and the audit trail says a
-- ranking chose them.
--
-- THIS IS ONLY HALF THE FIX. The other half is in lib/platform/youtube.ts and
-- lib/platform/tiktok.ts: an unusable seed now costs its own row and not the
-- platform. Both halves are needed — this one stops the bad rows being written,
-- that one stops a single bad row taking down a working list, whatever wrote it.

-- ---------------------------------------------------------------------------
-- What a stored short can be seeded by
-- ---------------------------------------------------------------------------
--
-- IMMUTABLE and pure: it reads no table, so it can be used in the ranking's
-- GROUP BY and in an index predicate later without surprising anybody.
--
-- NULL IS THE ANSWER FOR "nothing here is addressable", and every caller must
-- filter it out rather than store it. A null seed is not a seed with a missing
-- name — it is the statement that this observation names no creator this tool
-- can go back to.
create or replace function shorts_scraper.seed_from_short(
  in_platform        shorts_scraper.platform,
  in_creator_handle  text,
  in_creator_id      text
)
returns text
language sql
immutable
as $$
  select case in_platform
    when 'youtube' then
      case
        when btrim(coalesce(in_creator_id, '')) ~ '^UC[A-Za-z0-9_-]{22}$'
          then btrim(in_creator_id)
        when btrim(coalesce(in_creator_handle, '')) ~ '^@?[A-Za-z0-9._-]{3,30}$'
          then '@' || ltrim(btrim(in_creator_handle), '@')
        else null
      end
    when 'tiktok' then
      case
        when btrim(coalesce(in_creator_id, '')) ~ '^MS4wLjABAAAA[A-Za-z0-9_-]{64}$'
          then btrim(in_creator_id)
        else null
      end
    when 'instagram' then
      case
        when btrim(coalesce(in_creator_handle, '')) ~ '^@?[A-Za-z0-9._]{1,30}$'
          then lower(ltrim(btrim(in_creator_handle), '@'))
        else null
      end
    when 'facebook' then
      case
        when btrim(coalesce(in_creator_id, '')) ~ '^[0-9]{5,}$'
          then btrim(in_creator_id)
        when btrim(coalesce(in_creator_handle, '')) ~ '^[A-Za-z0-9._-]{3,50}$'
          then btrim(in_creator_handle)
        else null
      end
    -- X is read by search query. It has no seed input, so it gets no seeds.
    else null
  end
$$;

comment on function shorts_scraper.seed_from_short(shorts_scraper.platform, text, text) is
  'The value a platform''s adapter can address this creator by, or null when the stored row '
  'names none. Mirrors the seed formats in lib/yt/channel-ref.ts and lib/platform/*.ts.';

-- ---------------------------------------------------------------------------
-- The rolling ranking, now ranking addresses
-- ---------------------------------------------------------------------------
--
-- DROPPED AND RECREATED rather than replaced, because the returned column is no
-- longer `creator_handle` and Postgres will not rename an output column in
-- place. The ranking itself is migration 11's and is unchanged: SUM of views
-- inside the window, ties broken by count and then by name. Read 11's header
-- for why SUM and why a rolling window.
--
-- WHAT CHANGED IS THE KEY. Rows are grouped by the ADDRESS now, not the display
-- name, so one creator seen under a name and an id is one row rather than two,
-- and a creator this tool cannot go back to is not ranked at all.
drop function if exists shorts_scraper.top_creators(shorts_scraper.platform, integer, integer);

create function shorts_scraper.top_creators(
  in_platform     shorts_scraper.platform,
  in_window_days  integer default 7,
  in_limit        integer default 200
)
returns table (seed text, total_views bigint, shorts_seen bigint)
language sql
stable
security definer
set search_path = shorts_scraper, public
as $$
  select
    x.addr,
    -- COALESCE, because a null view_count is "not reported", not zero, and a
    -- sum over a mix of the two must not refuse to produce a number.
    sum(coalesce(x.views, 0))::bigint,
    count(*)::bigint
  from (
    select
      shorts_scraper.seed_from_short(s.platform, s.creator_handle, s.creator_id) as addr,
      s.view_count                                                               as views
    from shorts_scraper.shorts s
    where s.platform = in_platform
      -- GREATEST(1, ...) so a zero or negative window cannot silently become
      -- "all of history", which would make a weekly ranking a lifetime one.
      and s.discovered_at >= now() - (greatest(1, in_window_days) || ' days')::interval
  ) x
  -- The rows this tool cannot address. Skipped rather than grouped under an
  -- empty key: an observation whose creator cannot be revisited is not evidence
  -- about any creator.
  where x.addr is not null
  group by x.addr
  order by 2 desc, 3 desc, x.addr asc
  limit greatest(1, in_limit)
$$;

-- ---------------------------------------------------------------------------
-- The refresh
-- ---------------------------------------------------------------------------
--
-- Identical to migration 11's except that it seeds `seed` instead of
-- `creator_handle`. Every guarantee 11's header claims still holds: idempotent,
-- deactivates rather than deletes, and NEVER touches a row a person added.
create or replace function shorts_scraper.refresh_auto_seeds(
  in_window_days integer default 7,
  in_per_platform integer default 200
)
returns integer
language plpgsql
security definer
set search_path = shorts_scraper, public
as $$
declare
  p         shorts_scraper.platform;
  affected  integer := 0;
  touched   integer;
begin
  foreach p in array enum_range(null::shorts_scraper.platform)
  loop
    with ranked as (
      select t.seed
      from shorts_scraper.top_creators(p, in_window_days, in_per_platform) t
    )
    insert into shorts_scraper.platform_seeds (platform, seed, active, source, note)
    select
      p,
      r.seed,
      true,
      'auto',
      'Automatic: top ' || in_per_platform || ' by views seen in the last '
        || in_window_days || ' days.'
    from ranked r
    on conflict (platform, seed) do update
      -- A row a person added and switched off STAYS off: the automatic sweep
      -- owns 'auto' rows only, and this guard is what stops an upsert from
      -- overriding a human decision through the back door.
      set active = case
                     when shorts_scraper.platform_seeds.source = 'auto' then true
                     else shorts_scraper.platform_seeds.active
                   end;

    get diagnostics touched = row_count;
    affected := affected + touched;

    update shorts_scraper.platform_seeds ps
       set active = false,
           deactivated_at = now()
     where ps.platform = p
       and ps.source = 'auto'
       and ps.active
       and ps.seed not in (
         select t.seed
         from shorts_scraper.top_creators(p, in_window_days, in_per_platform) t
       );

    get diagnostics touched = row_count;
    affected := affected + touched;
  end loop;

  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- The rows already written
-- ---------------------------------------------------------------------------
--
-- The four display names and the thirteen @names are in the table right now,
-- and the refresh above would eventually retire them by dropping out of the
-- ranking. "Eventually" is not good enough for rows that make a platform read
-- as broken, and a deployment whose window has gone quiet would keep them
-- forever.
--
-- THE TEST IS THE RULE ITSELF, not a second copy of the regexes: a seed is
-- usable exactly when feeding it back through `seed_from_short` returns it
-- unchanged. A bare YouTube handle normalises to `@handle` and is therefore
-- retired here and re-added in its normal form by the next refresh, which runs
-- before every run.
--
-- AUTOMATIC ROWS ONLY. A person who typed a seed by hand meant it, including a
-- shape this function does not recognise.
update shorts_scraper.platform_seeds ps
   set active = false,
       deactivated_at = now()
 where ps.source = 'auto'
   and ps.active
   and shorts_scraper.seed_from_short(ps.platform, ps.seed, ps.seed) is distinct from ps.seed;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- The 05 migration's rule, restated because a new function does not inherit an
-- argument: EXECUTE comes off public and anon explicitly, every time.
revoke execute on function shorts_scraper.seed_from_short(shorts_scraper.platform, text, text) from public, anon, authenticated;
revoke execute on function shorts_scraper.top_creators(shorts_scraper.platform, integer, integer) from public, anon, authenticated;
revoke execute on function shorts_scraper.refresh_auto_seeds(integer, integer) from public, anon, authenticated;

grant execute on function shorts_scraper.seed_from_short(shorts_scraper.platform, text, text) to service_role;
grant execute on function shorts_scraper.top_creators(shorts_scraper.platform, integer, integer) to service_role;
grant execute on function shorts_scraper.refresh_auto_seeds(integer, integer) to service_role;
