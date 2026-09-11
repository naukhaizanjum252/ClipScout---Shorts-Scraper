import { redirect } from "next/navigation";

/**
 * `/` IS NOT A PAGE ANY MORE. It is a doorway onto the tool.
 *
 * Erik, 2026-09-04, looking at the running app: *"This screen is useless cut
 * it, cut the sign in and drop me on the home page for this thing."*
 *
 * What used to be here was a landing page — a headline, two call-to-action
 * buttons, and a status table listing which of the five platforms had a reader.
 * It was written for a signed-out visitor, and the reasoning behind every
 * sentence of it was that a stranger might arrive at `/` and need to be told
 * what the tool was before being allowed in. Three things killed that premise
 * at once:
 *
 *   1. NOBODY IS SIGNED OUT. The gate was removed the same day (see
 *      lib/auth/role.ts). There is no "outside" to write copy for — the first
 *      screen and the tool are now the same audience.
 *   2. IT ASKED FOR A SECOND CLICK TO REACH THE ONLY ACTION. The product is one
 *      button. A page whose entire job was to point at that button was a step
 *      between the operator and the thing they came for.
 *   3. IT KEPT A SECOND COPY OF THE PLATFORM READINESS TABLE. /admin/shorts
 *      reports per-platform readiness from the run that just happened. The copy
 *      here was asserted by hand and could only ever drift — the exact failure
 *      the old file's own header comment spent forty lines warning about.
 *
 * WHY A REDIRECT RATHER THAN MOVING THE CONSOLE TO `/`. The shorts console,
 * seeds and credentials are one shell with one nav rail, and that shell is the
 * `app/(admin)` route group — tests/admin-routes.test.ts walks that directory to
 * discover every route the app serves. Hoisting one of the three to `/` would
 * split the group for a cosmetic gain in the address bar and cost the suite its
 * only route-discovery mechanism.
 *
 * WHY IT IS A PAGE REDIRECT AND NOT A PROXY ONE. proxy.ts contains no redirect
 * at all, and tests/admin-routes.test.ts asserts that as a whole-file property —
 * "not 'the redirect is narrow' but 'there is no redirect'" — because that is
 * what stops the deleted auth gate creeping back in. Putting this one there
 * would cost that guarantee to save nothing.
 */
export default function Home() {
  redirect("/admin/shorts");
}
