/**
 * THE GATE IS GONE, AND THIS FILE IS WHAT STOPS IT COMING BACK BY ACCIDENT.
 *
 * Erik's call, 2026-09-04: the scraper is fully open. This file used to prove
 * the opposite — that every route under `app/(admin)` redirected a signed-out
 * visitor to `/admin/login`, that the redirect carried `?next=`, that a session
 * cookie opened the door. All of that described a login page that no longer
 * exists, so those cases were not weakened, they were INVERTED: every admin
 * route must now be reachable with no cookies, no session, and no environment.
 *
 * Deleting the file instead would have been the easy move and the wrong one.
 * The route-by-route generation below is the only thing in the suite that
 * notices a NEW page appearing under `app/(admin)`, and a gate that creeps back
 * in — a redirect added to `proxy.ts`, a `PUBLIC_PREFIXES` list reintroduced —
 * would otherwise be caught by nothing at all.
 *
 * What is still asserted, unchanged, because it was never about sign-in:
 *   - the matcher reaches every admin URL, asset-extension bypass included
 *   - `x-pathname` travels on Next's request-override channel and OVERWRITES
 *     whatever the caller sent, so a visitor cannot forge which page the layout
 *     thinks it is rendering
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const ADMIN_GROUP = path.join(ROOT, "app", "(admin)");

/**
 * A concrete stand-in for a `[dynamic]` segment. The proxy does not parse it,
 * so any stable string does; one shaped like a real id keeps failures legible.
 */
const SAMPLE_DYNAMIC_SEGMENT = "UC0000000000000000000sample";

/** Files that make a directory a routable URL in the App Router. */
const ROUTE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js", "route.ts", "route.js"];

/**
 * Turn one App Router directory segment into its URL segment.
 *
 * Returns null for segments that contribute nothing to the URL — route groups
 * like `(admin)`, which is why `app/(admin)/admin/...` serves at `/admin/...`.
 */
function urlSegment(segment: string): string | null {
  if (segment.startsWith("(") && segment.endsWith(")")) return null;
  if (segment.startsWith("[")) return SAMPLE_DYNAMIC_SEGMENT;
  return segment;
}

/** Every URL path under `app/(admin)` that Next will actually serve. */
function discoverAdminRoutes(): string[] {
  const found: string[] = [];

  const walk = (dir: string, segments: string[]) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    if (entries.some((e) => e.isFile() && ROUTE_FILES.includes(e.name))) {
      found.push(`/${segments.join("/")}`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // `_private` folders are opted out of routing by Next itself.
      if (entry.name.startsWith("_")) continue;
      const next = urlSegment(entry.name);
      walk(path.join(dir, entry.name), next === null ? segments : [...segments, next]);
    }
  };

  walk(ADMIN_GROUP, []);
  return found.sort();
}

const ADMIN_ROUTES = discoverAdminRoutes();

/**
 * `proxy.ts` with its comments removed.
 *
 * THE ASSERTIONS BELOW SEARCH THIS, NOT THE RAW FILE, and the difference is not
 * cosmetic. The first draft of this file searched the raw source for
 * "previewEnabled" and "updateSession" — and went red, because proxy.ts's own
 * header comment NAMES both of them while explaining why they were deleted.
 * Prose that documents the absence of a thing is not the thing.
 *
 * This is the same trap that made tests/migrations.test.ts vacuous for weeks: a
 * comment stripper that never stripped anything, so a migration whose comments
 * merely DISCUSSED revoking from anon satisfied a check that anon WAS revoked.
 * Stripping is done here rather than trusting a hand-written source file to
 * avoid the words it needs to explain itself.
 */
function withoutComments(source: string): string {
  // `.` excludes line terminators in JS unless the `s` flag is set, so `.*`
  // stops at the end of the line — and stops at a lone `\r` too, which is the
  // detail the migrations stripper got wrong on CRLF files.
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1");
}

const PROXY_SOURCE = withoutComments(
  fs.readFileSync(path.join(ROOT, "proxy.ts"), "utf8"),
);

/**
 * Load the proxy against a stubbed environment.
 *
 * The proxy no longer reads any environment at all, which is itself asserted
 * below. The stub is kept so the two deploy states can still be exercised — a
 * proxy that started reading config again would pass one and fail the other.
 */
async function loadProxy(env: { url: string; key: string }) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", env.key);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
  vi.resetModules();
  const { proxy } = await import("../proxy");
  return proxy;
}

/**
 * Enough to make `isSupabaseConfigured` true and nothing more. `.invalid` is the
 * reserved TLD that can never resolve, and the key says what it is in the string
 * itself, so neither can be mistaken for a real credential by a person or by the
 * key-shaped-string grep in tests/config-agreement.test.ts.
 */
const CONFIGURED = {
  url: "https://stub.supabase.invalid",
  key: "sb_publishable_stub_not_a_real_key",
};

/** No environment at all — the state a zero-env first deploy is in. */
const UNCONFIGURED = { url: "", key: "" };

const DEPLOY_STATES = [
  ["configured", CONFIGURED],
  ["unconfigured", UNCONFIGURED],
] as const;

function requestFor(pathname: string, headers?: Record<string, string>) {
  return new NextRequest(`https://shorts.example/${pathname.replace(/^\//, "")}`, { headers });
}

/**
 * The value a server component's `headers()` will be given for `name`.
 *
 * Next's own wire format for `NextResponse.next({ request: { headers } })` —
 * every overridden header is written as `x-middleware-request-<name>`, and the
 * names are listed in `x-middleware-override-headers`.
 */
function requestOverride(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function overriddenNames(response: Response): string[] {
  return (response.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
}

/** Next signals a middleware redirect with a 3xx and a Location header. */
function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has("location");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the admin surface as the filesystem actually has it", () => {
  it("finds routes at all, so an empty walk cannot pass as an empty admin group", () => {
    // Without this, a broken walk (wrong path, renamed group, a Next release
    // that moves route files) would report zero routes and every route-by-route
    // assertion below would vacuously pass while protecting nothing.
    expect(ADMIN_ROUTES.length).toBeGreaterThan(0);
  });

  it("includes the routes this product actually has", () => {
    // The cross-platform shorts list, and the page where an operator pastes a
    // provider key that bills their own account. If the walk still works but
    // stops seeing these, discovery has drifted.
    expect(ADMIN_ROUTES).toContain("/admin/shorts");
    expect(ADMIN_ROUTES).toContain("/admin/credentials");
  });

  it("no longer has a login route, because nothing signs in", () => {
    // The counterpart to the deletion of app/(admin)/admin/login. If a login
    // page returns, this file's whole premise is wrong and should be revisited
    // deliberately rather than left half-true.
    expect(ADMIN_ROUTES).not.toContain("/admin/login");
    expect(fs.existsSync(path.join(ADMIN_GROUP, "admin", "login"))).toBe(false);
  });

  it("strips the (admin) route group from the URL, as Next does", () => {
    for (const route of ADMIN_ROUTES) {
      expect(route.startsWith("/admin"), `${route} should serve under /admin`).toBe(true);
      expect(route).not.toContain("(admin)");
    }
  });
});

describe("every admin route is open, in either deploy state", () => {
  for (const [label, env] of DEPLOY_STATES) {
    describe(`on a ${label} deploy`, () => {
      it("does not redirect any discovered admin route", async () => {
        const proxy = await loadProxy(env);

        for (const route of ADMIN_ROUTES) {
          const response = await proxy(requestFor(route));
          expect(
            isRedirect(response),
            `${route} redirected to ${response.headers.get("location")} on a ${label} deploy`,
          ).toBe(false);
        }
      });

      it("does not redirect a route carrying a filter query", async () => {
        // The old gate rewrote these into `?next=`. Nothing should touch them.
        const proxy = await loadProxy(env);
        const response = await proxy(requestFor("/admin/shorts?platform=tiktok&sort=views"));

        expect(isRedirect(response)).toBe(false);
        expect(requestOverride(response, "x-pathname")).toBe("/admin/shorts");
      });

      it("does not redirect the public root", async () => {
        const proxy = await loadProxy(env);
        expect(isRedirect(await proxy(requestFor("/")))).toBe(false);
      });

      it("lets a visitor with no cookies at all through", async () => {
        // The exact request a stranger with the URL makes. Under the old gate
        // this was the redirect case; it is now the ordinary case.
        const proxy = await loadProxy(env);
        const response = await proxy(requestFor("/admin/shorts"));

        expect(isRedirect(response)).toBe(false);
        expect(response.status).toBe(200);
      });
    });
  }
});

describe("the proxy no longer consults anything it used to gate on", () => {
  it("does not import the auth session helper", () => {
    // `updateSession` made a network round-trip to Supabase on every matched
    // request to refresh a session that no longer exists. Re-importing it would
    // reintroduce that cost silently.
    expect(PROXY_SOURCE).not.toContain("updateSession");
  });

  it("does not read the preview flag or the configured flag", () => {
    // Both existed only to decide who got walked past the gate.
    expect(PROXY_SOURCE).not.toContain("previewEnabled");
    expect(PROXY_SOURCE).not.toContain("isSupabaseConfigured");
  });

  it("actually strips comments, so the assertions below are not vacuous", () => {
    // If `withoutComments` silently returned the input, every `not.toContain`
    // in this block would still pass on a proxy that had been fully reverted —
    // because the header comment names all three forbidden symbols. This case
    // fails the moment the stripper stops working.
    const raw = fs.readFileSync(path.join(ROOT, "proxy.ts"), "utf8");
    expect(raw).toContain("previewEnabled");
    expect(PROXY_SOURCE).not.toContain("previewEnabled");
    expect(PROXY_SOURCE).toContain("NextResponse.next");
  });

  it("contains no redirect at all", () => {
    // The single strongest statement this file can make about the source: not
    // "the redirect is narrow" but "there is no redirect".
    expect(PROXY_SOURCE).not.toContain("NextResponse.redirect");
  });

  it("behaves identically whether or not Supabase is configured", async () => {
    // Anti-vacuity for the two-state loop above: if the proxy started reading
    // config again, the states would diverge and this would catch it even if
    // both happened to avoid redirecting.
    const configured = await loadProxy(CONFIGURED);
    const configuredResponse = await configured(requestFor("/admin/shorts"));

    const unconfigured = await loadProxy(UNCONFIGURED);
    const unconfiguredResponse = await unconfigured(requestFor("/admin/shorts"));

    expect(unconfiguredResponse.status).toBe(configuredResponse.status);
    expect(requestOverride(unconfiguredResponse, "x-pathname")).toBe(
      requestOverride(configuredResponse, "x-pathname"),
    );
  });
});

describe("x-pathname travels on the request-override channel", () => {
  it("names x-pathname in Next's override list", async () => {
    const proxy = await loadProxy(CONFIGURED);
    const response = await proxy(requestFor("/admin/shorts"));

    expect(overriddenNames(response)).toContain("x-pathname");
  });

  it("carries the pathname of the page actually requested", async () => {
    const proxy = await loadProxy(CONFIGURED);

    for (const route of ADMIN_ROUTES) {
      const response = await proxy(requestFor(route));
      expect(requestOverride(response, "x-pathname"), `wrong x-pathname for ${route}`).toBe(route);
    }
  });

  it("carries the pathname on the unconfigured deploy too", async () => {
    const proxy = await loadProxy(UNCONFIGURED);
    const response = await proxy(requestFor("/admin/shorts"));

    expect(requestOverride(response, "x-pathname")).toBe("/admin/shorts");
  });

  it("overwrites an x-pathname the caller supplied", async () => {
    // THE ONE SECURITY PROPERTY LEFT IN THIS FILE. The layout renders its nav
    // from this header; a caller who could set it could make the layout claim
    // to be a page it is not.
    const proxy = await loadProxy(CONFIGURED);
    const response = await proxy(
      requestFor("/admin/shorts", { "x-pathname": "/admin/somewhere-else" }),
    );

    expect(requestOverride(response, "x-pathname")).toBe("/admin/shorts");
  });

  it("does not leave the pathname on the response, where it did nothing", async () => {
    const proxy = await loadProxy(CONFIGURED);
    const response = await proxy(requestFor("/admin/shorts"));

    expect(response.headers.get("x-pathname")).toBeNull();
  });
});

describe("the proxy's own matcher reaches every admin URL, assets included", () => {
  /**
   * The matcher entries, compiled as plain RegExps — which is what this
   * project's matcher is. If somebody switches to path-to-regexp syntax
   * (`/admin/:path*`) these tests need rewriting rather than deleting: they
   * would silently stop describing what Next compiles.
   */
  async function matcherPatterns(): Promise<RegExp[]> {
    const { config } = await import("../proxy");
    return (config.matcher as readonly string[]).map((m) => new RegExp(`^${m}$`));
  }

  const reaches = (patterns: RegExp[], url: string) => patterns.some((p) => p.test(url));

  /**
   * The extensions the matcher excludes, read out of the matcher itself rather
   * than copied here, so these assertions always cover whatever it names now.
   */
  async function excludedExtensions(): Promise<string[]> {
    const { config } = await import("../proxy");
    const alternation = /\(\?:((?:[a-z0-9]+\|)+[a-z0-9]+)\)\$/.exec(
      (config.matcher as readonly string[]).join(" "),
    );
    if (!alternation) throw new Error("could not find the asset extension list in the matcher");
    return alternation[1].split("|");
  }

  it("reads a non-empty extension list out of the matcher", async () => {
    // Anti-vacuity for the generated tests below: if the parse ever returned
    // nothing they would assert nothing while passing.
    const extensions = await excludedExtensions();
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions).toContain("png");
  });

  it("matches every discovered admin route", async () => {
    const patterns = await matcherPatterns();

    for (const route of ADMIN_ROUTES) {
      expect(reaches(patterns, route), `matcher does not reach ${route}`).toBe(true);
    }
  });

  it("matches every discovered admin route with an asset extension stuck on the end", async () => {
    // `/admin/shorts.png` must still reach the proxy, so `x-pathname` is set
    // (and overwritten) there too. The gate this originally protected is gone;
    // the header forgery it also protects is not.
    const patterns = await matcherPatterns();
    const extensions = await excludedExtensions();

    for (const route of ADMIN_ROUTES) {
      for (const extension of extensions) {
        const url = `${route}.${extension}`;
        expect(reaches(patterns, url), `matcher does not reach ${url}`).toBe(true);
      }
    }
  });

  it("still excludes the static assets the exclusion is actually for", async () => {
    const patterns = await matcherPatterns();
    const extensions = await excludedExtensions();

    for (const extension of extensions) {
      const url = `/logo.${extension}`;
      expect(reaches(patterns, url), `matcher should not reach ${url}`).toBe(false);
    }
    expect(reaches(patterns, "/_next/static/chunk.js")).toBe(false);
    expect(reaches(patterns, "/favicon.ico")).toBe(false);
  });

  it("reaches ordinary pages, so the exclusion has not swallowed the site", async () => {
    const patterns = await matcherPatterns();

    expect(reaches(patterns, "/")).toBe(true);
    expect(reaches(patterns, "/admin")).toBe(true);
  });
});
