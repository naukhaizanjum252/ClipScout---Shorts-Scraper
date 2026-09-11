-- The privileges a schema that is not `public` does not get for free.
--
-- THIS FILE EXISTS BECAUSE MOVING OFF `public` BROKE SOMETHING INVISIBLE.
--
-- Erik decided on 2026-09-02 that this tool lands in LookUp Media's own
-- Supabase, in a database SHARED with the account's other projects, one schema
-- per tool. The migrations were re-homed from `public` into `shorts_scraper`
-- that day.
--
-- What went with them, silently, was every grant nobody had written down.
-- Supabase ships
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
-- so a table created in `public` is reachable by a signed-in session the moment
-- it exists, and RLS is then what decides which ROWS come back. That default
-- applies to `public` and to nothing else. In `shorts_scraper` the tables were
-- created with no privileges at all, which fails EARLIER than RLS and looks
-- completely different:
--
--     permission denied for table shorts
--
-- not "zero rows". Every policy in migration 04 would have been correct, every
-- assertion in tests/migrations.test.ts would have passed, and the app would
-- have returned nothing at all. That is precisely the class of defect the
-- static migration audit cannot see, and it is why verify/db.ts exists.
--
-- THE SCAR SURVIVES THE 2026-09-04 PIVOT UNCHANGED. The tables are different
-- ones now; the reason they arrive ungranted is not.
--
-- SO THE GRANTS ARE WRITTEN OUT, TABLE BY TABLE, AND THEY ARE NARROWER THAN THE
-- DEFAULT WOULD HAVE BEEN. That is the compensation for the extra file: `grant
-- all` was never right, and nothing is granted here that no policy backs.

-- ---------------------------------------------------------------------------
-- 1. `authenticated` — exactly what the policies in migration 04 allow
-- ---------------------------------------------------------------------------
--
-- A grant here is a NECESSARY condition, not a sufficient one: RLS still has
-- the final say on every row. The rule followed below is that a table gets a
-- privilege only where a policy in 20260901_04_rls.sql would let it through,
-- so the grant list and the policy list can be diffed by eye.

grant select, update on shorts_scraper.profiles to authenticated;

grant select, insert, update, delete on shorts_scraper.shorts to authenticated;

-- NOTE THE ABSENT `delete` ON BOTH RUN TABLES. It is absent on purpose. These
-- two rows are the only thing that distinguishes "this platform returned no
-- Shorts over the threshold" from "this platform could not be read at all",
-- after the list on the screen is gone. A session that can delete them can
-- erase the difference, and no policy in migration 04 allows it either.
grant select, insert, update on shorts_scraper.runs          to authenticated;
grant select, insert, update on shorts_scraper.run_platforms to authenticated;

grant select on shorts_scraper.credential_quota_days to authenticated;

-- `api_credentials` is deliberately NOT here. Migration 02 grants it
-- COLUMN BY COLUMN so that `secret_ciphertext` is unreachable by a browser
-- session, and a table-wide grant in this file would undo that quietly.

-- ---------------------------------------------------------------------------
-- 2. `service_role` — the unattended worker
-- ---------------------------------------------------------------------------
--
-- A scheduled or background "get latest shorts" has no user session, so it
-- cannot write as `authenticated`. It writes the inventory and its own run rows
-- and nothing else: no `profiles`, because it never decides who anybody is, and
-- no `api_credentials`, because it reaches a key only through
-- lease_api_credential() (migration 02), which is the single audited path to a
-- plaintext credential.
--
-- service_role BYPASSES RLS, so this list is the whole of what a background run
-- can touch. Keep it short.

grant select, insert, update, delete on shorts_scraper.shorts        to service_role;
grant select, insert, update         on shorts_scraper.runs          to service_role;
grant select, insert, update         on shorts_scraper.run_platforms to service_role;

-- ---------------------------------------------------------------------------
-- 3. Column-level grants are for `api_credentials` and nothing else
-- ---------------------------------------------------------------------------
--
-- Worth stating because the failure mode is silent and one-directional. A
-- TABLE-level grant covers every column, including columns added by a later
-- migration. A COLUMN-level grant does not: a new column on a column-granted
-- table arrives unreadable, which is the safe direction but an invisible one.
--
-- `api_credentials` is granted column by column deliberately, so that
-- `secret_ciphertext` stays unreachable. Every other table in this schema is
-- granted table-wide, and must stay that way — narrowing one later would mean
-- every future column needs its own grant, and nothing would go red when
-- somebody forgot.

-- ---------------------------------------------------------------------------
-- 4. anon still gets nothing, restated after the grants above
-- ---------------------------------------------------------------------------
--
-- Migration 05 revoked everything from `anon` before this file runs, and these
-- grants name `authenticated` and `service_role` only — so this is belt rather
-- than a fix. It is here because the failure mode is a future edit that adds
-- `anon` to one of the lists above, and a revoke placed AFTER them is the one
-- that survives it.

revoke all on all tables in schema shorts_scraper from anon;
revoke usage on schema shorts_scraper from public, anon;

notify pgrst, 'reload schema';
