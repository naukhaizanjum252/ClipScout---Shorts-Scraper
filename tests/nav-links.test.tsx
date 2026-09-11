// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NavLinks, isCurrent } from "@/app/(admin)/admin/nav-links";

/**
 * THE RAIL LIGHTS THE PAGE YOU ARE ON. THAT IS THE WHOLE FILE.
 *
 * THE BUG, reported 2026-09-05 with a screenshot: the Seeds page, with
 * "Credentials" lit in the rail. `app/(admin)/admin/layout.tsx` is a server
 * component and read the pathname from the `x-pathname` request header, but a
 * LAYOUT DOES NOT RE-RENDER on a client-side navigation between two pages that
 * share it — so the value was whichever admin page loaded first, and the chip
 * never moved.
 *
 * WHY THE CENTRAL CASE MOCKS `usePathname` AND RE-RENDERS RATHER THAN JUST
 * RENDERING ONCE. A test that renders at one path and asserts one chip passes
 * against the OLD broken code too: the first paint was always correct. The
 * failure only exists on the SECOND path, so the regression case has to change
 * the pathname and re-render without remounting — which is exactly what the
 * router does to this component and exactly what it never did to the layout.
 * Without that, this file would be decoration.
 */

/**
 * THE REAL RAIL IS TWO ITEMS SINCE 2026-09-05 — Shorts and Credentials; Seeds
 * went with the page behind it when seeding became automatic. A third entry is
 * kept in this fixture ON PURPOSE: the component is generic over whatever list
 * it is handed, and every case here is about the highlight rule rather than
 * about this deployment's menu. Pinning the fixture to the live nav would make
 * these tests fail the next time a page is added or removed, which is not what
 * any of them are checking.
 */
const NAV = [
  { href: "/admin/shorts", label: "Shorts" },
  { href: "/admin/seeds", label: "Seeds" },
  { href: "/admin/credentials", label: "Credentials" },
] as const;

const pathname = vi.hoisted(() => ({ current: "/admin/shorts" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

/** The label of whichever link is marked current, or null. */
function lit(): string | null {
  const marked = document.querySelector('[aria-current="page"]');
  return marked?.textContent ?? null;
}

describe("which link the rail lights", () => {
  it("lights the page being rendered, and only that one", () => {
    pathname.current = "/admin/seeds";
    render(<NavLinks items={NAV} />);

    expect(lit()).toBe("Seeds");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("follows a client-side navigation, which is the reported bug", () => {
    // THE REGRESSION CASE. Land on Credentials, then navigate to Seeds the way
    // the router does — same component instance, new pathname, no remount. The
    // old server-rendered rail could not see this happen at all.
    pathname.current = "/admin/credentials";
    const { rerender } = render(<NavLinks items={NAV} />);
    expect(lit()).toBe("Credentials");

    pathname.current = "/admin/seeds";
    rerender(<NavLinks items={NAV} />);

    expect(lit(), "the rail is still lighting the page we navigated AWAY from").toBe("Seeds");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("says which page it is on in ARIA, not only in colour", () => {
    // DESIGN.md: colour is never the only carrier. `data-active` drives the
    // violet chip; `aria-current` is what a screen reader is told, and a
    // sighted-only signal would leave that reader with no answer at all.
    pathname.current = "/admin/seeds";
    render(<NavLinks items={NAV} />);

    const seeds = screen.getByText("Seeds");
    expect(seeds.getAttribute("aria-current")).toBe("page");
    expect(seeds.getAttribute("data-active")).toBe("true");

    const shorts = screen.getByText("Shorts");
    expect(shorts.getAttribute("aria-current")).toBeNull();
    expect(shorts.getAttribute("data-active")).toBe("false");
  });

  it("lights nothing rather than something wrong on an unknown path", () => {
    // Lighting the wrong link is the failure this component exists to remove,
    // so an unlit rail is the correct degraded state — not a fallback to the
    // first item.
    pathname.current = "/admin/somewhere-nobody-built";
    render(<NavLinks items={NAV} />);
    expect(lit()).toBeNull();
  });

  it("renders every item it is given, current or not", () => {
    pathname.current = "/admin/shorts";
    render(<NavLinks items={NAV} />);
    for (const item of NAV) {
      expect(screen.getByText(item.label).getAttribute("href")).toBe(item.href);
    }
  });
});

describe("the nesting rule", () => {
  it("treats a nested page as its section", () => {
    // /admin/seeds/<id> has not been built, and when it is, it must light Seeds
    // rather than nothing.
    expect(isCurrent("/admin/seeds/abc123", "/admin/seeds")).toBe(true);
  });

  it("does not treat a prefix that is not a path segment as nested", () => {
    // The trap this rule is written to avoid: a future /admin/seeds-archive
    // must not light Seeds. `startsWith("/admin/seeds")` alone would.
    expect(isCurrent("/admin/seeds-archive", "/admin/seeds")).toBe(false);
  });

  it("matches the page itself", () => {
    expect(isCurrent("/admin/seeds", "/admin/seeds")).toBe(true);
  });
});
