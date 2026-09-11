/**
 * The X adapter and its HTTP client.
 *
 * ------------------------------------------------------------ READ THIS FIRST
 *
 * EVERY FIXTURE IN THIS FILE WAS BUILT BY HAND FROM X'S DOCUMENTATION ON
 * 2026-09-04. NOT ONE OF THEM WAS RECORDED FROM A REAL RESPONSE, because there
 * is no X API key on this machine and nobody has issued a single request.
 *
 * That means these tests prove THE PARSER. They prove that when a response
 * shaped the way X's data dictionary says it is shaped arrives, this code turns
 * it into the right `ShortRecord`, bills the right number of resources, stops at
 * the right cap and refuses in the right way. They prove NOTHING WHATEVER about
 * the API:
 *
 *   - not that `media.public_metrics.view_count` is populated for arbitrary
 *     third-party videos, which is the single unverified fact the whole X leg
 *     rests on;
 *   - not whether the Post fields parameter is called `tweet.fields` or
 *     `post.fields`, which X's own documentation answers both ways;
 *   - not whether an expanded User in `includes.users` is billed at $0.010;
 *   - not that the counts endpoint returns `post_count` rather than
 *     `tweet_count`.
 *
 * A green suite here means the code is ready to find those things out. It does
 * not mean it has. Only a real key proves the API, and the day one exists the
 * first thing to do is replace the constructed fixtures below with recorded
 * ones and delete this paragraph.
 *
 * The shapes come from:
 *   https://docs.x.com/x-api/fundamentals/data-dictionary  (the media example,
 *     verbatim: duration_ms 46947, view_count 6909260, media_key
 *     "13_1263145212760805376", the preview_image_url, the variants shape)
 *   https://docs.x.com/x-api/posts/recent-search           (data/includes/meta)
 *   https://docs.x.com/x-api/posts/recent-search-counts    (data/meta)
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery } from "./adapter";
import { safeToShowMessage } from "../shorts/run";
import { adapterFor, xConfigFor } from "./registry";
import type { ShortRecord } from "./types";
import { PlatformUnavailableError } from "./unavailable";
import { topicQuery, XAdapter, XNoVideoError, XViewCountUnreadableError } from "./x";
import {
  bestMp4Variant,
  estimateUsd,
  pageSizeFor,
  queryProblems,
  startTimeFor,
  worstCaseBilledPosts,
  XApiError,
  XClient,
  XCredentialError,
  XQueryError,
  XRateLimitError,
  XSpendCapError,
  type XMedia,
} from "./x-client";

const QUERY: LatestShortsQuery = { limit: 20, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };
const GOOD_QUERY = "min_likes:20000 has:video_link -is:retweet lang:en";
const NOW = () => new Date("2026-09-04T12:00:00.000Z");
const TOKEN = "AAAAAAAAAAAAAAAAAAAAA-this-is-not-a-real-token-9f3";

// ------------------------------------------------- fixtures, built from docs

/** The variants array shape, from the data dictionary's `variants` example. */
const VARIANTS = [
  { bit_rate: 632_000, content_type: "video/mp4", url: "https://video.twimg.com/low.mp4?tag=12" },
  { bit_rate: 2_176_000, content_type: "video/mp4", url: "https://video.twimg.com/high.mp4?tag=12" },
  { content_type: "application/x-mpegURL", url: "https://video.twimg.com/manifest.m3u8" },
];

function videoMedia(over: Partial<XMedia> = {}): XMedia {
  return {
    media_key: "13_1263145212760805376",
    type: "video",
    duration_ms: 46_947,
    height: 1080,
    width: 1920,
    preview_image_url: "https://pbs.twimg.com/media/EYeX7akWsAIP1_1.jpg",
    public_metrics: { view_count: 6_909_260 },
    variants: VARIANTS,
    ...over,
  };
}

function post(id: string, mediaKey: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    text: "Testing, testing...",
    created_at: "2026-09-03T10:00:00.000Z",
    author_id: "2244994945",
    lang: "en",
    ...(mediaKey ? { attachments: { media_keys: [mediaKey] } } : {}),
    public_metrics: {
      retweet_count: 10,
      reply_count: 5,
      like_count: 100,
      quote_count: 2,
      bookmark_count: 3,
      // Deliberately enormous, and deliberately never used as a view count.
      impression_count: 99_000_000,
    },
    ...over,
  };
}

const USER = { id: "2244994945", name: "X Developers", username: "xdevelopers" };

function searchBody(over: Record<string, unknown> = {}) {
  return {
    data: [post("1263145271946551300", "13_1263145212760805376")],
    includes: { media: [videoMedia()], users: [USER] },
    meta: { result_count: 1, newest_id: "1263145271946551300", oldest_id: "1263145271946551300" },
    ...over,
  };
}

// ------------------------------------------------------------ fetch doubles

interface Call {
  readonly url: URL;
  readonly headers: Record<string, string>;
}

/**
 * A fetch that answers from a queue of [status, body] and records every call.
 *
 * Deliberately NOT a stub that returns the same thing forever: half of what is
 * under test here is how many requests were sent and in what order, and a stub
 * that cannot run out cannot fail a test that over-fetches.
 */
function fakeFetch(responses: Array<[number, unknown, Record<string, string>?]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, headers });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra request to ${url.pathname}`);
    const [status, body, respHeaders] = next;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(respHeaders ?? {}) },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

function clientWith(responses: Array<[number, unknown, Record<string, string>?]>) {
  const { fn, calls } = fakeFetch(responses);
  return { client: new XClient({ bearerToken: TOKEN, fetch: fn, sleep: async () => {} }), calls };
}

/** A configured adapter whose only unknown is what the fake fetch returns. */
function adapterWith(
  responses: Array<[number, unknown, Record<string, string>?]>,
  over: { maxPostsPerRun?: number; windowHours?: number | null } = {},
) {
  const { client, calls } = clientWith(responses);
  const adapter = new XAdapter({
    client,
    query: GOOD_QUERY,
    maxPostsPerRun: over.maxPostsPerRun ?? 100,
    windowHours: over.windowHours ?? null,
    now: NOW,
  });
  return { adapter, client, calls };
}

const countsBody = (total: number) => ({
  data: [{ start: "2026-09-03T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z", post_count: total }],
  meta: { total_post_count: total },
});

// =============================================================== query rules

describe("the query is checked against the documented operator list before anything is paid for", () => {
  it("rejects min_faves: and min_retweets: with the names that do work", () => {
    // The operators reference says these two in as many words: "Those names are
    // not valid in the X API and will be rejected with a 400 error." Catching it
    // locally turns somebody's afternoon into one sentence.
    expect(queryProblems("cats min_faves:1000").join(" ")).toMatch(/min_likes:/);
    expect(queryProblems("cats min_retweets:50").join(" ")).toMatch(/min_reposts:/);
  });

  it("rejects has:videos, which is the one everybody writes from memory", () => {
    // It is not in the operator list at all. `has:media` and `has:video_link`
    // are, and only one of them means native X video.
    const said = queryProblems("cats has:videos").join(" ");
    expect(said).toMatch(/has:video_link/);
    expect(said).toMatch(/has:media/);
  });

  it("rejects a query made only of conjunction-required operators", () => {
    // X rejects it outright — "using these operators alone would match an
    // extremely high volume of Posts" — and on a per-post meter that sentence is
    // about money, not just about validity.
    expect(queryProblems("has:video_link -is:retweet lang:en")).not.toEqual([]);
  });

  it("counts min_likes: as standalone, because the reference says it is", () => {
    // This is the operator the whole cost-control story leans on: it narrows by
    // popularity BEFORE the bill and it can carry a query by itself.
    expect(queryProblems("min_likes:20000 has:video_link -is:retweet lang:en")).toEqual([]);
  });

  it("enforces the 512-character self-serve ceiling", () => {
    expect(queryProblems(`min_likes:1 ${"a".repeat(600)}`).join(" ")).toMatch(/512/);
    expect(queryProblems("")).not.toEqual([]);
  });
});

// ============================================================ cost arithmetic

describe("what a run can be billed, worked out before it is spent", () => {
  it("knows a page has a documented MINIMUM of 10 results", () => {
    // Asking for 4 posts is impossible: `max_results` has a minimum of 10, so
    // the smallest request that serves it is billed for 10. A cap check against
    // the ask alone would authorise a bill it never agreed to.
    expect(pageSizeFor(4)).toBe(10);
    expect(pageSizeFor(50)).toBe(50);
    expect(pageSizeFor(500)).toBe(100);
    expect(worstCaseBilledPosts(4)).toBe(10);
    expect(worstCaseBilledPosts(101)).toBe(110);
    expect(worstCaseBilledPosts(105)).toBe(110);
    // A remainder of 10 or more is asked for exactly, so the overshoot is only
    // ever the 1..9 case and is at most 9 Posts.
    expect(worstCaseBilledPosts(150)).toBe(150);
    expect(worstCaseBilledPosts(100)).toBe(100);
    expect(worstCaseBilledPosts(200)).toBe(200);
    expect(worstCaseBilledPosts(0)).toBe(0);
  });

  it("prices Posts and Counts as certain, and expanded Users as a range", () => {
    // The gap between low and high is exactly the question the documentation
    // does not answer: whether an expanded user in `includes` is a User: Read.
    // A single figure would mean picking an answer and hoping.
    const { low, high } = estimateUsd({ postReads: 100, userReads: 40, countsRequests: 1, requests: 2 });
    expect(low).toBeCloseTo(100 * 0.005 + 0.005, 10);
    expect(high).toBeCloseTo(low + 40 * 0.01, 10);
    expect(high).toBeGreaterThan(low);
  });

  it("clamps a window to the documented 7 days and stops short of the edge", () => {
    // Recent search says start_time "must be within the last 7 days". Asking for
    // exactly the boundary is asking to be rejected by clock drift, so the
    // computed time is pulled back a minute.
    expect(startTimeFor(null, NOW())).toBeNull();
    expect(startTimeFor(24, NOW())).toBe("2026-09-03T12:01:00Z");
    expect(startTimeFor(9_000, NOW())).toBe(startTimeFor(168, NOW()));
    // No milliseconds — the form X's own examples use.
    expect(startTimeFor(1, NOW())).not.toMatch(/\.\d{3}Z$/);
  });
});

// ================================================================= the client

describe("XClient asks X for everything the product needs in one request", () => {
  it("sends the expansions and media fields that carry duration, views and the file", async () => {
    const { client, calls } = clientWith([[200, searchBody()]]);
    await client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 });

    const params = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe("/2/tweets/search/recent");
    expect(params.get("expansions")).toContain("attachments.media_keys");
    expect(params.get("expansions")).toContain("author_id");
    // The three fields the whole design turns on: without duration there is no
    // Short, without public_metrics there is no view count, without variants
    // there is a second hop to a downloader.
    expect(params.get("media.fields")).toContain("duration_ms");
    expect(params.get("media.fields")).toContain("public_metrics");
    expect(params.get("media.fields")).toContain("variants");
    expect(params.get("max_results")).toBe("20");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);

    // And on the Post itself. `public_metrics` in particular is easy to drop by
    // accident and impossible to notice afterwards: without it every row's
    // like_count and comment_count go null and the rows still look fine.
    // `attachments` carries the media_keys, without which no Post can be joined
    // to its video at all.
    const postFields = params.get("tweet.fields") ?? params.get("post.fields");
    expect(postFields).toBeTruthy();
    for (const field of ["created_at", "author_id", "public_metrics", "attachments"]) {
      expect(postFields, field).toContain(field);
    }
  });

  it("counts every resource X returned, including the ones it sliced off", async () => {
    // Billing is per resource RETURNED. A page of 100 that we only keep 20 of is
    // a page of 100 on the invoice, and a ledger that counted what we kept would
    // under-report by 80.
    const many = {
      data: Array.from({ length: 100 }, (_, i) => post(`10${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()], users: [USER] },
      meta: { result_count: 100 },
    };
    const { client } = clientWith([[200, many]]);
    const result = await client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 });

    expect(result.posts).toHaveLength(20);
    expect(client.spend.postReads).toBe(100);
    expect(client.spend.userReads).toBe(1);
  });

  it("sizes the last page so it never buys more than the cap allows", async () => {
    const pageOne = {
      data: Array.from({ length: 100 }, (_, i) => post(`20${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()], users: [USER] },
      meta: { result_count: 100, next_token: "PAGE2" },
    };
    const pageTwo = {
      data: Array.from({ length: 20 }, (_, i) => post(`21${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()] },
      meta: { result_count: 20 },
    };
    const { client, calls } = clientWith([
      [200, pageOne],
      [200, pageTwo],
    ]);
    await client.searchRecent({ query: GOOD_QUERY, maxPosts: 120 });

    expect(calls).toHaveLength(2);
    expect(calls[1].url.searchParams.get("max_results")).toBe("20");
    expect(calls[1].url.searchParams.get("next_token")).toBe("PAGE2");
  });

  it("says when it stopped early because more pages existed", async () => {
    // The rows in hand are then a slice of something larger, which the adapter
    // is not allowed to hand back as though it were the answer.
    const page = {
      data: Array.from({ length: 10 }, (_, i) => post(`30${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()] },
      meta: { result_count: 10, next_token: "MORE" },
    };
    const { client } = clientWith([[200, page]]);
    const result = await client.searchRecent({ query: GOOD_QUERY, maxPosts: 10 });
    expect(result.truncatedByCap).toBe(true);
  });
});

describe("the field-parameter name X's own documentation cannot agree on", () => {
  it("retries once with the other spelling when X rejects the first, and it is free", async () => {
    // A 400 returns no resources and reads are billed per resource, so the
    // retry costs nothing. Getting this wrong silently loses every metric.
    const rejection = {
      errors: [
        {
          type: "https://api.x.com/2/problems/invalid-request",
          title: "Invalid Request",
          detail: "The `tweet.fields` query parameter value is not one of the allowed values",
          parameter: "tweet.fields",
        },
      ],
    };
    const { client, calls } = clientWith([
      [400, rejection],
      [200, searchBody()],
    ]);
    const result = await client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 });

    expect(result.posts).toHaveLength(1);
    expect(calls[0].url.searchParams.has("tweet.fields")).toBe(true);
    expect(calls[1].url.searchParams.has("post.fields")).toBe(true);
    expect(client.postFieldsParam).toBe("post.fields");
    // The rejected request returned nothing, so nothing was billed for it.
    expect(client.spend.postReads).toBe(1);
  });

  it("does not flip twice, so a genuine 400 surfaces instead of looping", async () => {
    const rejection = {
      errors: [{ title: "Invalid Request", detail: "`post.fields` is not valid", parameter: "post.fields" }],
    };
    const { client } = clientWith([
      [400, rejection],
      [400, rejection],
    ]);
    await expect(client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 })).rejects.toBeInstanceOf(XApiError);
  });

  it("flips at most ONCE for the client's whole life, not once per page", async () => {
    // The flip is a one-time discovery about the API, not a per-request retry.
    // Without the once-only guard a run that flips on page 1 flips BACK on page
    // 2, so it alternates spellings down the pagination and buys a duplicate
    // page every time it does. That is money, and it is invisible.
    const rejection = {
      errors: [{ title: "Invalid Request", detail: "`tweet.fields` is not valid", parameter: "tweet.fields" }],
    };
    const pageOne = {
      data: Array.from({ length: 20 }, (_, i) => post(`50${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()], users: [USER] },
      meta: { result_count: 20, next_token: "PAGE2" },
    };
    const { client, calls } = clientWith([
      [400, rejection], // page 1, first spelling
      [200, pageOne], // page 1, retried with the other spelling — the one flip
      [400, rejection], // page 2 is refused, and must NOT trigger a second flip
      [200, searchBody()], // reached only if it flipped again
    ]);

    await expect(client.searchRecent({ query: GOOD_QUERY, maxPosts: 40 })).rejects.toBeInstanceOf(
      XApiError,
    );
    expect(calls).toHaveLength(3);
  });

  it("throws rather than paying again when the parameter was accepted and ignored", async () => {
    // The other failure shape: 200 OK, posts with only id and text. Retrying
    // that costs a whole page of Post reads to guess a parameter name, which is
    // the exact thing the cap exists to stop. It names the one-line fix instead.
    const stripped = {
      data: [{ id: "1263145271946551300", text: "Testing, testing..." }],
      meta: { result_count: 1 },
    };
    const { client, calls } = clientWith([[200, stripped]]);
    await expect(client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 })).rejects.toThrow(
      /X_POST_FIELDS_PARAM/,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("every failure mode gets its own sentence", () => {
  it("tells a bad key apart from an access level that is not entitled", async () => {
    const bad = clientWith([[401, { title: "Unauthorized", detail: "Unauthorized" }]]);
    const denied = clientWith([
      [403, { title: "Forbidden", detail: "not permitted for your access level" }],
    ]);

    await expect(bad.client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 })).rejects.toThrow(
      /revoked|wrong/i,
    );
    const err = await denied.client
      .searchRecent({ query: GOOD_QUERY, maxPosts: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XCredentialError);
    expect((err as Error).message).toMatch(/ACCESS LEVEL/);
  });

  it("carries the rate-limit reset time rather than sleeping through it", async () => {
    // Recent search resets on a 15-minute window. Sleeping through one inside a
    // web request turns a slow page into a hung one.
    const reset = Math.floor(new Date("2026-09-04T12:15:00.000Z").getTime() / 1000);
    const { client } = clientWith([
      [429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(reset) }],
    ]);
    const err = await client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XRateLimitError);
    expect((err as XRateLimitError).resetAt?.toISOString()).toBe("2026-09-04T12:15:00.000Z");
  });

  it("refuses a bad query locally, with no request at all", async () => {
    const { client, calls } = clientWith([]);
    await expect(client.searchRecent({ query: "has:video_link", maxPosts: 20 })).rejects.toBeInstanceOf(
      XQueryError,
    );
    expect(calls).toHaveLength(0);
  });

  it("never puts the bearer token in an error message", async () => {
    // The token travels in a header, not a query string — but an error that
    // echoed a URL or a config dump would still be a credential in a log file.
    const { client } = clientWith([[400, { detail: "Invalid Request" }]]);
    const err = await client.searchRecent({ query: GOOD_QUERY, maxPosts: 20 }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).stack ?? "")).not.toContain(TOKEN);
  });
});

describe("the counts probe reads both spellings of its own field", () => {
  it("prefers meta.total_post_count", async () => {
    const { client } = clientWith([[200, countsBody(412)]]);
    await expect(client.countRecent(GOOD_QUERY)).resolves.toBe(412);
    expect(client.spend.countsRequests).toBe(1);
  });

  it("falls back to the pre-rename total_tweet_count", async () => {
    // The OpenAPI spec says post_count; the endpoint answered tweet_count for
    // its whole life before the rename and the rest of the docs still mix them.
    const { client } = clientWith([[200, { data: [], meta: { total_tweet_count: 77 } }]]);
    await expect(client.countRecent(GOOD_QUERY)).resolves.toBe(77);
  });

  it("sums the buckets when there is no meta total at all", async () => {
    const { client } = clientWith([
      [200, { data: [{ post_count: 3 }, { tweet_count: 4 }, {}], meta: {} }],
    ]);
    await expect(client.countRecent(GOOD_QUERY)).resolves.toBe(7);
  });
});

// ================================================================ the adapter

describe("an unconfigured X says which thing is missing, and makes no request", () => {
  it("names the credential when there is none", async () => {
    const reason = await new XAdapter().unavailableReason();
    expect(reason).toMatch(/Bearer token/i);
    // And it says why there is no keyless fallback, unlike YouTube.
    expect(reason).toMatch(/no user-timeline extractor/i);
  });

  it("names the query when there is a key but no query", async () => {
    const { client } = clientWith([]);
    const reason = await new XAdapter({ client, maxPostsPerRun: 100 }).unavailableReason();
    expect(reason).toMatch(/X_SEARCH_QUERY/);
  });

  it("names the spend cap, and says it has no default on purpose", async () => {
    // Same rule as `dailyQuotaUnits()` in lib/config.ts: a number nobody with
    // the authority to set it has said does not get invented here.
    const { client } = clientWith([]);
    const reason = await new XAdapter({ client, query: GOOD_QUERY }).unavailableReason();
    expect(reason).toMatch(/X_MAX_POSTS_PER_RUN/);
    expect(reason).toMatch(/no default/i);
  });

  it("tells a cap that was never set apart from one that was set to nonsense", async () => {
    const { client } = clientWith([]);
    const nonsense = new XAdapter({ client, query: GOOD_QUERY, maxPostsPerRun: Number.NaN });
    expect(await nonsense.unavailableReason()).toMatch(/not a positive whole number/);
  });

  it("reports a broken query as unavailable rather than waiting to be rejected", async () => {
    const { client } = clientWith([]);
    const adapter = new XAdapter({ client, query: "cats min_faves:100", maxPostsPerRun: 50 });
    expect(await adapter.unavailableReason()).toMatch(/min_likes:/);
  });

  it("is available once all three are present, having sent nothing", async () => {
    // unavailableReason() is called on every status render. The cheapest thing
    // X sells costs half a cent, so this method may not buy anything.
    const { client, calls } = clientWith([]);
    const adapter = new XAdapter({ client, query: GOOD_QUERY, maxPostsPerRun: 100 });
    await expect(adapter.unavailableReason()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws from latestShorts and downloadUrl rather than returning an empty list", async () => {
    const bare = new XAdapter();
    await expect(bare.latestShorts(QUERY)).rejects.toBeInstanceOf(PlatformUnavailableError);
    await expect(bare.downloadUrl(ROW)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("uses OUR word for the platform, not yt-dlp's", () => {
    // The vocabulary says `x`; yt-dlp says `twitter`. lib/platform/types.ts
    // refuses to hold a synonym table, so the translation lives here.
    expect(new XAdapter().platform).toBe("x");
  });
});

describe("the spend cap stops a run instead of truncating it", () => {
  it("refuses when the run asks for more posts than the cap authorises", async () => {
    const { adapter, calls } = adapterWith([], { maxPostsPerRun: 10 });
    const err = await adapter.latestShorts({ ...QUERY, limit: 500 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XSpendCapError);
    // Nothing was sent. Not the counts probe, not a page.
    expect(calls).toHaveLength(0);
    expect((err as Error).message).toMatch(/silently returning fewer/);
  });

  it("refuses when the 10-result minimum would bill past the cap", async () => {
    // Ask for 4 posts with a cap of 5: the smallest possible request is billed
    // for 10, which is more than was authorised. Catching that here is the
    // difference between a cap and a suggestion.
    const { adapter, calls } = adapterWith([], { maxPostsPerRun: 5 });
    await expect(adapter.latestShorts({ ...QUERY, limit: 4 })).rejects.toBeInstanceOf(XSpendCapError);
    expect(calls).toHaveLength(0);
  });

  it("stops after the counts probe when the query matches more than the cap", async () => {
    // The whole point of paying half a cent first: it stops a $2,060 query
    // before the first Post is bought.
    const { adapter, calls } = adapterWith([[200, countsBody(412_000)]], { maxPostsPerRun: 100 });
    const err = await adapter.latestShorts(QUERY).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(XSpendCapError);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/2/tweets/counts/recent");
    // It says what to do about it, and narrowing comes before raising the cap.
    expect((err as Error).message).toMatch(/min_likes:/);
    expect((err as Error).message).toMatch(/arbitrary recency slice/);
  });

  it("skips the search entirely when the probe says nothing matches", async () => {
    // A real answer about X, bought for half a cent, rather than an inference
    // from an empty search we would have paid per-post to run.
    const { adapter, calls } = adapterWith([[200, countsBody(0)]]);
    await expect(adapter.latestShorts(QUERY)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(adapter.lastRun?.matchedInWindow).toBe(0);
  });

  it("refuses to hand back a slice when counts and search disagree", async () => {
    const page = {
      data: Array.from({ length: 20 }, (_, i) => post(`40${i}`, "13_1263145212760805376")),
      includes: { media: [videoMedia()], users: [USER] },
      meta: { result_count: 20, next_token: "MORE" },
    };
    const { adapter } = adapterWith([
      [200, countsBody(15)],
      [200, page],
    ]);
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(XSpendCapError);
  });

  it("sends the window as start_time on both the probe and the search", async () => {
    const { adapter, calls } = adapterWith(
      [
        [200, countsBody(3)],
        [200, searchBody()],
      ],
      { windowHours: 24 },
    );
    await adapter.latestShorts(QUERY);
    expect(calls[0].url.searchParams.get("start_time")).toBe("2026-09-03T12:01:00Z");
    expect(calls[1].url.searchParams.get("start_time")).toBe("2026-09-03T12:01:00Z");
  });
});

describe("one documented response becomes one row", () => {
  it("carries the view count, the duration and the link out of a single request", async () => {
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, searchBody()],
    ]);
    const [row] = await adapter.latestShorts(QUERY);

    expect(row).toEqual<ShortRecord>({
      platform: "x",
      // The POST id, not the media_key: `13_1263145212760805376` opens nothing.
      platform_video_id: "1263145271946551300",
      url: "https://x.com/xdevelopers/status/1263145271946551300",
      title: "Testing, testing...",
      creator_handle: "xdevelopers",
      creator_id: "2244994945",
      creator_url: "https://x.com/xdevelopers",
      // 46,947ms from the data dictionary's own example.
      duration_seconds: 47,
      view_count: 6_909_260,
      like_count: 100,
      comment_count: 5,
      published_at: "2026-09-03T10:00:00.000Z",
      thumbnail_url: "https://pbs.twimg.com/media/EYeX7akWsAIP1_1.jpg",
      discovered_at: "2026-09-04T12:00:00.000Z",
      discovered_by: "x-api-v2:tweets/search/recent",

      topic_slug: null,
    });
  });

  it("NEVER uses the post's impression_count as a view count", async () => {
    // An impression is the post appearing on a timeline; a view is somebody
    // playing the video. The fixture's impression_count is 99,000,000 against a
    // real view count of 6,909,260 — substituting one for the other would let
    // rows clear the 500,000 bar they never cleared.
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, searchBody()],
    ]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row.view_count).toBe(6_909_260);
    expect(row.view_count).not.toBe(99_000_000);
  });

  it("skips a post whose only media is a photo, and keeps the video one", async () => {
    const body = searchBody({
      data: [post("111", "3_photo"), post("222", "13_video")],
      includes: {
        media: [
          { media_key: "3_photo", type: "photo", url: "https://pbs.twimg.com/media/x.jpg" },
          videoMedia({ media_key: "13_video" }),
        ],
        users: [USER],
      },
    });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["222"]);
  });

  it("falls back to the id-only URL when the author expansion did not come back", async () => {
    const body = searchBody({ includes: { media: [videoMedia()], users: [] } });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row.url).toBe("https://x.com/i/status/1263145271946551300");
    expect(row.creator_handle).toBeNull();
    // The author id is still on the Post itself, so provenance is not lost.
    expect(row.creator_id).toBe("2244994945");
  });
});

describe("a null view count, which is the one thing nobody has confirmed", () => {
  it("keeps a row with an unknown view count instead of scoring it zero", async () => {
    // Null is not zero and not "probably fine". The row survives with a null, so
    // lib/shorts/run.ts counts it under `unknownViews` — an operator seeing a
    // large unknownViews is looking at a bug to chase, not a quiet day on X.
    const body = searchBody({
      data: [post("111", "13_a"), post("222", "13_b")],
      includes: {
        media: [videoMedia({ media_key: "13_a" }), videoMedia({ media_key: "13_b", public_metrics: {} })],
        users: [USER],
      },
    });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const rows = await adapter.latestShorts(QUERY);

    expect(rows).toHaveLength(2);
    expect(rows[1].view_count).toBeNull();
    expect(rows[1].view_count).not.toBe(0);
    expect(adapter.lastRun?.postsWithViewCount).toBe(1);
  });

  it("THROWS when not one video carried a view count, rather than looking empty", async () => {
    // This is the failure the whole X leg is gambling against, and it is the
    // one that must never render as "nothing over 500,000 views on X today".
    const body = searchBody({
      includes: { media: [videoMedia({ public_metrics: undefined })], users: [USER] },
    });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const err = await adapter.latestShorts(QUERY).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(XViewCountUnreadableError);
    expect((err as Error).message).toMatch(/not readable at this access level/);
    // And it says what the run cost, because that is what the answer cost.
    expect((err as Error).message).toMatch(/\$\d/);
  });

  it("THROWS when the query matched posts but selected no video at all", async () => {
    const body = searchBody({
      data: [post("111", "3_photo")],
      includes: {
        media: [{ media_key: "3_photo", type: "photo" }],
        users: [USER],
      },
    });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const err = await adapter.latestShorts(QUERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XNoVideoError);
    expect((err as Error).message).toMatch(/has:video_link/);
  });

  it("keeps a video whose duration X did not state, as a null and not as a zero", async () => {
    // A null duration is dropped downstream — duration is the only thing that
    // defines a Short — but it is dropped by the caller, counted, and visible.
    const body = searchBody({
      includes: { media: [videoMedia({ duration_ms: undefined })], users: [USER] },
    });
    const { adapter } = adapterWith([
      [200, countsBody(3)],
      [200, body],
    ]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row.duration_seconds).toBeNull();
  });
});

describe("downloadUrl resolves a playable file, on demand and never stored", () => {
  it("picks the highest-bitrate progressive MP4", async () => {
    const { adapter, calls } = adapterWith([
      [200, { data: post("1263145271946551300", "13_1263145212760805376"), includes: { media: [videoMedia()] } }],
    ]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBe("https://video.twimg.com/high.mp4?tag=12");
    expect(calls[0].url.pathname).toBe("/2/tweets/1263145271946551300");
  });

  it("ignores the HLS manifest, which a browser cannot save as a file", () => {
    // Handing an operator a .m3u8 when they asked for the video is the same
    // broken promise as a dead link.
    expect(bestMp4Variant({ variants: [VARIANTS[2]] })).toBeNull();
    expect(bestMp4Variant({ variants: [] })).toBeNull();
    expect(bestMp4Variant(undefined)).toBeNull();
  });

  it("returns null when the post has no video, which is a fact about one row", async () => {
    const { adapter } = adapterWith([
      [200, { data: post("1263145271946551300", "3_photo"), includes: { media: [{ media_key: "3_photo", type: "photo" }] } }],
    ]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBeNull();
  });

  it("charges one Post read for the lookup, and says so", async () => {
    const { adapter, client } = adapterWith([
      [200, { data: post("1263145271946551300", "13_1263145212760805376"), includes: { media: [videoMedia()] } }],
    ]);
    await adapter.downloadUrl(ROW);
    expect(client.spend.postReads).toBe(1);
  });

  it("THROWS on another platform's row rather than answering null", async () => {
    // SCAR, 2026-09-08. This returned null, and null on this seam is rendered
    // by app/(admin)/admin/shorts/actions.ts as "It was asked and it answered —
    // nothing failed and nothing was refused, there is simply no media URL for
    // this one". That is a false sentence about a routing bug and it names X as
    // the thing that came up empty. Every other adapter here already threw.
    const { adapter, calls } = adapterWith([]);
    await expect(adapter.downloadUrl({ ...ROW, platform: "tiktok" })).rejects.toThrow(/registry/);
    expect(calls, "a misrouted row cost a Post read to refuse").toEqual([]);
  });
});

// ============================== the answers this leg was bought to settle reach a person

/**
 * SCAR, 2026-09-08. `markSafeToShow` in lib/shorts/run.ts documents its own
 * reason for existing and quotes, as the example, "X returned 40 video posts
 * and not one carried a view count" — the message `XViewCountUnreadableError`
 * composes. Neither it nor `XNoVideoError` was ever marked, so both went to a
 * log file and /admin/shorts said "the thrown message is in this deployment's
 * server log". lib/shorts/run.test.ts proved the mechanism against a
 * locally-declared `SafeError` carrying that exact sentence, which is why the
 * gap stayed green: the unit worked and the wiring was absent.
 */
describe("X's own refusals are fit to print", () => {
  const spend = { postReads: 40, userReads: 0, countsRequests: 1, requests: 2 };

  it("marks the view-count answer, which is the whole question the key was bought for", () => {
    const error = new XViewCountUnreadableError(40, spend);
    expect(safeToShowMessage(error)).toMatch(/not one carried/);
    expect(safeToShowMessage(error)).toMatch(/Refusing to report that as a quiet day/);
  });

  it("marks the no-video answer, which names the operator's own fix", () => {
    expect(safeToShowMessage(new XNoVideoError(40, spend))).toMatch(/has:video_link/);
  });

  it("leaves nothing of the token or the URL in either sentence", () => {
    // The rule these are safe under: composed here, out of this file's own
    // counts and a published price table. Nothing from a response body.
    for (const error of [new XViewCountUnreadableError(40, spend), new XNoVideoError(40, spend)]) {
      expect(error.message).not.toMatch(/api\.x\.com/);
      expect(error.message).not.toMatch(/Bearer|token/i);
    }
  });
});

// =============================================================== registry wiring

describe("the registry is the only place that reads X's configuration", () => {
  it("takes the query whole, without splitting it the way seeds are split", () => {
    // `seedsFor` splits on commas AND whitespace, which is right for channel ids
    // and would turn this query into four unrelated fragments.
    const config = xConfigFor({ env: { X_SEARCH_QUERY: GOOD_QUERY, X_MAX_POSTS_PER_RUN: "200" } });
    expect(config.query).toBe(GOOD_QUERY);
    expect(config.maxPostsPerRun).toBe(200);
    expect(config.windowHours).toBeNull();
  });

  it("tells an unset cap apart from one set to nonsense", () => {
    expect(xConfigFor({ env: {} }).maxPostsPerRun).toBeNull();
    expect(xConfigFor({ env: { X_MAX_POSTS_PER_RUN: "two hundred" } }).maxPostsPerRun).toBeNaN();
  });

  it("lets explicit options win over the environment", () => {
    const config = xConfigFor({ env: { X_SEARCH_QUERY: "from-env" }, x: { query: "explicit" } });
    expect(config.query).toBe("explicit");
  });

  it("builds an X adapter that is unavailable with nothing configured", async () => {
    // `adapterFor` became async when the registry started leasing credentials
    // to build an XClient — the fix for the blocker where nothing in the tree
    // ever constructed one.
    const adapter = await adapterFor("x", { env: {} });
    expect(adapter.platform).toBe("x");
    expect(await adapter.unavailableReason()).toMatch(/Bearer token/i);
  });
});

/** A row shaped the way this adapter produces them, for the refusal paths. */
const ROW: ShortRecord = {
  platform: "x",
  platform_video_id: "1263145271946551300",
  url: "https://x.com/xdevelopers/status/1263145271946551300",
  title: "Testing, testing...",
  creator_handle: "xdevelopers",
  creator_id: "2244994945",
  creator_url: "https://x.com/xdevelopers",
  duration_seconds: 47,
  view_count: 6_909_260,
  like_count: 100,
  comment_count: 5,
  published_at: "2026-09-03T10:00:00.000Z",
  thumbnail_url: "https://pbs.twimg.com/media/EYeX7akWsAIP1_1.jpg",
  discovered_at: "2026-09-04T12:00:00.000Z",
  discovered_by: "x-api-v2:tweets/search/recent",

  topic_slug: null,
};

/**
 * The topic-narrowed query.
 *
 * X bills per Post returned, so the shape of this string is a cost decision as
 * much as a correctness one. The assertions below are the two properties that
 * make topics on X safe without a separate spend switch: the operator's guards
 * survive, and a multi-word phrase is quoted so the query does not silently
 * widen into an implicit AND.
 */
describe("topicQuery", () => {
  const configured = "min_likes:20000 has:video_link -is:retweet lang:en";

  it("keeps every cost control the operator configured", () => {
    const q = topicQuery(configured, ["shark tank"]);
    expect(q).toContain("min_likes:20000");
    expect(q).toContain("has:video_link");
    expect(q).toContain("-is:retweet");
    expect(q).toContain("lang:en");
  });

  it("quotes a multi-word phrase so it is a phrase and not an implicit AND", () => {
    expect(topicQuery(configured, ["shark tank"])).toBe(`("shark tank") ${configured}`);
  });

  it("leaves a single word unquoted", () => {
    expect(topicQuery(configured, ["bodycam"])).toBe(`(bodycam) ${configured}`);
  });

  it("ORs the terms together, so the group narrows rather than excludes", () => {
    expect(topicQuery(configured, ["shark tank", "dragons den"])).toBe(
      `("shark tank" OR "dragons den") ${configured}`,
    );
  });

  it("drops a stray quote rather than escaping it, because X documents no escape", () => {
    expect(topicQuery(configured, ['say "what"'])).toBe(`("say what") ${configured}`);
  });

  it("is the configured query unchanged when there are no usable terms", () => {
    expect(topicQuery(configured, ["", "   "])).toBe(configured);
  });

  it("produces a query X's own validator accepts", () => {
    // The combination is what gets sent, so it is the combination that has to
    // pass — a topic that made the query illegal would fail after the counts
    // request had already been paid for.
    expect(queryProblems(topicQuery(configured, ["shark tank", "dragons den"]))).toEqual([]);
  });
});
