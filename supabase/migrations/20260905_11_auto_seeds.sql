-- ============================================================================
-- SEEDS STOP BEING SOMEBODY'S JOB
-- ============================================================================
--
-- Erik, 2026-09-05: "Seeds is not suppose to be a manual task, can you fully
-- automate 200 top seeds for each and then remove the front end. We don't want
-- to see or use it we just want the scraper to work." And, clarifying the
-- number: "this 200 should be dynamic... not just the 200 now but the 200 on a
-- weekly basis".
--
-- THAT CLARIFICATION IS WHAT MAKES THIS BUILDABLE HONESTLY. A fixed list of
-- "the top 200 creators" is not something this repo can obtain — nobody sells
-- it, and writing one out by hand would be inventing data and calling it a
-- ranking. A ROLLING top 200 is different: it is a fact about what this
-- deployment has actually seen in the last seven days, computed from rows it
-- fetched itself. Nothing is asserted that was not observed.
--
-- ---------------------------------------------------------------------------
-- WHERE THE RANKING COMES FROM
-- ---------------------------------------------------------------------------
--
-- `shorts_scraper.shorts` already stores every row every run has kept, with
-- `platform`, `creator_handle`, `view_count` and `discovered_at`. That is the
-- observation history, and it has been accumulating since the first run. This
-- migration adds no new source of truth; it reads the one that exists.
--
-- A creator's score is the SUM of views on the shorts of theirs seen inside the
-- window, not their best video and not a count of videos. Reasoning, because
-- each alternative is defensible and one had to be chosen:
--
--   MAX would rank a creator with one freak video above a creator who clears
--   the threshold every week. The second is who this tool is for.
--   COUNT ignores size entirely and would rank a prolific small account over a
--   large one, which inverts the whole point of a view threshold.
--   SUM rewards being repeatedly big, which is what "top creator" means here.
--
-- Rows with a null `creator_handle` are skipped rather than grouped under an
-- empty key. A row whose creator this tool could not identify is not evidence
-- about any creator.
--
-- ---------------------------------------------------------------------------
-- THE BOOTSTRAP PROBLEM, AND WHICH PLATFORMS IT LEAVES OUT
-- ---------------------------------------------------------------------------
--
-- A seed list derived from observations is empty on an empty database, and a
-- platform that can only be read BY seed then has nothing to read and never
-- observes anything. That deadlock is real and it does not affect every
-- platform equally:
--
--   TIKTOK, INSTAGRAM, X — break the deadlock on their own. They have seedless
--   discovery (the vendor's TikTok trending feed and keyword search, its
--   Instagram reels search, and X's own search query), so a first run on an
--   empty database still returns rows, and those rows name creators. The list
--   fills itself from run one.
--
--   YOUTUBE — breaks it only with a key. The keyless yt-dlp path walks a
--   channel's uploads and cannot enumerate channels, so with no key and no
--   seeds it observes nothing. With a YouTube Data API key, search.list is
--   discovery.
--
--   FACEBOOK — DOES NOT BREAK IT, AND THIS IS NOT A GAP THIS MIGRATION CAN
--   CLOSE. lib/credentials/providers.ts records, against Meta's own reference
--   read 2026-09-04, that the Graph API documents no read on a Page's video
--   edges and offers no public-content search; and lib/platform/registry.ts
--   records that no vendor sells Facebook Reels discovery, ScrapeCreators
--   included. There is therefore no mechanism, paid or free, by which this tool
--   can find a Facebook Page it was not told about. Facebook's rolling top 200
--   will contain exactly the creators somebody names and no others, and if
--   nobody names any it stays empty forever. Automating it is not a matter of
--   effort.
--
-- ---------------------------------------------------------------------------
-- WHY SEEDS ARE STILL A TABLE AND NOT COMPUTED AT READ TIME
-- ---------------------------------------------------------------------------
--
-- A view would be simpler and it would throw away the audit trail. The columns
-- `added_at`, `last_fetched_ok_at` and `note` answer "why were we fetching this
-- creator, and did it ever work", and the 07 migration is explicit that a row a
-- session can remove is a row that takes that answer with it. So the ranking
-- WRITES to `platform_seeds` rather than replacing it, and every automatic row
-- keeps its history the same way a hand-added one did.

-- ---------------------------------------------------------------------------
-- Telling an automatic seed from one a person put there
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS COLUMN THE REFRESH BELOW WOULD BE DESTRUCTIVE. It deactivates
-- seeds that have fallen out of the top 200, and on a deployment where somebody
-- had hand-added a creator, that sweep would quietly switch off the one row a
-- person deliberately chose. The refresh only ever touches rows it owns.
--
-- 'manual' IS THE DEFAULT so that every row already in this table — all of them
-- added by a person through the page this change deletes — keeps working and
-- keeps being left alone.
alter table shorts_scraper.platform_seeds
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'auto'));

comment on column shorts_scraper.platform_seeds.source is
  'manual = a person added it and the automatic refresh must not touch it. '
  'auto = shorts_scraper.refresh_auto_seeds() owns this row and may deactivate it.';

-- Ranking scans by platform and date; seeding writes by (platform, source).
create index if not exists shorts_discovered_at_platform_idx
  on shorts_scraper.shorts (platform, discovered_at desc)
  where creator_handle is not null;

create index if not exists platform_seeds_source_idx
  on shorts_scraper.platform_seeds (platform, source);

-- ---------------------------------------------------------------------------
-- The rolling ranking
-- ---------------------------------------------------------------------------
--
-- READ-ONLY AND SEPARATE FROM THE WRITE, so the ranking can be inspected —
-- "what would the refresh do" — without doing it. A function that can only be
-- run by doing the thing is a function nobody checks before running.
create or replace function shorts_scraper.top_creators(
  in_platform     shorts_scraper.platform,
  in_window_days  integer default 7,
  in_limit        integer default 200
)
returns table (creator_handle text, total_views bigint, shorts_seen bigint)
language sql
stable
security definer
set search_path = shorts_scraper, public
as $$
  select
    s.creator_handle,
    -- COALESCE, because a null view_count is "not reported", not zero, and a
    -- sum over a mix of the two must not refuse to produce a number.
    sum(coalesce(s.view_count, 0))::bigint as total_views,
    count(*)::bigint                        as shorts_seen
  from shorts_scraper.shorts s
  where s.platform = in_platform
    and s.creator_handle is not null
    and btrim(s.creator_handle) <> ''
    -- GREATEST(1, ...) so a zero or negative window cannot silently become
    -- "all of history", which would make a weekly ranking a lifetime one.
    and s.discovered_at >= now() - (greatest(1, in_window_days) || ' days')::interval
  group by s.creator_handle
  order by total_views desc, shorts_seen desc, s.creator_handle asc
  limit greatest(1, in_limit)
$$;

-- ---------------------------------------------------------------------------
-- The refresh
-- ---------------------------------------------------------------------------
--
-- Idempotent: running it twice in a row changes nothing the second time, which
-- is what lets it be called before every run rather than needing its own
-- scheduler entry. The seven-day window rolls on its own, so "the 200 on a
-- weekly basis" falls out of the query rather than out of a cron expression.
--
-- IT DEACTIVATES RATHER THAN DELETES, because the 07 migration grants no DELETE
-- on this table and says why: the history is the point. A creator who drops out
-- of the top 200 this week and returns next week is reactivated, and their
-- `added_at` and `last_fetched_ok_at` are still the original ones.
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
    -- Upsert this platform's current top N as active automatic seeds.
    with ranked as (
      select creator_handle
      from shorts_scraper.top_creators(p, in_window_days, in_per_platform)
    )
    insert into shorts_scraper.platform_seeds (platform, seed, active, source, note)
    select
      p,
      r.creator_handle,
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

    -- Retire automatic seeds that are no longer in the window's top N. Manual
    -- rows are untouched by the `source` predicate.
    update shorts_scraper.platform_seeds ps
       set active = false,
           deactivated_at = now()
     where ps.platform = p
       and ps.source = 'auto'
       and ps.active
       and ps.seed not in (
         select creator_handle
         from shorts_scraper.top_creators(p, in_window_days, in_per_platform)
       );

    get diagnostics touched = row_count;
    affected := affected + touched;
  end loop;

  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- The 05 migration's rule, restated because a new function does not inherit an
-- argument: EXECUTE comes off public and anon explicitly, every time. These two
-- are called by the run path, which is a service_role process, and by nobody in
-- a browser — there is no longer a page that could call them.
revoke execute on function shorts_scraper.top_creators(shorts_scraper.platform, integer, integer) from public, anon, authenticated;
revoke execute on function shorts_scraper.refresh_auto_seeds(integer, integer) from public, anon, authenticated;

grant execute on function shorts_scraper.top_creators(shorts_scraper.platform, integer, integer) to service_role;
grant execute on function shorts_scraper.refresh_auto_seeds(integer, integer) to service_role;
