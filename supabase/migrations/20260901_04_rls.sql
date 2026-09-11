-- RLS. The whole access model in one file, every table in this schema.
--
-- THERE IS NO ANON POLICY ANYWHERE, AND THAT IS THE DESIGN.
--
-- Carried deliberately from `impressions/supabase/migrations/20260822_03_rls.sql`,
-- including the thing that repo learned the hard way: a policy is only half the
-- door. The other half is EXECUTE on functions, which Postgres grants to PUBLIC
-- on creation AND Supabase grants to `anon` on top. Closing one leaves the
-- other. See 20260901_05_lock_function_grants.sql, and
-- tests/migrations.test.ts, which fails if a function is ever added without
-- both revokes.
--
-- There is no public surface in this tool — no share tokens, no intake form,
-- nothing an unauthenticated request should reach. So `anon` gets nothing at
-- all, which is the easiest version of this to keep true.
--
-- WHAT CHANGED IN THE PIVOT. The old access model had a hole shaped like a
-- state machine: `channels` had no UPDATE policy at all, because a curation
-- decision could only be made through a SECURITY DEFINER function that
-- attributed it to a person. There is no curation any more, so there is no such
-- function and no such gap. `shorts` is ordinary inventory: a run writes it,
-- an admin can correct or delete a row, a member can read it. Anything that
-- needs a human decision recorded against it is not in this product.

alter table shorts_scraper.profiles              enable row level security;
alter table shorts_scraper.shorts                enable row level security;
alter table shorts_scraper.runs                  enable row level security;
alter table shorts_scraper.run_platforms         enable row level security;
alter table shorts_scraper.api_credentials       enable row level security;
alter table shorts_scraper.credential_quota_days enable row level security;

-- --- profiles --------------------------------------------------------------

create policy "profiles: read own"
  on shorts_scraper.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles: admins read all"
  on shorts_scraper.profiles for select
  to authenticated
  using (shorts_scraper.is_admin());

-- Nobody edits their own role from the client. Role changes are a service-role
-- operation, the same rule `impressions` settled on.
create policy "profiles: update own name"
  on shorts_scraper.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and app_role = (select p.app_role from shorts_scraper.profiles p where p.id = (select auth.uid()))
  );

-- --- shorts ----------------------------------------------------------------
--
-- Read for any member, write for an admin. UPDATE exists because view counts
-- move and a re-run refreshes them in place; DELETE exists because the client
-- asked for the rest to be axed, and a list that can only grow is not the
-- product he described.

create policy "shorts: members read"
  on shorts_scraper.shorts for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "shorts: admins insert"
  on shorts_scraper.shorts for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "shorts: admins update"
  on shorts_scraper.shorts for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

create policy "shorts: admins delete"
  on shorts_scraper.shorts for delete
  to authenticated
  using (shorts_scraper.is_admin());

-- --- runs and run_platforms ------------------------------------------------
--
-- No DELETE policy on either, and that is the point of them. The run record is
-- what separates "this platform returned nothing" from "this platform could not
-- be read", and a record that can be tidied away from a browser session stops
-- being evidence. UPDATE is allowed because a run is written when it starts and
-- finished when it ends.

create policy "runs: members read"
  on shorts_scraper.runs for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "runs: admins insert"
  on shorts_scraper.runs for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "runs: admins update"
  on shorts_scraper.runs for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

create policy "run_platforms: members read"
  on shorts_scraper.run_platforms for select
  to authenticated
  using (shorts_scraper.can_read());

create policy "run_platforms: admins insert"
  on shorts_scraper.run_platforms for insert
  to authenticated
  with check (shorts_scraper.is_admin());

create policy "run_platforms: admins update"
  on shorts_scraper.run_platforms for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

-- --- api_credentials -------------------------------------------------------
--
-- Admins only, on every verb they have at all. The column-level grants in
-- migration 02 are what stop even an admin reading `secret_ciphertext` back.
--
-- SCAR, 2026-09-04 review. This paragraph used to read "Note there is NO UPDATE
-- policy: `last_used_at` and the check results are written by the server" — a
-- sentence that is true about WHO decides the values and false about WHICH ROLE
-- writes them. There is no server-side role here. `SupabaseCredentialBackend`
-- is handed the admin's session client by `resolveCredentialStore()`, so
-- `noteCheck` and `noteUse` are UPDATEs issued as `authenticated`, and with no
-- policy and no grant every one of them was refused. The visible symptom would
-- have been the worst kind: press "Test this key", pay for the call, watch it
-- succeed upstream, and read a PostgREST permission error on the screen.
-- Nothing in the suite noticed, because the store's tests use the in-memory
-- backend, which has no grants to get wrong.
--
-- THE POLICY IS DELIBERATELY WIDER THAN THE GRANT, and the grant is the narrow
-- half. This says "an admin may update a credential row"; migration 02's
-- `grant update (last_used_at, last_check_ok, last_check_at, last_check_error)`
-- says which columns that can possibly mean. Postgres checks the column
-- privilege first and independently of RLS, so the ciphertext is out of reach
-- even for a session this policy admits — which is the same belt-and-braces
-- split the SELECT side already runs on.

create policy "api_credentials: admins read"
  on shorts_scraper.api_credentials for select
  to authenticated
  using (shorts_scraper.is_admin());

create policy "api_credentials: admins insert"
  on shorts_scraper.api_credentials for insert
  to authenticated
  with check (shorts_scraper.is_admin());

-- What an UPDATE here is FOR: recording that a key was tested or used. Both
-- halves are named because a policy with a `using` and no `with check` would
-- let a row be updated INTO a state the same policy would refuse to admit.
create policy "api_credentials: admins record a check"
  on shorts_scraper.api_credentials for update
  to authenticated
  using (shorts_scraper.is_admin())
  with check (shorts_scraper.is_admin());

create policy "api_credentials: admins delete"
  on shorts_scraper.api_credentials for delete
  to authenticated
  using (shorts_scraper.is_admin());

-- --- credential_quota_days -------------------------------------------------
--
-- Readable by a member so the UI can say how much of an operator's allowance a
-- run consumed. Written only by `record_credential_units()`, which is
-- service_role's alone.

create policy "credential_quota_days: members read"
  on shorts_scraper.credential_quota_days for select
  to authenticated
  using (shorts_scraper.can_read());

notify pgrst, 'reload schema';
