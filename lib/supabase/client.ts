import { createBrowserClient } from "@supabase/ssr";

import { DB_SCHEMA, supabasePublishableKey, supabaseUrl } from "./config";

/**
 * The browser client. Carries the publishable key and nothing else — no
 * service-role key ever ships to a browser, and the one function that yields a
 * plaintext API credential is granted to `service_role` alone, so this client
 * cannot reach it even with a valid admin session.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: DB_SCHEMA },
  });
}
