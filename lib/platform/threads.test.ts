/**
 * The Threads adapter — the one platform that can be ASKED something and can
 * never MEASURE the answer.
 *
 * Three failures are guarded against here, and the third is the one that
 * matters most because it is the one somebody would introduce while trying to
 * be helpful.
 *
 *   1. RETURNING `[]` WHERE THERE IS NO WAY IN. The untargeted run must refuse.
 *      Threads has no trending edge, so an empty list would say "Threads had
 *      nothing big today" — a claim about Threads that nobody checked.
 *
 *   2. TRUSTING META'S OWN FILTER. `media_type=VIDEO` goes out on the request
 *      and is checked again on the reply, because a text post filed as a short
 *      is a row this tool invented.
 *
 *   3. INVENTING A NUMBER. Every row comes back with `view_count` and
 *      `duration_seconds` null, forever, because Meta publishes neither for
 *      other people's posts. A future edit that fills either one in — from a
 *      like count, from a reply count, from a guess about clip length — makes
 *      Threads rows eligible for the 500,000 threshold they were never
 *      measured against. The assertions below are what stop it.
 *
 * NOTHING HERE TOUCHES META. There is no Threads token on this machine;
 * `fetch` is replaced throughout.
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery } from "./adapter";
import { MetaCallBudget, MetaUnreadableError } from "./meta-client";
import { ThreadsAdapter } from "./threads";
import { asTopical } from "./topical";
import { PlatformUnavailableError } from "./unavailable";
import type { Topic } from "../shorts/topics";

const QUERY: LatestShortsQuery = {
  limit: 20,
  minViews: 500_000,
  minDurationSeconds: 0,
  maxDurationSeconds: 120,
};

const TOKEN = "THAA-not-a-real-threads-token-0000";

const TOPIC: Topic = {
  id: "t1",
  name: "Shark Tank",
  slug: "shark-tank",
  terms: ["shark tank pitch"],
  active: true,
  source: "plan",
  publishesTo: null,
  note: null,
  addedAt: "2026-09-05T00:00:00.000Z",
};

function videoPost(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    text: "a caption",
    media_type: "VIDEO",
    permalink: `https://www.threads.net/@someone/post/${id}`,
    timestamp: "2026-09-07T08:00:00+0000",
    username: "someone",
    ...extra,
  };
}

function stubFetch(bodies: unknown[], init: { status?: number } = {}) {
  const urls: string[] = [];
  let i = 0;
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, urls };
}

function configured(bodies: unknown[], over: Record<string, unknown> = {}) {
  const stub = stubFetch(bodies);
  const adapter = new ThreadsAdapter({
    token: TOKEN,
    fetchImpl: stub.impl,
    now: () => new Date("2026-09-08T12:00:00.000Z"),
    ...over,
  });
  return { adapter, ...stub };
}

describe("nothing configured", () => {
  const adapter = new ThreadsAdapter();

  it("names the token and the scope that is actually load-bearing", async () => {
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/threads_keyword_search/);
    expect(reason).toMatch(/threads\.net/);
  });

  it("says up front that it can find clips and never measure them", async () => {
    // An operator deciding whether the App Review paperwork is worth it needs
    // this sentence BEFORE they do the paperwork, not after the first run comes
    // back with a page of unverified rows.
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/unknown views/i);
    expect(reason).toMatch(/unverified/i);
  });

  it("refuses a topic run rather than searching without a token", async () => {
    await expect(adapter.latestShortsForTopic(TOPIC, QUERY)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
  });
});

describe("the untargeted run refuses instead of reporting an empty Threads", () => {
  it("throws even when the token is perfectly good", async () => {
    const { adapter } = configured([{ data: [] }]);

    // THE POINT OF THE WHOLE FILE, in one assertion. A configured adapter that
    // is asked for "the latest shorts" with no subject has no question it could
    // put to Meta, and the honest answer is a refusal.
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("makes no call at all, so the refusal costs nothing", async () => {
    const { adapter, urls } = configured([{ data: [] }]);
    await adapter.latestShorts(QUERY).catch(() => undefined);
    expect(urls).toEqual([]);
  });

  it("explains it as a limit of the question rather than of the credential", async () => {
    const { adapter } = configured([{ data: [] }]);
    const error = (await adapter.latestShorts(QUERY).catch((e) => e)) as PlatformUnavailableError;
    expect(error.reason).toMatch(/only be read for a SUBJECT/i);
    // Not "save a token" — a token would not help, and sending somebody to
    // /admin/credentials for this would waste their afternoon.
    expect(error.reason).not.toMatch(/save (one|a token) on/i);
  });
});

describe("searching for a subject", () => {
  it("is recognised as a topical adapter", () => {
    expect(asTopical(new ThreadsAdapter())).not.toBeNull();
  });

  it("sends the topic's term, asks Meta for video only, and hits the Threads host", async () => {
    const { adapter, urls } = configured([{ data: [videoPost("18001")] }]);
    await adapter.latestShortsForTopic(TOPIC, QUERY);

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] as string);
    // graph.threads.net and NOT graph.facebook.com. The Graph host does not
    // serve this edge at all, so a copy-paste of the Meta base would 404 every
    // search while looking like a working adapter.
    expect(url.host).toBe("graph.threads.net");
    expect(url.pathname).toBe("/v1.0/keyword_search");
    expect(url.searchParams.get("q")).toBe("shark tank pitch");
    expect(url.searchParams.get("media_type")).toBe("VIDEO");
  });

  it("refuses a topic with no terms rather than searching for nothing", async () => {
    const { adapter, urls } = configured([{ data: [] }]);
    const reason = await adapter.topicUnavailableReason({ ...TOPIC, terms: ["  ", ""] });
    expect(reason).toMatch(/no search terms/i);
    expect(urls).toEqual([]);
  });

  it("makes one call per term and counts a post matching two of them once", async () => {
    const { adapter, urls } = configured([
      { data: [videoPost("18001")] },
      { data: [videoPost("18001"), videoPost("18002")] },
    ]);

    const rows = await adapter.latestShortsForTopic(
      { ...TOPIC, terms: ["shark tank", "dragons den"] },
      QUERY,
    );

    expect(urls).toHaveLength(2);
    // Two requests, three results, two shorts. De-duplicated HERE rather than
    // in the run, because a duplicate that reached the run would be reported as
    // the platform returning the same post twice — which it did not.
    expect(rows.map((r) => r.platform_video_id)).toEqual(["18001", "18002"]);
  });

  it("labels every row with the subject that found it", async () => {
    const { adapter } = configured([{ data: [videoPost("18001")] }]);
    const rows = await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(rows[0]?.topic_slug).toBe("shark-tank");
  });
});

describe("what a row says, and what it refuses to say", () => {
  it("carries no view count and no duration, and that is permanent", async () => {
    const { adapter } = configured([
      {
        data: [
          // Every number Meta could plausibly hand back is present on this post
          // and none of them is a view count or a length. A future edit that
          // maps one of them onto either field fails here.
          videoPost("18001", { has_replies: true, is_quote_post: false, is_reply: false }),
        ],
      },
    ]);

    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);

    expect(row?.view_count).toBeNull();
    expect(row?.duration_seconds).toBeNull();
    expect(row?.like_count).toBeNull();
    expect(row?.comment_count).toBeNull();
  });

  it("keeps the permalink as the URL and the id as Meta issued it", async () => {
    const { adapter } = configured([{ data: [videoPost("18023456789012345")] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);

    expect(row?.platform_video_id).toBe("18023456789012345");
    expect(row?.url).toBe("https://www.threads.net/@someone/post/18023456789012345");
    expect(row?.platform).toBe("threads");
  });

  it("records the caption as the title, because Threads has no title", async () => {
    const { adapter } = configured([{ data: [videoPost("18001", { text: "  a caption  " })] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(row?.title).toBe("a caption");
  });

  it("builds the creator URL from the username and leaves the id null", async () => {
    const { adapter } = configured([{ data: [videoPost("18001")] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);

    expect(row?.creator_handle).toBe("someone");
    expect(row?.creator_url).toBe("https://www.threads.net/@someone");
    // `owner` is excluded from keyword_search by documentation. Null is what
    // happened; a fabricated id would be worse than none.
    expect(row?.creator_id).toBeNull();
  });

  it("drops a post with no id or no permalink rather than synthesising either", async () => {
    const { adapter } = configured([
      {
        data: [
          videoPost("18001", { permalink: undefined }),
          { ...videoPost("x"), id: undefined },
          videoPost("18002"),
        ],
      },
    ]);

    const rows = await adapter.latestShortsForTopic(TOPIC, QUERY);
    // Identity is (platform, platform_video_id) and `url` is documented always
    // present. A row missing either cannot be looked up again, so it is not
    // stored at all.
    expect(rows.map((r) => r.platform_video_id)).toEqual(["18002"]);
  });

  it("says which adapter found it", async () => {
    const { adapter } = configured([{ data: [videoPost("18001")] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(row?.discovered_by).toBe("meta:threads-keyword-search");
    expect(row?.discovered_at).toBe("2026-09-08T12:00:00.000Z");
  });
});

describe("Meta's own filter is checked and not trusted", () => {
  it("drops a text post that comes back from a VIDEO search", async () => {
    const { adapter } = configured([
      { data: [videoPost("18001"), videoPost("18002", { media_type: "TEXT_POST" })] },
    ]);

    const rows = await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["18001"]);
  });

  it("accepts a lowercased media_type, because a case change is not a contract change", async () => {
    const { adapter } = configured([{ data: [videoPost("18001", { media_type: "video" })] }]);
    const rows = await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(rows).toHaveLength(1);
  });

  it("refuses a page where nothing carries a media_type at all", async () => {
    const { adapter } = configured([
      { data: [{ id: "1", permalink: "https://example.invalid/1" }] },
    ]);

    // An unreadable listing, not an empty one — the usual cause is a token
    // without threads_keyword_search. Reporting it as "no shorts found" is the
    // silent failure this whole platform is most prone to.
    await expect(adapter.latestShortsForTopic(TOPIC, QUERY)).rejects.toBeInstanceOf(
      MetaUnreadableError,
    );
  });

  it("reports a genuinely empty search as empty", async () => {
    const { adapter } = configured([{ data: [] }]);
    await expect(adapter.latestShortsForTopic(TOPIC, QUERY)).resolves.toEqual([]);
  });
});

describe("the plumbing it shares and the budget it does not", () => {
  it("meters against its own budget", async () => {
    const budget = new MetaCallBudget(1);
    const { adapter } = configured([{ data: [videoPost("18001")] }], { budget });

    await adapter.latestShortsForTopic(TOPIC, QUERY);
    expect(budget.spent()).toBe(1);
  });

  it("refuses a limit that is not a positive integer before spending a call", async () => {
    const { adapter, urls } = configured([{ data: [] }]);
    await expect(
      adapter.latestShortsForTopic(TOPIC, { ...QUERY, limit: 0 }),
    ).rejects.toBeInstanceOf(MetaUnreadableError);
    expect(urls).toEqual([]);
  });

  it("offers no download URL, because keyword search returns no media URL", async () => {
    const { adapter } = configured([{ data: [videoPost("18001")] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);
    await expect(adapter.downloadUrl(row!)).resolves.toBeNull();
  });

  it("still refuses another platform's row, rather than answering null for it", async () => {
    // Null here is a claim ABOUT THREADS — the page prints "It was asked and it
    // answered" — so making it about a TikTok row would be this adapter
    // answering for a platform it cannot see. Every other adapter guards this.
    const { adapter } = configured([{ data: [videoPost("18001")] }]);
    const [row] = await adapter.latestShortsForTopic(TOPIC, QUERY);
    await expect(adapter.downloadUrl({ ...row!, platform: "tiktok" })).rejects.toThrow(/registry/);
  });

  it("keeps the token out of the URL it reports on failure", async () => {
    const { adapter } = configured([{ error: { message: "bad scope" } }], {});
    const error = await adapter
      .latestShortsForTopic(TOPIC, QUERY)
      .catch((e: Error) => e);
    expect(String(error)).not.toContain(TOKEN);
  });
});
