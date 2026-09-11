/**
 * THERE IS NO SIGN-IN. Erik's call, 2026-09-04: the scraper is fully open —
 * anyone who can reach the URL can use every part of it.
 *
 * This file is the one place that decision is implemented. It keeps the
 * `Viewer` shape the rest of the app already reads so the change did not have
 * to ripple through seven call sites, but every field now says, truthfully,
 * that nobody has been identified:
 *
 *   userId: null   — no account exists to point at. The database's actor
 *                    columns (`created_by`, `started_by`, `added_by`,
 *                    `decided_by`) are all `uuid references auth.users(id)`
 *                    and all NULLABLE, so null is a value they accept and a
 *                    reader can interpret. A synthetic UUID here would have
 *                    been a lie stored under a foreign key that points nowhere.
 *   email:  null   — same reason.
 *   role:   owner  — not a claim about a person. It is how "no gate" is spelled
 *                    in the vocabulary the call sites already speak.
 *
 * WHAT THIS COSTS, PLAINLY: audit trails record WHAT happened and WHEN, never
 * WHO. Restoring sign-in means restoring `getViewer` to read a session; the
 * call sites do not change.
 */
export type UserRole = "owner" | "admin" | "member";

export interface Viewer {
  /** Null whenever nobody is signed in — which, right now, is always. */
  readonly userId: string | null;
  readonly email: string | null;
  readonly role: UserRole;
}

/**
 * The single viewer this app has. Frozen so a caller cannot quietly mutate the
 * shared object and change what every later caller sees.
 */
export const OPEN_ACCESS: Viewer = Object.freeze({
  userId: null,
  email: null,
  role: "owner",
});

export function isAdmin(viewer: Viewer | null): boolean {
  return viewer !== null && (viewer.role === "owner" || viewer.role === "admin");
}

/**
 * Never returns null and never touches the network. Kept `async` because every
 * call site awaits it, and because a future sign-in would need to be async
 * again.
 */
export async function getViewer(): Promise<Viewer> {
  return OPEN_ACCESS;
}
