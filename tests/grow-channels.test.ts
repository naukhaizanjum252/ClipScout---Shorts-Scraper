import { describe, expect, it } from "vitest";

import type { Platform, ShortRecord } from "@/lib/platform/types";
import { enumerableChannel } from "@/lib/platform/channels";
import { growTopicChannels } from "@/lib/shorts/grow-channels";
import { MemoryTopicChannelStore } from "@/lib/shorts/topic-channels";

/**
 * THE SELF-GROW LOOP, UNDER TEST.
 *
 * It adopts the creators that performed for a topic into that topic's channel
 * list — additively, capped, and without ever touching a row the operator
 * already has.
 */
const UC = "UCabcdefghijklmnopqrstuv"; // a well-formed YouTube channel id
const UC2 = "UCzyxwvutsrqponmlkjihgfe";

function short(over: Partial<ShortRecord> & Pick<ShortRecord, "platform" | "platform_video_id">): ShortRecord {
  return {
    platform: over.platform,
    platform_video_id: over.platform_video_id,
    url: `https://example.test/${over.platform}/${over.platform_video_id}`,
    title: "clip",
    creator_handle: over.creator_handle ?? null,
    creator_id: over.creator_id ?? null,
    creator_url: null,
    duration_seconds: over.duration_seconds ?? 30,
    view_count: over.view_count ?? 900_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-14T00:00:00.000Z",
    discovered_by: "test",
    topic_slug: over.topic_slug === undefined ? "american-artists" : over.topic_slug,
  };
}

describe("enumerableChannel", () => {
  it("uses the UC id for YouTube and the handle for Instagram, and nothing else", () => {
    expect(enumerableChannel(short({ platform: "youtube", platform_video_id: "y", creator_id: UC }))).toBe(UC);
    expect(
      enumerableChannel(short({ platform: "instagram", platform_video_id: "i", creator_handle: "@beyonce" })),
    ).toBe("@beyonce");
    // TikTok's creator id is a numeric uploader id, not a sec_uid — not enumerable.
    expect(
      enumerableChannel(short({ platform: "tiktok", platform_video_id: "t", creator_id: "6754760670083138566" })),
    ).toBeNull();
  });
});

describe("growTopicChannels", () => {
  it("adopts the performing creators as auto channels, grouped by topic and platform", async () => {
    const store = new MemoryTopicChannelStore();
    await growTopicChannels({
      store,
      shorts: [
        short({ platform: "youtube", platform_video_id: "y1", creator_id: UC, view_count: 2_000_000 }),
        short({ platform: "instagram", platform_video_id: "i1", creator_handle: "@beyonce", view_count: 1_500_000 }),
        // TikTok yields no enumerable id, so nothing is adopted for it.
        short({ platform: "tiktok", platform_video_id: "t1", creator_id: "123", view_count: 3_000_000 }),
      ],
    });

    const channels = await store.listChannels("american-artists");
    expect(channels.map((c) => `${c.platform}:${c.channel}`).sort()).toEqual([
      `instagram:@beyonce`,
      `youtube:${UC}`,
    ]);
    expect(channels.every((c) => c.source === "auto")).toBe(true);
    expect(channels.every((c) => c.active)).toBe(true);
  });

  it("respects the per-platform cap, keeping the highest-view creators", async () => {
    const store = new MemoryTopicChannelStore();
    await growTopicChannels({
      store,
      cap: 1,
      shorts: [
        short({ platform: "youtube", platform_video_id: "lo", creator_id: UC, view_count: 600_000 }),
        short({ platform: "youtube", platform_video_id: "hi", creator_id: UC2, view_count: 9_000_000 }),
      ],
    });

    const yt = (await store.listChannels("american-artists")).filter((c) => c.platform === "youtube");
    expect(yt).toHaveLength(1);
    expect(yt[0]?.channel).toBe(UC2); // the higher-view one won the single slot
  });

  it("never touches an existing channel — a switched-off one stays off", async () => {
    const store = new MemoryTopicChannelStore();
    // Operator added this by hand, then switched it off.
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: UC });
    await store.setChannelActive("american-artists", "youtube", UC, false);

    await growTopicChannels({
      store,
      shorts: [short({ platform: "youtube", platform_video_id: "y1", creator_id: UC, view_count: 5_000_000 })],
    });

    const [row] = await store.listChannels("american-artists");
    // Still one row, still off, still manual — the grow did not reactivate it.
    expect(row?.active).toBe(false);
    expect(row?.source).toBe("manual");
  });

  it("ignores rows with no topic", async () => {
    const store = new MemoryTopicChannelStore();
    await growTopicChannels({
      store,
      shorts: [short({ platform: "youtube", platform_video_id: "y1", creator_id: UC, topic_slug: null })],
    });
    expect(await store.listChannels()).toHaveLength(0);
  });

  it("counts an existing channel toward the cap so it does not overfill", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: UC });

    await growTopicChannels({
      store,
      cap: 1,
      shorts: [short({ platform: "youtube", platform_video_id: "y1", creator_id: UC2, view_count: 9_000_000 })],
    });

    // The cap is 1 and one already existed, so the new performer is not added.
    const yt = (await store.listChannels("american-artists")).filter((c) => c.platform === "youtube");
    expect(yt).toHaveLength(1);
    expect(yt[0]?.channel).toBe(UC);
  });
});
