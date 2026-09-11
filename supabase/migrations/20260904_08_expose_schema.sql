-- Make the shorts_scraper schema reachable over PostgREST.
--
-- WHY THIS MIGRATION EXISTS. Every request to this project's REST endpoint
-- came back:
--
--   {"code":"PGRST106","message":"Invalid schema: shorts_scraper",
--    "hint":"Only the following schemas are exposed: public, graphql_public"}
--
-- ...for the service-role key as well as the anon key. PostgREST refuses a
-- schema that is not on its allow-list before it ever considers RLS, so the
-- nine tables built by migrations 01-07 were unreachable from the app despite
-- existing, being correctly permissioned, and passing every audit.
--
-- The Supabase dashboard exposes this as Settings -> Data API -> "Exposed
-- schemas". That dashboard control does exactly what the statement below does:
-- it sets the `pgrst.db_schemas` GUC on the `authenticator` role, which is the
-- role PostgREST connects as, and then tells PostgREST to re-read its config.
-- Doing it here keeps it with the rest of the schema, versioned and reviewable,
-- instead of living only as a checkbox somebody has to remember to tick.
--
-- THE ONE THING TO KNOW BEFORE RUNNING IT: the value is absolute, not additive.
-- It replaces the whole list, so `public` and `graphql_public` are repeated
-- below deliberately. Dropping either one takes Supabase's own tooling offline
-- for this project. If this project ever gains another tool's schema, that
-- schema must be added to this line too, and this file is where it goes.

alter role authenticator
  set pgrst.db_schemas = 'public, graphql_public, shorts_scraper';

-- PostgREST caches its configuration. Without this it keeps serving the old
-- allow-list until the next connection recycle, which can be minutes.
notify pgrst, 'reload config';

-- Also reload the schema cache, so the tables inside the newly exposed schema
-- are visible immediately rather than after the next cache refresh. Skipping
-- this produces PGRST205 ("table not found") on a schema that IS exposed --
-- a confusingly different error for the same underlying staleness.
notify pgrst, 'reload schema';
