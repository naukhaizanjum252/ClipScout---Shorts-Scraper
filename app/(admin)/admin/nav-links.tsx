"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * THE RAIL'S LINKS, LIT FROM THE PATHNAME THE BROWSER IS ACTUALLY ON.
 *
 * THE BUG THIS FIXES, reported 2026-09-05 with a screenshot: the Seeds page
 * with "Credentials" lit in the rail. Not a styling slip — the highlight was
 * pointing at a different page from the one on screen, which is the one thing
 * navigation furniture must never do.
 *
 * WHY IT HAPPENED. `app/(admin)/admin/layout.tsx` is a server component, and a
 * layout is not handed the pathname, so it read the `x-pathname` header that
 * proxy.ts attaches to every request. That works exactly once. A layout DOES
 * NOT RE-RENDER on a client-side navigation between two pages that share it —
 * React reuses it and swaps only the children — so the header it read was from
 * whichever admin page was loaded FIRST, and every subsequent click left the
 * chip behind. Opening /admin/credentials and clicking Seeds is precisely that
 * path, which is why the screenshot looks like it does. A full reload always
 * "fixed" it, which is why it survived this long.
 *
 * IT WAS A KNOWN LIMIT AND IT WAS WRITTEN DOWN, in the layout's own header,
 * naming this fix — a small client component around the links, `usePathname`,
 * ported from impressions' `app/(admin)/nav-links.tsx` — and saying it was
 * "worth fixing next". It then shipped anyway. A documented defect is still a
 * defect; the note bought an explanation, not an exemption.
 *
 * WHY `usePathname` AND NOT A PROP. Passing the server's pathname down would
 * reproduce the bug exactly: the value would be captured when the layout last
 * rendered, which is the thing that does not happen again. This hook is
 * subscribed to the router, so it updates on every client-side navigation. It
 * also returns the right value during SSR, so the first paint is correct and
 * there is no flash of a wrong chip.
 *
 * WHAT STAYS THE SAME: `aria-current` is the answer and the violet chip is the
 * decoration. DESIGN.md's rule that colour is never the only carrier applies to
 * navigation state as much as to a spend warning, and a screen reader must not
 * have to infer which page it is on from a background.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * True when `pathname` is the page behind `href`, or a page nested under it.
 *
 * The nesting half matters for a detail route that has not been built yet —
 * /admin/seeds/<id> must light Seeds rather than nothing. Exported so the test
 * can exercise the rule directly rather than only through rendered output.
 */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  // Null on the very first render in some environments; treated as "no page is
  // current", which lights nothing. Lighting the WRONG link is the failure this
  // file exists to remove, so an empty rail is the correct degraded state.
  const pathname = usePathname() ?? "";

  return (
    <>
      {items.map((item) => {
        const current = isCurrent(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="nav-item"
            aria-current={current ? "page" : undefined}
            data-active={current}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
