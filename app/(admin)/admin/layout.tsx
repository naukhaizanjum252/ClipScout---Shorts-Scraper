import Link from "next/link";

import { getViewer, isAdmin } from "@/lib/auth/role";
import { resolveCredentialStore } from "@/lib/credentials/resolve";

import { checkScrapeCreatorsCreditsAction } from "./credentials/actions";
import { NavCredits } from "./nav-credits";
import { NavLinks } from "./nav-links";

/**
 * The admin shell. It exists because /admin is more than one page, and a person
 * who lands on the shorts list has no other way back to the credential settings
 * that make a metered platform readable.
 *
 * IT IS NOW THE SAME SHELL AS `impressions`. Erik, 2026-09-04, looking at the
 * running app: *"Same style as all of the other luka tools please."* The thin
 * top bar with two underlined text links was the exact thing impressions/
 * DESIGN.md lists under `avoid` — flat near-black, hairline grey rules, square
 * corners, zero depth — so this is that repo's rail, ported rather than
 * reinvented: a 236px `.rail` with a `.mark` wordmark and `.nav-item` entries,
 * the active one lit with `--accent-soft` and an inset violet ring. The classes
 * are impressions' own, so somebody moving between the two tools sees no seam.
 *
 * WHAT THE PIVOT CHANGED HERE, 2026-09-04. The first link was Channels and it
 * is now Shorts, because the channel inventory and its review queue were a
 * misread of the brief and have been deleted. One action, one list.
 *
 * SEEDS ARRIVED IN THE RAIL ON 2026-09-04, and it is a third link rather than a
 * tab inside Shorts for a reason worth stating. The list of creators an adapter
 * reads used to be an environment variable, so the only way to change it was a
 * commit and a redeploy — which is to say it was not part of the app at all. It
 * is now rows somebody edits, and a thing the ops team maintains between runs
 * belongs beside the run rather than inside it. It also carries the schedule and
 * the queue of suggested creators, neither of which is about any one list of
 * shorts.
 *
 * IT SITS BETWEEN SHORTS AND CREDENTIALS because that is the order somebody sets
 * this tool up in: look at the results, notice a platform is empty, name the
 * creators it should read, and only then go and pay for a key if it still cannot
 * run.
 *
 * WHY THE RAIL NO LONGER CARRIES A "SOURCE" FOOTER, AND WHY THAT IS AN HONESTY
 * FIX RATHER THAN A TIDY-UP. It used to print `describeSource()` — one adapter
 * name and one sentence — on the reasoning that a reviewer should not have to
 * open Credentials to remember whether they were looking at a keyless walk or a
 * billed API. That reasoning was sound when there was one source. There are now
 * five platforms with five different answers, and three of them cannot run at
 * all; a single global source line in the chrome would be a claim that is wrong
 * for most of the screen, sitting in the one place that appears on every page.
 * Per-platform readiness moved to /admin/shorts, next to the rows it describes,
 * where it is reported by the run that just happened rather than asserted by
 * the furniture.
 *
 * HOW IT KNOWS WHICH PAGE IS OPEN, AND THE BUG THAT CHANGED THE ANSWER.
 *
 * This layout used to work it out itself, by reading the `x-pathname` header
 * proxy.ts attaches to every request. That was wrong in a way that only shows
 * up after the second click: A LAYOUT DOES NOT RE-RENDER ON A CLIENT-SIDE
 * NAVIGATION between two pages that share it, so the header it read was from
 * whichever admin page loaded FIRST and the chip never moved again. Erik hit it
 * on 2026-09-05 and sent a screenshot of the Seeds page with Credentials lit.
 *
 * The limit was documented HERE, in this comment, naming this exact fix and
 * calling it "worth fixing next" — and then it shipped. Writing a defect down
 * is not the same as not having one, which is the more useful half of this
 * scar: the note bought an explanation for a reviewer and bought the operator
 * nothing at all.
 *
 * `./nav-links.tsx` now owns the links and asks the router directly with
 * `usePathname`, which is subscribed and therefore updates on every client-side
 * navigation. Its own header carries the reasoning.
 *
 * CONSEQUENCE WORTH KNOWING: nothing in the app reads `x-pathname` any more.
 * proxy.ts still sets it, and tests/admin-routes.test.ts still proves a caller
 * cannot forge it, but it now has no consumer. That is dead weight rather than
 * a hazard, and removing it means touching the proxy and its suite together —
 * a separate change, not a silent side effect of a nav fix.
 *
 * THERE IS NO LONGER A PAGE THAT OPTS OUT OF THIS SHELL. /admin/login used to,
 * because offering a signed-out visitor links the proxy would bounce straight
 * back was a loop dressed up as navigation. The login page is gone, nothing
 * signs in, and so every route in this group gets the rail. The escape hatch
 * that used to check for it has been removed rather than left inert: a branch
 * guarding a path that cannot occur is a claim that it can.
 */
/**
 * TWO ITEMS, NOT THREE. Seeds left the rail on 2026-09-05 with the page behind
 * it. Erik: *"Seeds is not suppose to be a manual task ... We don't want to see
 * or use it we just want the scraper to work."*
 *
 * The seed LIST did not go anywhere — it is the rolling seven-day top 200
 * creators per platform, recomputed from what runs have observed, and the run
 * path refreshes it before every read. What went is the idea that a person
 * curates it. There is no screen for it because there is no decision on it.
 */
const NAV = [
  { href: "/admin/shorts", label: "Shorts" },
  { href: "/admin/library", label: "Library" },
  { href: "/admin/topics", label: "What to look for" },
  { href: "/admin/credentials", label: "Credentials" },
] as const;

/**
 * IS A SCRAPECREATORS KEY SAVED? Read once for the rail so the credits chip can
 * hide itself when there is no account to ask about — the same rule the
 * credentials bar keeps. This is a database read, not a ScrapeCreators call, so
 * it spends no credit; the balance itself is only ever fetched on an explicit
 * press inside `NavCredits`. Wrapped so a store that cannot be read leaves the
 * chip hidden rather than taking the whole admin shell down with it.
 */
async function scrapeCreatorsKeySaved(canRead: boolean): Promise<boolean> {
  if (!canRead) return false;
  try {
    const { store } = await resolveCredentialStore();
    if (!store) return false;
    const credentials = await store.list();
    return credentials.some((c) => c.provider === "scrapecreators" && c.status === "active");
  } catch (cause) {
    console.error("[admin] the credit chip could not check for a saved key:", cause);
    return false;
  }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  const admin = isAdmin(viewer);
  const hasVendorKey = await scrapeCreatorsKeySaved(admin);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Admin">
        {/* The wordmark used to be the way back out to the public landing page.
            That page is now a redirect INTO this shell (see app/page.tsx), so
            pointing at "/" would send somebody on a round trip to arrive where
            the first nav item already goes. It goes straight to the one action
            instead, which is what "home" means for this tool. */}
        <Link href="/admin/shorts" className="mark">
          ClipScout<span>viral shorts by topic</span>
        </Link>

        {/* A client component, and the one thing in this rail that has to be.
            See ./nav-links.tsx: the highlight has to follow a navigation the
            server never re-renders for. */}
        <NavLinks items={NAV} />

        {/* The credit balance in the chrome. Hidden unless a key is saved, and
            never fetched on its own — see ./nav-credits.tsx. */}
        <NavCredits
          hasKey={hasVendorKey}
          canCheck={admin}
          check={checkScrapeCreatorsCreditsAction}
        />
      </nav>

      {/* A <div>, not a <main>: each admin page brings its own <main>, and two
          nested ones would be invalid and would give the page two landmarks.
          The class is impressions' `.main`, so the padding and column width
          match. If these pages ever drop their own <main> — impressions' pages
          do, because its layout owns the element — this must become <main
          className="main"> in the same commit, or the admin area loses its main
          landmark entirely. */}
      <div className="main">{children}</div>
    </div>
  );
}
