import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, supabasePublishableKey, supabaseUrl } from "./config";

/**
 * Session refresh on every request. Ported from `impressions/lib/supabase/proxy.ts`.
 *
 * WHY IT TAKES HEADER OVERRIDES NOW, AND WHY THEY CANNOT LIVE IN THE CALLER.
 *
 * proxy.ts needs the request pathname to reach the admin layout, and the only
 * way to change what a server component's `headers()` returns is
 * `NextResponse.next({ request: { headers } })`. Every `NextResponse` this
 * function returns is built here, including the one rebuilt inside `setAll`
 * after Supabase rotates the auth cookies — so a caller that set the header on
 * the response it got back would be setting it on the wrong channel, and a
 * caller that handed in a pre-built `Headers` snapshot would lose the refreshed
 * cookies, because `request.cookies.set` mutates `request.headers` and the
 * snapshot would predate it.
 *
 * Hence: the caller passes NAMES AND VALUES, and this file re-derives the
 * headers from the live request at each point it constructs a response. The
 * cookie refresh and the pathname override both survive, which they could not
 * do at the same time under any arrangement where the caller owned the Headers
 * object.
 */

/** Request headers the proxy wants a server component to see. Set, not merged. */
export type RequestHeaderOverrides = Readonly<Record<string, string>>;

/**
 * A pass-through response whose REQUEST headers carry `overrides`.
 *
 * `set` rather than `append` is deliberate and is half the fix for the forged
 * `x-pathname` this replaced: a value the caller sent on the wire is
 * overwritten, never read through, so nothing downstream can be handed a
 * client's claim about which page it is on.
 */
function nextWithRequestHeaders(request: NextRequest, overrides: RequestHeaderOverrides) {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  return NextResponse.next({ request: { headers } });
}

export async function updateSession(request: NextRequest, overrides: RequestHeaderOverrides) {
  // Unconfigured still gets the overrides. The admin layout renders on this
  // path too — it is the README's first-deploy state — and a nav that
  // highlights the wrong link there would be a bug reported from the exact
  // deploy nobody has credentials to debug.
  if (!isSupabaseConfigured) return nextWithRequestHeaders(request, overrides);

  let supabaseResponse = nextWithRequestHeaders(request, overrides);

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // Rebuilt from the request as it now stands: the line above has already
        // written the rotated cookies into `request.headers`, so this response
        // forwards the FRESH session to the server component, with the
        // overrides re-applied on top. Dropping the overrides here was the
        // failure mode this shape exists to prevent — the header would be
        // present on every ordinary request and mysteriously absent on exactly
        // the requests where a token had just been refreshed.
        supabaseResponse = nextWithRequestHeaders(request, overrides);
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
        Object.entries(headers ?? {}).forEach(([key, value]) =>
          supabaseResponse.headers.set(key, value as string),
        );
      },
    },
  });

  await supabase.auth.getClaims();

  return supabaseResponse;
}
