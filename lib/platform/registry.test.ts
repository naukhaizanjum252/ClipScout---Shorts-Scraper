/**
 * The registry, and the two seams it is here to hold.
 *
 * THREE KINDS OF TEST LIVE IN THIS FILE, AND THE FIRST KIND IS NEW.
 *
 *   THE WIRING TESTS, at the top. They go through `buildAdapters()` — the same
 *   entry point the action, the script and the scheduler call — with a fake
 *   credential store, and assert what comes out is USABLE. They exist because
 *   on 2026-09-04 this repo had 746 green tests and a registry that constructed
 *   no `XClient` at all and passed the Meta adapters no configuration at all,
 *   so an operator could paste a valid, paid-for X bearer token and be told X
 *   was unavailable, permanently, with every one of those tests still green.
 *
 *   Every adapter had a thorough unit test. Each one built its adapter BY HAND,
 *   handed it a fixture client, and proved the adapter works. Not one asked
 *   whether the application ever builds one of these with real configuration.
 *   That is the bug class these tests close, and it is why they assert
 *   AVAILABILITY and OBSERVED REQUESTS rather than reaching inside an adapter:
 *   a test that reads a private field would pass against a registry that built
 *   the object and then never used it.
 *
 *   THE RETURN-SHAPE TESTS, in the middle. What the registry answers for a
 *   platform, and what `statusFor` does with an adapter that misbehaves.
 *
 *   THE SEAM TEST, at the bottom. It reads the repository and fails if platform
 *   knowledge has started leaking out of lib/platform/. Same shape as the old
 *   lib/source/select.test.ts, kept for the same reason: the failure it
 *   prevents is not hypothetical, it is the state this repo was already in
 *   before the rewrite.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { credentialFields } from "../credentials/fields";
import { spendCapabilities } from "../shorts/run";
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import { MetaBudgetError, MetaCallBudget } from "./meta-client";
import {
  adapterFor,
  buildAdapters,
  platformStatuses,
  PROVIDER_BACKED_PLATFORMS,
  seedEnvKey,
  seedsFor,
  statusFor,
  VENDOR_ENV,
  VENDOR_PROVIDER,
  type ProviderBackedPlatform,
  type CredentialLease,
  type CredentialProviderName,
  type CredentialSource,
  type SeedRow,
  type SeedSource,
} from "./registry";
import { ENDPOINTS, SCRAPECREATORS_BASE } from "./scrapecreators";
import { PLATFORMS, platformLabel, type Platform, type ShortRecord } from "./types";
import type { ProviderClient } from "./unavailable";
import type { YtDlpRunner } from "./ytdlp";

const CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";

/** A yt-dlp that exists and answers, so availability turns on configuration alone. */
const installed: YtDlpRunner = async (args) => {
  if (args.includes("--version")) return "2026.07.04\n";
  return JSON.stringify({ channel_id: CHANNEL, entries: [] });
};

const provider: ProviderClient = {
  latestShorts: async () => [],
  downloadUrl: async () => null,
};

// =========================================================== the wiring seam

/**
 * The shape of a saved key, as the credential store hands one over.
 *
 * Not a `PlaintextLease` from lib/credentials — the registry takes a structural
 * port so lib/platform does not depend on that module. A real store satisfies
 * the port, and there is a test at the bottom of this block proving the ONE
 * field name the registry reads out of `identifiers` still exists there.
 */
function leaseOf(secret: string, identifiers: Record<string, string> = {}): CredentialLease {
  return { secret, identifiers };
}

/**
 * A credential store holding whatever the test says, and nothing else.
 *
 * KEYED BY `CredentialProviderName` AND NOT BY `Platform` SINCE 2026-09-04,
 * which is the whole first blocker in one type parameter: a credential provider
 * is now either a platform whose own API we call or a VENDOR serving several
 * platforms, and `scrapecreators` is the first thing in this repo that could
 * not be named while the two were the same list.
 */
class FakeCredentials implements CredentialSource {
  /** Every provider that was asked for, in order. */
  readonly asked: CredentialProviderName[] = [];

  constructor(private readonly rows: Partial<Record<CredentialProviderName, CredentialLease>>) {}

  async lease(provider: CredentialProviderName): Promise<CredentialLease | null> {
    this.asked.push(provider);
    return this.rows[provider] ?? null;
  }
}

/** A seed store holding rows, the way a database does. */
class FakeSeeds implements SeedSource {
  constructor(private readonly rows: readonly SeedRow[]) {}
  async listSeeds(): Promise<readonly SeedRow[]> {
    return this.rows;
  }
}

const X_TOKEN = "AAAAAAAAAAAAAAAAAAAAA-test-bearer-token";
const META_TOKEN = "EAAG-test-meta-access-token";
const IG_USER_ID = "17841405309211844";

/** Enough X configuration that availability turns on the credential alone. */
const X_ENV = {
  X_SEARCH_QUERY: "min_likes:20000 has:video_link -is:retweet lang:en",
  X_MAX_POSTS_PER_RUN: "200",
};

async function statusOf(platform: Platform, options: Parameters<typeof platformStatuses>[0]) {
  const statuses = await platformStatuses(options);
  return statuses.find((s) => s.platform === platform);
}

describe("buildAdapters wires an adapter that can actually run", () => {
  it("turns X available the moment a bearer token is saved", async () => {
    // THE TEST THAT WOULD HAVE CAUGHT IT. Against the previous registry this
    // fails: `new XClient` existed nowhere in the tree, so `XAdapter` was
    // always built with `client: null` and X answered "no X credential is
    // configured" whatever was in the database. Availability, not internals —
    // an adapter holding a client it never received would still fail this.
    const status = await statusOf("x", {
      env: X_ENV,
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
    });
    expect(status?.reason).toBeNull();
    expect(status?.available).toBe(true);
  });

  it("leaves X unavailable, and says why, when no token is saved", async () => {
    // The other direction, and the one a lazy client would have broken: a
    // registry that built a client which leases on first use would report X
    // available with nothing saved at all.
    const status = await statusOf("x", { env: X_ENV, run: installed, credentials: new FakeCredentials({}) });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(/no X credential is configured/i);
  });

  it("still refuses X with a token but no query or cap, and names the missing one", async () => {
    // A saved key must not paper over the two numbers that decide what a run
    // costs. X bills per Post returned; neither has a default anywhere.
    const status = await statusOf("x", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
    });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(/X_SEARCH_QUERY/);
  });

  it("turns Instagram available on a Meta token, the operator's account id and a seed", async () => {
    // Would have caught it: the registry constructed `new InstagramAdapter(
    // provider)` with the first argument only, so the object carrying the
    // token, the seeds and the account id never arrived and Instagram reported
    // all three missing forever.
    const status = await statusOf("instagram", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({
        instagram: leaseOf(META_TOKEN, { ig_business_account_id: IG_USER_ID }),
      }),
      seedStore: new FakeSeeds([{ platform: "instagram", seed: "bluebottle", active: true }]),
    });
    expect(status?.reason).toBeNull();
    expect(status?.available).toBe(true);
  });

  it("names the account id as the gap when the credential carries no ig_business_account_id", async () => {
    // Business Discovery is a field expansion on YOUR OWN account node, so a
    // token without one has nothing to address. A registry that read the wrong
    // identifier key would land here, which is the failure the field-name test
    // below is paired with.
    const status = await statusOf("instagram", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ instagram: leaseOf(META_TOKEN) }),
      seedStore: new FakeSeeds([{ platform: "instagram", seed: "bluebottle", active: true }]),
    });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(/Instagram professional account id/);
  });

  it("turns Facebook available on a Meta Page token and a seeded Page", async () => {
    const status = await statusOf("facebook", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ facebook: leaseOf(META_TOKEN, { page_id: "1234567890" }) }),
      seedStore: new FakeSeeds([{ platform: "facebook", seed: "1234567890", active: true }]),
    });
    expect(status?.reason).toBeNull();
    expect(status?.available).toBe(true);
  });

  it("wires all three at once without any of them flipping the others", async () => {
    // One buildAdapters call, three credentials, five statuses. TikTok stays
    // unavailable because no data provider has been chosen, and YouTube because
    // nothing seeded it — both correct, and both would be hidden by a wiring
    // step that turned everything on at once.
    const statuses = await platformStatuses({
      env: X_ENV,
      run: installed,
      credentials: new FakeCredentials({
        x: leaseOf(X_TOKEN),
        instagram: leaseOf(META_TOKEN, { ig_business_account_id: IG_USER_ID }),
        facebook: leaseOf(META_TOKEN),
      }),
      seedStore: new FakeSeeds([
        { platform: "instagram", seed: "bluebottle", active: true },
        { platform: "facebook", seed: "1234567890", active: true },
      ]),
    });
    expect(statuses.filter((s) => s.available).map((s) => s.platform).sort()).toEqual([
      "facebook",
      "instagram",
      "x",
    ]);
  });

  it("asks the store only for the providers it can actually spend", async () => {
    // Five leases, not six and not seven. Each one is a round trip through a
    // SECURITY DEFINER function while a status page renders. YouTube has
    // nothing here that would spend a key; TikTok has no key of its own but is
    // one of the three platforms the VENDOR key buys, which is why one of the
    // names on this list is a vendor and not a platform. Threads has its own,
    // leased separately from the two graph.facebook.com platforms because it
    // is a different host with a different token.
    const credentials = new FakeCredentials({});
    await buildAdapters({ env: {}, run: installed, credentials });
    expect([...credentials.asked].sort()).toEqual([
      "facebook",
      "instagram",
      VENDOR_PROVIDER,
      "threads",
      "x",
    ]);
  });

  it("lets a credential read that fails out, rather than calling it 'no key saved'", async () => {
    // The two are different facts and the second is a lie that sends an
    // operator to a settings page where their key is sitting saved and correct.
    // A registry that caught this would report five platforms unconfigured
    // because one query failed.
    const exploding: CredentialSource = {
      lease: async () => {
        throw new Error("permission denied for function lease_api_credential");
      },
    };
    await expect(buildAdapters({ env: {}, run: installed, credentials: exploding })).rejects.toThrow(
      /lease_api_credential/,
    );
  });

  it("hands the run an X adapter that can say what it spent", async () => {
    /*
     * THE SAME DEFECT AGAIN, ONE FILE OVER, AND THIS IS THE TEST THAT KEEPS IT
     * CLOSED.
     *
     * lib/platform/x-client.ts's header writes out the exact registry line that
     * should have called `meterWithX`, and `meterWithX` had ZERO call sites in
     * the tree. `XMeteredAdapter` exists so that a platform billing $0.005 a row
     * does not report a price of nothing — and `spendCapabilities()`, which is
     * what lib/shorts/run.ts actually asks, saw a plain `XAdapter` with no
     * brand and no method. Money spent, nothing reported, every test green.
     *
     * This asserts through `spendCapabilities` rather than through a private
     * field because that IS the consumer: it is the function that decides
     * whether a run ever asks this adapter about money.
     */
    const adapters = await buildAdapters({
      env: X_ENV,
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
    });
    const metered = spendCapabilities(adapters.get("x") as PlatformAdapter);
    expect(metered.declared, "a run would never ask X what it charged").toBe(true);
    expect(metered.accounting, "X declares it meters itself and cannot report a run").not.toBeNull();
  });

  it("leaves an unconfigured X unmetered, so it cannot report a price of zero", async () => {
    // The other direction, and it matters as much: in `report.spend` a missing
    // platform means "quoted no price" and a present one means "this is what it
    // cost". An X with no key charges nothing and must not appear at all.
    const adapters = await buildAdapters({ env: X_ENV, run: installed, credentials: new FakeCredentials({}) });
    expect(spendCapabilities(adapters.get("x") as PlatformAdapter).declared).toBe(false);
  });
});

// ------------------------------------------- the vendor-backed platforms

/**
 * WHERE A DATA VENDOR REACHES THE PRODUCT, AND WHERE IT DOES NOT.
 *
 * ScrapeCreators was chosen on 2026-09-04 to serve TikTok, Instagram and
 * Facebook — and explicitly NOT X, which stays on its own official API because
 * that is the only route that returns the duration the 120-second filter needs.
 * These tests pin the halves of that decision that are true of THIS tree today,
 * so that the change which lands the vendor client cannot quietly get one of
 * them wrong.
 *
 * THEY GO THROUGH `buildAdapters()`, WITH THE ADAPTERS' OWN ANSWERS AND WITH
 * OBSERVED REQUESTS, for the reason at the top of this file: a registry that
 * built a client and dropped it passes any test that reaches inside an adapter,
 * and passed 746 of them once.
 */
describe("a data provider reaches the platforms it was bought for, and no others", () => {
  /**
   * A provider that records the queries it was asked, so "the registry dropped
   * it" is visible rather than inferred.
   *
   * `LatestShortsQuery` carries no platform — an adapter knows which one it is —
   * so each adapter gets its OWN recorder and the count is what identifies it.
   */
  function recordingProvider(): ProviderClient & { readonly calls: LatestShortsQuery[] } {
    const calls: LatestShortsQuery[] = [];
    return {
      calls,
      latestShorts: async (query: LatestShortsQuery) => {
        calls.push(query);
        return [];
      },
      downloadUrl: async () => null,
    };
  }

  const QUERY: LatestShortsQuery = { limit: 5, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

  it("turns Instagram and Facebook available on the provider alone, with no Meta token at all", async () => {
    // The whole point of the vendor: neither platform needs Business
    // Verification, App Review, a Page token or an account id once a provider
    // is answering. A registry that accepted the client and dropped it would
    // leave both reporting the Meta setup they no longer need.
    const client = recordingProvider();
    const statuses = await platformStatuses({
      env: {},
      run: installed,
      credentials: new FakeCredentials({}),
      providers: { instagram: client, facebook: client },
    });
    expect(statuses.filter((s) => s.available).map((s) => s.platform).sort()).toEqual([
      "facebook",
      "instagram",
    ]);
  });

  it("is the provider, not the official route, that answers a run for those two", async () => {
    // Availability alone would pass against an adapter that reports itself
    // ready and then calls Meta anyway. This asserts the request went to the
    // provider — the observable half.
    const ig = recordingProvider();
    const fb = recordingProvider();
    const adapters = await buildAdapters({
      env: {},
      run: installed,
      credentials: new FakeCredentials({}),
      providers: { instagram: ig, facebook: fb },
      fetchImpl: (async () => {
        throw new Error("the official Meta route was called even though a provider was supplied");
      }) as unknown as typeof globalThis.fetch,
    });
    await adapters.get("instagram")?.latestShorts(QUERY);
    await adapters.get("facebook")?.latestShorts(QUERY);
    expect(ig.calls, "the Instagram adapter did not use the provider it was given").toEqual([QUERY]);
    expect(fb.calls, "the Facebook adapter did not use the provider it was given").toEqual([QUERY]);
  });

  /**
   * X IS THE ONE THAT MUST NOT BE HANDED TO A VENDOR, and the strongest way to
   * say so is that it cannot be: `providers` is typed
   * `Partial<Record<ProviderBackedPlatform, ProviderClient>>` and X is not in
   * that union, so `providers: { x: client }` does not compile. What this test
   * adds is the other half — that X, wired the ordinary way, still goes to X's
   * own host — because the type says nothing about where the request lands.
   */
  it("leaves X on its own official API, at api.x.com, with a provider in play", async () => {
    const vendor = recordingProvider();
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [], meta: { result_count: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const adapters = await buildAdapters({
      env: X_ENV,
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
      providers: { instagram: vendor, facebook: vendor },
      fetchImpl,
    });
    await adapters.get("x")?.latestShorts(QUERY);

    expect(urls.length, "X made no request at all").toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).host).toBe("api.x.com");
    expect(vendor.calls, "the vendor client was asked to answer for X").toEqual([]);
  });

  /**
   * THE GAP THAT CLOSED. This test used to read "still decides TikTok on seeds
   * alone, because its adapter takes no provider yet" and carried an instruction
   * to rewrite it the moment `TikTokAdapter` grew a `ProviderClient` parameter.
   * It grew one on 2026-09-04, so this is that rewrite: TikTok now goes
   * available on a provider exactly the way Instagram and Facebook do, and the
   * keyless path is still there underneath for a deployment with no vendor key.
   */
  it("turns TikTok available on a provider, and still reads it keylessly without one", async () => {
    const tiktok = recordingProvider();
    const withProvider = await statusOf("tiktok", {
      env: {},
      run: installed,
      providers: { tiktok },
    });
    expect(withProvider?.available, "a provider must make TikTok readable").toBe(true);

    const seeded = await statusOf("tiktok", {
      env: {},
      run: installed,
      // A sec_uid's documented shape: MS4wLjABAAAA and 64 more characters.
      seeds: { tiktok: [`MS4wLjABAAAA${"x".repeat(64)}`] },
    });
    expect(seeded?.available, "a seeded TikTok is readable keylessly through yt-dlp").toBe(true);

    const neither = await statusOf("tiktok", { env: {}, run: installed });
    expect(neither?.available).toBe(false);
    expect(neither?.reason, "an unconfigured TikTok must say what it needs").toMatch(/seed/i);
  });

  it("sends a TikTok run to the provider rather than to yt-dlp", async () => {
    // Availability alone would pass against an adapter that reports itself
    // ready on a provider and then shells out to yt-dlp anyway.
    const tiktok = recordingProvider();
    const adapters = await buildAdapters({
      env: {},
      providers: { tiktok },
      run: async () => {
        throw new Error("yt-dlp was run even though a provider was supplied");
      },
    });
    await adapters.get("tiktok")?.latestShorts(QUERY);
    expect(tiktok.calls, "the TikTok adapter did not use the provider it was given").toEqual([QUERY]);
  });
});

// ===================================== the sentence on the card names the reader

/**
 * THE CARD MUST DESCRIBE THE ROUTE THAT WILL ACTUALLY BE TAKEN.
 *
 * SCAR, 2026-09-08. `statusFor` calls `adapter.describe()` and /admin/shorts
 * prints that sentence directly above whatever happened to the platform. On a
 * deployment with a ScrapeCreators key, the Instagram card read "via Meta's
 * official Graph API — Business Discovery … Nothing here has been run against
 * Meta" immediately above a failure notice saying ScrapeCreators was out of
 * credits. Meta had not been called. Facebook's card had the same defect.
 * `TikTokAdapter` branched on its provider and the two Meta adapters did not,
 * so the bug was invisible on the one platform anybody had checked.
 *
 * ASSERTED FOR THE WHOLE LIST rather than three times by hand, because the
 * failure was one platform being forgotten. A fourth vendor-backed platform is
 * a compile error in `KEYLESS_CLAIM` before it is a wrong sentence on a card.
 */
describe("a provider-backed platform says which reader answered", () => {
  /**
   * A phrase that is TRUE of the no-provider route and FALSE of the vendor one.
   * Not a spelling check — each of these names the mechanism the other route
   * does not use, so a describe() that kept it while holding a provider is
   * describing a read that will not happen.
   */
  const KEYLESS_CLAIM: Record<ProviderBackedPlatform, RegExp> = {
    tiktok: /sec_uid/i,
    instagram: /official Graph API/i,
    facebook: /official Graph API/i,
  };

  for (const platform of PROVIDER_BACKED_PLATFORMS) {
    it(`${platform} describes the vendor route when it is holding a vendor`, async () => {
      const keyless = await adapterFor(platform, { env: {}, run: installed });
      const vendor = await adapterFor(platform, {
        env: {},
        run: installed,
        providers: { [platform]: provider },
      });

      expect(
        vendor.describe(),
        "the card says the same thing whether or not a vendor is answering",
      ).not.toBe(keyless.describe());

      expect(
        keyless.describe(),
        "the keyless sentence stopped naming its own mechanism, so this test proves nothing",
      ).toMatch(KEYLESS_CLAIM[platform]);

      expect(
        vendor.describe(),
        "the card claims a route the provider short-circuits",
      ).not.toMatch(KEYLESS_CLAIM[platform]);
    });
  }

  it("puts that sentence on the status row, which is what the page renders", async () => {
    // Through `platformStatuses` rather than the adapter, because `description`
    // travelling from describe() to the card is the half that was broken.
    const [status] = (
      await platformStatuses({ env: {}, run: installed, providers: { instagram: provider } })
    ).filter((s) => s.platform === "instagram");
    expect(status?.description).not.toMatch(/official Graph API/i);
    expect(status?.available, "a provider makes Instagram readable").toBe(true);
  });
});


// ======================================== THE VENDOR SEAM, THROUGH buildAdapters

/**
 * ===========================================================================
 * THE ACCEPTANCE TEST FOR 2026-09-04, AND THE ONE FALSIFIABLE CLAIM THIS ROUND
 * WAS ASKED TO MAKE TRUE
 * ===========================================================================
 *
 * DELETE lib/platform/scrapecreators.ts AND THIS FILE MUST GO RED. That was the
 * whole brief, because it had already failed twice in the same shape and the
 * third one was worse:
 *
 *   `new XClient` had ZERO call sites in the entire tree.
 *   The Meta adapters were constructed without the options object carrying
 *     their token.
 *   `ScrapeCreatorsClient` had one definition and ZERO production call sites —
 *     a reviewer moved the whole file out of the tree and the suite stayed 100%
 *     green with `tsc` exiting 0.
 *
 * Each time the units were built well and tested well. Nothing tested the seam.
 * A unit test that constructs an adapter by hand and hands it a fixture client
 * proves the part and says NOTHING WHATEVER about whether the product ever
 * builds one.
 *
 * SO THESE TESTS ASSERT TWO THINGS AND NEVER AN INTERNAL: what each adapter out
 * of `buildAdapters()` SAYS about itself, and what URLs it actually REQUESTS.
 * A registry that leased the key, built the client, built the providers and
 * then dropped them on the floor passes every test that reads a private field,
 * and fails these.
 */
describe("a saved ScrapeCreators key reaches the three platforms it was bought for", () => {
  const SC_KEY = "sc-live-key-not-real-0000";
  const FB_PAGE_URL = "https://www.facebook.com/bluebottle";
  const SEC_UID = `MS4wLjABAAAA${"x".repeat(64)}`;
  const QUERY: LatestShortsQuery = { limit: 5, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };
  const VENDOR_HOST = new URL(SCRAPECREATORS_BASE).host;

  /** Every leg configured: X's two numbers, and TikTok's region. */
  const FULLY_CONFIGURED = { ...X_ENV, [VENDOR_ENV.tiktokRegions]: "US" };

  /**
   * The seed rows, as a database holds them.
   *
   * Instagram's handle and Facebook's page URL are here because for those two
   * the seed IS the vendor source. TikTok's is deliberately absent — its vendor
   * source is the region in the environment above, and a sec_uid seed would say
   * nothing about whether the vendor leg works. YouTube's is here because the
   * seed store WINS over the environment for every platform, so a row is the
   * only way to seed it once a store is in play.
   */
  const VENDOR_SEEDS = new FakeSeeds([
    { platform: "youtube", seed: CHANNEL, active: true },
    { platform: "instagram", seed: "bluebottle", active: true },
    { platform: "facebook", seed: FB_PAGE_URL, active: true },
  ]);

  /**
   * A fetch that answers both hosts, and records every request.
   *
   * THE VENDOR BODY CARRIES ALL THREE RESULTS KEYS, PRESENT AND EMPTY, because
   * present-and-empty is the one case lib/platform/scrapecreators.ts allows to
   * mean "no results" — an ABSENT results array is a shape change and throws.
   * Returning [] here therefore exercises the parser's success path rather than
   * dodging it.
   */
  function recorder() {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, key: headers["x-api-key"] });
      const body =
        new URL(url).host === "api.x.com"
          ? { data: [], meta: { result_count: 0 } }
          : { success: true, credits_charged: 1, credits_remaining: 999, aweme_list: [], items: [], reels: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { seen, fetchImpl };
  }

  it("turns all three available, and sends each one to the vendor's own host", async () => {
    const { seen, fetchImpl } = recorder();
    const options = {
      env: FULLY_CONFIGURED,
      run: installed,
      credentials: new FakeCredentials({
        [VENDOR_PROVIDER]: leaseOf(SC_KEY),
        x: leaseOf(X_TOKEN),
      }),
      seedStore: VENDOR_SEEDS,
      fetchImpl,
    };

    // ---------------------------------------------------------- what they say
    const statuses = await platformStatuses(options);
    const available = statuses.filter((s) => s.available).map((s) => s.platform).sort();
    expect(
      available,
      "with a vendor key, an X token, a YouTube seed and a TikTok region, every platform is " +
        "readable — and NO Meta token, app review or Instagram business account id is involved " +
        "in any of it, which is the entire reason this vendor was bought",
    ).toEqual(["facebook", "instagram", "tiktok", "x", "youtube"]);

    // -------------------------------------------------------- what they DO
    const adapters = await buildAdapters(options);
    const observed = new Map<Platform, Array<{ url: string; key: string | undefined }>>();
    const failed = new Map<Platform, unknown>();
    for (const platform of PLATFORMS) {
      const before = seen.length;
      try {
        await (adapters.get(platform) as PlatformAdapter).latestShorts(QUERY);
      } catch (cause) {
        failed.set(platform, cause);
      }
      observed.set(platform, seen.slice(before));
    }

    /**
     * THE THREE. Each one must have issued at least one request, every request
     * must have gone to the vendor's host, and the endpoint must be the one
     * that platform's source maps to — which is what makes this an assertion
     * about the WIRING rather than about the client. A registry that built one
     * provider and handed it to all three would fail on the paths.
     */
    const expectedEndpoint: Record<string, string> = {
      tiktok: ENDPOINTS.tiktokTrending,
      instagram: ENDPOINTS.instagramUserReels,
      facebook: ENDPOINTS.facebookProfileReels,
    };
    for (const platform of ["tiktok", "instagram", "facebook"] as const) {
      const requests = observed.get(platform) ?? [];
      expect(failed.get(platform), `${platform} threw instead of reading the vendor`).toBeUndefined();
      expect(requests.length, `${platform} issued no request at all`).toBeGreaterThan(0);
      for (const request of requests) {
        const url = new URL(request.url);
        expect(url.host, `${platform} did not go to the vendor`).toBe(VENDOR_HOST);
        expect(url.pathname, `${platform} asked the wrong endpoint`).toBe(expectedEndpoint[platform]);
        // THE LEASED KEY ARRIVED. Not "a client was built" — the string that
        // came out of the credential store is on the wire, in the header the
        // vendor documents, and never in the URL.
        expect(request.key, `${platform} sent no x-api-key`).toBe(SC_KEY);
        expect(request.url).not.toContain(SC_KEY);
      }
    }

    // X IS NOT HANDED TO THE VENDOR, and the type system already says so —
    // `providers: { x: client }` does not compile. This is the half the type
    // cannot state: where the request actually lands.
    const xRequests = observed.get("x") ?? [];
    expect(xRequests.length, "X made no request at all").toBeGreaterThan(0);
    for (const request of xRequests) expect(new URL(request.url).host).toBe("api.x.com");

    // YOUTUBE IS KEYLESS AND STAYS KEYLESS. Paying a vendor for it would be
    // buying something yt-dlp already gives away.
    expect(
      observed.get("youtube"),
      "YouTube issued an HTTP request; it reads through yt-dlp and must not be on a metered API",
    ).toEqual([]);
  });

  it("puts the vendor key on the wire for a platform that had no other route at all", async () => {
    // Instagram and Facebook have no keyless path — yt-dlp marks instagram:user
    // CURRENTLY BROKEN and has no Facebook page enumerator — so before this
    // wiring, a saved vendor key left them reporting a Meta setup they no
    // longer need. With NO Meta credential in the store at all, both answer.
    const { seen, fetchImpl } = recorder();
    const adapters = await buildAdapters({
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seedStore: VENDOR_SEEDS,
      fetchImpl,
    });

    await (adapters.get("instagram") as PlatformAdapter).latestShorts(QUERY);
    await (adapters.get("facebook") as PlatformAdapter).latestShorts(QUERY);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      ENDPOINTS.instagramUserReels,
      ENDPOINTS.facebookProfileReels,
    ]);
  });

  it("shares ONE client across the three, so one request ceiling covers them all", async () => {
    /*
     * ONE CREDIT BALANCE, ONE METER. Three clients would be three ceilings
     * against one balance: a run capped at 2 requests could issue 6 and no
     * brake would fire. lib/platform/meta-client.ts records that exact mistake
     * having been made once already with the Meta call budget.
     *
     * The cap is set to 2 and three platforms are asked for one page each. The
     * third must be refused — which is only possible if all three are counting
     * against the same object.
     */
    const { seen, fetchImpl } = recorder();
    const adapters = await buildAdapters({
      env: { [VENDOR_ENV.tiktokRegions]: "US", [VENDOR_ENV.maxRequests]: "2" },
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seedStore: VENDOR_SEEDS,
      fetchImpl,
    });

    await (adapters.get("tiktok") as PlatformAdapter).latestShorts(QUERY);
    await (adapters.get("instagram") as PlatformAdapter).latestShorts(QUERY);
    await expect(
      (adapters.get("facebook") as PlatformAdapter).latestShorts(QUERY),
      "the third platform spent the shared budget's third request, so each one is metering itself",
    ).rejects.toThrow(/request budget is spent/i);
    expect(seen).toHaveLength(2);
  });
});

// ------------------------------------ what a vendor key does NOT silently do

/**
 * THE OTHER HALF OF THE SEAM, AND THE REASON THE PREVIOUS ROUND REFUSED TO
 * WRITE THE FIRST HALF.
 *
 * /admin/credentials and /admin/shorts render EVERY platform through this file.
 * A lease of a provider name a deployment's credential vocabulary does not know
 * does not come back null — the environment store dies looking up a field spec
 * that does not exist, and Postgres rejects an unknown enum value inside the
 * RPC. So a speculative lease takes out five working rows to enable one dead
 * one, and these tests are what stops that being reintroduced.
 */
describe("a vendor key that is missing, unusable or unconfigured never takes the page down", () => {
  const SC_KEY = "sc-live-key-not-real-0000";
  const SEC_UID = `MS4wLjABAAAA${"x".repeat(64)}`;

  /** A store that answers for platforms and dies on the vendor, as an old schema would. */
  const vendorUnknown: CredentialSource = {
    lease: async (provider) => {
      if (provider === VENDOR_PROVIDER) {
        throw new Error('invalid input value for enum credential_provider: "scrapecreators"');
      }
      return null;
    },
  };

  it("degrades to the keyless path and reports the read failure, rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const statuses = await platformStatuses({
        env: {},
        run: installed,
        credentials: vendorUnknown,
        seeds: { tiktok: [SEC_UID] },
      });

      // FIVE ROWS. Not an exception, and not four rows with one missing — a
      // platform missing from this list is a platform the UI cannot even say it
      // failed to read.
      expect(statuses.map((s) => s.platform)).toEqual([...PLATFORMS]);

      const tiktok = statuses.find((s) => s.platform === "tiktok");
      expect(
        tiktok?.available,
        "TikTok has a keyless path and a broken vendor key must not remove it",
      ).toBe(true);
      expect(tiktok?.notes.join(" "), "the failure must be reported, not swallowed").toMatch(
        /could not be READ/,
      );

      // Instagram and Facebook have no keyless path, so they refuse — and the
      // refusal names the vendor read that failed, rather than sending the
      // operator to a Meta setup they were told they no longer needed.
      const instagram = statuses.find((s) => s.platform === "instagram");
      expect(instagram?.available).toBe(false);
      expect(instagram?.reason).toMatch(/could not be READ/);
      expect(instagram?.reason).toMatch(/credential_provider/);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves an X credential read free to throw, because that asymmetry is deliberate", async () => {
    // The vendor catch must not have quietly become a general one. An X key
    // that cannot be READ is a broken deployment, and reporting "no key
    // configured" for it is the lie this repo exists to refuse.
    const exploding: CredentialSource = {
      lease: async () => {
        throw new Error("permission denied for function lease_api_credential");
      },
    };
    await expect(platformStatuses({ env: {}, run: installed, credentials: exploding })).rejects.toThrow(
      /lease_api_credential/,
    );
  });

  it("will not guess a TikTok region, and says which variable would give it one", async () => {
    /*
     * AN UNSET TIKTOK SOURCE IS "TELL ME A REGION OR A KEYWORD". It is not a
     * guess — "US" would decide what the operator is looking for and charge
     * them a credit for it — and it is not an empty result. A TikTok seed is a
     * sec_uid, which is yt-dlp's key for one creator and cannot be turned into
     * a region or a keyword by anything.
     */
    const seeded = await statusOf("tiktok", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seeds: { tiktok: [SEC_UID] },
    });
    expect(seeded?.available, "the keyless path still works and must not be taken away").toBe(true);
    expect(
      seeded?.notes.join(" "),
      "an operator who paid for a trending feed and is being served seeded creators has to be " +
        "told, or they will never find out",
    ).toMatch(new RegExp(VENDOR_ENV.tiktokRegions));

    const unseeded = await statusOf("tiktok", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
    });
    expect(unseeded?.available).toBe(false);
    // Both gaps, in one sentence, because both are true and either one fixes it.
    expect(unseeded?.reason).toMatch(/seed/i);
    expect(unseeded?.reason).toMatch(new RegExp(VENDOR_ENV.tiktokKeywords));
  });

  it("refuses Instagram and Facebook with a key and no seeds, rather than reporting them empty", async () => {
    // The dangerous direction. A provider built over an EMPTY source list
    // reports available and then throws in the middle of a run, after the card
    // has already promised the platform — so the refusal is decided here,
    // before anybody presses anything and before a credit is at risk.
    const statuses = await platformStatuses({
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seedStore: new FakeSeeds([]),
    });
    for (const platform of ["instagram", "facebook"] as const) {
      const status = statuses.find((s) => s.platform === platform);
      expect(status?.available, `${platform} must not promise what it cannot read`).toBe(false);
      expect(status?.reason, `${platform} must name the seeds it needs`).toMatch(/seed/i);
    }
  });

  it("will not turn a Facebook Page id into a page URL, and names the seed it skipped", async () => {
    // Two legitimate Facebook seeds for two different routes: the official
    // Graph route takes a numeric Page id, the vendor takes a public page URL.
    // Constructing one from the other resolves for some pages, 404s for others,
    // and costs a credit either way to find out which.
    const status = await statusOf("facebook", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seedStore: new FakeSeeds([{ platform: "facebook", seed: "1234567890", active: true }]),
    });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(/1234567890/);
    expect(status?.reason).toMatch(/page URL/i);
  });

  it("refuses a garbage request cap rather than spending the vendor's default", async () => {
    // The cap is counted in REQUESTS and the vendor bills one credit per
    // request, so the number IS what a run may cost. Falling back to a default
    // would spend on behalf of somebody visibly trying to limit it.
    const status = await statusOf("instagram", {
      env: { [VENDOR_ENV.maxRequests]: "forty" },
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      seedStore: new FakeSeeds([{ platform: "instagram", seed: "bluebottle", active: true }]),
    });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(new RegExp(VENDOR_ENV.maxRequests));
  });

  it("leases the vendor under a name a grep can find, and it is the exported one", () => {
    /*
     * PINS THE ONE PLACE THIS FILE'S HONESTY DETECTORS CAN BE FOOLED.
     *
     * tests/credential-honesty.test.tsx decides whether /admin/credentials is
     * telling the truth about "this key is spent on every run" by grepping the
     * run path for `lease("<provider>")`. A constant at the call site is
     * invisible to it — the page would keep making the claim and nothing would
     * check it — so registry.ts writes the literal. This is what stops the
     * literal and `VENDOR_PROVIDER` drifting apart afterwards, which would leave
     * the detector green while the registry leased something else entirely.
     */
    const registry = fs.readFileSync(
      path.join(path.resolve(import.meta.dirname, "..", ".."), "lib/platform/registry.ts"),
      "utf8",
    );
    expect(stripComments(registry)).toContain(`lease("${VENDOR_PROVIDER}")`);
  });

  it("prints no vendor note at all when no vendor key is saved", async () => {
    // The ordinary state. Every adapter already says what it needs, and adding
    // "you have not bought a vendor" to three more rows is noise on a page
    // whose whole job is one button.
    const statuses = await platformStatuses({ env: {}, run: installed });
    expect(statuses.flatMap((s) => s.notes)).toEqual([]);
  });

  it("lets a caller's own provider win, and drops the vendor note for that platform", async () => {
    // Two clients answering for one platform is two credit meters against one
    // invoice. And a platform that IS being read must not carry a sentence
    // saying nothing was configured for it.
    const status = await statusOf("tiktok", {
      env: {},
      run: installed,
      credentials: new FakeCredentials({ [VENDOR_PROVIDER]: leaseOf(SC_KEY) }),
      providers: { tiktok: provider },
    });
    expect(status?.available).toBe(true);
    expect(status?.notes).toEqual([]);
  });
});

// ------------------------------------------------- one Meta app, one budget

/**
 * A Graph API response that parses, for a single Reel over any threshold.
 *
 * Only the fields the adapter reads are here. It is not a fixture of a real
 * response — nothing in this repo has ever called Meta.
 */
const IG_BODY = {
  business_discovery: {
    id: IG_USER_ID,
    username: "bluebottle",
    media: {
      data: [
        {
          id: "17895695668004550",
          permalink: "https://www.instagram.com/reel/CabcDEfGhIj/",
          media_product_type: "REELS",
          view_count: 900_000,
          username: "bluebottle",
          timestamp: "2026-09-03T09:00:00+0000",
        },
      ],
    },
  },
};

const FB_BODY = {
  data: [
    {
      id: "1234567890_987654321",
      created_time: "2026-09-03T09:00:00+0000",
      permalink_url: "https://www.facebook.com/1234567890/posts/987654321",
      attachments: { data: [{ media_type: "video", type: "video_inline" }] },
    },
  ],
};

/** A fetch that answers both Meta edges and records every URL it was given. */
function metaFetch(urls: string[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/posts") ? FB_BODY : IG_BODY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const RUN: LatestShortsQuery = { limit: 10, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

const META_WIRED = {
  env: {},
  run: installed,
  credentials: new FakeCredentials({
    instagram: leaseOf(META_TOKEN, { ig_business_account_id: IG_USER_ID }),
    facebook: leaseOf(META_TOKEN),
  }),
  seedStore: new FakeSeeds([
    { platform: "instagram", seed: "bluebottle", active: true },
    { platform: "facebook", seed: "1234567890", active: true },
  ]),
};

describe("Instagram and Facebook are one Meta app, so they share one budget", () => {
  it("spends a single hourly allowance across both adapters", async () => {
    // WOULD HAVE CAUGHT IT TWICE OVER. The previous registry passed the Meta
    // adapters no options at all, so each built its own 200-call budget and the
    // two could together issue 400 calls an hour against one app's allowance —
    // and a `metaBudget` option did not exist to be passed. With a ceiling of
    // one, the second adapter must be refused BEFORE its request goes out.
    const urls: string[] = [];
    const budget = new MetaCallBudget(1);
    const adapters = await buildAdapters({ ...META_WIRED, metaBudget: budget, fetchImpl: metaFetch(urls) });

    await (adapters.get("instagram") as PlatformAdapter).latestShorts(RUN);
    expect(budget.spent()).toBe(1);

    await expect((adapters.get("facebook") as PlatformAdapter).latestShorts(RUN)).rejects.toBeInstanceOf(
      MetaBudgetError,
    );
    // The brake fires before the wire, which is the whole point of a budget
    // that refuses rather than sleeps.
    expect(urls).toHaveLength(1);
  });

  it("builds one shared budget when the caller supplies none", async () => {
    // The default path. `resolveWiring` runs ONCE for the whole set, so the
    // budget it constructs is the same object in both adapters — five separate
    // resolutions would silently be five budgets again.
    const urls: string[] = [];
    const adapters = await buildAdapters({ ...META_WIRED, fetchImpl: metaFetch(urls) });
    await (adapters.get("instagram") as PlatformAdapter).latestShorts(RUN);
    await (adapters.get("facebook") as PlatformAdapter).latestShorts(RUN);
    expect(urls).toHaveLength(2);
  });

  it("sends the leased Meta token, as the access_token Meta documents", async () => {
    // The token the registry leased is the token that goes on the wire. Meta
    // documents the query-string form, which is why metaGet builds a safe URL
    // first and adds the token last; this asserts the LEASE reached the call at
    // all, which is the half of B2 an availability check cannot see.
    const urls: string[] = [];
    const adapters = await buildAdapters({ ...META_WIRED, fetchImpl: metaFetch(urls) });
    await (adapters.get("instagram") as PlatformAdapter).latestShorts(RUN);
    expect(urls[0]).toContain(`access_token=${encodeURIComponent(META_TOKEN)}`);
    // ...and the adapter's own error paths scrub it. Nothing here asserts about
    // logging, which is meta-client.test.ts's subject; this only proves the
    // token the registry leased is the token that was sent.
  });
});

// -------------------------------------------------- seeds: the database wins

describe("seeds come from the database when there is one", () => {
  it("reads the stored seed and ignores the environment naming a different one", async () => {
    const urls: string[] = [];
    const adapters = await buildAdapters({
      env: { PLATFORM_SEEDS_INSTAGRAM: "from-the-environment" },
      run: installed,
      credentials: new FakeCredentials({
        instagram: leaseOf(META_TOKEN, { ig_business_account_id: IG_USER_ID }),
      }),
      seedStore: new FakeSeeds([{ platform: "instagram", seed: "from-the-database", active: true }]),
      fetchImpl: metaFetch(urls),
    });
    await (adapters.get("instagram") as PlatformAdapter).latestShorts(RUN);
    expect(urls[0]).toContain("from-the-database");
    expect(urls[0]).not.toContain("from-the-environment");
  });

  it("treats a deactivated seed as zero, not as a reason to read the environment", async () => {
    // The failure this forbids: an operator switches a creator off on
    // /admin/seeds, the environment still names it, a union keeps fetching it,
    // and the page shows it as inactive. Zero means zero — see seeds.ts.
    const status = await statusOf("instagram", {
      env: { PLATFORM_SEEDS_INSTAGRAM: "still-in-the-environment" },
      run: installed,
      credentials: new FakeCredentials({
        instagram: leaseOf(META_TOKEN, { ig_business_account_id: IG_USER_ID }),
      }),
      seedStore: new FakeSeeds([{ platform: "instagram", seed: "switched-off", active: false }]),
    });
    expect(status?.available).toBe(false);
    expect(status?.reason).toMatch(/PLATFORM_SEEDS_INSTAGRAM/);
  });

  it("falls back to the environment when there is no seed store at all", async () => {
    // A machine with no database still has seeds, and still has to work.
    const status = await statusOf("youtube", {
      env: { PLATFORM_SEEDS_YOUTUBE: CHANNEL },
      run: installed,
    });
    expect(status?.available).toBe(true);
  });

  it("lets an explicit list win over both", async () => {
    // What lib/shorts/schedule.ts passes: it has already read the store and
    // grouped the rows, so the registry must not go and read them again.
    const adapters = await buildAdapters({
      env: { PLATFORM_SEEDS_YOUTUBE: "from-the-environment" },
      run: installed,
      seeds: { youtube: [CHANNEL] },
      seedStore: new FakeSeeds([{ platform: "youtube", seed: "from-the-database", active: true }]),
    });
    expect(await (adapters.get("youtube") as PlatformAdapter).unavailableReason()).toBeNull();
  });
});

// ---------------------------------------- the field name the registry reads

describe("the identifier the registry reads is the one the credential form writes", () => {
  it("still exists on the Instagram provider's field list", () => {
    // The registry has to name `ig_business_account_id` as a string literal —
    // there is nothing else to key an identifier map by. A rename in
    // lib/credentials/fields.ts would silently give Instagram `igUserId: null`,
    // and it would report "not configured" with a complete credential sitting
    // in the database. That is this round's bug in miniature, so it gets a test.
    const ids = credentialFields("instagram").map((f) => f.id);
    expect(ids).toContain("ig_business_account_id");
  });
});

// ------------------------------------------------ X's own configuration seam

describe("X's client is built the way X's own documentation says to build it", () => {
  it("sends the Post fields parameter the environment names", async () => {
    // x-client.ts throws an error telling an operator to "Set
    // X_POST_FIELDS_PARAM to `post.fields` and run again" — and until this
    // rewrite NOTHING IN THE TREE READ THAT VARIABLE. An error naming a lever
    // that does not exist is the same failure as an adapter nothing builds.
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ meta: { total_post_count: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const adapters = await buildAdapters({
      env: { ...X_ENV, X_POST_FIELDS_PARAM: "post.fields" },
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
      fetchImpl,
    });
    // A counts probe of zero, so nothing is billed per Post and no search runs.
    await (adapters.get("x") as PlatformAdapter).latestShorts(RUN);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/2/tweets/counts/recent");
    // The token travels in a header. If it ever reaches a URL, this is where
    // that shows up first.
    expect(urls[0]).not.toContain(X_TOKEN);
  });

  it("ignores an unrecognised X_POST_FIELDS_PARAM rather than taking the page down", async () => {
    // Read while a status page renders all five platforms. A typo in an
    // optional escape hatch may not be the thing that stops the page.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const status = await statusOf("x", {
        env: { ...X_ENV, X_POST_FIELDS_PARAM: "twee.fields" },
        run: installed,
        credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
      });
      expect(status?.available).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("honours an explicit null client even with a token saved", async () => {
    // The override exists for a caller that has already decided X is not to
    // run. `undefined` means "build one"; `null` means "do not".
    const status = await statusOf("x", {
      env: X_ENV,
      run: installed,
      credentials: new FakeCredentials({ x: leaseOf(X_TOKEN) }),
      xClient: null,
    });
    expect(status?.available).toBe(false);
  });
});

// ======================================================= the return shape

describe("the registry knows every platform, and only the registry does", () => {
  it("has an adapter for all six, and each one admits which it is", async () => {
    // The mapping is `satisfies Record<Platform, ...>`, so a sixth platform in
    // PLATFORMS breaks the build rather than silently returning nothing — but
    // that only catches a MISSING key, not a mis-wired one.
    for (const platform of PLATFORMS) {
      expect((await adapterFor(platform, { run: installed })).platform).toBe(platform);
    }
  });

  it("builds the whole set in the vocabulary's order", async () => {
    const adapters = await buildAdapters({ run: installed });
    expect([...adapters.keys()]).toEqual([...PLATFORMS]);
  });

  it("reports a row for every platform, including the ones nothing can read", async () => {
    // A platform missing from this list is a platform the UI cannot say it
    // failed to read, which is how "could not be read" becomes "no results".
    const statuses = await platformStatuses({ env: {}, run: installed });
    expect(statuses.map((s) => s.platform)).toEqual([...PLATFORMS]);
    expect(statuses.map((s) => s.label)).toEqual(PLATFORMS.map(platformLabel));
  });

  it("gives every unavailable platform a real sentence, not a shrug", async () => {
    const statuses = await platformStatuses({ env: {}, run: installed });
    const unavailable = statuses.filter((s) => !s.available);
    expect(unavailable).toHaveLength(6);
    for (const status of unavailable) {
      expect(status.reason, status.platform).toBeTruthy();
      // Long enough to actually explain something. "Not supported" is 13.
      expect((status.reason as string).length, status.platform).toBeGreaterThan(60);
      expect(status.description.length, status.platform).toBeGreaterThan(40);
    }
  });

  it("turns YouTube available the moment it is seeded", async () => {
    const statuses = await platformStatuses({
      env: { PLATFORM_SEEDS_YOUTUBE: CHANNEL },
      run: installed,
    });
    const youtube = statuses.find((s) => s.platform === "youtube");
    expect(youtube?.available).toBe(true);
    expect(youtube?.reason).toBeNull();
  });

  it("turns a provider-gap platform available the moment a provider is handed in", async () => {
    const statuses = await platformStatuses({ env: {}, run: installed, providers: { instagram: provider } });
    expect(statuses.find((s) => s.platform === "instagram")?.available).toBe(true);
    // And only that one. Handing in one provider must not flip the others.
    expect(statuses.filter((s) => s.available).map((s) => s.platform)).toEqual(["instagram"]);
  });
});

describe("statusFor — an adapter that cannot say whether it works has not said it works", () => {
  class Hostile implements PlatformAdapter {
    readonly platform: Platform = "tiktok";
    describe() {
      return "hostile";
    }
    async unavailableReason(): Promise<string | null> {
      throw new Error("upstream exploded");
    }
    async latestShorts(_query: LatestShortsQuery): Promise<ShortRecord[]> {
      return [];
    }
    async downloadUrl(_short: ShortRecord): Promise<string | null> {
      return null;
    }
  }

  it("reports unavailable rather than letting the throw escape", async () => {
    // If this propagated, one broken adapter would take down the status of all
    // five and the page would show nothing at all.
    const status = await statusFor(new Hostile());
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/upstream exploded/);
  });

  it("never reads a failed check as available", async () => {
    // The dangerous direction. Defaulting to available would send the run at an
    // adapter that has already said it is in trouble.
    expect((await statusFor(new Hostile())).available).toBe(false);
  });

  it("still produces a row when even describe() throws", async () => {
    // A status row must exist for every platform no matter how badly its
    // adapter is behaving, because a missing row is a platform the UI cannot
    // say anything about at all.
    class Worse extends Hostile {
      override describe(): string {
        throw new Error("describe exploded");
      }
    }
    const status = await statusFor(new Worse());
    expect(status.platform).toBe("tiktok");
    expect(status.description).toMatch(/could not describe itself/);
    expect(status.available).toBe(false);
  });
});

describe("seeds", () => {
  it("derives the environment key from the platform name", () => {
    // Derived, not a lookup table: a table is six branches waiting to
    // disagree, and a seventh platform gets its variable for free this way.
    // Threads proves the point — it arrived on 2026-09-08 and this line needed
    // no new branch, even though nothing ever READS its variable (Threads is
    // searched by keyword, never by account, so it has no seeds; see
    // lib/platform/threads.ts). The key is derivable whether or not it is used.
    expect(PLATFORMS.map(seedEnvKey)).toEqual([
      "PLATFORM_SEEDS_YOUTUBE",
      "PLATFORM_SEEDS_TIKTOK",
      "PLATFORM_SEEDS_INSTAGRAM",
      "PLATFORM_SEEDS_X",
      "PLATFORM_SEEDS_FACEBOOK",
      "PLATFORM_SEEDS_THREADS",
    ]);
  });

  it("splits a list on commas and whitespace, and drops the gaps", () => {
    const seeds = seedsFor("youtube", { env: { PLATFORM_SEEDS_YOUTUBE: " @a, @b\n@c ,, " } });
    expect(seeds).toEqual(["@a", "@b", "@c"]);
  });

  it("lets an explicit list win over the environment", () => {
    const seeds = seedsFor("tiktok", { env: { PLATFORM_SEEDS_TIKTOK: "from-env" }, seeds: { tiktok: ["explicit"] } });
    expect(seeds).toEqual(["explicit"]);
  });

  it("returns nothing when nothing is configured", () => {
    expect(seedsFor("facebook", { env: {} })).toEqual([]);
  });
});

// ---------------------------------------------------------------- the seam

/** Everything under here is lib/platform's business. Nothing else may know it. */
const PLATFORM_DIR = "lib/platform/";

/**
 * `x` is deliberately absent from this list. A single quoted letter is far too
 * common in ordinary code to be evidence of anything, and a rule that produces
 * false accusations is a rule people delete.
 */
const NAMEABLE: readonly string[] = ["youtube", "tiktok", "instagram", "facebook"];

/**
 * WHAT COUNTS AS BRANCHING, precisely — because the rule has to be enforceable
 * without being a nuisance.
 *
 * A COMPARISON against a platform literal is the offence: `=== "tiktok"`,
 * `case "youtube":`, `includes("instagram")`. Each one is a fork that some other
 * platform silently does not take, and five of them is a tool nobody can
 * describe.
 *
 * A `Record<Platform, ...>` TABLE is not. Its keys are checked by the compiler,
 * so it cannot silently miss a platform — add a sixth to PLATFORMS and the table
 * stops compiling. That is a stronger guarantee than this test can offer, which
 * is exactly why the registry's own adapter map is written that way. Banning
 * tables would push people towards branches, which is the opposite of the point.
 */
const COMPARISONS = NAMEABLE.flatMap((p) => [
  new RegExp(`[=!]==?\\s*["'\`]${p}["'\`]`),
  new RegExp(`["'\`]${p}["'\`]\\s*[=!]==?`),
  new RegExp(`case\\s+["'\`]${p}["'\`]`),
  new RegExp(`(includes|startsWith|indexOf)\\(\\s*["'\`]${p}["'\`]`),
]);

function sourceFiles(): Array<{ rel: string; body: string }> {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const out: Array<{ rel: string; body: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules", ".next", "fixtures"].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (rel.startsWith(PLATFORM_DIR)) continue;
      out.push({ rel, body: fs.readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

/** Comments are prose about the decision, not code that branches. Strip them. */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("nothing outside lib/platform branches on platform identity", () => {
  it("is the only place that compares against a platform name", () => {
    // The failure: an `if (platform === "tiktok")` in a page, then another in
    // an action, then a third in a query — and by the time there are five
    // nobody can say what the tool does for Instagram without reading all five.
    const offenders: string[] = [];
    for (const { rel, body } of sourceFiles()) {
      const code = stripComments(body);
      if (COMPARISONS.some((re) => re.test(code))) offenders.push(rel);
    }
    expect(offenders, `platform branching leaked into:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is the only place that decides which adapters exist", () => {
    // Everything else asks the registry. A module that constructs its own
    // adapter list decides for itself which platforms are in the product, and
    // the ones it forgets do not appear as unavailable — they do not appear at
    // all. That is the honesty rule failing by omission rather than by [].
    const offenders: string[] = [];
    for (const { rel, body } of sourceFiles()) {
      if (/from\s+["'][^"']*\/platform\/(youtube|tiktok|instagram|x|facebook)["']/.test(body)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "these modules build adapters themselves instead of calling buildAdapters() from " +
        `lib/platform/registry.ts, so any platform they forget vanishes silently:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * THE SEAM THAT WAS MISSING, AND IT IS WHY X WAS DEAD FOR A WHOLE ROUND.
   *
   * The two rules above say nobody else may BUILD an adapter. Neither said the
   * registry has to build a WORKING one, so a registry that constructed every
   * adapter and handed it nothing passed both — and `new XClient` appeared
   * nowhere in the tree while 746 tests stayed green.
   *
   * This asserts the one construction that has to exist somewhere, and that it
   * exists HERE. It is a grep, which is a blunt instrument, and it is paired
   * with the availability tests at the top of this file rather than trusted on
   * its own: the grep proves the line exists, and those prove it runs.
   */
  it("is the only place that constructs an X API client, and it does construct one", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const registry = fs.readFileSync(path.join(root, "lib/platform/registry.ts"), "utf8");
    expect(stripComments(registry)).toMatch(/new XClient\(/);

    const offenders = sourceFiles()
      .filter(({ body }) => /new XClient\(/.test(stripComments(body)))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `these modules build their own X client instead of letting the registry do it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * THE SAME GREP FOR THE VENDOR, AND IT IS THE ONE THIS ROUND WAS ABOUT.
   *
   * `ScrapeCreatorsClient` had ONE definition and ZERO production call sites.
   * lib/platform/scrapecreators.ts could be moved out of the tree entirely and
   * 976 tests stayed green with `tsc` exiting 0 — the whole vendor, unreachable,
   * fully tested, and invisible to every check this repo had.
   *
   * A grep is a blunt instrument and this one is deliberately not trusted on its
   * own: it proves the line EXISTS, and the acceptance tests above prove it
   * RUNS. What it adds that they cannot is the negative half — that no second
   * module quietly starts building its own client, which would be a second
   * credit meter against one balance.
   */
  it("is the only place that constructs a ScrapeCreators client, and it does construct one", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const registry = fs.readFileSync(path.join(root, "lib/platform/registry.ts"), "utf8");
    expect(stripComments(registry)).toMatch(/new ScrapeCreatorsClient\(/);

    // `sourceFiles()` already excludes lib/platform/, so this is asking about
    // everything OUTSIDE the seam — a page, an action, a script.
    const offenders = sourceFiles()
      .filter(({ body }) => /new ScrapeCreatorsClient\(/.test(stripComments(body)))
      .map(({ rel }) => rel);
    expect(
      offenders,
      "these modules build their own ScrapeCreators client instead of letting the registry do " +
        `it, which is a second credit meter against one balance:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
