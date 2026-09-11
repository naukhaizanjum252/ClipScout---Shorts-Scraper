import { createClient } from "@supabase/supabase-js";

import {
  DB_SCHEMA,
  supabaseServiceRoleKey,
  supabaseUrl,
  type TenantClient,
} from "./config";

/**
 * The client every server-side data path must use now that there is no sign-in.
 *
 * WHY THE COOKIE CLIENT ABOVE CANNOT BE USED FOR DATA: with sign-in removed
 * there is never a session, so `createSupabaseServerClient` presents the
 * publishable key and PostgREST treats the request as the `anon` role. RLS is
 * enabled on all nine tables (migration 04) and NO POLICY GRANTS `anon`
 * ANYTHING. So that client does not error — it returns zero rows, forever, and
 * the console renders an empty list against a perfectly healthy database. That
 * failure is silent, which is exactly why this is a separate function with a
 * name that says which one it is.
 *
 * This client presents the service-role key, which bypasses RLS entirely. That
 * is safe ONLY because it never leaves the server: it is built from
 * `SUPABASE_SERVICE_ROLE_KEY`, which has no `NEXT_PUBLIC_` prefix and so is
 * never inlined into a client bundle. Do not import this from a Client
 * Component.
 *
 * THROWS rather than falling back when the key is missing. A fallback to the
 * cookie client would produce the silent-empty-list failure above, and an
 * operator would reasonably read "no shorts found" as an answer about the world
 * rather than about their configuration.
 */
export function createSupabaseAdminClient(): TenantClient {
  const key = supabaseServiceRoleKey();
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set, so this server cannot read or write its own " +
        "database. Sign-in was removed, so there is no session to fall back to. Set it in " +
        ".env.local for local work and in the Vercel project settings for the deployment.",
    );
  }
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: DB_SCHEMA },
  }) as TenantClient;
}
