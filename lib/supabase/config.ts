import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase wiring.
 *
 * WHICH project this points at was decided by Erik on 2026-09-02, answering the
 * plan's open question Q4: LookUp Media's own Supabase, in a database SHARED
 * with the account's other projects, because a Supabase project per tool costs
 * $10/month each and there are a lot of tools.
 *
 * Everything here still has to work when it is not configured at all, because
 * that is the state the default keyless (`ytdlp`) path runs in — `pnpm seed`
 * needs no database, no key and no `.env.local`.
 */

/**
 * The schema this tool owns. THE ISOLATION BOUNDARY IN A SHARED DATABASE.
 *
 * Every table, type and function in supabase/migrations/ lives here and nothing
 * lives in `public`, so a co-tenant project in the same database cannot be
 * reached from this app and cannot be damaged by this app's grants. Migration
 * 01 section 0 has the full reasoning; tests/migrations.test.ts fails the build
 * if `public` reappears in a migration.
 *
 * OPERATOR STEP, and it is easy to miss: PostgREST only serves schemas listed
 * in the project's `Settings -> API -> Exposed schemas`. Add `shorts_scraper`
 * there, alongside whatever the co-tenants have listed, or every query from
 * this app returns PGRST106. `verify/db.ts --check` reports that case by name
 * rather than as an opaque failure.
 */
export const DB_SCHEMA = "shorts_scraper";

/**
 * A Supabase client already pointed at this tool's schema.
 *
 * The type parameter is not decoration: `supabase-js` carries the schema name
 * in the client's TYPE, so a plain `SupabaseClient` — which defaults to
 * `"public"` — will not assign to one of these. That is the compiler refusing a
 * client that would read the wrong tenant's tables in a shared database, and it
 * is why `resolve.ts` stopped compiling the moment `DB_SCHEMA` was introduced.
 * Keep the alias; do not widen it back to `SupabaseClient`.
 */
export type TenantClient = SupabaseClient<any, typeof DB_SCHEMA>;
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

/**
 * The service-role key.
 *
 * SERVER ONLY, and read through a function rather than exported as a constant
 * so that importing this module from a client component cannot bundle it. It is
 * needed for exactly one thing: `lease_api_credential`, the SECURITY DEFINER
 * function that hands an ingest worker the plaintext of an operator's key. That
 * function is granted to `service_role` and to nothing else — not `anon`, not
 * `authenticated`, not PUBLIC — so an admin's browser session cannot reach a
 * key even though the admin is the person who pasted it in.
 *
 * Nothing else in this repo may use it. If a second caller appears, that is the
 * moment to ask whether it should be a definer function instead.
 */
export function supabaseServiceRoleKey(): string | null {
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return raw ? raw : null;
}
