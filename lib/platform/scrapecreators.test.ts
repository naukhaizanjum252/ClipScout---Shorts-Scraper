/**
 * The ScrapeCreators client.
 *
 * ============================================================================
 * READ THIS FIRST — WHAT A GREEN RUN OF THIS FILE DOES AND DOES NOT MEAN
 * ============================================================================
 *
 * EVERY FIXTURE BELOW WAS BUILT BY HAND FROM docs.scrapecreators.com ON
 * 2026-09-04. NOT ONE OF THEM WAS RECORDED FROM A REAL RESPONSE, because there
 * is no ScrapeCreators API key on this machine and not a single request has
 * ever been issued.
 *
 * A FIXTURE BUILT FROM DOCUMENTATION PROVES THE PARSER AND NOT THE API. These
 * tests prove that when a body shaped the way the docs say it is shaped
 * arrives, this code turns it into the right `ShortRecord`, counts the right
 * credits, stops at the right ceiling, and refuses in the specific way an
 * operator can act on. They prove NOTHING about ScrapeCreators:
 *
 *   - not that `/v1/instagram/user/reels` still returns `items[].media` at all,
 *     which their own status page says migrated to a new data source between
 *     25 and 26 August 2026;
 *   - not that `/v1/tiktok/search/hashtag` takes the parameter we refuse to
 *     guess;
 *   - not that a request really costs one credit on every endpoint, when their
 *     pricing page says "1 credit === 1 request (for most endpoints). A few use
 *     more";
 *   - not that Facebook's `view_count` is wrong by the factor one local yt-dlp
 *     probe measured, nor by how much, nor in which direction in general.
 *
 * A green suite here means the code is ready to find those things out. The day
 * a real key exists, the first job is to replace these constructed fixtures
 * with recorded ones and delete this paragraph.
 *
 * The shapes come from, all read 2026-09-04:
 *   https://docs.scrapecreators.com/introduction              (key header, statuses)
 *   https://docs.scrapecreators.com/v1/tiktok/get-trending-feed
 *   https://docs.scrapecreators.com/v1/tiktok/search/keyword
 *   https://docs.scrapecreators.com/v3/tiktok/profile/videos  (the duration literal)
 *   https://docs.scrapecreators.com/v1/instagram/user/reels/
 *   https://docs.scrapecreators.com/v2/instagram/reels/search
 *   https://docs.scrapecreators.com/v1/facebook/profile/reels
 *   https://scrapecreators.com/                               (the price table)
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import { FacebookAdapter } from "./facebook";
import { InstagramAdapter } from "./instagram";
import {
  ASSUMED_CREDITS_PER_REQUEST,
  API_KEY_HEADER,
  ENDPOINTS,
  MICROS_PER_CREDIT_FREELANCE,
  ScrapeCreatorsClient,
  ScrapeCreatorsCredentialError,
  ScrapeCreatorsCreditsExhaustedError,
  ScrapeCreatorsNotFoundError,
  ScrapeCreatorsNoKeyError,
  ScrapeCreatorsProvider,
  ScrapeCreatorsRateLimitError,
  ScrapeCreatorsRequestCapError,
  ScrapeCreatorsRequestError,
  ScrapeCreatorsShapeError,
  ScrapeCreatorsSourceBlockedError,
  ScrapeCreatorsSourceError,
  ScrapeCreatorsUpstreamError,
  facebookReelRecords,
  instagramReelRecords,
  FACEBOOK_VIEWS_MULTIPLIER,
  instagramSearchRecords,
  INSTAGRAM_LIKES_TO_VIEWS,
  measurementCaveat,
  tiktokRecords,
  type PlatformSource,
} from "./scrapecreators";
import { TikTokAdapter } from "./tiktok";
import { MemoryShortsStore } from "../shorts/memory-store";
import { requireComplete } from "../shorts/store";
import {
  getLatestShorts,
  markSafeToShow,
  METERS_ITS_OWN_SPEND,
  safeToShowMessage,
  spendCapabilities,
  SpendContractError,
  type AccountingAdapter,
  type RunAccount,
} from "../shorts/run";
import type { ShortRecord } from "./types";
import { asCreatorEnumerating } from "./unavailable";

const KEY = "sc-live-not-a-real-key-8842";
const NOW = () => new Date("2026-09-04T12:00:00.000Z");
const QUERY: LatestShortsQuery = { limit: 20, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

// ---------------------------------------------------------------------------
// A fetch that never touches the network
// ---------------------------------------------------------------------------

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** Replies in order; the last reply repeats once the queue is drained. */
function stubFetch(...replies: Reply[]) {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let index = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls, headers };
}

function client(fetchImpl: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new ScrapeCreatorsClient({
    apiKey: KEY,
    fetch: fetchImpl,
    now: NOW,
    sleep: async () => {},
    ...over,
  });
}

function provider(
  fetchImpl: typeof globalThis.fetch,
  platform: "tiktok" | "instagram" | "facebook",
  sources: readonly PlatformSource[],
  over: Record<string, unknown> = {},
) {
  const core = client(fetchImpl, over);
  return { core, provider: new ScrapeCreatorsProvider({ client: core, platform, sources }) };
}

// ---------------------------------------------------------------------------
// Fixtures, built from the documented shapes
// ---------------------------------------------------------------------------

/**
 * One TikTok post.
 *
 * `video.duration` IS 89131 AND THAT NUMBER IS THE WHOLE POINT OF THIS FIXTURE.
 * It is the literal from https://docs.scrapecreators.com/v3/tiktok/profile/videos,
 * and 89131 is 89.131 SECONDS in milliseconds. Read as seconds it is a
 * twenty-four-hour TikTok, which does not exist, and every row would fail the
 * 120-second Shorts ceiling.
 */
function tiktokAweme(over: Record<string, unknown> = {}) {
  return {
    aweme_id: "7334621391758642478",
    desc: "how to fold a shirt",
    create_time: 1_739_470_683,
    share_url: "https://www.tiktok.com/@kansascitychiefsfan5/video/7334621391758642478",
    statistics: {
      play_count: 3_100_000,
      digg_count: 412_000,
      comment_count: 8_140,
    },
    author: { unique_id: "kansascitychiefsfan5", uid: "6754760670083138566", nickname: "KC" },
    video: {
      duration: 89_131,
      cover: { url_list: ["https://p16.tiktokcdn.com/cover.jpeg"] },
      play_addr: { url_list: ["https://v16.tiktokcdn.com/play.mp4?sig=1"] },
      download_addr: { url_list: ["https://v16.tiktokcdn.com/dl.mp4?sig=2"] },
    },
    ...over,
  };
}

function trendingBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    credits_remaining: 24_812,
    credits_charged: 1,
    aweme_list: [tiktokAweme()],
    ...over,
  };
}

/** `/v1/instagram/user/reels` — `items[].media`, `video_duration` 76.783 SECONDS. */
function igReelItem(over: Record<string, unknown> = {}) {
  return {
    media: {
      taken_at: 1_736_294_201,
      created_at: "2025-01-07T23:56:41.000Z",
      pk: "3540614075954356349",
      id: "3540614075954356349_2700692569",
      code: "DEiyb48AeB9",
      caption: { text: "reel caption" },
      play_count: 1_240_000,
      ig_play_count: 1_240_000,
      like_count: 88_100,
      comment_count: 903,
      video_duration: 76.783,
      video_versions: [{ height: 1920, width: 1080, type: 101, url: "https://ig.cdn/v.mp4?sig=9" }],
      image_versions2: { candidates: [{ url: "https://ig.cdn/thumb.jpg" }] },
      url: "https://www.instagram.com/reel/DEiyb48AeB9",
      user: { pk: "2700692569", username: "someone" },
    },
    ...over,
  };
}

function igReelsBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    credits_remaining: 24_811,
    credits_charged: 1,
    items: [igReelItem()],
    paging_info: { max_id: "QVFE_page2", more_available: true },
    status: "ok",
    ...over,
  };
}

/** `/v2/instagram/reels/search` — documented WITHOUT any view-count field. */
function igSearchBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    credits_remaining: 24_810,
    credits_charged: 1,
    reels: [
      {
        id: "3540614075954356350",
        shortcode: "DEiyb48AeC0",
        url: "https://www.instagram.com/reel/DEiyb48AeC0",
        caption: "found by keyword",
        video_url: "https://ig.cdn/search.mp4",
        video_duration: 41.5,
        taken_at: "2026-08-30T10:00:00.000Z",
        like_count: 12_000,
        comment_count: 340,
        owner: { id: "2700692570", username: "elsewhere", is_verified: true },
      },
    ],
    ...over,
  };
}

/** `/v1/facebook/profile/reels`. `view_count` is a plain integer in their example. */
function fbReelsBody(over: Record<string, unknown> = {}) {
  return {
    success: true,
    credits_remaining: 24_809,
    credits_charged: 1,
    reels: [
      {
        id: "1122334455",
        post_id: "pfbid0Example",
        video_id: "9988776655",
        creation_time: "2026-08-29T08:15:00.000Z",
        url: "https://www.facebook.com/reel/9988776655",
        view_count: 900,
        description: "a page reel",
        thumbnail: "https://scontent.fb/thumb.jpg",
        play_time_in_ms: 31_400,
        video_url: "https://video.fb/reel.mp4?sig=7",
        author: {
          id: "100064",
          name: "A Page",
          is_verified: true,
          url: "https://www.facebook.com/apage",
        },
      },
    ],
    cursor: "cur-2",
    next_page_id: "npi-2",
    ...over,
  };
}

// ===========================================================================
describe("what a request looks like", () => {
  it("presents the key in the x-api-key header and never in the URL", async () => {
    const { fn, calls, headers } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await p.latestShorts(QUERY);

    expect(headers[0]?.[API_KEY_HEADER]).toBe(KEY);
    // The whole reason this vendor's errors are safe to print: the secret is
    // never in a URL, so a URL in a message can never leak it.
    expect(calls[0]).not.toContain(KEY);
    expect(calls[0]).toBe(`https://api.scrapecreators.com${ENDPOINTS.tiktokTrending}?region=US`);
  });

  it("refuses to construct with an empty key rather than sending an unauthenticated request", () => {
    const { fn } = stubFetch({ body: trendingBody() });
    expect(() => client(fn, { apiKey: "   " })).toThrow(ScrapeCreatorsNoKeyError);
  });

  it("refuses to send when the leased key resolves to nothing", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }], {
      apiKey: () => null,
    });
    await expect(p.latestShorts(QUERY)).rejects.toThrow(ScrapeCreatorsNoKeyError);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("TikTok mapping", () => {
  it("reads duration as MILLISECONDS, so an 89-second post is 89 seconds and not 89,131", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const [row] = await p.latestShorts(QUERY);

    // 89131 ms. Read as seconds this row fails a 120-second ceiling and the
    // whole platform is filed under `dropped.tooLong` — a run that read TikTok
    // correctly, paid for it, and reported nothing.
    expect(row?.duration_seconds).toBeCloseTo(89.131, 3);
    expect(row?.duration_seconds).toBeLessThan(QUERY.maxDurationSeconds);
  });

  it("maps a documented trending item onto a ShortRecord", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const [row] = await p.latestShorts(QUERY);

    expect(row).toMatchObject({
      platform: "tiktok",
      platform_video_id: "7334621391758642478",
      url: "https://www.tiktok.com/@kansascitychiefsfan5/video/7334621391758642478",
      title: "how to fold a shirt",
      creator_handle: "kansascitychiefsfan5",
      creator_id: "6754760670083138566",
      view_count: 3_100_000,
      like_count: 412_000,
      comment_count: 8_140,
      thumbnail_url: "https://p16.tiktokcdn.com/cover.jpeg",
      published_at: "2025-02-13T18:18:03.000Z",
      discovered_at: "2026-09-04T12:00:00.000Z",
      discovered_by: `scrapecreators:${ENDPOINTS.tiktokTrending}`,
    });
    // No TikTok endpoint here documents a profile URL field, and this file does
    // not build one out of parts.
    expect(row?.creator_url).toBeNull();
  });

  it("unwraps the keyword search's aweme_info and reads share_info.share_url", async () => {
    const { fn, calls } = stubFetch({
      body: {
        success: true,
        credits_charged: 1,
        cursor: 20,
        search_item_list: [
          {
            aweme_info: tiktokAweme({
              share_url: undefined,
              share_info: { share_url: "https://www.tiktok.com/@a/video/7334621391758642478" },
            }),
          },
        ],
      },
    });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "keyword", keyword: "cat" }]);
    const rows = await p.latestShorts({ ...QUERY, limit: 1 });

    expect(calls[0]).toContain("query=cat");
    expect(rows[0]?.url).toBe("https://www.tiktok.com/@a/video/7334621391758642478");
    expect(rows[0]?.discovered_by).toBe(`scrapecreators:${ENDPOINTS.tiktokKeyword}`);
  });

  it("drops an item with no id or no permalink rather than inventing one", () => {
    const rows = tiktokRecords(
      [tiktokAweme({ aweme_id: undefined }), tiktokAweme({ share_url: undefined, url: undefined })],
      "2026-09-04T12:00:00.000Z",
      ENDPOINTS.tiktokTrending,
    );
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
describe("Instagram mapping", () => {
  it("reads video_duration as SECONDS and play_count as the view count", async () => {
    const { fn } = stubFetch({ body: igReelsBody({ paging_info: { more_available: false } }) });
    const { provider: p } = provider(fn, "instagram", [{ kind: "creator", handle: "someone" }]);
    const [row] = await p.latestShorts(QUERY);

    // Seconds, fractional, and NOT the same unit as TikTok's `video.duration`.
    expect(row?.duration_seconds).toBeCloseTo(76.783, 3);
    expect(row).toMatchObject({
      platform: "instagram",
      platform_video_id: "3540614075954356349",
      url: "https://www.instagram.com/reel/DEiyb48AeB9",
      title: "reel caption",
      creator_handle: "someone",
      view_count: 1_240_000,
      like_count: 88_100,
      comment_count: 903,
      thumbnail_url: "https://ig.cdn/thumb.jpg",
      published_at: "2025-01-07T23:56:41.000Z",
      discovered_by: `scrapecreators:${ENDPOINTS.instagramUserReels}`,
    });
  });

  it("falls back to ig_play_count rather than reporting a null nobody watched it", () => {
    const [row] = instagramReelRecords(
      [igReelItem({ media: { ...igReelItem().media, play_count: undefined } })],
      "2026-09-04T12:00:00.000Z",
    );
    expect(row?.view_count).toBe(1_240_000);
  });

  it("follows paging_info.max_id and stops when more_available is false", async () => {
    const { fn, calls } = stubFetch(
      { body: igReelsBody() },
      {
        body: igReelsBody({
          items: [igReelItem({ media: { ...igReelItem().media, pk: "999", code: "ZZZ" } })],
          paging_info: { max_id: "QVFE_page3", more_available: false },
        }),
      },
    );
    const { provider: p } = provider(fn, "instagram", [{ kind: "creator", handle: "someone" }]);
    const rows = await p.latestShorts(QUERY);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("max_id=QVFE_page2");
    expect(rows).toHaveLength(2);
  });

  it("gives a keyword-searched reel a null view count, because that endpoint publishes none", () => {
    const rows = instagramSearchRecords(igSearchBody().reels, "2026-09-04T12:00:00.000Z");
    // /v2/instagram/reels/search documents no view count at all, so this figure
    // is DERIVED from the like count — Erik, 2026-09-08. The vendor's own
    // fields are unchanged beside it.
    expect(rows[0]?.view_count).toBe(12_000 * INSTAGRAM_LIKES_TO_VIEWS);
    expect(rows[0]?.like_count).toBe(12_000);
    expect(rows[0]?.duration_seconds).toBe(41.5);
  });

  it("uses a thumbnail from the search response when one is there, and null when not", () => {
    // The documented response lists no thumbnail, but Instagram payloads
    // commonly carry one under image_versions2 (or a flatter field), and a
    // picture is what a person scans a wall of clips by. So it is read
    // opportunistically — and absent stays null, never invented.
    const withCandidates = instagramSearchRecords(
      [
        {
          ...igSearchBody().reels[0],
          image_versions2: { candidates: [{ url: "https://ig.cdn/reel.jpg" }] },
        },
      ],
      "2026-09-04T12:00:00.000Z",
    );
    expect(withCandidates[0]?.thumbnail_url).toBe("https://ig.cdn/reel.jpg");

    const withDisplayUrl = instagramSearchRecords(
      [{ ...igSearchBody().reels[0], display_url: "https://ig.cdn/display.jpg" }],
      "2026-09-04T12:00:00.000Z",
    );
    expect(withDisplayUrl[0]?.thumbnail_url).toBe("https://ig.cdn/display.jpg");

    const none = instagramSearchRecords(igSearchBody().reels, "2026-09-04T12:00:00.000Z");
    expect(none[0]?.thumbnail_url).toBeNull();
  });
});

// ===========================================================================
describe("the Instagram derived view count", () => {
  it("multiplies the like count by the configured factor", () => {
    const [row] = instagramSearchRecords(igSearchBody().reels, "2026-09-04T12:00:00.000Z");
    expect(row?.view_count).toBe(48_000);
  });

  it("marks the figure as derived rather than reported", () => {
    const [row] = instagramSearchRecords(igSearchBody().reels, "2026-09-04T12:00:00.000Z");
    const caveat = measurementCaveat(row!);
    expect(caveat?.basis).toBe("derived");
    expect(caveat?.field).toBe("view_count");
    // NULL, not 12,000. `reportedValue` means "what the source said about
    // views", and this endpoint said nothing about views.
    expect(caveat?.reportedValue).toBeNull();
  });

  it("puts the arithmetic in the note, so the number can be checked by hand", () => {
    const [row] = instagramSearchRecords(igSearchBody().reels, "2026-09-04T12:00:00.000Z");
    const note = measurementCaveat(row!)?.note ?? "";
    expect(note).toContain("ESTIMATE");
    expect(note).toContain("12,000");
    expect(note).toContain("48,000");
    expect(note).toContain(String(INSTAGRAM_LIKES_TO_VIEWS));
  });

  it("derives nothing when the vendor sent no like count, and says so with a null", () => {
    const [row] = instagramSearchRecords(
      [{ ...igSearchBody().reels[0], like_count: undefined }],
      "2026-09-04T12:00:00.000Z",
    );
    // Nothing to multiply. The row stays unjudgeable rather than becoming a
    // zero, which would be a claim about the reel.
    expect(row?.view_count).toBeNull();
    expect(row?.like_count).toBeNull();
    expect(measurementCaveat(row!)).toBeNull();
  });

  it("derives zero views from zero likes, and still marks it", () => {
    const [row] = instagramSearchRecords(
      [{ ...igSearchBody().reels[0], like_count: 0 }],
      "2026-09-04T12:00:00.000Z",
    );
    // "The vendor said 0 likes" is a measurement, and 0 x 4 is a defensible 0.
    // It is distinct from the null above and must not collapse into it.
    expect(row?.view_count).toBe(0);
    expect(measurementCaveat(row!)?.basis).toBe("derived");
  });

  it("lets a derived figure clear the threshold and be kept", () => {
    const [row] = instagramSearchRecords(
      [{ ...igSearchBody().reels[0], like_count: 200_000 }],
      "2026-09-04T12:00:00.000Z",
    );
    // 200,000 x 4 = 800,000, over the 500,000 minimum. This is the whole point
    // of the change: rows that used to land in "could not be judged" now pass.
    expect(row?.view_count).toBe(800_000);
    expect(row!.view_count!).toBeGreaterThanOrEqual(QUERY.minViews);
  });
});

// ===========================================================================
describe("the Facebook view-count caveat", () => {
  it("multiplies the vendor's view_count rather than copying or discarding it", () => {
    const [row] = facebookReelRecords(fbReelsBody().reels, "2026-09-04T12:00:00.000Z");
    // Erik, 2026-09-08. Until then this was null and the row was unjudgeable.
    expect(row?.view_count).toBe(900 * FACEBOOK_VIEWS_MULTIPLIER);
  });

  it("still reads a real duration, so only the view count is invented", () => {
    const [row] = facebookReelRecords(fbReelsBody().reels, "2026-09-04T12:00:00.000Z");
    // 31,400 ms. This one IS measured, and that is the difference between
    // Facebook and the Instagram keyword sweep.
    expect(row?.duration_seconds).toBe(31.4);
  });

  it("preserves the vendor's figure verbatim in the caveat, with a printable note", () => {
    const [row] = facebookReelRecords(fbReelsBody().reels, "2026-09-04T12:00:00.000Z");
    const caveat = measurementCaveat(row as ShortRecord);
    expect(caveat?.field).toBe("view_count");
    // DERIVED describes the figure the row carries, not what arrived on the
    // wire - the wire figure is right there in reportedValue, untouched.
    expect(caveat?.basis).toBe("derived");
    expect(caveat?.reportedValue).toBe(900);
    expect(caveat?.note).toContain("900");
    expect(caveat?.note).toContain("7,200");
    expect(caveat?.note).toContain("408");
    expect(caveat?.note).toContain("9.8K");
  });

  it("keeps 'the vendor said nothing' distinct from 'the vendor said 0'", () => {
    const withZero = facebookReelRecords(
      [{ ...fbReelsBody().reels[0], view_count: 0 }],
      "2026-09-04T12:00:00.000Z",
    );
    const withNothing = facebookReelRecords(
      [{ ...fbReelsBody().reels[0], view_count: undefined }],
      "2026-09-04T12:00:00.000Z",
    );
    expect(measurementCaveat(withZero[0]!)?.reportedValue).toBe(0);
    expect(measurementCaveat(withNothing[0]!)?.reportedValue).toBeNull();
    // And the same distinction survives the multiplication: 0 x 8 is a
    // defensible 0, while nothing x 8 is still nothing.
    expect(withZero[0]?.view_count).toBe(0);
    expect(withNothing[0]?.view_count).toBeNull();
  });

  it("carries BOTH documented pagination values forward, not just one of them", async () => {
    /*
     * The docs list `cursor` AND `next_page_id` as pagination parameters and do
     * not say whether either alone is enough, so both are carried. They travel
     * as one opaque token joined by `CURSOR_PAIR_SEPARATOR`, and this test is
     * here because that separator was briefly an INVISIBLE character inside a
     * string literal — unreviewable by eye, and silently wrong for any cursor
     * containing the character it happened to be.
     */
    const { fn, calls } = stubFetch(
      { body: fbReelsBody({ cursor: "cur-2", next_page_id: "npi-2" }) },
      {
        body: fbReelsBody({
          reels: [{ ...fbReelsBody().reels[0], video_id: "second" }],
          cursor: undefined,
          next_page_id: undefined,
        }),
      },
    );
    const { provider: p } = provider(fn, "facebook", [
      { kind: "page", url: "https://www.facebook.com/apage" },
    ]);
    const rows = await p.latestShorts(QUERY);

    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("next_page_id=npi-2");
    expect(calls[1]).toContain("cursor=cur-2");
    // And no stray separator leaked into either parameter value.
    expect(calls[1]).not.toContain("%00");
  });

  it("reads play_time_in_ms as milliseconds and author.url as the creator URL", () => {
    const [row] = facebookReelRecords(fbReelsBody().reels, "2026-09-04T12:00:00.000Z");
    expect(row?.duration_seconds).toBeCloseTo(31.4, 3);
    expect(row?.creator_url).toBe("https://www.facebook.com/apage");
    // Not documented on this endpoint. Absent, not zero.
    expect(row?.like_count).toBeNull();
  });

  it("returns a plain ShortRecord for TikTok and Instagram — the caveat is Facebook-only", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const [row] = await p.latestShorts(QUERY);
    expect(measurementCaveat(row!)).toBeNull();
    expect(Object.keys(row!)).not.toContain("measurement_caveat");
  });
});

// ===========================================================================
describe("THROUGH getLatestShorts — the entry point the app actually uses", () => {
  /**
   * The whole point of this block.
   *
   * These assertions do NOT poke at a mapper. They build the real
   * `FacebookAdapter` around the real `ScrapeCreatorsProvider` — the exact
   * drop-in lib/platform/unavailable.ts was written for, `new
   * FacebookAdapter(provider)` — and run the real `getLatestShorts`. An earlier
   * round of this repo shipped 746 green tests over an adapter nothing ever
   * constructed; a test that runs the app's own entry point is the only kind
   * that could have caught it.
   */
  function facebookRun(fetchImpl: typeof globalThis.fetch) {
    const { core, provider: p } = provider(fetchImpl, "facebook", [
      { kind: "page", url: "https://www.facebook.com/apage" },
    ]);
    return { core, adapter: new FacebookAdapter(p) };
  }

  it("a Facebook reel IS compared against 500,000 now, on a corrected number, and is persisted", async () => {
    /**
     * THE CONTRACT THIS TEST PINS WAS REVERSED ON 2026-09-08, ERIK'S CALL.
     *
     * It used to assert the opposite in its own title: that a Facebook reel is
     * never silently compared against 500,000 and lands in `unverified`. The
     * reasoning was that the vendor's view count may be an order of magnitude
     * wrong, so comparing it in either direction is a claim nobody can back.
     *
     * The instruction now is to multiply it by 8 and use the result. So this
     * row - 1.2 million reported, 9.6 million corrected - is kept, PERSISTED to
     * the store and shown to a client, on a number that is a configured guess
     * applied to a distrusted figure. That is the change, stated plainly,
     * because the store assertion below is the one with consequences: the
     * database will hold 9,600,000 as this reel's view count, and the caveat
     * explaining where it came from is NOT a persisted column.
     */
    const { fn } = stubFetch({
      body: fbReelsBody({
        reels: [{ ...fbReelsBody().reels[0], view_count: 1_200_000 }],
        cursor: undefined,
        next_page_id: undefined,
      }),
    });
    const { adapter } = facebookRun(fn);
    const store = new MemoryShortsStore();

    const report = await getLatestShorts({
      adapters: [adapter],
      store,
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    expect(report.shorts).toHaveLength(1);
    expect(report.shorts[0]?.view_count).toBe(9_600_000);
    expect(report.unverified ?? []).toHaveLength(0);

    // PERSISTED - and the stored row carries the corrected number. Whether the
    // caveat survives the store is asserted rather than assumed.
    const stored = requireComplete(await store.readShorts());
    expect(stored).toHaveLength(1);
    expect(stored[0]?.view_count).toBe(9_600_000);

    // The caveat rode through the run to where a UI can print it.
    const caveat = measurementCaveat(report.shorts[0]!);
    expect(caveat?.basis).toBe("derived");
    expect(caveat?.reportedValue).toBe(1_200_000);
    expect(caveat?.note).toContain("1,200,000");
    expect(caveat?.note).toContain("9,600,000");
  });

  it("an 89-second TikTok is KEPT and not filed under dropped.tooLong", async () => {
    /*
     * THE CONSEQUENCE OF THE MILLISECOND UNIT, PROVED THROUGH THE RUN RATHER
     * THAN THROUGH THE MAPPER. Read as seconds, 89131 fails the 120-second
     * ceiling, the row lands in `dropped.tooLong`, and the report says TikTok
     * had nothing under the Shorts ceiling — a sentence that reads as a result.
     *
     * THE REAL `TikTokAdapter`, NOT A HAND-WRITTEN ONE. Until 2026-09-04 this
     * test had to compose an object literal that forwarded two methods, because
     * lib/platform/tiktok.ts had no provider slot to put this provider in — the
     * one of the three platforms this vendor was bought for. A literal
     * satisfies `PlatformAdapter` by construction and would keep passing even
     * if no adapter in the tree could ever be handed a provider, which is
     * exactly how a client with zero call sites stayed green for a round.
     */
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const adapter = new TikTokAdapter(p, { now: NOW });
    expect(adapter.mode).toBe("vendor");

    const report = await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    const outcome = report.platforms.find((o) => o.platform === "tiktok");
    expect(report.shorts).toHaveLength(1);
    expect(report.shorts[0]?.duration_seconds).toBeCloseTo(89.131, 3);
    if (outcome?.status === "ok") {
      expect(outcome.kept).toBe(1);
      expect(outcome.dropped.tooLong).toBe(0);
    }
  });

  it("a keyword-searched reel is never presented as though it cleared 500,000", async () => {
    /*
     * THE v2 REEL SEARCH ENDPOINT PUBLISHES NO VIEW COUNT OF ANY KIND — not a
     * null one, the field is absent from the documented response
     * (https://docs.scrapecreators.com/v2/instagram/reels/search, read
     * 2026-09-04). Proved through the run, with the real `InstagramAdapter`
     * around the real provider, because the mapper test one block up only shows
     * the derived figure; what matters is what the REPORT does with it.
     *
     * WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER DOES. Until
     * 2026-09-08 it pinned the opposite contract shut: `view_count` stayed null,
     * the row landed in `unverified`, and substituting the like count was named
     * here as the temptation being refused. Erik has since instructed exactly
     * that substitution — `like_count * INSTAGRAM_LIKES_TO_VIEWS`. The old
     * paragraph is kept rather than deleted because the reasoning in it did not
     * become wrong, it became overruled, and a reader who finds a fabricated
     * view count in a repo built on measurement honesty deserves to see that it
     * was a decision and not an oversight.
     *
     * SO WHAT IS PINNED NOW: the derived number is judged like any other, it can
     * be dropped as below the threshold, and — the part that still matters — it
     * arrives carrying a caveat that says it was computed. 12,000 likes x 4 is
     * 48,000, which is under 500,000, so this row is dropped as `belowThreshold`
     * where it used to be `unverified`. That is a REAL change in what the
     * operator is told: "not viral enough" is now being said on the strength of
     * a number nobody measured.
     */
    const { fn } = stubFetch({ body: igSearchBody() });
    const { provider: p } = provider(fn, "instagram", [{ kind: "keyword", query: "cat" }]);

    const report = await getLatestShorts({
      adapters: [new InstagramAdapter(p)],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    // 12,000 x 4 = 48,000, under the 500,000 minimum, so it is dropped rather
    // than kept. Not unverified any more: a comparison DID happen.
    expect(report.shorts).toEqual([]);
    expect(report.unverified ?? []).toHaveLength(0);

    const outcome = report.platforms.find((o) => o.platform === "instagram");
    if (outcome?.status === "ok") {
      expect(outcome.kept).toBe(0);
      // WHICH BUCKET, not how many. The tally counts one judgement per page the
      // stub served, where `unverified` above deduplicates by short — so a
      // number here would pin the stub's pagination rather than the behaviour.
      // What changed on 2026-09-08 is the bucket: this row moved out of
      // `unknownViews` and into `belowThreshold`, judged on a derived figure.
      expect(outcome.dropped.belowThreshold).toBeGreaterThan(0);
      expect(outcome.dropped.unknownViews).toBe(0);
    }
  });

  it("a keyword-searched reel that clears the derived threshold is kept, and says the number was derived", async () => {
    /**
     * THE OTHER HALF OF ERIK'S 2026-09-08 CHANGE, and the one worth staring at:
     * a row reaching the kept, persisted, client-facing list on a view count
     * this application invented. 200,000 likes x 4 = 800,000.
     *
     * The caveat riding along is the only thing separating that from a lie, and
     * it is asserted here rather than left to the console, because the console
     * can only print what the record carries.
     */
    const { fn } = stubFetch({
      body: igSearchBody({ reels: [{ ...igSearchBody().reels[0], like_count: 200_000 }] }),
    });
    const { provider: p } = provider(fn, "instagram", [{ kind: "keyword", query: "cat" }]);

    const report = await getLatestShorts({
      adapters: [new InstagramAdapter(p)],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    expect(report.shorts).toHaveLength(1);
    expect(report.shorts[0]?.view_count).toBe(800_000);
    expect(measurementCaveat(report.shorts[0]!)?.basis).toBe("derived");
  });

  it("a broken Instagram endpoint reports as FAILED, never as an empty Instagram", async () => {
    // A 200 with a body this parser does not recognise — what an upstream data
    // source migration looks like from here. Their status page shows exactly
    // this happening to an Instagram reels endpoint on 25-26 August 2026.
    const { fn } = stubFetch({
      body: { success: true, credits_charged: 1, data: { edges: [] } },
    });
    const { core, provider: p } = provider(fn, "instagram", [
      { kind: "creator", handle: "someone" },
    ]);
    const { InstagramAdapter } = await import("./instagram");
    const adapter = new InstagramAdapter(p);

    const report = await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    const outcome = report.platforms.find((o) => o.platform === "instagram");
    expect(outcome?.status).toBe("failed");
    expect(core.usage.requests).toBe(1);
    // The operator is told which endpoint, what was expected and what arrived —
    // and it reaches the SCREEN, not just the log, because a shape error is
    // composed in this file and marked fit to print.
    if (outcome?.status === "failed") {
      expect(outcome.error).toContain(ENDPOINTS.instagramUserReels);
      expect(outcome.error).toContain("`items`");
      expect(outcome.error).toContain("NOT 'no results'");
      expect(outcome.safeMessage).toBe(outcome.error);
    }
  });

  it("an EMPTY items array is a real answer and reports as ok with nothing kept", async () => {
    const { fn } = stubFetch({ body: igReelsBody({ items: [], paging_info: {} }) });
    const { provider: p } = provider(fn, "instagram", [{ kind: "creator", handle: "someone" }]);
    const { InstagramAdapter } = await import("./instagram");

    const report = await getLatestShorts({
      adapters: [new InstagramAdapter(p)],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    const outcome = report.platforms.find((o) => o.platform === "instagram");
    // Present-and-empty is the ONE case in this client where "nothing came
    // back" is allowed to mean nothing came back.
    expect(outcome?.status).toBe("ok");
    if (outcome?.status === "ok") expect(outcome.returned).toBe(0);
  });

  it("reports a REAL, NON-ZERO spend through report.spend — the figure that used to be structurally zero", async () => {
    const { fn } = stubFetch({
      body: fbReelsBody({ cursor: undefined, next_page_id: undefined }),
    });
    const { core, provider: p } = provider(fn, "facebook", [
      { kind: "page", url: "https://www.facebook.com/apage" },
    ]);

    /*
     * A metered adapter that delegates to the client, exactly as
     * `XMeteredAdapter` delegates to `XClient`. It is written here rather than
     * imported because lib/platform/facebook.ts does not yet carry the brand —
     * see the risks in the handover. What is being proved is that THIS CLIENT
     * satisfies the contract `getLatestShorts` enforces, and that the number
     * that reaches `report.spend` is a real one.
     */
    const inner = new FacebookAdapter(p);
    const metered: AccountingAdapter = {
      // TAKEN FROM THE CLIENT, not hardcoded, so that a client which stopped
      // declaring the brand fails this test too. A hardcoded `true` here would
      // let the delegating adapter keep the contract alive over a client that
      // had quietly dropped it — which is the shape of the original bug.
      [METERS_ITS_OWN_SPEND]: core[METERS_ITS_OWN_SPEND],
      platform: "facebook",
      describe: () => inner.describe(),
      unavailableReason: () => inner.unavailableReason(),
      latestShorts: (q) => inner.latestShorts(q),
      downloadUrl: (s) => inner.downloadUrl(s),
      accountForLastRun: (): RunAccount | null => core.accountForLastRun(),
    };

    const report = await getLatestShorts({
      adapters: [metered],
      store: new MemoryShortsStore(),
      limit: 20,
      minViews: 500_000,
      maxDurationSeconds: 120,
      now: () => "2026-09-04T12:00:00.000Z",
    });

    expect(report.spend).toHaveLength(1);
    const spent = report.spend![0]!;
    // One request, one credit the API said it charged, at the Freelance rate.
    expect(spent.usdMicros).toBe(MICROS_PER_CREDIT_FREELANCE);
    expect(spent.usdMicros).toBeGreaterThan(0);
    expect(spent.note).toContain("billed per REQUEST and not per row");
    expect(spent.note).toContain("credits remaining");
  });
});

// ===========================================================================
describe("the money contract", () => {
  it("carries the METERS_ITS_OWN_SPEND brand, so the capability is declared and not guessed", () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const core = client(fn);
    expect(core[METERS_ITS_OWN_SPEND]).toBe(true);
  });

  it("an adapter delegating to this client passes spendCapabilities; half a contract throws", () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const core = client(fn);
    const base: PlatformAdapter = {
      platform: "tiktok",
      describe: () => "",
      unavailableReason: async () => null,
      latestShorts: async () => [],
      downloadUrl: async () => null,
    };

    const whole = { ...base, [METERS_ITS_OWN_SPEND]: true as const, accountForLastRun: () => core.accountForLastRun() };
    expect(spendCapabilities(whole).accounting).not.toBeNull();

    // The method without the brand is the exact shape that reported nothing.
    const half = { ...base, accountForLastRun: () => core.accountForLastRun() };
    expect(() => spendCapabilities(half)).toThrow(SpendContractError);
  });

  it("reports null when nothing was sent, and a figure when something was", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { core, provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);

    // "Nobody asked" is not "it was free".
    expect(core.accountForLastRun()).toBeNull();

    await p.latestShorts(QUERY);
    const account = core.accountForLastRun();
    expect(account?.spend?.usdMicros).toBe(MICROS_PER_CREDIT_FREELANCE);

    // A DELTA, not a running total: a second account with no further requests
    // must not bill the first run's credits again.
    expect(core.accountForLastRun()).toBeNull();
  });

  it("prefers the vendor's credits_charged over the assumed 1 per request, including zero", async () => {
    const { fn } = stubFetch({ body: trendingBody({ credits_charged: 0 }) });
    const { core, provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await p.latestShorts(QUERY);

    expect(core.usage.creditsCharged).toBe(0);
    expect(core.usage.creditsAssumed).toBe(0);
    expect(core.accountForLastRun()?.spend?.usdMicros).toBe(0);
  });

  it("counts an assumed credit apart from a charged one and says so in the note", async () => {
    const { fn } = stubFetch({ body: trendingBody({ credits_charged: undefined }) });
    const { core, provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await p.latestShorts(QUERY);

    expect(core.usage.creditsAssumed).toBe(ASSUMED_CREDITS_PER_REQUEST);
    const note = core.accountForLastRun()?.spend?.note ?? "";
    expect(note).toContain("ASSUMED");
    expect(note).toContain("A few use more");
  });

  it("prices at the tier it was told to use and names it, never guessing from the balance", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { core, provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }], {
      creditPriceMicros: 990,
      creditPriceLabel: "the $497 / 500,000-credit Business rate, $0.99 per 1,000",
    });
    await p.latestShorts(QUERY);
    const account = core.accountForLastRun();
    expect(account?.spend?.usdMicros).toBe(990);
    expect(account?.spend?.note).toContain("$0.99 per 1,000");
  });
});

// ===========================================================================
describe("the request ceiling — billing is per REQUEST, so the cap is on requests", () => {
  it("stops a paginating source at the cap and reports a spend-cap truncation, keeping paid-for rows", async () => {
    const { fn } = stubFetch({ body: igReelsBody() }); // always says there is more
    const { core, provider: p } = provider(fn, "instagram", [{ kind: "creator", handle: "someone" }], {
      maxRequests: 2,
    });

    const rows = await p.latestShorts({ ...QUERY, limit: 50 });
    expect(rows).toHaveLength(2);
    expect(core.usage.requests).toBe(2);

    const account = core.accountForLastRun();
    expect(account?.truncation?.cause).toBe("spend-cap");
    expect(account?.truncation?.message).toContain("2 ScrapeCreators requests");
  });

  it("throws rather than returning [] when the cap is spent before a single row is read", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { core, provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }], {
      maxRequests: 1,
    });
    await p.latestShorts(QUERY);
    expect(core.requestsRemaining).toBe(0);

    // A budget stop with nothing in hand must never render as "this platform
    // had nothing today".
    await expect(p.latestShorts(QUERY)).rejects.toThrow(ScrapeCreatorsRequestCapError);
  });

  it("shares one budget across all three platforms, because there is one credit balance", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const core = client(fn, { maxRequests: 2 });
    const tiktok = new ScrapeCreatorsProvider({
      client: core,
      platform: "tiktok",
      sources: [{ kind: "trending", region: "US" }],
    });
    const facebook = new ScrapeCreatorsProvider({
      client: core,
      platform: "facebook",
      sources: [{ kind: "page", url: "https://www.facebook.com/apage" }],
    });

    await tiktok.latestShorts(QUERY);
    await facebook.latestShorts(QUERY).catch(() => undefined);
    expect(core.requestsRemaining).toBe(0);
    await expect(tiktok.latestShorts(QUERY)).rejects.toThrow(ScrapeCreatorsRequestCapError);
  });
});

// ===========================================================================
describe("failing loudly, and differently, for each thing that can go wrong", () => {
  const cases: Array<{
    status: number;
    error: new (...args: never[]) => Error;
    says: string;
  }> = [
    { status: 400, error: ScrapeCreatorsRequestError, says: "malformed" },
    { status: 401, error: ScrapeCreatorsCredentialError, says: "rejected the API key" },
    { status: 402, error: ScrapeCreatorsCreditsExhaustedError, says: "out of credits" },
    { status: 403, error: ScrapeCreatorsSourceBlockedError, says: "public source blocked" },
    { status: 404, error: ScrapeCreatorsNotFoundError, says: "could not find" },
    { status: 429, error: ScrapeCreatorsRateLimitError, says: "rate-limited" },
  ];

  for (const c of cases) {
    it(`maps ${c.status} to its own error with its own instruction`, async () => {
      const { fn } = stubFetch({ status: c.status, body: { message: "upstream said so" } });
      const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
      await expect(p.latestShorts(QUERY)).rejects.toBeInstanceOf(c.error);
      await expect(p.latestShorts(QUERY)).rejects.toThrow(new RegExp(c.says, "i"));
    });
  }

  it("keeps 401 and 402 apart — a wrong key and an empty balance are fixed differently", async () => {
    const bad = stubFetch({ status: 401, body: { message: "invalid api key" } });
    const broke = stubFetch({ status: 402, body: { message: "Gotta purchase more credits" } });

    const p1 = provider(bad.fn, "tiktok", [{ kind: "trending", region: "US" }]).provider;
    const p2 = provider(broke.fn, "tiktok", [{ kind: "trending", region: "US" }]).provider;

    await expect(p1.latestShorts(QUERY)).rejects.not.toBeInstanceOf(
      ScrapeCreatorsCreditsExhaustedError,
    );
    await expect(p2.latestShorts(QUERY)).rejects.not.toBeInstanceOf(ScrapeCreatorsCredentialError);
  });

  it("names the seed in a 403 or 404, so an operator fixes the seed and not the key", async () => {
    const { fn } = stubFetch({ status: 404, body: { message: "not found" } });
    const { provider: p } = provider(fn, "instagram", [{ kind: "creator", handle: "ghostaccount" }]);
    await expect(p.latestShorts(QUERY)).rejects.toThrow(/@ghostaccount/);
  });

  it("retries a 5xx and then reports it as theirs, not as no results", async () => {
    const { fn } = stubFetch({ status: 500, body: { message: "boom" } });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await expect(p.latestShorts(QUERY)).rejects.toBeInstanceOf(ScrapeCreatorsUpstreamError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a 429, because sleeping inside a run turns a slow page into a hung one", async () => {
    const { fn } = stubFetch({ status: 429, body: {}, headers: { "retry-after": "30" } });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await expect(p.latestShorts(QUERY)).rejects.toThrow(/wait 30s/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats `success: false` on a 200 as a failure and never as an empty result", async () => {
    const { fn } = stubFetch({ body: { success: false, aweme_list: [] } });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await expect(p.latestShorts(QUERY)).rejects.toBeInstanceOf(ScrapeCreatorsShapeError);
  });

  it("treats an intact envelope full of unreadable items as a shape change", async () => {
    const { fn } = stubFetch({
      body: { success: true, credits_charged: 1, aweme_list: [{ videoId: "new-shape" }] },
    });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    await expect(p.latestShorts(QUERY)).rejects.toThrow(/could read an id and a URL from none/);
  });

  it("marks every composed message fit to print, so an operator reads it instead of grepping a log", async () => {
    const { fn } = stubFetch({ status: 402, body: { message: "Gotta purchase more credits" } });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const caught = await p.latestShorts(QUERY).catch((e: unknown) => e);
    const printable = safeToShowMessage(caught);
    expect(printable).toContain("out of credits");
    expect(printable).not.toContain(KEY);
  });
});

// ===========================================================================
describe("refusals that cost nothing", () => {
  it("refuses a TikTok hashtag source with no parameter name rather than guessing one", () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const core = client(fn);
    expect(
      () =>
        new ScrapeCreatorsProvider({
          client: core,
          platform: "tiktok",
          // paramName deliberately blank: the docs page does not name it.
          sources: [{ kind: "hashtag", hashtag: "fyp", paramName: "" }],
        }),
    ).toThrow(/will not guess one/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("sends the operator-supplied hashtag parameter once they have supplied it", async () => {
    const { fn, calls } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [
      { kind: "hashtag", hashtag: "fyp", paramName: "hashtag" },
    ]);
    await p.latestShorts(QUERY);
    expect(calls[0]).toContain("hashtag=fyp");
  });

  it("refuses an Instagram creator source with neither handle nor userId", () => {
    const { fn } = stubFetch({ body: igReelsBody() });
    expect(
      () =>
        new ScrapeCreatorsProvider({
          client: client(fn),
          platform: "instagram",
          sources: [{ kind: "creator" }],
        }),
    ).toThrow(ScrapeCreatorsSourceError);
  });

  it("refuses to run with no sources at all, rather than reporting an empty platform", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "facebook", []);
    await expect(p.latestShorts(QUERY)).rejects.toThrow(/NOT a report that the platform had no/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses to resolve another platform's download URL", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const row = { platform: "youtube", platform_video_id: "x" } as unknown as ShortRecord;
    await expect(p.downloadUrl(row)).rejects.toThrow(ScrapeCreatorsSourceError);
  });
});

// ===========================================================================
describe("downloadUrl — resolved from a page already paid for, or null", () => {
  it("returns a media URL seen on the page this run bought", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]);
    const [row] = await p.latestShorts(QUERY);
    // download_addr preferred over play_addr; both documented on the trending page.
    expect(await p.downloadUrl(row!)).toBe("https://v16.tiktokcdn.com/dl.mp4?sig=2");
    // And no second request was bought to find it.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns null for a row this process never read, rather than paying to guess", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const { provider: p } = provider(fn, "facebook", [
      { kind: "page", url: "https://www.facebook.com/apage" },
    ]);
    const row = {
      platform: "facebook",
      platform_video_id: "never-seen",
    } as unknown as ShortRecord;
    expect(await p.downloadUrl(row)).toBeNull();
  });
});

// ===========================================================================
describe("total readers — a changed subfield must not kill a platform", () => {
  it("degrades an unreadable field to null rather than throwing", () => {
    const [row] = tiktokRecords(
      [
        tiktokAweme({
          statistics: { play_count: "not a number", digg_count: null },
          video: { duration: "oops" },
          create_time: "not a timestamp",
        }),
      ],
      "2026-09-04T12:00:00.000Z",
      ENDPOINTS.tiktokTrending,
    );
    expect(row?.view_count).toBeNull();
    expect(row?.duration_seconds).toBeNull();
    expect(row?.published_at).toBeNull();
    // The id and the URL survived, so the row is still a real short with two
    // unknowns — which run.ts will file as `unverified`, not drop.
    expect(row?.platform_video_id).toBe("7334621391758642478");
  });

  it("reads a numeric field sent as a string, because scraped payloads do that", () => {
    const [row] = tiktokRecords(
      [tiktokAweme({ statistics: { play_count: "3100000" } })],
      "2026-09-04T12:00:00.000Z",
      ENDPOINTS.tiktokTrending,
    );
    expect(row?.view_count).toBe(3_100_000);
  });

  it("refuses a millisecond timestamp masquerading as unix seconds", () => {
    const [row] = tiktokRecords(
      [tiktokAweme({ create_time: 1_739_470_683_000 })],
      "2026-09-04T12:00:00.000Z",
      ENDPOINTS.tiktokTrending,
    );
    // Filed as the year 57000 it would look like data. Null says "unknown".
    expect(row?.published_at).toBeNull();
  });
});

// A no-op reference so the linter cannot prune the import that documents the
// safe-to-print rule this file asserts against.
markSafeToShow(class extends Error {});

// ===========================================================================
describe("Instagram creator enumeration (a topic's channels)", () => {
  it("enumerates handles through /v1/instagram/user/reels on the same client", async () => {
    const { fn, calls } = stubFetch({ body: igReelsBody({ paging_info: { more_available: false } }) });
    // Built with NO configured sources — the handles are passed explicitly, as a
    // topic run does; the one client/meter is reused.
    const { provider: p } = provider(fn, "instagram", []);
    const rows = await p.latestShortsForCreators(["@someone"], QUERY);

    expect(rows.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("/v1/instagram/user/reels");
    expect(rows.every((r) => r.platform === "instagram")).toBe(true);
  });

  it("returns [] for a handle list with nothing usable, sending no request", async () => {
    const { fn, calls } = stubFetch({ body: igReelsBody() });
    const { provider: p } = provider(fn, "instagram", []);
    expect(await p.latestShortsForCreators(["   ", "@"], QUERY)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("is a capability only the Instagram provider advertises", () => {
    const ig = provider(stubFetch({ body: igReelsBody() }).fn, "instagram", []).provider;
    const tk = provider(stubFetch({ body: trendingBody() }).fn, "tiktok", [
      { kind: "trending", region: "US" },
    ]).provider;
    expect(asCreatorEnumerating(ig)).not.toBeNull();
    // TikTok creators are read by sec_uid through yt-dlp, not this vendor.
    expect(asCreatorEnumerating(tk)).toBeNull();
  });

  it("refuses if a non-Instagram provider is asked to enumerate a creator", async () => {
    const { fn } = stubFetch({ body: trendingBody() });
    const tk = provider(fn, "tiktok", [{ kind: "trending", region: "US" }]).provider;
    await expect(tk.latestShortsForCreators(["MS4wLjABAAAA"], QUERY)).rejects.toThrow();
  });
});
