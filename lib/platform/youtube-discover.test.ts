/**
 * Seed discovery — the thing that breaks the bootstrap deadlock.
 *
 * The deadlock was real and shipped: `refresh_auto_seeds` ranks creators out
 * of the `shorts` table, so with an empty database it returned 0 and every
 * platform read "will not run" forever. These tests pin the way out, and in
 * particular the failure modes that would quietly restore it — a discovery
 * pass that throws, or one that reports "no channels" when it actually could
 * not read anything, would put the deadlock straight back.
 */
import { describe, expect, it, vi } from "vitest";

import { bootstrapReason, discoverYouTubeChannels, DISCOVERY_HASHTAGS } from "./youtube-discover";

/** One flat-playlist entry as the hashtag feed really returns them. */
function entry(over: Record<string, unknown> = {}) {
  return {
    _type: "url",
    id: "abc123",
    url: "https://www.youtube.com/watch?v=abc123",
    title: "a short",
    channel_id: "UCe6n0z9UbsxYCS8P83f84tw",
    channel: "Sierra & Rhia FAM",
    view_count: 1_000,
    duration: 31,
    ...over,
  };
}

const runReturning = (entries: unknown[]) =>
  vi.fn(async () => JSON.stringify({ id: "shorts", title: "shorts", entries }));

describe("discovery finds channels with no seed list and no key", () => {
  it("returns the channel behind a short", async () => {
    const found = await discoverYouTubeChannels(runReturning([entry()]), { hashtags: ["shorts"] });
    expect(found).toEqual([
      {
        channelId: "UCe6n0z9UbsxYCS8P83f84tw",
        channelName: "Sierra & Rhia FAM",
        sampledViews: 1_000,
        sampledShorts: 1,
      },
    ]);
  });

  it("sums a channel's views across the sample and ranks by them", async () => {
    const run = runReturning([
      entry({ channel_id: "UC00000000000000000000aa", channel: "small", view_count: 10 }),
      entry({ channel_id: "UC00000000000000000000bb", channel: "big", view_count: 900 }),
      entry({ channel_id: "UC00000000000000000000aa", channel: "small", view_count: 20 }),
    ]);
    const found = await discoverYouTubeChannels(run, { hashtags: ["shorts"] });
    expect(found.map((c) => [c.channelId, c.sampledViews, c.sampledShorts])).toEqual([
      ["UC00000000000000000000bb", 900, 1],
      ["UC00000000000000000000aa", 30, 2],
    ]);
  });

  it("asks the hashtag feed, which is the endpoint that actually works", async () => {
    // Measured 2026-09-05: /feed/trending errors and redirects to the home
    // page. If someone swaps this for trending, discovery silently returns
    // nothing and the deadlock is back.
    const run = runReturning([entry()]);
    await discoverYouTubeChannels(run, { hashtags: ["viralshorts"] });
    const argv = (run.mock.calls[0] as unknown as [string[]])[0];
    expect(argv).toContain("https://www.youtube.com/hashtag/viralshorts");
    expect(argv).toContain("--flat-playlist");
  });

  it("ships a non-empty default hashtag list, so calling it with nothing still works", () => {
    expect(DISCOVERY_HASHTAGS.length).toBeGreaterThan(0);
  });
});

describe("discovery refuses to seed rubbish", () => {
  it("drops an entry with no channel id", async () => {
    const found = await discoverYouTubeChannels(runReturning([entry({ channel_id: undefined })]), {
      hashtags: ["shorts"],
    });
    expect(found).toEqual([]);
  });

  it("drops a malformed channel id rather than seeding a channel that cannot be read", async () => {
    const found = await discoverYouTubeChannels(runReturning([entry({ channel_id: "not-a-channel" })]), {
      hashtags: ["shorts"],
    });
    expect(found).toEqual([]);
  });

  it("survives the literal nulls a flat playlist puts in entries it could not expand", async () => {
    // Exactly what TikTok's broken tag extractor returns.
    const found = await discoverYouTubeChannels(runReturning([null, entry(), undefined]), {
      hashtags: ["shorts"],
    });
    expect(found).toHaveLength(1);
  });

  it("drops a video longer than the Shorts ceiling", async () => {
    const found = await discoverYouTubeChannels(runReturning([entry({ duration: 600 })]), {
      hashtags: ["shorts"],
    });
    expect(found).toEqual([]);
  });

  it("keeps an entry with NO duration, because absent is not the same as long", async () => {
    // The adapter re-checks duration properly later; discarding here would
    // throw away channels for a field the feed simply did not send.
    const found = await discoverYouTubeChannels(runReturning([entry({ duration: null })]), {
      hashtags: ["shorts"],
    });
    expect(found).toHaveLength(1);
  });
});

describe("a failing hashtag does not cost the whole pass", () => {
  it("skips the tag that threw and still returns the others", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.some((a) => a.includes("dead"))) throw new Error("extractor broke");
      return JSON.stringify({ entries: [entry()] });
    });
    const found = await discoverYouTubeChannels(run, { hashtags: ["dead", "shorts"] });
    expect(found).toHaveLength(1);
  });

  it("returns empty rather than throwing when every tag fails", async () => {
    // NEVER THROWS is the contract: the caller is a cold deployment with no
    // seeds, and an exception here would turn "found nothing" into a broken
    // page. It is the adapter's unavailableReason that explains the empty list.
    const run = vi.fn(async () => {
      throw new Error("all dead");
    });
    await expect(discoverYouTubeChannels(run, { hashtags: ["a", "b"] })).resolves.toEqual([]);
  });
});

describe("platforms that cannot bootstrap say why", () => {
  it("YouTube can, so it gives no reason", () => {
    expect(bootstrapReason("youtube")).toBeNull();
  });

  it("TikTok names the broken extractors rather than looking like an oversight", () => {
    const reason = bootstrapReason("tiktok");
    expect(reason).toMatch(/CURRENTLY BROKEN/);
    expect(reason).toMatch(/ScrapeCreators/);
  });

  it("every other platform gives a reason too", () => {
    for (const platform of ["instagram", "facebook", "x"] as const) {
      expect(bootstrapReason(platform)).toBeTruthy();
    }
  });
});
