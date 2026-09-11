/**
 * THE INSTANT-FEEDBACK FALLBACK FOR A ROUTE CHANGE.
 *
 * Every admin page is `force-dynamic` — it renders on the server and reads
 * Supabase on each load. Without a loading boundary, Next keeps the CURRENT
 * page on screen until the TARGET page's server render finishes, so a nav click
 * looks like it did nothing for a beat and then jumps. A `loading.tsx` in each
 * route turns that dead beat into an immediate swap: the click shows this at
 * once, the real content replaces it when it arrives.
 *
 * One component, re-exported as the default from each route's `loading.tsx`, so
 * the four pages share one spinner rather than four copies drifting apart.
 */
export function RouteLoading() {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <span className="run-spinner" aria-hidden="true" />
      <span>Loading&#8230;</span>
    </div>
  );
}
