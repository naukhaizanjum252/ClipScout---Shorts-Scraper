-- Close both doors, and stop the next function inheriting them.
--
-- THIS FILE EXISTS BECAUSE OF AN AUDIT IN ANOTHER REPO. `impressions` shipped
-- with a design that said "the publishable key reaches three functions"; an
-- audit of the actual grants found TWELVE OF FIFTEEN functions callable by
-- `anon`. Not a leak — every body happened to be guarded — but the claim was
-- false, and the next function added would have been world-callable with nobody
-- finding out.
--
-- The cause is that there are TWO grants and a revoke has to close both:
--
--   PUBLIC   Postgres grants EXECUTE on every new function to PUBLIC.
--   anon     Supabase ships, for the `public` schema,
--              alter default privileges in schema public
--                grant execute on functions to anon, authenticated;
--            so a function created THERE gets an EXPLICIT anon grant on top.
--
-- This repo creates nothing in `public` (see migration 01, section 0), so the
-- second grant should not reach us. "Should not" is not an argument this file
-- accepts — Supabase can change that shipped default, and a future hand can
-- create a schema differently. Both revokes stay, they cost nothing, and
-- verify/db.ts reads the real ACLs out of `pg_proc` rather than trusting this
-- reasoning.
--
-- `revoke ... from public` does not remove the named `anon` grant, and
-- `revoke ... from anon` does not remove the PUBLIC one. Each looks like it
-- worked. That is the whole trap, and it is why every revoke in this repo says
-- `from public, anon` and why tests/migrations.test.ts fails a build where one
-- of them does not.

-- ---------------------------------------------------------------------------
-- 1. Every function created in migrations 01 and 02
-- ---------------------------------------------------------------------------

revoke execute on function shorts_scraper.short_max_seconds() from public, anon;
revoke execute on function shorts_scraper.role_of()           from public, anon;
revoke execute on function shorts_scraper.is_admin()          from public, anon;
revoke execute on function shorts_scraper.can_read()          from public, anon;

-- ---------------------------------------------------------------------------
-- 2. Give back exactly what a signed-in session needs, and nothing else
-- ---------------------------------------------------------------------------
--
-- The capability functions are NOT optional. RLS policy expressions are
-- evaluated as the QUERYING role, so every policy in 20260901_04_rls.sql calls
-- `is_admin()` / `can_read()` as `authenticated`. Revoke those without granting
-- them back and the app reads nothing at all.

grant execute on function shorts_scraper.role_of()   to authenticated;
grant execute on function shorts_scraper.is_admin()  to authenticated;
grant execute on function shorts_scraper.can_read()  to authenticated;

-- `short_max_seconds()` is used by the generated column on `shorts`, which is
-- evaluated as the table owner, not as the caller. Nobody else needs it.

-- ---------------------------------------------------------------------------
-- 3. The default, for both roles
-- ---------------------------------------------------------------------------
--
-- The root cause rather than the symptom. After this, a function created in
-- `shorts_scraper` is NOT callable by anon or by PUBLIC, and anything that
-- genuinely needs to be has to say so in as many words.
--
-- Note the blast radius, which is the point of the schema move: every statement
-- in this section names `shorts_scraper`. The same statements against `public`
-- would reach across a shared database and revoke a co-tenant project's grants.
--
-- Deliberately the safe direction to fail in: a function that should have been
-- reachable and is not shows up the first time somebody opens the page; one
-- that should have been private and is not shows up too late.

alter default privileges in schema shorts_scraper revoke execute on functions from public;
alter default privileges in schema shorts_scraper revoke execute on functions from anon;

-- ---------------------------------------------------------------------------
-- 4. And the tables
-- ---------------------------------------------------------------------------
--
-- There is no public surface in this tool — no share tokens, no intake form,
-- nothing an unauthenticated request should reach — so `anon` gets nothing at
-- table level either. RLS with no anon policy already returns zero rows; this
-- makes it a grant fact rather than a policy fact, which is the version that
-- survives somebody adding a permissive policy later.

revoke all on all tables in schema shorts_scraper from anon;
revoke all on all sequences in schema shorts_scraper from anon;
alter default privileges in schema shorts_scraper revoke all on tables from anon;
alter default privileges in schema shorts_scraper revoke all on sequences from anon;

notify pgrst, 'reload schema';
