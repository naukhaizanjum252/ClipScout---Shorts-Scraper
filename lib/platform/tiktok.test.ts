/**
 * The TikTok adapter, in both of its modes.
 *
 * The thing worth protecting here is not that TikTok works — it may not, and
 * the file says so. It is that every way it can fail produces a SENTENCE and
 * never an empty list: no seeds, a seed of the wrong shape, no yt-dlp, a
 * listing that comes back without the numbers the threshold needs, or a vendor
 * that was never told what to ask for.
 *
 * ============================================================================
 * WHY THIS FILE IMPORTS lib/platform/scrapecreators.ts
 * ============================================================================
 *
 * Because the seam is the thing that kept going missing. A previous round
 * shipped a complete, well-tested ScrapeCreators client that nothing in the
 * tree ever built — a reviewer moved the file out and the suite stayed green
 * with tsc exiting 0. Tests that only ever see a hand-written fake
 * `ProviderClient` cannot catch that: a fake satisfies the interface by
 * construction and proves nothing about the object the app would actually use.
 *
 * So the block at the bottom builds the REAL `ScrapeCreatorsClient` and the
 * REAL `ScrapeCreatorsProvider` — the exact two classes lib/platform/registry.ts
 * imports — hands the provider to the REAL `TikTokAdapter`, and runs the REAL
 * `getLatestShorts` over it. Only `fetch` is stubbed. Delete
 * lib/platform/scrapecreators.ts and this file stops compiling. That is
 * deliberate and it is the point.
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery } from "./adapter";
import {
  ScrapeCreatorsClient,
  ScrapeCreatorsProvider,
  ScrapeCreatorsSourceError,
  type TikTokSource,
} from "./scrapecreators";
import { TikTokAdapter } from "./tiktok";
import { PlatformUnavailableError, type ProviderClient } from "./unavailable";
import { YtDlpError, type YtDlpRunner } from "./ytdlp";
import { MemoryShortsStore } from "../shorts/memory-store";
import { getLatestShorts } from "../shorts/run";

const QUERY: LatestShortsQuery = { limit: 20, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };
const NOW = () => new Date("2026-09-04T12:00:00.000Z");

/** A real-shaped sec_uid: `MS4wLjABAAAA` plus 64 characters, per yt-dlp's own regex. */
const SEC_UID = `MS4wLjABAAAA${"x".repeat(64)}`;

function scripted(handler: (args: readonly string[]) => string): { run: YtDlpRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: YtDlpRunner = async (args) => {
    calls.push([...args]);
    return handler(args);
  };
  return { run, calls };
}

/**
 * A listing shaped the way yt-dlp's `_parse_aweme_video_web(extract_flat=True)`
 * builds one — id, url, duration, view_count, uploader as the @name and
 * uploader_id as a numeric author id.
 */
function listing(entries: Array<Record<string, unknown>>) {
  return JSON.stringify({ id: SEC_UID, title: "someone", entries });
}

function post(over: Record<string, unknown> = {}) {
  return {
    id: "7016615996818033413",
    url: "https://www.tiktok.com/@someone/video/7016615996818033413",
    title: "a post",
    duration: 27,
    view_count: 2_000_000,
    like_count: 900,
    comment_count: 12,
    uploader: "someone",
    uploader_id: "6691488002098119685",
    channel_id: SEC_UID,
    ...over,
  };
}

function workingRunner(body = listing([post()])) {
  return scripted((args) => {
    if (args.includes("--version")) return "2026.07.04\n";
    if (args.includes("--print")) return "https://media.test/tt.mp4\n";
    return body;
  });
}

/** A hand-written provider, for the cases that are about the ADAPTER's branching. */
function fakeProvider(
  over: Partial<ProviderClient> = {},
): ProviderClient & { calls: LatestShortsQuery[] } {
  const calls: LatestShortsQuery[] = [];
  return {
    calls,
    latestShorts: async (query) => {
      calls.push(query);
      return [
        {
          platform: "tiktok",
          platform_video_id: "vendor-1",
          url: "https://www.tiktok.com/@trending/video/vendor-1",
          title: "from the trending feed",
          creator_handle: "trending",
          creator_id: "42",
          creator_url: null,
          duration_seconds: 31,
          view_count: 3_100_000,
          like_count: 1,
          comment_count: 1,
          published_at: "2026-09-01T00:00:00.000Z",
          thumbnail_url: null,
          discovered_at: "2026-09-04T12:00:00.000Z",
          discovered_by: "scrapecreators:/v1/tiktok/get-trending-feed",
          topic_slug: null,
        },
      ];
    },
    downloadUrl: async () => "https://media.vendor/tt.mp4",
    ...over,
  };
}

// ===========================================================================
describe("unavailableReason — every refusal names something the operator can do", () => {
  it("explains that TikTok cannot be browsed at all, keylessly", async () => {
    // Verified from `yt-dlp --list-extractors` on 2026-09-04: tag, sound and
    // effect are all marked CURRENTLY BROKEN and there is no trending
    // extractor. So "seed creators" is the honest instruction, not a shortcut.
    const reason = await new TikTokAdapter(null, { run: workingRunner().run }).unavailableReason();
    expect(reason).toMatch(/CURRENTLY BROKEN/);
    expect(reason).toMatch(/No TikTok creators have been seeded/);
  });

  it("refuses an @handle seed, quoting yt-dlp's own diagnosis", async () => {
    // Run here against two unrelated public profiles, both failed with exactly
    // this. Letting the handle through would move that failure from a settings
    // page into the middle of a run.
    const reason = await new TikTokAdapter(null, {
      seeds: ["@khaby.lame"],
      run: workingRunner().run,
    }).unavailableReason();
    expect(reason).toMatch(/Unable to extract secondary user ID/);
    expect(reason).toContain("@khaby.lame");
  });

  it("tells the operator where a sec_uid comes from", async () => {
    // A reason that says "wrong format" and stops is not actionable.
    const reason = await new TikTokAdapter(null, {
      seeds: ["someone"],
      run: workingRunner().run,
    }).unavailableReason();
    expect(reason).toMatch(/tiktok\.com\/@someone\/video/);
  });

  it("checks seed shape without spawning anything", async () => {
    const { run, calls } = workingRunner();
    await new TikTokAdapter(null, { seeds: ["@nope"], run }).unavailableReason();
    expect(calls).toHaveLength(0);
  });

  it("reports a missing yt-dlp", async () => {
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, "`yt-dlp` is not installed or not on PATH");
    };
    await expect(
      new TikTokAdapter(null, { seeds: [SEC_UID], run }).unavailableReason(),
    ).resolves.toMatch(/not installed or not on PATH/);
  });

  it("accepts a sec_uid of the shape yt-dlp's own regex requires", async () => {
    await expect(
      new TikTokAdapter(null, { seeds: [SEC_UID], run: workingRunner().run }).unavailableReason(),
    ).resolves.toBeNull();
  });
});

// ===========================================================================
/**
 * ONE UNUSABLE SEED IS ONE UNUSABLE ROW — the same scar as YouTube's, recorded
 * in lib/platform/youtube.test.ts and fixed in the same round. TikTok's version
 * was worse: the automatic ranking wrote thirteen @names into `platform_seeds`,
 * not one of which is a sec_uid, so the refusal was correct and total.
 * Migration 13 stops writing them; this is the half that stops a single one
 * costing the creators beside it.
 */
describe("a seed it cannot address costs its own row, not the platform", () => {
  it("still runs when at least one seed is a sec_uid", async () => {
    await expect(
      new TikTokAdapter(null, {
        seeds: ["@khaby.lame", SEC_UID],
        run: workingRunner().run,
      }).unavailableReason(),
    ).resolves.toBeNull();
  });

  it("says which seeds it is skipping", () => {
    const described = new TikTokAdapter(null, {
      seeds: ["@khaby.lame", SEC_UID],
      run: workingRunner().run,
    }).describe();
    expect(described).toContain("@khaby.lame");
    expect(described).toMatch(/1 of 2 seeded values are not sec_uids/);
  });

  it("reads only the seeds it can address", async () => {
    const { run, calls } = workingRunner();
    await new TikTokAdapter(null, {
      seeds: ["@khaby.lame", SEC_UID],
      run,
      now: NOW,
    }).latestShorts(QUERY);
    const listings = calls.filter((args) => args.some((a) => a.startsWith("tiktokuser:")));
    expect(listings).toHaveLength(1);
    expect(listings[0]).toContain(`tiktokuser:${SEC_UID}`);
  });
});

// ===========================================================================
describe("latestShorts — the keyless yt-dlp path", () => {
  it("addresses the creator the way yt-dlp asked to be addressed", async () => {
    // `tiktokuser:<sec_uid>` is the only input form that skips the profile-page
    // scrape, which is the step verified to fail.
    const { run, calls } = workingRunner();
    await new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(QUERY);
    expect(calls.flat()).toContain(`tiktokuser:${SEC_UID}`);
  });

  it("reads the handle from `uploader`, not from the numeric author id", async () => {
    // TikTok is the other way round from YouTube. Getting this wrong puts a
    // number in the handle column, where it still looks like data.
    const { run } = workingRunner();
    const [short] = await new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(
      QUERY,
    );
    expect(short.creator_handle).toBe("someone");
    expect(short.creator_id).toBe(SEC_UID);
    expect(short.platform).toBe("tiktok");
    expect(short.platform_video_id).toBe("7016615996818033413");
  });

  it("applies the same ceiling as every other platform", async () => {
    // Every TikTok is short in practice. The filter runs anyway, from the same
    // config, because "it never matters here" is how a filter is wrong the day
    // the platform raises its own limit.
    const { run } = workingRunner(listing([post({ id: "long", duration: 200 }), post()]));
    const shorts = await new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(
      QUERY,
    );
    expect(shorts.map((s) => s.platform_video_id)).toEqual(["7016615996818033413"]);
  });

  it("THROWS rather than returning [] when it cannot run", async () => {
    await expect(
      new TikTokAdapter(null, { run: workingRunner().run }).latestShorts(QUERY),
    ).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("THROWS when the listing arrives without view counts", async () => {
    // The failure this guards: TikTok changes its payload, every row loses its
    // playCount, every row fails the threshold, and the screen reports that
    // nothing on TikTok passed 500,000 views.
    const { run } = workingRunner(
      listing([post({ view_count: undefined }), post({ id: "b", view_count: undefined })]),
    );
    await expect(
      new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(QUERY),
    ).rejects.toThrow(/not one carried a view count/);
  });

  it("passes yt-dlp's own failure through instead of swallowing it", async () => {
    // If TikTok demands a login, that sentence is the most useful thing anyone
    // can be told, and it comes from upstream rather than from us.
    const run: YtDlpRunner = async (args) => {
      if (args.includes("--version")) return "2026.07.04\n";
      throw new YtDlpError(
        null,
        "yt-dlp exited 1: ERROR: [tiktok:user] Log into an account that has access",
      );
    };
    await expect(
      new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(QUERY),
    ).rejects.toThrow(/Log into an account that has access/);
  });

  it("reports an empty creator as empty, not as broken", async () => {
    // Zero entries IS a result: this creator posted nothing recently. It must
    // not be turned into an error any more than an error may be turned into [].
    const { run } = workingRunner(listing([]));
    await expect(
      new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(QUERY),
    ).resolves.toEqual([]);
  });
});

// ===========================================================================
describe("downloadUrl", () => {
  it("resolves one on demand", async () => {
    const { run } = workingRunner();
    const adapter = new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl(short)).resolves.toBe("https://media.test/tt.mp4");
  });

  it("refuses another platform's row", async () => {
    const { run } = workingRunner();
    const adapter = new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl({ ...short, platform: "youtube" })).rejects.toThrow(YtDlpError);
  });

  it("throws yt-dlp's reason on the keyless path rather than returning null", async () => {
    // Same rule as YouTube: null on this seam means the adapter cannot get a
    // file at all, so a refusal has to arrive as a refusal, in yt-dlp's words.
    const { run: working } = workingRunner();
    const run: YtDlpRunner = async (args) => {
      if (args.includes("--print")) {
        throw new YtDlpError(null, "yt-dlp exited 1: ERROR: [TikTok] video is private");
      }
      return working(args);
    };
    const adapter = new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl(short)).rejects.toThrow(/is private/);
  });

  it("asks the provider, not yt-dlp, when there is one", async () => {
    const { run, calls } = workingRunner();
    const adapter = new TikTokAdapter(fakeProvider(), { seeds: [SEC_UID], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl(short)).resolves.toBe("https://media.vendor/tt.mp4");
    expect(calls).toHaveLength(0);
  });

  it("keeps the platform guard in vendor mode — a foreign row is a routing bug, not a null", async () => {
    // Handing back null here would render as "no download available for this
    // video" when the truth is that the caller sent an Instagram row to the
    // TikTok adapter.
    const adapter = new TikTokAdapter(fakeProvider(), { run: workingRunner().run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl({ ...short, platform: "instagram" })).rejects.toThrow(
      YtDlpError,
    );
  });
});

// ===========================================================================
describe("the provider slot — the parameter this adapter did not have", () => {
  it("says which mode it is in, because the two answer different questions", async () => {
    const vendor = new TikTokAdapter(fakeProvider(), { run: workingRunner().run });
    const keyless = new TikTokAdapter(null, { seeds: [SEC_UID], run: workingRunner().run });

    expect(vendor.mode).toBe("vendor");
    expect(keyless.mode).toBe("yt-dlp");
    // "What is trending in the US" and "what did these three creators post" are
    // not the same answer, and an operator who cannot tell them apart cannot
    // tell whether the tool answered the question they asked.
    expect(vendor.describe()).not.toBe(keyless.describe());
    expect(vendor.describe()).toMatch(/trending feed/);
    expect(keyless.describe()).toMatch(/sec_uid/);
  });

  it("is available with a provider even with no seeds and no yt-dlp at all", async () => {
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, "`yt-dlp` is not installed or not on PATH");
    };
    const adapter = new TikTokAdapter(fakeProvider(), { run });
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });

  it("delegates latestShorts to the provider and never spawns yt-dlp", async () => {
    const { run, calls } = workingRunner();
    const provider = fakeProvider();
    const adapter = new TikTokAdapter(provider, { seeds: [SEC_UID], run, now: NOW });

    const shorts = await adapter.latestShorts(QUERY);

    expect(shorts.map((s) => s.platform_video_id)).toEqual(["vendor-1"]);
    expect(provider.calls).toEqual([QUERY]);
    // SEEDS ARE NOT SILENTLY MIXED IN. A run that says "trending" must not also
    // be quietly reading three creators nobody mentioned.
    expect(calls).toHaveLength(0);
  });

  it("keeps the keyless path working when there is no provider", async () => {
    // A vendor key that lapses must not take TikTok with it.
    const { run } = workingRunner();
    const shorts = await new TikTokAdapter(null, { seeds: [SEC_UID], run, now: NOW }).latestShorts(
      QUERY,
    );
    expect(shorts.map((s) => s.discovered_by)).toEqual(["ytdlp:tiktok-user"]);
  });

  it("lets a provider's failure out rather than converting it into []", async () => {
    const boom = fakeProvider({
      latestShorts: async () => {
        throw new ScrapeCreatorsSourceError("the vendor refused");
      },
    });
    await expect(new TikTokAdapter(boom).latestShorts(QUERY)).rejects.toThrow(/the vendor refused/);
  });
});

// ===========================================================================
// THE SEAM. Real client, real provider, real adapter, real run.
// ===========================================================================

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

function stubFetch(...replies: Reply[]) {
  const calls: string[] = [];
  let index = 0;
  const fn = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

/**
 * The documented trending shape.
 *
 * `video.duration` IS 89131 AND THAT LITERAL IS THE WHOLE POINT — milliseconds,
 * from https://docs.scrapecreators.com/v3/tiktok/profile/videos, where it sits
 * beside a `create_time` of 1739470683. Read as seconds it is a twenty-four-hour
 * TikTok, which does not exist.
 */
function trendingBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    credits_charged: 1,
    credits_remaining: 24_812,
    aweme_list: [
      {
        aweme_id: "7334621391758642478",
        desc: "how to fold a shirt",
        create_time: 1_739_470_683,
        share_url: "https://www.tiktok.com/@kansascitychiefsfan5/video/7334621391758642478",
        statistics: { play_count: 3_100_000, digg_count: 412_000, comment_count: 8_140 },
        author: { unique_id: "kansascitychiefsfan5", uid: "6754760670083138566" },
        video: {
          duration: 89_131,
          cover: { url_list: ["https://p16.tiktokcdn.com/cover.jpeg"] },
          download_addr: { url_list: ["https://v16.tiktokcdn.com/dl.mp4?sig=2"] },
        },
      },
    ],
    ...over,
  };
}

/** The two classes lib/platform/registry.ts imports, built the way it builds them. */
function vendorTikTok(fetchImpl: typeof globalThis.fetch, sources: readonly TikTokSource[]) {
  const client = new ScrapeCreatorsClient({
    apiKey: "sc-leased-not-a-real-key",
    fetch: fetchImpl,
    now: NOW,
  });
  return {
    client,
    provider: new ScrapeCreatorsProvider({ client, platform: "tiktok", sources }),
  };
}

describe("THE SEAM — ScrapeCreatorsProvider into TikTokAdapter into getLatestShorts", () => {
  it("carries a configured region all the way to a kept 89-second short", async () => {
    /*
     * THE TEST THIS ROUND EXISTS FOR.
     *
     * Nothing between the key and the report is hand-faked: the real
     * `ScrapeCreatorsClient`, the real `ScrapeCreatorsProvider`, the real
     * `TikTokAdapter` in the provider slot it did not previously have, and the
     * real `getLatestShorts` judging the rows. Only `fetch` is stubbed, because
     * there is no ScrapeCreators key on this machine and never has been.
     *
     * It also proves the millisecond conversion WHERE IT MATTERS. Read as
     * seconds, 89131 fails the 120-second ceiling, the row lands in
     * `dropped.tooLong`, and the report says TikTok had nothing under the
     * Shorts ceiling — a sentence that reads as a legitimate result.
     */
    const { fn, calls } = stubFetch({ body: trendingBody() });
    const { provider } = vendorTikTok(fn, [{ kind: "trending", region: "US" }]);

    const adapter = new TikTokAdapter(provider, { seeds: [], run: workingRunner().run, now: NOW });

    expect(adapter.mode).toBe("vendor");
    await expect(adapter.unavailableReason()).resolves.toBeNull();

    const report = await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    expect(calls[0]).toBe("https://api.scrapecreators.com/v1/tiktok/get-trending-feed?region=US");
    expect(report.shorts).toHaveLength(1);
    expect(report.shorts[0]?.duration_seconds).toBeCloseTo(89.131, 3);
    expect(report.shorts[0]?.discovered_by).toBe("scrapecreators:/v1/tiktok/get-trending-feed");

    const outcome = report.platforms.find((o) => o.platform === "tiktok");
    expect(outcome?.status).toBe("ok");
    if (outcome?.status === "ok") {
      expect(outcome.kept).toBe(1);
      expect(outcome.dropped.tooLong).toBe(0);
    }
  });

  it("reads the trending feed EXACTLY ONCE, because no pagination cursor is documented", async () => {
    // https://docs.scrapecreators.com/v1/tiktok/get-trending-feed publishes no
    // cursor on its response. Billing is per REQUEST, so a second page would be
    // a credit spent on a parameter nobody documented — and this body carries
    // the very fields that would tempt one.
    const { fn, calls } = stubFetch({
      body: trendingBody({ has_more: true, max_cursor: 20, cursor: 20 }),
    });
    const { client, provider } = vendorTikTok(fn, [{ kind: "trending", region: "US" }]);

    await new TikTokAdapter(provider, { now: NOW }).latestShorts(QUERY);

    expect(calls).toHaveLength(1);
    expect(client.usage.requests).toBe(1);
  });

  it("refuses through the adapter when the vendor was given nothing to ask for", async () => {
    /*
     * NEVER AN EMPTY RESULT. A provider with no sources is a configuration hole,
     * and the one thing it must not do is hand back [] — on screen that is
     * "TikTok had no shorts over 500,000 views today", a claim nobody made. The
     * refusal names what would fix it, and it costs nothing to produce.
     *
     * The sentence an operator reads on the platform card for this state is
     * composed by lib/platform/registry.ts, which is the object that knows a key
     * was leased and that no region and no keyword were set. This is the
     * backstop underneath it.
     */
    const { fn, calls } = stubFetch({ body: trendingBody() });
    const { provider } = vendorTikTok(fn, []);
    const adapter = new TikTokAdapter(provider, {
      seeds: [SEC_UID],
      run: workingRunner().run,
      now: NOW,
    });

    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(ScrapeCreatorsSourceError);
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(/TikTok region or keyword/);
    // And nothing was sent to find that out.
    expect(calls).toHaveLength(0);
  });

  it("keeps the TikTok millisecond and the Instagram second apart, in one assertion", async () => {
    /*
     * TWO FIELDS ONE WORD APART IN TWO ENDPOINTS OF ONE VENDOR, and reading
     * either in the other's unit is silent. TikTok `video.duration` = 89131 is
     * MILLISECONDS; Instagram `video_duration` = 76.783 is SECONDS, and the
     * fraction is the tell. Divide the Instagram figure by a thousand and every
     * reel becomes 0.077 seconds; leave the TikTok one alone and every short
     * becomes 25 hours and is dropped as too long. Both are asserted here, side
     * by side, because the mistake is a confusion BETWEEN the two and a test of
     * either one alone cannot see it.
     */
    const tiktokFetch = stubFetch({ body: trendingBody() });
    const { provider: tiktokProvider } = vendorTikTok(tiktokFetch.fn, [
      { kind: "trending", region: "US" },
    ]);
    const [tiktokRow] = await new TikTokAdapter(tiktokProvider, { now: NOW }).latestShorts(QUERY);

    const igFetch = stubFetch({
      body: {
        success: true,
        credits_charged: 1,
        items: [
          {
            media: {
              pk: "3540614075954356349",
              code: "DEiyb48AeB9",
              url: "https://www.instagram.com/reel/DEiyb48AeB9",
              video_duration: 76.783,
              play_count: 1_240_000,
              taken_at: 1_736_294_201,
              user: { pk: "2700692569", username: "someone" },
            },
          },
        ],
        paging_info: { more_available: false },
      },
    });
    const igClient = new ScrapeCreatorsClient({
      apiKey: "sc-leased-not-a-real-key",
      fetch: igFetch.fn,
      now: NOW,
    });
    const [igRow] = await new ScrapeCreatorsProvider({
      client: igClient,
      platform: "instagram",
      sources: [{ kind: "creator", handle: "someone" }],
    }).latestShorts(QUERY);

    expect(tiktokRow?.duration_seconds).toBeCloseTo(89.131, 3);
    expect(igRow?.duration_seconds).toBeCloseTo(76.783, 3);
    // Both under the ceiling, and both for the right reason rather than by luck.
    expect(tiktokRow!.duration_seconds!).toBeLessThan(QUERY.maxDurationSeconds);
    expect(igRow!.duration_seconds!).toBeLessThan(QUERY.maxDurationSeconds);
  });
});
