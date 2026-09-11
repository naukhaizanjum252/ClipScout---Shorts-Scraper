-- ============================================================================
-- THE SCRAPER LEARNS WHAT TO LOOK FOR
-- ============================================================================
--
-- Luka, 2026-09-05, with a screenshot of /admin/shorts: "we need to tell it
-- what kinds of shorts to look for ... for example we things like shark tank,
-- top gear ... we need the scraper to be able to search for those specific
-- clips, not any random shorts with 500k+ views."
--
-- Everything this deployment could ask for until today was SIZE — a view
-- threshold and a duration window. Nothing anywhere said SUBJECT, so a run
-- returned the biggest Shorts on the platform and there was no way to ask for
-- Shark Tank. The client's plan (the "Lucky Plan" document, read 2026-09-05) is
-- thirty niche channels, each fed by one kind of clip, so "what kind" is not a
-- refinement of this product — it is most of it.
--
-- ---------------------------------------------------------------------------
-- A TOPIC IS A SUBJECT AND THE WORDS THAT FIND IT
-- ---------------------------------------------------------------------------
--
-- `terms` is what gets sent: `ytsearch:<term> #shorts` on YouTube keylessly,
-- ScrapeCreators' keyword endpoints on TikTok and Instagram, and an OR-group
-- ANDed onto the configured X query. Facebook cannot be searched by anybody at
-- any price and says so instead of returning an empty list — see
-- lib/platform/topical.ts for the per-platform evidence.
--
-- THE TERMS ARE NOT IN THE PLAN DOCUMENT. It names each niche and links example
-- clips; turning "Respect Moments" into words a search engine answers is a
-- translation somebody had to make. The rows below carry that translation as a
-- STARTING POINT, editable on /admin/topics, which is why they are rows and not
-- a constant in code.
--
-- ---------------------------------------------------------------------------
-- WHY THE SLUG IS THE ADDRESS AND THE NAME CANNOT BE EDITED
-- ---------------------------------------------------------------------------
--
-- `shorts.topic_slug` records which subject found a row, and it records the
-- SLUG rather than a foreign key to `topics.id`. Two reasons, and the second is
-- the binding one:
--
--   A slug is readable in a log, an export and a database console without a
--   join. `topic_slug = 'shark-tank'` needs no explanation.
--
--   A TOPIC MAY BE DELETED AND ITS HISTORY MUST SURVIVE. A foreign key forces
--   the choice between cascading (destroying the record of what a run found)
--   and restricting (making a topic undeletable). Neither is right for a label
--   describing something that already happened. The slug is a fact about the
--   run, not a pointer at a row that still has to exist.
--
-- The cost is that renaming a topic would orphan its history, so the store
-- refuses renames — `setTopicTerms` edits terms and nothing else, and changing
-- a name means deleting and re-adding, which is honest about what happens to
-- the rows.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO `topic_id` ON `platform_seeds`
-- ---------------------------------------------------------------------------
--
-- Tempting, and wrong. A seed is a CREATOR and a creator is not about one
-- subject: the channel that posts the best Shark Tank clips also posts other
-- things, and filing it under one topic would either stop it being read for the
-- others or make every row it produced claim a subject nobody searched for.
-- Topics search; seeds enumerate. They are two different questions and the
-- rows they produce are labelled differently — `topic_slug` is null for every
-- row a seeded walk found, which means "no subject was asked for" and not "the
-- subject is unknown".

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table if not exists shorts_scraper.topics (
  id           uuid primary key default gen_random_uuid(),

  -- What a person calls it. "Shark Tank".
  name         text not null check (btrim(name) <> '' and length(name) <= 80),

  -- The address. Lowercase, digits and single hyphens — the same rule
  -- `slugify` applies in lib/shorts/topics.ts, restated here because a slug
  -- that the database accepts and the client cannot produce is a row nothing
  -- can ever match.
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  -- The searches. NEVER EMPTY: a topic with no words is a subject nothing can
  -- be asked for, and a run that met one would have to either skip it silently
  -- or fall back to reading everything. Both are worse than refusing the row.
  terms        text[] not null check (
                 array_length(terms, 1) between 1 and 12
                 and array_position(terms, null) is null
                 and array_position(terms, '') is null
               ),

  -- Off means "do not search for this". There is no delete path in the store,
  -- for the same reason `platform_seeds` has none: a row that a session can
  -- remove is a row that takes its history with it.
  active       boolean not null default true,

  -- 'plan' = shipped from the client's plan document. 'manual' = somebody
  -- typed it. The distinction exists so a future "restore the defaults" can
  -- tell the two apart, and so nothing automatic ever overwrites a person's
  -- edit — the guard migration 11 had to add to `platform_seeds` after the
  -- fact.
  source       text not null default 'manual' check (source in ('plan', 'manual')),

  -- The channel these clips are being gathered FOR, when the plan names one.
  -- DISPLAY ONLY. Nothing reads it, nothing posts to it; it is here so an
  -- operator looking at a topic can tell which of the thirty channels it feeds.
  publishes_to text,

  note         text,
  added_at     timestamptz not null default now()
);

comment on table shorts_scraper.topics is
  'A subject to search for and the words that find it. Rows drive what every run asks each platform for; without them a run returns whatever is biggest, which is what Luka asked us to stop doing on 2026-09-05.';

comment on column shorts_scraper.topics.slug is
  'The address. Recorded on every short this topic found, so it must outlive the row: see the header on why this is not a foreign key.';

comment on column shorts_scraper.topics.terms is
  'What actually gets sent to each platform''s search. Edited by operators; the shipped values are a starting point translated from the plan document, not something the document stated.';

-- A run reads the active list every time. Partial, because the inactive rows
-- are history and are never walked.
create index if not exists topics_active_idx
  on shorts_scraper.topics (name)
  where active;

-- ---------------------------------------------------------------------------
-- The label on a short
-- ---------------------------------------------------------------------------
--
-- NULLABLE, AND NULL IS A REAL ANSWER: "no subject was asked for". Every row
-- this deployment has already stored gets null and that is correct — they were
-- found by untargeted reads, which is exactly the complaint that produced this
-- migration. Backfilling them with a guessed subject would be inventing the
-- provenance the column exists to record.
--
-- NOT A FOREIGN KEY. See the header.
alter table shorts_scraper.shorts
  add column if not exists topic_slug text
    check (topic_slug is null or topic_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

comment on column shorts_scraper.shorts.topic_slug is
  'The topic this row was searched for, or null when nothing was. Null means "no subject was asked for" — an untargeted read of a seeded channel — and never "the subject is unknown".';

-- The page groups by topic and then orders by views. Partial: the untargeted
-- rows are the majority today and are never selected by topic.
create index if not exists shorts_topic_idx
  on shorts_scraper.shorts (topic_slug, view_count desc)
  where topic_slug is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- The same shape as every other table in this schema (migration 04): readable
-- by anybody signed in, writable by admins, and the service role bypasses RLS
-- entirely so the run path is unaffected.
alter table shorts_scraper.topics enable row level security;

create policy "topics: members read"
  on shorts_scraper.topics for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "topics: admins insert"
  on shorts_scraper.topics for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "topics: admins update"
  on shorts_scraper.topics for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

create policy "topics: admins delete"
  on shorts_scraper.topics for delete
  to authenticated
  using (shorts_scraper.is_admin());

-- SPELLED OUT, NEVER `grant all`. Two reasons, and the second is the one that
-- bites: a privilege list a person can read is a privilege list a person can
-- check, and tests/migrations.test.ts audits every operation this application
-- performs against these lines by name. `grant all` is invisible to that audit,
-- so a table granted that way is a table nobody is checking.
grant select, insert, update, delete on shorts_scraper.topics to authenticated;

-- The run reads the topic list with no session in scope — see
-- `resolveTopicStore`, which builds an admin client exactly as the seed store
-- does. DELETE is deliberately absent: nothing in the run path deletes a topic,
-- and a grant nothing uses is a grant that outlives the reason for it.
grant select, insert, update on shorts_scraper.topics to service_role;

-- ---------------------------------------------------------------------------
-- The thirty niches from the plan
-- ---------------------------------------------------------------------------
--
-- `on conflict do nothing` so this migration is idempotent AND so a re-run can
-- never overwrite an operator's edited terms. The names and the `publishes_to`
-- handles are read straight out of the plan document; the terms are the
-- translation described in the header.
--
-- NFL/Baseball and American Artists/Female Artists share a channel in the plan.
-- They stay separate topics because they are separate searches.
insert into shorts_scraper.topics (name, slug, terms, source, publishes_to, note)
values
  ('Wholesome Animal',     'wholesome-animal',     array['wholesome animal','animal rescue','cute animal moment'],                      'plan', '@animalsdreamtoo',   'From the client''s plan document, 2026-09-05.'),
  ('Respect Moments',      'respect-moments',      array['respect moment','act of kindness','restored my faith in humanity'],           'plan', '@yougottarespect',   'From the client''s plan document, 2026-09-05.'),
  ('Military Clips',       'military-clips',       array['military moment','soldier homecoming','armed forces'],                        'plan', '@salutenow',         'From the client''s plan document, 2026-09-05.'),
  ('Brave Risks',          'brave-risks',          array['brave rescue','close call','dangerous stunt'],                                'plan', '@abitbrave',         'From the client''s plan document, 2026-09-05.'),
  ('Smart Animals',        'smart-animals',        array['smart animal','clever animal','animal intelligence'],                         'plan', '@sosoclever',        'From the client''s plan document, 2026-09-05.'),
  ('Rich People Moves',    'rich-people-moves',    array['rich people','luxury lifestyle','millionaire mindset'],                       'plan', '@wiredbymoney',      'From the client''s plan document, 2026-09-05.'),
  ('Famous Chef Clips',    'famous-chef-clips',    array['gordon ramsay','famous chef','chef reaction'],                                'plan', '@thechefster',       'From the client''s plan document, 2026-09-05.'),
  ('Top Gear Clips',       'top-gear-clips',       array['top gear','the grand tour','jeremy clarkson'],                                'plan', '@topofgear',         'From the client''s plan document, 2026-09-05.'),
  ('Car Facts',            'car-facts',            array['car facts','supercar fact','car engineering'],                                'plan', '@realmotorhub',      'From the client''s plan document, 2026-09-05.'),
  ('NFL',                  'nfl',                  array['nfl highlight','nfl moment','football touchdown'],                            'plan', '@realnflzone',       'From the client''s plan document, 2026-09-05.'),
  ('Baseball',             'baseball',             array['mlb highlight','baseball moment','home run'],                                 'plan', '@realnflzone',       'From the client''s plan document, 2026-09-05.'),
  ('NBA',                  'nba',                  array['nba highlight','nba moment','basketball crossover'],                          'plan', '@faststepball',      'From the client''s plan document, 2026-09-05.'),
  ('American Rappers',     'american-rappers',     array['rapper interview','rap freestyle','hip hop moment'],                          'plan', '@nahthisisrap',      'From the client''s plan document, 2026-09-05.'),
  ('American Artists',     'american-artists',     array['live vocal performance','singer live','artist performance'],                  'plan', '@realtalentartists', 'From the client''s plan document, 2026-09-05.'),
  ('Female Artists',       'female-artists',       array['female singer live','female artist performance','female vocalist'],           'plan', '@realtalentartists', 'From the client''s plan document, 2026-09-05.'),
  ('Bodycam',              'bodycam',              array['bodycam footage','police bodycam','bodycam arrest'],                          'plan', '@camonbodies',       'From the client''s plan document, 2026-09-05.'),
  ('Family Guy',           'family-guy',           array['family guy','peter griffin','family guy funny moment'],                       'plan', '@familyofguys',      'From the client''s plan document, 2026-09-05.'),
  ('Simpsons',             'simpsons',             array['the simpsons','homer simpson','simpsons prediction'],                         'plan', '@simpofthesons',     'From the client''s plan document, 2026-09-05.'),
  ('Business Advice',      'business-advice',      array['business advice','entrepreneur advice','business lesson'],                    'plan', '@nowthisisrich',     'From the client''s plan document, 2026-09-05.'),
  ('Shark Tank',           'shark-tank',           array['shark tank','shark tank pitch','dragons den'],                                'plan', '@pitchfastnow',      'From the client''s plan document, 2026-09-05.'),
  ('America''s Got Talent','americas-got-talent',  array['americas got talent','agt audition','golden buzzer'],                         'plan', '@wowrealtalent',     'From the client''s plan document, 2026-09-05.'),
  ('Breaking Bad',         'breaking-bad',         array['breaking bad','walter white','better call saul'],                             'plan', '@breakingitsobad',   'From the client''s plan document, 2026-09-05.'),
  ('Funny Movie Clips',    'funny-movie-clips',    array['funny movie clip','funny movie scene','comedy movie moment'],                 'plan', '@makeurdayclips',    'From the client''s plan document, 2026-09-05.'),
  ('Artists Making Music', 'artists-making-music', array['making a beat','studio session','producing a song'],                          'plan', '@secretartistcam',   'From the client''s plan document, 2026-09-05.'),
  ('Funny Celebrities',    'funny-celebrities',    array['funny celebrity moment','celebrity interview funny','celebrity bloopers'],    'plan', '@celebshavefun',     'From the client''s plan document, 2026-09-05.'),
  ('Court Cases',          'court-cases',          array['courtroom moment','court case','judge reaction'],                             'plan', '@courtisnojoke',     'From the client''s plan document, 2026-09-05.'),
  ('Technology',           'technology',           array['new technology','tech gadget','future tech'],                                 'plan', '@seriousbitoftech',  'From the client''s plan document, 2026-09-05.'),
  ('Golf',                 'golf',                 array['golf shot','golf highlight','pga tour'],                                      'plan', '@holeinshorts',      'From the client''s plan document, 2026-09-05.'),
  ('Gangster Films',       'gangster-films',       array['gangster movie scene','mafia movie','goodfellas scene'],                      'plan', '@realgmovies',       'From the client''s plan document, 2026-09-05.'),
  ('Streamer Clips',       'streamer-clips',       array['streamer clip','twitch clip','streamer reaction'],                            'plan', '@ohtheystreamin',    'From the client''s plan document, 2026-09-05.')
on conflict (slug) do nothing;
