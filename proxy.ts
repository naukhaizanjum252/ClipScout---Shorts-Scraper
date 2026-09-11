import { type NextRequest, NextResponse } from "next/server";

/**
 * THERE IS NO GATE HERE ANY MORE. Erik's call, 2026-09-04: the scraper is fully
 * open. Every path under /admin is reachable by anyone who has the URL.
 *
 * What this file used to do, and why none of it survives:
 *
 *   - Redirect signed-out visitors to /admin/login. Deleted with the login page
 *     itself. Nothing signs in, so a redirect could only ever have been a wall.
 *   - Call `updateSession` to refresh the Supabase auth cookie. Deleted because
 *     it made a network round-trip to Supabase on EVERY matched request to
 *     refresh a session that no longer exists. That was latency spent on
 *     nothing.
 *   - Consult `previewEnabled()` and `isSupabaseConfigured` to decide whether a
 *     keyless deploy should be walked past the gate. With no gate, there is
 *     nothing to walk past.
 *
 * WHAT REMAINS is the one thing the app actually reads from the proxy: the
 * `x-pathname` request header, which app/(admin)/admin/layout.tsx uses to mark
 * the current nav item. It is set from `request.nextUrl.pathname` — a value the
 * server derived — and OVERWRITES any `x-pathname` the caller tried to send, so
 * a client cannot forge it.
 *
 * SECURITY NOTE, STATED PLAINLY SO IT IS NOT DISCOVERED LATER: the protection
 * on this deployment is now the secrecy of the URL, nothing else. Anyone with
 * the link can trigger runs that spend metered API quota, and can add or delete
 * stored API keys. Stored secrets stay unreadable — they are encrypted with
 * CREDENTIALS_ENCRYPTION_KEY, which lives outside the database — but they can
 * be REPLACED by anyone who reaches the page. Restoring a gate means restoring
 * this redirect and `getViewer` in lib/auth/role.ts together; neither works
 * alone.
 */
export async function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/(admin(?:/.*)?|(?!_next/static|_next/image|favicon\.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
