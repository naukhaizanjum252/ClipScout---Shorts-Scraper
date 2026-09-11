-- Give `service_role` the grants the app now actually needs.
--
-- WHY THIS EXISTS. Sign-in was removed on 2026-09-04 (Erik's call: the scraper
-- is fully open). With no session there is no `authenticated` role, so every
-- server-side data path moved to `createSupabaseAdminClient()`, which connects
-- as `service_role`. Migrations 02, 06 and 07 had granted `service_role` only
-- what an unattended cron run needed — `shorts`, `runs`, `run_platforms`, plus
-- a partial hand on the seed tables. Everything the ADMIN PAGES do was granted
-- to `authenticated` and to nobody else.
--
-- So without this file the credentials page, the seeds page and the schedule
-- would fail against a database that is otherwise perfectly built. Note what
-- kind of failure that is: `service_role` bypasses RLS, so a missing POLICY
-- would have been silent (zero rows). A missing GRANT is not — Postgres refuses
-- the statement outright, and PostgREST returns 42501. Loud, but only if
-- somebody is looking at the right screen.
--
-- THE RULE FOLLOWED HERE: `service_role` is granted exactly what `authenticated`
-- already had for the same operation, and not one privilege more. The point is
-- to change WHO the app connects as, not to widen what the app may do.
--
-- The one thing deliberately NOT copied is `profiles`. `authenticated` has
-- select/update on it to resolve a signed-in person's role. Nothing resolves a
-- role any more — lib/auth/role.ts returns a constant and touches no database —
-- so granting it would be adding reach that no code uses.

-- ---------------------------------------------------------------------------
-- Seeds and proposals
-- ---------------------------------------------------------------------------
-- `service_role` could already select/update `platform_seeds` (the cron run
-- marks them fetched) and select/insert `seed_proposals` (it proposes). What it
-- could not do is what a PERSON does on the seeds page: add a seed by hand,
-- and accept or reject a proposal.

grant insert on shorts_scraper.platform_seeds to service_role;
grant update, delete on shorts_scraper.seed_proposals to service_role;

-- ---------------------------------------------------------------------------
-- Quota display
-- ---------------------------------------------------------------------------
-- Written only by `record_credential_units()`, which is SECURITY DEFINER and so
-- needs no grant. This is the READ that puts "units used today" on the
-- credentials page.

grant select on shorts_scraper.credential_quota_days to service_role;

-- ---------------------------------------------------------------------------
-- Stored API keys
-- ---------------------------------------------------------------------------
-- COLUMN BY COLUMN, DELIBERATELY, mirroring what migration 02 gave
-- `authenticated`. A plain `grant select on api_credentials to service_role`
-- would have been one line and would have handed `secret_ciphertext` to the
-- ordinary listing path.
--
-- That matters less than it did — `service_role` bypasses RLS, and anyone
-- holding the key can read any column by other means — but it keeps the
-- application's own read path unable to load a ciphertext by accident, which is
-- what stops one landing in a log line, an error message, or a React payload
-- sent to the browser. The ciphertext still has exactly one way out:
-- `lease_api_credential()`, which is SECURITY DEFINER and already granted.
--
-- The same consequence as migration 02 applies: a column added to this table
-- later arrives with NO grant and is invisible until it is named here too.

grant select (
  id, provider, label, masked, identifiers, status, created_at, created_by,
  last_used_at, last_check_ok, last_check_at, last_check_error, daily_quota_units
) on shorts_scraper.api_credentials to service_role;

-- INSERT carries the ciphertext, because saving a new key is what writes it.
grant insert (
  id, provider, label, secret_ciphertext, masked, identifiers, status, created_at, created_by, daily_quota_units
) on shorts_scraper.api_credentials to service_role;

-- UPDATE covers only the four columns the server writes back after a call --
-- the same four migration 02 named, and for the same reason: a "Test this key"
-- press must be able to record its result without being able to rewrite the key.
grant update (
  last_used_at, last_check_ok, last_check_at, last_check_error
) on shorts_scraper.api_credentials to service_role;

grant delete on shorts_scraper.api_credentials to service_role;
