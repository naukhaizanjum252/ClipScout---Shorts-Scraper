/**
 * The Facebook adapter, which now really does call Meta — and still cannot
 * serve the product.
 *
 * Two failures are being guarded against here and they pull in opposite
 * directions. The first is the old one: returning `[]` when the platform could
 * not be read, so "we have no way in" appears on screen as "Facebook was quiet
 * today". The second is new and arrives with the official API: returning rows
 * that were never view-checked or length-checked as though they had cleared
 * 500,000 views and 120 seconds. Nothing readable through the Graph API carries
 * either number, so every row comes back with both null — and these tests are
 * what stop somebody filling them in later from a number that was measured
 * locally at 408 against a badge reading 9.8K.
 *
 * NONE OF THIS TOUCHES META. There is no token on this machine; `fetch` is
 * replaced throughout.
 */
import { describe, expect, it, vi } from "vitest";

import type { LatestShortsQuery } from "./adapter";
import { FacebookAdapter } from "./facebook";
import { GRAPH_VERSION, MetaBudgetError, MetaCallBudget, MetaUnreadableError } from "./meta-client";
import type { ShortRecord } from "./types";
import { PlatformUnavailableError, type ProviderClient } from "./unavailable";

const QUERY: LatestShortsQuery = { limit: 20, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

const TOKEN = "EAAG-not-a-real-page-token-0000";
const PAGE_ID = "1234567890";

const ROW: ShortRecord = {
  platform: "facebook",
  platform_video_id: "1234567890_999",
  url: "https://www.facebook.com/1234567890/posts/999",
  title: null,
  creator_handle: null,
  creator_id: null,
  creator_url: null,
  duration_seconds: 35,
  view_count: 1_500_000,
  like_count: null,
  comment_count: null,
  published_at: null,
  thumbnail_url: null,
  discovered_at: "2026-09-04T12:00:00.000Z",
  discovered_by: "provider",

  topic_slug: null,
};

function videoPost(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    created_time: "2026-09-01T08:00:00+0000",
    message: "a message",
    permalink_url: `https://www.facebook.com/${PAGE_ID}/posts/${id}`,
    from: { id: PAGE_ID, name: "A Page" },
    attachments: { data: [{ media_type: "video", type: "video_autoplay", title: "an attachment title" }] },
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
  return { impl, urls, calls: impl as unknown as ReturnType<typeof vi.fn> };
}

function configured(bodies: unknown[], over: Record<string, unknown> = {}) {
  const stub = stubFetch(bodies);
  const adapter = new FacebookAdapter(null, {
    seeds: [PAGE_ID],
    token: TOKEN,
    fetchImpl: stub.impl,
    now: () => new Date("2026-09-04T12:00:00.000Z"),
    ...over,
  });
  return { adapter, ...stub };
}

describe("nothing configured — the refusal is itself the finding", () => {
  const adapter = new FacebookAdapter();

  it("names both missing pieces", async () => {
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/Meta Page access token/);
    expect(reason).toMatch(/PLATFORM_SEEDS_FACEBOOK/);
  });

  it("records that BOTH video edges refuse reads for everyone, not just for strangers", async () => {
    // The finding that makes this platform hopeless through the official API,
    // and the one most likely to be re-litigated. /{page-id}/videos and
    // /{page-id}/video_reels both answer "You can't perform this operation on
    // this endpoint" for reads — including for a Page's own admin.
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/video_reels/);
    expect(reason).toMatch(/can't perform this operation/);
    expect(reason).toMatch(/Reels cannot be read through the official API at all/);
  });

  it("says the readable feed only ever shows Pages the operator administers", async () => {
    // A refusal that does not address the obvious alternative gets overruled by
    // the first person who thinks of it.
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/administers/);
  });

  it("closes off the Meta Content Library rather than leaving it to be suggested", async () => {
    // Academic and non-profit only. This business is ineligible, and applying
    // through somebody who is not would be a false representation.
    expect(await adapter.unavailableReason()).toMatch(/Content Library/);
    expect(await adapter.unavailableReason()).toMatch(/ineligible/);
  });

  it("says out loud that nothing here has been run against Meta", async () => {
    expect(await adapter.unavailableReason()).toMatch(/has been run against Meta/);
    expect(adapter.describe()).toMatch(/has been run against Meta/);
  });

  it("carries the measured view-count scar into what an operator reads", async () => {
    // 408 reported against a badge reading 9.8K, measured 2026-09-04. A number
    // that can be wrong by that much may not be compared to a 500,000 threshold.
    expect(adapter.describe()).toMatch(/9\.8K/);
    expect(adapter.describe()).toMatch(/408/);
  });

  it("THROWS from latestShorts instead of returning an empty list", async () => {
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("carries the same sentence into the error as into the UI", async () => {
    const reason = (await adapter.unavailableReason()) as string;
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(reason);
  });

  it("THROWS from downloadUrl, because nothing here produced a row to resolve", async () => {
    await expect(adapter.downloadUrl(ROW)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });
});

describe("partly configured", () => {
  it("does not list the token as missing when one is present", async () => {
    const adapter = new FacebookAdapter(null, { token: TOKEN });
    const reason = (await adapter.unavailableReason()) as string;
    expect(reason).toMatch(/PLATFORM_SEEDS_FACEBOOK/);
    expect(reason).not.toMatch(/save one on \/admin\/credentials/);
  });

  it("treats a lease that yields null as no token", async () => {
    const adapter = new FacebookAdapter(null, { token: async () => null, seeds: [PAGE_ID] });
    expect(await adapter.unavailableReason()).toMatch(/Meta Page access token/);
  });

  it("becomes available with a token and a seeded page", async () => {
    const { adapter } = configured([{ data: [] }]);
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });
});

describe("the readable path: a Page's own post feed", () => {
  it("reads /{page-id}/posts at the pinned version", async () => {
    // NOT /videos and NOT /video_reels — both refuse reads. If somebody
    // "upgrades" this to the obvious edge, it will 400 in production and this
    // test is the note explaining why.
    const { adapter, urls } = configured([{ data: [videoPost("p1")] }]);
    await adapter.latestShorts(QUERY);
    expect(urls[0]).toContain(`/${GRAPH_VERSION}/${PAGE_ID}/posts?`);
    expect(urls[0]).not.toContain("/videos");
    expect(urls[0]).not.toContain("video_reels");
  });

  it("asks for attachments, which is the only way to tell a video post from a photo", async () => {
    const { adapter, urls } = configured([{ data: [videoPost("p1")] }]);
    await adapter.latestShorts(QUERY);
    const fields = new URL(urls[0] as string).searchParams.get("fields") as string;
    expect(fields).toContain("attachments");
    expect(fields).toContain("permalink_url");
  });

  it("clamps the page size to the 100 Meta documents for this edge", async () => {
    // Asking for more is not an error that says so — it is a silently smaller
    // page, which would look like a Page that posts less than it does.
    const { adapter, urls } = configured([{ data: [] }]);
    await adapter.latestShorts({ ...QUERY, limit: 500 });
    expect(new URL(urls[0] as string).searchParams.get("limit")).toBe("100");
  });

  it("passes a smaller limit through unchanged", async () => {
    const { adapter, urls } = configured([{ data: [] }]);
    await adapter.latestShorts({ ...QUERY, limit: 5 });
    expect(new URL(urls[0] as string).searchParams.get("limit")).toBe("5");
  });

  it("RETURNS EVERY ROW WITH A NULL VIEW COUNT AND A NULL DURATION. ALWAYS.", async () => {
    // Nothing on the Post, StoryAttachment or Video nodes carries either
    // number. Any code that starts filling them in — from a scrape, from an
    // insights call, from a guess — breaks this, and should have to argue with
    // the 408-against-9.8K measurement in the file header first.
    const { adapter } = configured([{ data: [videoPost("p1"), videoPost("p2")] }]);
    const rows = await adapter.latestShorts(QUERY);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.view_count).toBeNull();
      expect(row.duration_seconds).toBeNull();
    }
  });

  it("hands the rows back rather than filtering them away to nothing", async () => {
    // The tempting "tidy" version applies the view and duration filters here,
    // returns [], and Facebook reads as quiet. It never had a chance to be
    // anything else. Returning the rows is what lets the run report say
    // "returned 2, kept 0, unknown duration 2".
    const { adapter } = configured([{ data: [videoPost("p1"), videoPost("p2")] }]);
    await expect(adapter.latestShorts(QUERY)).resolves.toHaveLength(2);
  });

  it("maps the documented post fields onto the record", async () => {
    const { adapter } = configured([{ data: [videoPost("1234567890_999")] }]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row).toMatchObject({
      platform: "facebook",
      platform_video_id: "1234567890_999",
      url: `https://www.facebook.com/${PAGE_ID}/posts/1234567890_999`,
      title: "an attachment title",
      creator_handle: "A Page",
      creator_id: PAGE_ID,
      published_at: "2026-09-01T08:00:00+0000",
    });
    expect(row?.discovered_by).toMatch(/facebook-page-posts/);
  });

  it("falls back to the post message when the attachment has no title", async () => {
    const { adapter } = configured([
      { data: [videoPost("p1", { attachments: { data: [{ media_type: "video" }] } })] },
    ]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row?.title).toBe("a message");
  });

  it("keeps a photo post out of a shorts list", async () => {
    const { adapter } = configured([
      {
        data: [
          videoPost("video"),
          videoPost("photo", { attachments: { data: [{ media_type: "photo", type: "photo" }] } }),
        ],
      },
    ]);
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["video"]);
  });

  it("matches a video type it has never seen, because Meta's list ends in 'etc'", async () => {
    // Matching too narrowly loses posts silently. Matching too widely is
    // harmless here: a stray row carries a null duration and is dropped
    // downstream anyway.
    const { adapter } = configured([
      { data: [videoPost("p1", { attachments: { data: [{ type: "video_inline_something_new" }] } })] },
    ]);
    await expect(adapter.latestShorts(QUERY)).resolves.toHaveLength(1);
  });

  it("skips a post with no permalink and no attachment URL to fall back on", async () => {
    const { adapter } = configured([
      {
        data: [
          videoPost("p1", { permalink_url: undefined }),
          videoPost("p2"),
        ],
      },
    ]);
    const rows = await adapter.latestShorts(QUERY);
    expect(rows.map((r) => r.platform_video_id)).toEqual(["p2"]);
  });

  it("uses the attachment's unshimmed URL when the post has no permalink", async () => {
    const { adapter } = configured([
      {
        data: [
          videoPost("p1", {
            permalink_url: undefined,
            attachments: { data: [{ media_type: "video", unshimmed_url: "https://fb.test/reel/1" }] },
          }),
        ],
      },
    ]);
    const [row] = await adapter.latestShorts(QUERY);
    expect(row?.url).toBe("https://fb.test/reel/1");
  });

  it("returns a genuinely empty list when the Page has posted nothing", async () => {
    const { adapter } = configured([{ data: [] }]);
    await expect(adapter.latestShorts(QUERY)).resolves.toEqual([]);
  });

  it("makes one call per seeded page", async () => {
    const { adapter, urls } = configured([{ data: [] }], { seeds: ["a", "b"] });
    await adapter.latestShorts(QUERY);
    expect(urls).toHaveLength(2);
  });
});

describe("refusing to report an unreadable answer as an empty one", () => {
  it("throws when posts arrived and not one carried an attachments field", async () => {
    // Meta documents that video posts on this edge require admin status, so
    // this shape is far more likely to be a token without the Page role than a
    // Page that has never posted media. Those must not look the same.
    const { adapter } = configured([{ data: [{ id: "p1", permalink_url: "https://x/" }] }]);
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaUnreadableError);
    await expect(adapter.latestShorts(QUERY)).rejects.toThrow(/admin status/);
  });

  it("does not throw when at least one post carried attachments", async () => {
    const { adapter } = configured([
      { data: [{ id: "p1", permalink_url: "https://x/" }, videoPost("p2")] },
    ]);
    await expect(adapter.latestShorts(QUERY)).resolves.toHaveLength(1);
  });

  it("turns a Meta error envelope into an actionable sentence", async () => {
    const stub = stubFetch(
      [
        {
          error: {
            // Echoing the request back is what Meta actually does, and it is
            // the only way this assertion about the token is worth anything.
            message: `denied for ?access_token=${TOKEN}`,
            type: "OAuthException",
            code: 190,
            error_subcode: 492,
            fbtrace_id: "Zz9",
          },
        },
      ],
      { status: 400 },
    );
    const adapter = new FacebookAdapter(null, { seeds: [PAGE_ID], token: TOKEN, fetchImpl: stub.impl });
    const error = (await adapter.latestShorts(QUERY).catch((e: unknown) => e)) as Error;
    // Subcode 492 is "the user does not have the required role on this Page" —
    // the single most likely failure for this adapter, and the one where a bare
    // "OAuthException" would send somebody to regenerate a perfectly good token.
    expect(error.message).toMatch(/role on this Page/);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("the call budget stops the request before it is sent", () => {
  it("throws MetaBudgetError and issues no further fetch", async () => {
    const budget = new MetaCallBudget(1);
    const { adapter, calls } = configured([{ data: [] }], { seeds: ["a", "b"], budget });
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaBudgetError);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("shares one budget between adapters when one is handed in", async () => {
    // Two adapters with their own budgets can together spend 400 calls an hour
    // against one app's allowance. This is the shape that prevents it.
    const budget = new MetaCallBudget(1);
    const first = configured([{ data: [] }], { budget });
    const second = configured([{ data: [] }], { budget });
    await first.adapter.latestShorts(QUERY);
    await expect(second.adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(MetaBudgetError);
  });
});

describe("downloadUrl resolves on demand and never stores", () => {
  it("walks post -> attachment target -> video source, both documented fields", async () => {
    const { adapter, urls } = configured([
      { attachments: { data: [{ target: { id: "vid-77" } }] } },
      { source: "https://video.test/raw.mp4" },
    ]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBe("https://video.test/raw.mp4");
    expect(urls[0]).toContain(`/${ROW.platform_video_id}?`);
    expect(urls[1]).toContain("/vid-77?");
    expect(new URL(urls[1] as string).searchParams.get("fields")).toBe("source");
  });

  it("returns null when the attachment has no target id", async () => {
    const { adapter, calls } = configured([{ attachments: { data: [{}] } }]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBeNull();
    // And does not go on to ask for a video it does not have an id for.
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("THROWS when Meta refuses, because null does not mean that", async () => {
    // REVERSED 2026-09-08 — see the matching test in instagram.test.ts. Null is
    // rendered on /admin/shorts as "nothing failed and nothing was refused",
    // which is precisely the wrong sentence for a Page token that has just been
    // refused for want of pages_read_engagement.
    const { adapter } = configured([{ error: { message: "nope", code: 100 } }]);
    await expect(adapter.downloadUrl(ROW)).rejects.toThrow(/Meta Graph API refused/);
  });

  it("refuses to resolve another platform's row", async () => {
    const { adapter } = configured([{ data: [] }]);
    await expect(adapter.downloadUrl({ ...ROW, platform: "tiktok" })).rejects.toThrow(/registry/);
  });
});

describe("the third-party provider path still short-circuits everything", () => {
  const provider: ProviderClient = {
    latestShorts: async () => [ROW],
    downloadUrl: async () => "https://media.test/fb.mp4",
  };
  const adapter = new FacebookAdapter(provider);

  it("becomes available with nothing else edited", async () => {
    await expect(adapter.unavailableReason()).resolves.toBeNull();
    await expect(adapter.latestShorts(QUERY)).resolves.toEqual([ROW]);
    await expect(adapter.downloadUrl(ROW)).resolves.toBe("https://media.test/fb.mp4");
  });

  it("keeps its platform identity", () => {
    expect(adapter.platform).toBe("facebook");
  });

  it("says so on the card, instead of describing Meta's route", async () => {
    // The same defect Instagram carried: the card claimed the official Graph
    // API, and claimed Facebook could "only ever show you Pages you
    // administer", while the read that happened went to a vendor and asked for
    // public page URLs.
    expect(adapter.describe()).not.toMatch(/official Graph API/i);
    expect(adapter.describe()).not.toMatch(/Pages you administer/i);
    expect(adapter.describe()).toMatch(/data provider/i);
    expect(adapter.mode).toBe("vendor");
    expect(new FacebookAdapter().mode).toBe("meta");
  });

  it("keeps the view-count caveat in BOTH modes, because it is about Facebook", async () => {
    // The measurement — a badge reading 9.8K against a reported 408 — is a fact
    // about Facebook's own numbers and survives the change of route.
    expect(adapter.describe()).toMatch(/9\.8K/);
    expect(adapter.describe()).toMatch(/408/);
    expect(new FacebookAdapter().describe()).toMatch(/9\.8K/);
  });

  it("refuses another platform's row BEFORE the provider is asked to pay for it", async () => {
    let asked = false;
    const watching = new FacebookAdapter({
      latestShorts: async () => [],
      downloadUrl: async () => {
        asked = true;
        return "https://media.test/should-not-happen.mp4";
      },
    });
    await expect(watching.downloadUrl({ ...ROW, platform: "tiktok" })).rejects.toThrow(/registry/);
    expect(asked, "a misrouted row was handed to the vendor").toBe(false);
  });
});
