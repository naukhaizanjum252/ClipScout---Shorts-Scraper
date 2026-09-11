/**
 * The Instagram adapter, and the one thing it must never do.
 *
 * The official Graph API can tell this product that a Reel has 900,000 views
 * and CANNOT tell it whether that Reel is twenty seconds or three minutes long —
 * Instagram media has no duration field. So the failure this file exists to
 * prevent is not "the adapter is broken"; it is "the adapter quietly presents
 * rows it never length-checked as though they had passed the 120-second
 * ceiling". Nearly every test below is about that.
 *
 * NONE OF THIS TOUCHES META. There is no token on this machine. `fetch` is
 * replaced everywhere and what is under test is the mapping, the filtering, the
 * refusals and the URL — not whether Meta answers.
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery } from "./adapter";
import { InstagramAdapter } from "./instagram";
import { GRAPH_VERSION, MetaBudgetError, MetaCallBudget, MetaUnreadableError } from "./meta-client";
import type { ShortRecord } from "./types";
import { PlatformUnavailableError, type ProviderClient } from "./unavailable";

const QUERY: LatestShortsQuery = { limit: 20, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

const TOKEN = "EAAG-not-a-real-token-0000";
const IG_USER_ID = "17841405309211844";

const ROW: ShortRecord = {
  platform: "instagram",
  platform_video_id: "Cabc123",
  url: "https://www.instagram.com/reel/Cabc123/",
  title: null,
  creator_handle: null,
  creator_id: null,
  creator_url: null,
  duration_seconds: 20,
  view_count: 900_000,
  like_count: null,
  comment_count: null,
  published_at: null,
  thumbnail_url: null,
  discovered_at: "2026-09-04T12:00:00.000Z",
  discovered_by: "provider",

  topic_slug: null,
};

interface MediaFixture {
  id: string;
  permalink: string;
  media_product_type: string;
  view_count?: number;
  like_count?: number;
  comments_count?: number;
  timestamp?: string;
  caption?: string;
  username?: string;
  thumbnail_url?: string;
  media_url?: string;
}

function reel(id: string, views: number | undefined, extra: Partial<MediaFixture> = {}): MediaFixture {
  return {
    id,
    permalink: `https://www.instagram.com/reel/${id}/`,
    media_product_type: "REELS",
    ...(views === undefined ? {} : { view_count: views }),
    ...extra,
  };
}

function discoveryBody(media: MediaFixture[], username = "someone") {
  return {
    business_discovery: {
      id: "17841401441775531",
      username,
      followers_count: 267_793,
      media_count: 1205,
      media: { data: media },
    },
    id: IG_USER_ID,
  };
}

/** A `fetch` that records every URL and answers with one canned body. */
function stubFetch(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, urls, calls: impl as unknown as ReturnType<typeof vi.fn> };
}

function configured(body: unknown, over: Record<string, unknown> = {}) {
  const stub = stubFetch(body);
  const adapter = new InstagramAdapter(null, {
    igUserId: IG_USER_ID,
    seeds: ["@someone"],
    token: TOKEN,
    fetchImpl: stub.impl,
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    ...over,
  });
  return { adapter, ...stub };
}

describe("nothing configured — it refuses, and the refusal is the product answer", () => {
  const adapter = new InstagramAdapter();

  it("is unavailable and names all three missing pieces", async () => {
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/Meta access token/);
    expect(reason).toMatch(/Instagram professional account id/);
    expect(reason).toMatch(/PLATFORM_SEEDS_INSTAGRAM/);
  });

  it("warns about the duration hole BEFORE anyone starts App Review", async () => {
    // The whole reason this refusal is long. Somebody about to spend weeks on
    // Business Verification deserves to know the finished result still cannot
    // say how long a Reel is. Delete that sentence and this goes red.
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/NO duration field/);
    expect(reason).toMatch(/120-second ceiling/);
  });

  it("says out loud that nothing here has been run against Meta", async () => {
    // The single most important rule this round. If this file ever starts
    // claiming the route works, this is the test that should have stopped it.
    expect(await adapter.unavailableReason()).toMatch(/has been run against Meta/);
    expect(adapter.describe()).toMatch(/has been run against Meta/);
  });

  it("keeps the previously verified keyless finding on the record", async () => {
    // yt-dlp's own source carries `_WORKING = False` on InstagramUserIE. It is
    // why there is no free path and why a Meta token is the only route.
    expect(await adapter.unavailableReason()).toMatch(/CURRENTLY BROKEN/);
    expect(await adapter.unavailableReason()).toMatch(/instagram:user/);
  });

  it("THROWS from latestShorts instead of returning an empty list", async () => {
    // `[]` reads on screen as "nothing on Instagram passed 500,000 views".
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("carries the same sentence into the error as into the UI", async () => {
    const reason = (await adapter.unavailableReason()) as string;
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(reason);
  });

  it("THROWS from downloadUrl too, because no such row could exist", async () => {
    await expect(adapter.downloadUrl(ROW)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });
});

describe("partly configured — the refusal names what is missing and nothing else", () => {
  it("does not complain about the token when a token is present", async () => {
    // A refusal that lists gaps that are not gaps sends somebody to re-check a
    // setting that was already right.
    const adapter = new InstagramAdapter(null, { token: TOKEN, igUserId: IG_USER_ID });
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/PLATFORM_SEEDS_INSTAGRAM/);
    expect(reason).not.toMatch(/needs a Meta access token/);
    expect(reason).not.toMatch(/save one on \/admin\/credentials/);
  });

  it("still refuses when the seeds are there but the account id is not", async () => {
    const adapter = new InstagramAdapter(null, { token: TOKEN, seeds: ["someone"] });
    expect(await adapter.unavailableReason()).toMatch(/Instagram professional account id/);
  });

  it("accepts an async token source, because a credential lease is async", async () => {
    const adapter = new InstagramAdapter(null, {
      token: async () => TOKEN,
      igUserId: IG_USER_ID,
      seeds: ["someone"],
    });
    expect(await adapter.unavailableReason()).toBeNull();
  });

  it("treats a token source that yields null as no token at all", async () => {
    // What a `CredentialStore.lease()` returns when nothing is saved. It must
    // read as unconfigured, not as configured-with-empty.
    const adapter = new InstagramAdapter(null, {
      token: async () => null,
      igUserId: IG_USER_ID,
      seeds: ["someone"],
    });
    expect(await adapter.unavailableReason()).toMatch(/Meta access token/);
  });
});

describe("the official Business Discovery path", () => {
  it("becomes available once all three pieces are present", async () => {
    const { adapter } = configured(discoveryBody([]));
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });

  it("asks for the PINNED Graph version and never a versionless path", async () => {
    // An unpinned Graph API silently changes field sets under you.
    const { adapter, urls } = configured(discoveryBody([reel("a", 600_000)]));
    await adapter.latestShorts(QUERY);
    expect(urls[0]).toContain(`/${GRAPH_VERSION}/${IG_USER_ID}?`);
    expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it("addresses the operator's own account and expands the seeded username", async () => {
    // Business Discovery is a field expansion on YOUR node naming THEIR handle.
    // Getting that backwards is the easiest mistake to make here.
    const { adapter, urls } = configured(discoveryBody([reel("a", 600_000)]));
    await adapter.latestShorts(QUERY);
    const fields = new URL(urls[0] as string).searchParams.get("fields") as string;
    expect(fields).toContain("business_discovery.username(someone)");
    expect(fields).toContain("view_count");
    expect(fields).toContain("media_product_type");
    // The @ the operator probably typed must not reach the API.
    expect(fields).not.toContain("@someone");
  });

  it("caps the nested media edge at the query limit rather than fetching everything", async () => {
    const { adapter, urls } = configured(discoveryBody([reel("a", 600_000)]));
    await adapter.latestShorts({ ...QUERY, limit: 7 });
    expect(new URL(urls[0] as string).searchParams.get("fields")).toContain("media.limit(7)");
  });

  it("sends the token on the query string, which is the documented form", async () => {
    const { adapter, urls } = configured(discoveryBody([reel("a", 600_000)]));
    await adapter.latestShorts(QUERY);
    expect(new URL(urls[0] as string).searchParams.get("access_token")).toBe(TOKEN);
  });

  it("RETURNS EVERY ROW WITH A NULL DURATION. ALWAYS.", async () => {
    // THE TEST THIS FILE EXISTS FOR. Instagram media has no duration field, so
    // there is nothing to read one from. Any code that starts inventing a
    // number here — a default, a guess from media_product_type, a zero —
    // breaks this and should.
    const { adapter } = configured(discoveryBody([reel("a", 600_000), reel("b", 5_000_000)]));
    const rows = await adapter.latestShorts(QUERY);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.duration_seconds).toBeNull();
  });

  it("maps the fields Meta documents onto the record", async () => {
    const { adapter } = configured(
      discoveryBody([
        reel("Cxyz", 900_000, {
          caption: "a caption",
          like_count: 1234,
          comments_count: 56,
          timestamp: "2026-09-01T08:00:00+0000",
          username: "someone",
          thumbnail_url: "https://cdn.test/thumb.jpg",
        }),
      ]),
    );
    const [row] = await adapter.latestShorts(QUERY);
    expect(row).toMatchObject({
      platform: "instagram",
      platform_video_id: "Cxyz",
      url: "https://www.instagram.com/reel/Cxyz/",
      title: "a caption",
      creator_handle: "someone",
      creator_id: "17841401441775531",
      creator_url: "https://www.instagram.com/someone/",
      view_count: 900_000,
      like_count: 1234,
      comment_count: 56,
      published_at: "2026-09-01T08:00:00+0000",
      thumbnail_url: "https://cdn.test/thumb.jpg",
      duration_seconds: null,
    });
    expect(row?.discovered_by).toMatch(/business-discovery/);
  });

  it("drops anything that is not published to the REELS surface", async () => {
    // A feed photo is not a candidate for a shorts list under any reading. This
    // is a SURFACE filter and it is not a duration proxy — see the next test.
    const { adapter } = configured(
      discoveryBody([
        reel("a", 900_000),
        { id: "b", permalink: "https://x/", media_product_type: "FEED", view_count: 9_000_000 },
      ]),
    );
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["a"]);
  });

  it("does not let the REELS filter stand in for the duration ceiling", async () => {
    // media_product_type is documented as "Surface where the media is
    // published". A surface is not a length. If somebody ever "fixes" the null
    // duration by setting it from this field, this is the guard.
    const { adapter } = configured(discoveryBody([reel("a", 900_000)]));
    const [row] = await adapter.latestShorts({ ...QUERY, maxDurationSeconds: 120 });
    expect(row?.duration_seconds).toBeNull();
  });

  it("applies the view threshold, which is the one half of the promise it CAN answer", async () => {
    const { adapter } = configured(discoveryBody([reel("under", 499_999), reel("over", 500_000)]));
    const rows = await adapter.latestShorts(QUERY);
    // 500,000 exactly is kept: `minViews` is a minimum and a minimum is inclusive.
    expect(rows.map((r) => r.platform_video_id)).toEqual(["over"]);
  });

  it("drops a Reel whose view count is missing rather than treating it as zero or as passing", async () => {
    const { adapter } = configured(discoveryBody([reel("known", 900_000), reel("unknown", undefined)]));
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["known"]);
  });

  it("returns a genuinely empty list when the creator posted no Reels", async () => {
    // The one case where `[]` is honest: the call worked and there was nothing.
    const { adapter } = configured(discoveryBody([]));
    await expect(adapter.latestShorts(QUERY)).resolves.toEqual([]);
  });

  it("makes one call per seeded username", async () => {
    const { adapter, urls } = configured(discoveryBody([reel("a", 900_000)]), {
      seeds: ["one", "two", "three"],
    });
    await adapter.latestShorts(QUERY);
    expect(urls).toHaveLength(3);
  });
});

describe("refusing to report an unreadable answer as an empty one", () => {
  it("throws when Reels came back and not one carried a view count", async () => {
    // Standard Access instead of Advanced Access looks exactly like this: rows
    // arrive, view_count does not. Every row would then be dropped and
    // Instagram would read as quiet when it is actually unfiltered.
    const { adapter } = configured(discoveryBody([reel("a", undefined), reel("b", undefined)]));
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaUnreadableError);
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(/view_count/);
  });

  it("does not throw when at least one view count arrived", async () => {
    // The guard is about a broken shape, not about one quiet row.
    const { adapter } = configured(discoveryBody([reel("a", undefined), reel("b", 900_000)]));
    await expect(adapter.latestShorts(QUERY)).resolves.toHaveLength(1);
  });

  it("throws when the response has no business_discovery block", async () => {
    // Not a professional account, or age-gated. Either way it is not "this
    // creator has posted nothing".
    const { adapter } = configured({ id: IG_USER_ID });
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaUnreadableError);
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(/age-gated/);
  });

  it("skips a media row with no id or no permalink rather than inventing one", async () => {
    const { adapter } = configured(
      discoveryBody([
        { id: "", permalink: "https://x/", media_product_type: "REELS", view_count: 900_000 },
        reel("good", 900_000),
      ]),
    );
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["good"]);
  });
});

describe("the token never leaves the process in a message", () => {
  it("scrubs it out of a Meta error that echoed the request back", async () => {
    const stub = stubFetch(
      {
        error: {
          message: `Invalid OAuth access token for https://graph.facebook.com/${GRAPH_VERSION}/x?access_token=${TOKEN}`,
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
          fbtrace_id: "AbCdEf",
        },
      },
      { status: 400 },
    );
    const adapter = new InstagramAdapter(null, {
      igUserId: IG_USER_ID,
      seeds: ["someone"],
      token: TOKEN,
      fetchImpl: stub.impl,
    });
    const error = (await adapter.latestShorts(QUERY).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(TOKEN);
    // And it is still useful: the subcode's actionable sentence survives.
    expect(error.message).toMatch(/expired/);
    expect(error.message).toMatch(/AbCdEf/);
  });
});

describe("the call budget stops the request before it is sent", () => {
  it("throws MetaBudgetError and issues no fetch at all", async () => {
    const budget = new MetaCallBudget(1);
    const { adapter, calls } = configured(discoveryBody([reel("a", 900_000)]), {
      seeds: ["one", "two"],
      budget,
    });
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaBudgetError);
    // One call went out, the second was refused before reaching the network.
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("downloadUrl resolves on demand and never stores", () => {
  it("finds the media_url by id through the verified Business Discovery path", async () => {
    const { adapter, urls } = configured(
      discoveryBody([{ id: "Cxyz", permalink: "https://x/", media_product_type: "REELS", media_url: "https://cdn.test/v.mp4" }]),
    );
    const url = await adapter.downloadUrl({
      ...ROW,
      platform_video_id: "Cxyz",
      creator_handle: "someone",
    });
    expect(url).toBe("https://cdn.test/v.mp4");
    expect(new URL(urls[0] as string).searchParams.get("fields")).toContain("media_url");
  });

  it("returns null when the row carries no handle to look it up by", async () => {
    const { adapter, calls } = configured(discoveryBody([]));
    await expect(adapter.downloadUrl({ ...ROW, creator_handle: null })).resolves.toBeNull();
    expect(calls).not.toHaveBeenCalled();
  });

  it("THROWS when the lookup fails, because null does not mean that", async () => {
    // REVERSED 2026-09-08, and the reason is what the old null was rendered as.
    // Null on this seam means "the adapter ran and there is no file for THIS
    // row", and app/(admin)/admin/shorts/actions.ts prints exactly that: "It
    // was asked and it answered — nothing failed and nothing was refused."
    // Swallowing a Meta refusal into null therefore told the operator that
    // nothing had gone wrong, on a button that had just been refused. Same
    // correction `YouTubeAdapter.downloadUrl` records for itself; Instagram and
    // Facebook were the two that leaked past it.
    const { adapter } = configured({ error: { message: "nope", code: 100 } });
    await expect(
      adapter.downloadUrl({ ...ROW, creator_handle: "someone" }),
    ).rejects.toThrow(/Meta Graph API refused/);
  });

  it("still answers null when the lookup SUCCEEDS and the post is not in it", async () => {
    // The one meaning null keeps: a good answer that did not contain this row.
    const { adapter } = configured(discoveryBody([reel("somebody-else", 900_000)]));
    await expect(adapter.downloadUrl({ ...ROW, creator_handle: "someone" })).resolves.toBeNull();
  });

  it("refuses to resolve another platform's row", async () => {
    const { adapter } = configured(discoveryBody([]));
    await expect(
      adapter.downloadUrl({ ...ROW, platform: "youtube", creator_handle: "someone" }),
    ).rejects.toThrow(/registry/);
  });
});

describe("the third-party provider path still short-circuits everything", () => {
  const provider: ProviderClient = {
    latestShorts: async () => [ROW],
    downloadUrl: async () => "https://media.test/ig.mp4",
  };
  const adapter = new InstagramAdapter(provider);

  it("becomes available with nothing else edited", async () => {
    // Constructing it with a client is the entire drop-in, and the registry
    // still constructs it exactly that way. If this needs more, the seam rotted.
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });

  it("hands the query straight to the provider", async () => {
    await expect(adapter.latestShorts(QUERY)).resolves.toEqual([ROW]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBe("https://media.test/ig.mp4");
  });

  it("keeps its platform identity", () => {
    expect(adapter.platform).toBe("instagram");
  });

  it("says so on the card, instead of describing Meta's route", async () => {
    // THE SCREENSHOT BUG. `describe()` returned the Business Discovery
    // paragraph unconditionally, so an operator whose run had just failed
    // inside a data vendor read "via Meta's official Graph API … Nothing here
    // has been run against Meta" directly above the vendor's own error.
    expect(adapter.describe()).not.toMatch(/official Graph API/i);
    expect(adapter.describe()).toMatch(/data provider/i);
    // It may still NAME Business Discovery — retiring a limit means saying
    // which limit — but it may not present it as the route being taken.
    expect(adapter.describe()).toMatch(/META IS NOT CALLED/);
    expect(adapter.mode).toBe("vendor");
    expect(new InstagramAdapter().mode).toBe("meta");
  });

  it("refuses another platform's row BEFORE the provider is asked to pay for it", async () => {
    // The guard used to sit after the provider short-circuit, so a routing bug
    // reached a metered vendor and spent a credit finding out. TikTok's adapter
    // documents the guard running first in both modes; this is Instagram's.
    let asked = false;
    const watching = new InstagramAdapter({
      latestShorts: async () => [],
      downloadUrl: async () => {
        asked = true;
        return "https://media.test/should-not-happen.mp4";
      },
    });
    await expect(watching.downloadUrl({ ...ROW, platform: "youtube" })).rejects.toThrow(/registry/);
    expect(asked, "a misrouted row was handed to the vendor").toBe(false);
  });
});
