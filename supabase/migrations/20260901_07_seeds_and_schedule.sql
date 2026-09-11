-- Seeds become rows, and a run can fire on a clock instead of on a button.
--
-- WHY THIS MIGRATION EXISTS AT ALL
--
-- Two adapters need a seed list, because neither platform has a browse-
-- everything feed a key-less reader can walk. Until now that list lived in
-- `PLATFORM_SEEDS_<PLATFORM>` environment variables, which has two consequences
-- nobody chose:
--
--   1. The ops team cannot edit it. Adding one creator is a code change, a
--      commit and a redeploy, performed by whoever holds the deploy key.
--   2. Nothing records WHO added a seed, WHEN, or whether it has ever produced
--      anything. An env var is a string; it has no provenance and no history,
--      so "why are we fetching this creator" has no answer six weeks later.
--
-- A seed is therefore a row here. The environment variable still works and is
-- still read — see lib/shorts/seeds.ts for the resolution rule and, more to the
-- point, for why the database WINS OUTRIGHT rather than merging with it: a seed
-- deactivated on the page has to stop being fetched, and a union with the
-- environment would keep fetching it with nothing on screen saying why.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not turn any schedule on. `platform_schedule.enabled` defaults to
-- FALSE for all five rows and only a person can change it. That is deliberate
-- and it is about money: X charges per Post read, so a schedule that switched
-- itself on when a migration ran would start billing an operator's account for
-- a decision nobody made. Applying this file costs nothing and changes no
-- behaviour until somebody enables a platform.
--
-- THE PROPOSAL QUEUE IS NOT AN AUTOMATION, AND THAT IS THE HONEST ANSWER
--
-- Erik asked (2026-09-04) whether TikTok creators can be seeded automatically.
-- Key-lessly they cannot be DISCOVERED: yt-dlp 2026.07.04 marks tiktok:tag,
-- tiktok:sound and tiktok:effect CURRENTLY BROKEN and ships no trending
-- extractor, and all three official TikTok APIs are closed to this use. A
-- scheduler can refresh a known list; nothing available here can grow one.
--
-- What IS available is weaker and worth having anyway: a creator seen on one
-- platform very often uses the same handle on another. `seed_proposals` holds
-- those guesses, with the post the handle was read off, for a human to confirm.
-- NOTHING IS EVER PROMOTED AUTOMATICALLY. A proposal is a guess about IDENTITY,
-- and a wrong one does not fail loudly — it quietly fills the inventory with a
-- different person's videos under a name the operator trusts. There is no
-- column here that could hold an auto-accept flag, and adding one would be
-- adding the failure.

-- ---------------------------------------------------------------------------
-- 1. Seeds
-- ---------------------------------------------------------------------------
--
-- THE KEY IS (platform, seed) AND THE SEED IS STORED VERBATIM.
--
-- No pattern constraint, for the same reason `shorts.platform_video_id` carries
-- none (see migration 01): a YouTube seed is a channel id or an @handle, a
-- TikTok seed is a 76-character sec_uid, an Instagram seed is a professional
-- account's @username. One regex that admits all of those admits nearly
-- anything, so it validates nothing while looking like a guarantee. What a
-- valid seed looks like is a per-platform fact and it lives behind the
-- per-platform seam, where the adapter that meets it can say so in a sentence
-- an operator can act on — the TikTok adapter already names every seed of the
-- wrong shape in its `unavailableReason()`.
--
-- The only thing refused here is a blank one.

create table shorts_scraper.platform_seeds (
  platform            shorts_scraper.platform not null,

  -- Whatever the adapter for that platform takes. Handed on unchanged.
  seed                text not null check (btrim(seed) <> ''),

  -- DEACTIVATED, NEVER DELETED. There is no DELETE policy and no DELETE grant
  -- on this table further down, and that is the design: `added_by`, `added_at`
  -- and `last_fetched_ok_at` are the answer to "why were we fetching this
  -- creator, and did it ever work", and a row a browser session can remove is a
  -- row that takes the answer with it. Reactivating is flipping this back.
  active              boolean not null default true,

  -- Why this creator is in the list, in a person's words. Optional, because
  -- forcing a sentence produces "asdf" rather than a reason.
  note                text,

  added_at            timestamptz not null default now(),
  added_by            uuid references auth.users(id) on delete set null,
  deactivated_at      timestamptz,
  deactivated_by      uuid references auth.users(id) on delete set null,

  -- WHAT THIS COLUMN MEANS, EXACTLY, BECAUSE IT IS EASY TO OVER-READ.
  --
  -- The last time a run of THIS PLATFORM completed without throwing while this
  -- seed was active. It does NOT mean this seed produced a video, and it does
  -- not mean this creator still exists. No adapter reports a per-seed outcome —
  -- they loop their seeds internally and return one list — so per-seed success
  -- is not a fact this schema is in a position to hold, and inventing it would
  -- be the worst kind of column: one that reads like a health check and is not.
  -- It says "we asked". Nothing more.
  last_fetched_ok_at  timestamptz,

  primary key (platform, seed),

  -- A deactivation is a person and a moment, or it is neither. `deactivated_by`
  -- is allowed to be null on its own because `on delete set null` above will
  -- null it when an account is removed, and losing the name must not falsify
  -- the fact that it happened.
  constraint a_deactivation_has_a_time
    check (active or deactivated_at is not null)
);

create index platform_seeds_active_idx
  on shorts_scraper.platform_seeds (platform, active);

comment on table shorts_scraper.platform_seeds is
  'Creators an adapter reads, as editable rows rather than a redeployed environment variable. Seeds are deactivated, never deleted, so the provenance of a list survives the list.';

comment on column shorts_scraper.platform_seeds.last_fetched_ok_at is
  'The last time a run of this platform finished without error while this seed was active. It is NOT evidence that this seed returned anything: no adapter reports per-seed outcomes.';

-- ---------------------------------------------------------------------------
-- 2. Seed proposals — the guess, and the human step that is not skippable
-- ---------------------------------------------------------------------------
--
-- One row is one suggestion: "the handle @someone was seen on platform A, so it
-- might be the same creator on platform B". Three fields carry the evidence and
-- they are all `not null`, because a suggestion with no evidence is a suggestion
-- nobody can rule on and it will sit in the queue forever.
--
-- STATE IS A CHECKED TEXT COLUMN AND NOT AN ENUM, on purpose. A workflow state
-- gains values — `expired` is the obvious next one — and in Postgres a new enum
-- value cannot be USED in the same transaction that adds it, so growing an enum
-- is a two-migration dance. A check constraint is one `drop constraint` and one
-- `add constraint` in a single transaction. The set is small and closed either
-- way; this is the version that can move.

create table shorts_scraper.seed_proposals (
  id                 uuid primary key default gen_random_uuid(),

  -- The platform this seed is being proposed FOR.
  platform           shorts_scraper.platform not null,
  seed               text not null check (btrim(seed) <> ''),

  state              text not null default 'pending'
                       check (state in ('pending', 'accepted', 'rejected')),

  -- THE EVIDENCE. Where the handle was actually observed, and in what.
  observed_platform  shorts_scraper.platform not null,
  observed_handle    text not null check (btrim(observed_handle) <> ''),

  -- The canonical post URL the handle was read off. This is the permanent link
  -- and not a resolved media address — a direct media URL from any of these
  -- platforms is signed and dies within hours, and none is stored anywhere in
  -- this schema (migration 01 says why, and tests/migrations.test.ts enforces
  -- it across every table including this one).
  evidence_url       text not null check (btrim(evidence_url) <> ''),
  evidence_note      text,

  proposed_at        timestamptz not null default now(),

  -- WHICH RUN OR ADAPTER OBSERVED THIS. Provenance is recorded, never inferred
  -- later, the same rule `shorts.discovered_by` follows.
  proposed_by        text not null check (btrim(proposed_by) <> ''),

  decided_at         timestamptz,
  decided_by         uuid references auth.users(id) on delete set null,

  -- A proposal is about a DIFFERENT platform from the one the handle was seen
  -- on. Proposing a TikTok handle as a TikTok seed is not a cross-platform
  -- guess, it is a duplicate of something the run already had.
  constraint a_proposal_crosses_platforms
    check (platform <> observed_platform),

  -- Pending means undecided, and decided means a moment is recorded. Written as
  -- an equivalence rather than two implications so neither half can be added
  -- without the other. `decided_by` is deliberately NOT in it: `on delete set
  -- null` above can remove the name, and losing who decided must not be able to
  -- reopen the decision.
  constraint a_decision_has_a_time
    check ((state = 'pending') = (decided_at is null))
);

-- ONE RULING PER GUESS, FOREVER. Not partial on `state = 'pending'`, which
-- would let a rejected proposal be re-proposed by the next run and the one after
-- that — a human's "no" turned into a weekly notification. Reconsidering means
-- deleting the ruling, which is a deliberate act by a person.
create unique index seed_proposals_one_ruling_per_seed
  on shorts_scraper.seed_proposals (platform, seed);

create index seed_proposals_pending_idx
  on shorts_scraper.seed_proposals (state, proposed_at desc);

comment on table shorts_scraper.seed_proposals is
  'Cross-platform seed guesses awaiting a human. A handle seen on one platform, suggested for another, with the post it was read off. Nothing here is ever promoted to a seed automatically: a wrong guess about identity fills the inventory with the wrong creator and never announces itself.';

-- ---------------------------------------------------------------------------
-- 3. The schedule
-- ---------------------------------------------------------------------------
--
-- One row per platform: whether it is scheduled at all, when it may next be
-- claimed, and the lock that stops two overlapping fires reading the same
-- platform twice.
--
-- WHY THERE IS EXACTLY ONE GATE COLUMN AND NOT TWO
--
-- `claimable_after` carries BOTH "a run is in flight" and "the last run was too
-- recent", because a claim then has one predicate to evaluate and can be a
-- single conditional UPDATE:
--
--     update platform_schedule
--        set lock_token = ..., locked_at = now, claimable_after = now + ttl
--      where platform = $1 and enabled and claimable_after <= now
--     returning *
--
-- Postgres re-checks that predicate against the updated snapshot under a row
-- lock, so of two fires racing on the same row exactly one gets a row back and
-- the other gets none. Split across two nullable columns joined by OR, the same
-- claim needs a filter shape that is awkward to express through PostgREST and
-- easy to get subtly wrong, and getting it wrong means double-fetching a
-- metered API without anything going red.
--
-- THE LOCK EXPIRES, AND THE DIRECTION OF THE ERROR IS CHOSEN.
--
-- A worker that is killed mid-run never releases. So a claim also sets
-- `claimable_after` to a time-to-live in the future and any later fire may take
-- the row once that passes. A TTL that is too SHORT lets a slow run be
-- overtaken and the platform read twice; too LONG leaves a crashed platform
-- idle until it lapses, which an operator can end by pressing the button. The
-- second is recoverable and the first costs money, so the TTL is deliberately
-- generous and `lock_token` exists so a run whose lock was taken cannot write
-- over the new holder's state when it finally returns.
--
-- NOBODY HAS MEASURED HOW LONG A RUN TAKES. There is therefore no TTL default
-- in this table: the caller passes one and lib/shorts/schedule.ts says in prose
-- what its own figure is and that it is a ceiling rather than a measurement.
--
-- `min_interval_seconds` IS NULLABLE AND NULL IS THE HONEST DEFAULT. It is a
-- floor — "never read this platform more often than this" — and nobody has said
-- what any of the five should be. Null means the thing calling the entry point
-- decides the cadence, which is what a cron expression already is. A number here
-- is an operator overriding that downwards, and it is a number a person typed.

create table shorts_scraper.platform_schedule (
  platform              shorts_scraper.platform primary key,

  -- FALSE FOR EVERY PLATFORM WHEN THIS MIGRATION RUNS. X bills per Post read;
  -- a schedule that enabled itself on deploy would spend an operator's money on
  -- a decision nobody made.
  enabled               boolean not null default false,

  -- The single gate. In the past means claimable now.
  claimable_after       timestamptz not null default now(),

  -- An operator's floor on cadence, in seconds. Null means none has been set.
  min_interval_seconds  integer check (min_interval_seconds is null or min_interval_seconds > 0),

  -- The current holder. All three together, or none of them.
  lock_token            text check (lock_token is null or btrim(lock_token) <> ''),
  locked_at             timestamptz,
  lock_expires_at       timestamptz,

  last_started_at       timestamptz,
  last_finished_at      timestamptz,

  -- What the last finished run said about this platform, in the run report's own
  -- vocabulary. Null before the first one. This is a convenience for the page;
  -- the record that matters is in `run_platforms`, which cannot be deleted.
  --
  -- `partial` IS ITS OWN VALUE AND IS NOT FOLDED INTO `ok`. A platform read to a
  -- spend cap or a rate limit was read, but not to the end, so its list is
  -- missing a tail of unknown size. Compressing that into `ok` would put a green
  -- tick on the one row an operator most needs to look at twice.
  last_outcome          text check (last_outcome is null or last_outcome in ('ok', 'partial', 'unavailable', 'failed')),
  last_note             text,

  constraint a_lock_is_whole_or_absent
    check (
      (lock_token is null) = (locked_at is null)
      and (lock_token is null) = (lock_expires_at is null)
    )
);

-- THERE IS DELIBERATELY NO `last_finished_at >= last_started_at` CHECK HERE,
-- and the reason is worth writing down because its absence looks like an
-- oversight next to the identical constraint on `runs`.
--
-- On `runs` the two columns describe ONE run, so the ordering is a real
-- invariant. Here they describe whatever run touched the row last, and the
-- moment a second run starts, `last_started_at` is the new run's and
-- `last_finished_at` is still the previous run's — so the earlier finish time is
-- correctly BEFORE the later start time and a check would reject the update.
-- Nulling the finish time on every claim would satisfy the check and throw away
-- the answer to "when did this platform last actually complete", which is the
-- question the table exists to answer.

comment on table shorts_scraper.platform_schedule is
  'One row per platform: whether it is scheduled, when it may next be claimed, and the expiring lock that keeps two overlapping fires from reading it twice. Every platform starts disabled.';

comment on column shorts_scraper.platform_schedule.claimable_after is
  'The single claim gate. A claim sets it to now plus the lock time-to-live; a release sets it to the finish time plus min_interval_seconds. In the past means claimable.';

comment on column shorts_scraper.platform_schedule.min_interval_seconds is
  'An operator floor on cadence. Null means none has been set and whatever calls the entry point decides how often a platform runs.';

-- All five, always, from the enum itself so a sixth platform cannot be added to
-- the vocabulary and quietly have no schedule row. `do nothing` so re-running
-- this file is safe.
insert into shorts_scraper.platform_schedule (platform)
select unnest(enum_range(null::shorts_scraper.platform))
on conflict (platform) do nothing;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
--
-- Same model as the rest of the schema: read for any member, write for an
-- admin, nothing at all for anon. Every policy names its roles, because a
-- policy with no `to` clause applies to PUBLIC and PUBLIC includes anon.

alter table shorts_scraper.platform_seeds    enable row level security;
alter table shorts_scraper.seed_proposals    enable row level security;
alter table shorts_scraper.platform_schedule enable row level security;

-- --- platform_seeds ---------------------------------------------------------
--
-- No DELETE policy. Deactivating is the operation; see the `active` column.

create policy "platform_seeds: members read"
  on shorts_scraper.platform_seeds for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "platform_seeds: admins insert"
  on shorts_scraper.platform_seeds for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "platform_seeds: admins update"
  on shorts_scraper.platform_seeds for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

-- --- seed_proposals ---------------------------------------------------------
--
-- DELETE IS ALLOWED HERE AND IS NOT ALLOWED ON `runs`, AND THE DIFFERENCE IS
-- THE POINT. A run row is evidence: it is what separates "this platform
-- returned nothing" from "this platform could not be read", and a session that
-- can erase it can erase the difference. A proposal is a GUESS this tool made
-- about somebody's identity. Deleting one is how a person reopens a question
-- they answered before, which the unique index above otherwise closes forever.

create policy "seed_proposals: members read"
  on shorts_scraper.seed_proposals for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "seed_proposals: admins insert"
  on shorts_scraper.seed_proposals for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "seed_proposals: admins update"
  on shorts_scraper.seed_proposals for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

create policy "seed_proposals: admins delete"
  on shorts_scraper.seed_proposals for delete
  to authenticated
  using (shorts_scraper.is_admin());

-- --- platform_schedule ------------------------------------------------------
--
-- No INSERT policy and no INSERT grant: the five rows are created by this
-- migration from the enum, and a session that can add rows can add a sixth
-- platform's schedule that no adapter will ever read. No DELETE either, for the
-- same reason in reverse — a missing row is a platform that silently never runs.

create policy "platform_schedule: members read"
  on shorts_scraper.platform_schedule for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "platform_schedule: admins update"
  on shorts_scraper.platform_schedule for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- A grant is a NECESSARY condition and RLS still has the final say, so this
-- list is written to be diffable by eye against the policies above: a privilege
-- appears here only where a policy would let it through.
--
-- TABLE-WIDE, not column by column. `api_credentials` is the only table in this
-- schema granted per column, because it holds a secret. Narrowing one of these
-- would mean every column a later migration adds arrives unreadable with nothing
-- going red — the safe direction, but an invisible one.

grant select, insert, update on shorts_scraper.platform_seeds    to authenticated;
grant select, insert, update, delete on shorts_scraper.seed_proposals to authenticated;
grant select, update on shorts_scraper.platform_schedule to authenticated;

-- The unattended run. It claims and releases the schedule, records that it
-- asked a seed, and files the proposals a run observed. It does not decide any
-- of them: there is no path from `insert` on `seed_proposals` to a row in
-- `platform_seeds` that does not go through a person, and service_role has no
-- INSERT on `platform_seeds` precisely so that stays true by grant rather than
-- by everyone remembering.
--
-- service_role BYPASSES RLS, so this list is the whole of what a background run
-- can touch on these three tables.
grant select, update on shorts_scraper.platform_seeds    to service_role;
grant select, insert on shorts_scraper.seed_proposals    to service_role;
grant select, update on shorts_scraper.platform_schedule to service_role;

-- Belt, restated after the grants above, exactly as migration 06 does it. The
-- failure this catches is a future edit that adds `anon` to one of the lists,
-- and a revoke placed AFTER them is the one that survives it.
revoke all on all tables in schema shorts_scraper from anon;
revoke usage on schema shorts_scraper from public, anon;

notify pgrst, 'reload schema';
