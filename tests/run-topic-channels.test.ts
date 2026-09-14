import { describe, expect, it } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "@/lib/platform/adapter";
import type { Platform, ShortRecord } from "@/lib/platform/types";
import { READS_CHANNELS, type ChannelReadingAdapter } from "@/lib/platform/channels";
import { READS_TOPICS, type TopicalAdapter } from "@/lib/platform/topical";
import { MemoryShortsStore } from "@/lib/shorts/memory-store";
import { getLatestShorts } from "@/lib/shorts/run";
import type { Topic } from "@/lib/shorts/topics";

/**
 * A TOPIC RUN SEARCHES ITS OWN CHANNELS, TOO — UNDER TEST.
 *
 * The wiring under test: `runTopics` calls a topic's keyword search AND, on the
 * same adapter instance, `latestShortsForChannels` for that topic's channels,
 * labelling both with the topic. And a channel read that fails must NOT discard
 * the keyword rows the run already gathered.
 */

function aShort(over: Partial<ShortRecord> & Pick<ShortRecord, "platform" | "platform_video_id">): ShortRecord {
  return {
    platform: over.platform,
    platform_video_id: over.platform_video_id,
    url: `https://example.test/${over.platform}/${over.platform_video_id}`,
    title: over.title ?? "a clip",
    creator_handle: over.creator_handle ?? "@someone",
    creator_id: over.creator_id ?? "c1",
    creator_url: null,
    duration_seconds: over.duration_seconds ?? 30,
    view_count: over.view_count ?? 900_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-14T00:00:00.000Z",
    discovered_by: "test",
    topic_slug: over.topic_slug ?? null,
  };
}

/** A fake adapter that both searches a subject and enumerates named channels. */
class TopicChannelFake implements PlatformAdapter, TopicalAdapter, ChannelReadingAdapter {
  readonly [READS_TOPICS] = true as const;
  readonly [READS_CHANNELS] = true as const;
  readonly channelCalls: { channels: readonly string[] }[] = [];

  constructor(
    readonly platform: Platform,
    private readonly keywordRows: readonly ShortRecord[],
    private readonly channelRows: readonly ShortRecord[],
    private readonly opts: { channelThrows?: string } = {},
  ) {}

  describe(): string {
    return `fake ${this.platform}`;
  }
  async unavailableReason(): Promise<string | null> {
    return null;
  }
  async latestShorts(): Promise<ShortRecord[]> {
    return [];
  }
  async downloadUrl(): Promise<string | null> {
    return null;
  }
  async topicUnavailableReason(): Promise<string | null> {
    return null;
  }
  async latestShortsForTopic(topic: Topic): Promise<ShortRecord[]> {
    // Real topical adapters label keyword rows with the topic; the fake does too.
    return this.keywordRows.map((r) => ({ ...r, topic_slug: topic.slug }));
  }
  async latestShortsForChannels(channels: readonly string[], _query: LatestShortsQuery): Promise<ShortRecord[]> {
    void _query;
    this.channelCalls.push({ channels });
    if (this.opts.channelThrows) throw new Error(this.opts.channelThrows);
    // Returned UNTAGGED — the run is what labels them with the topic.
    return [...this.channelRows];
  }
}

const topic: Topic = {
  id: "t1",
  name: "American Artists",
  slug: "american-artists",
  terms: ["american artists"],
  active: true,
  source: "manual",
  publishesTo: null,
  note: null,
  addedAt: "2026-09-14T00:00:00.000Z",
};

const clock = () => "2026-09-14T12:00:00.000Z";

describe("a topic run enumerates the topic's channels", () => {
  it("reads the topic's channels on the same adapter and labels the rows with the topic", async () => {
    const adapter = new TopicChannelFake(
      "youtube",
      [aShort({ platform: "youtube", platform_video_id: "kw1" })],
      [aShort({ platform: "youtube", platform_video_id: "ch1" })],
    );

    const report = await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 50,
      minViews: 500_000,
      maxDurationSeconds: 120,
      platforms: ["youtube"],
      topics: [topic],
      topic: { slug: topic.slug, name: topic.name },
      topicChannels: new Map([[topic.slug, { youtube: ["UC_beyonce", "UC_rihanna"] }]]),
      now: clock,
    });

    // The adapter was asked to enumerate exactly the topic's channels.
    expect(adapter.channelCalls).toHaveLength(1);
    expect(adapter.channelCalls[0]?.channels).toEqual(["UC_beyonce", "UC_rihanna"]);

    // Both the keyword hit and the channel hit are kept, and BOTH carry the topic.
    const ids = report.shorts.map((s) => s.platform_video_id).sort();
    expect(ids).toEqual(["ch1", "kw1"]);
    for (const short of report.shorts) expect(short.topic_slug).toBe("american-artists");
  });

  it("does not enumerate channels for a topic that named none for this platform", async () => {
    const adapter = new TopicChannelFake(
      "youtube",
      [aShort({ platform: "youtube", platform_video_id: "kw1" })],
      [aShort({ platform: "youtube", platform_video_id: "ch1" })],
    );

    await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 50,
      minViews: 500_000,
      maxDurationSeconds: 120,
      platforms: ["youtube"],
      topics: [topic],
      topic: { slug: topic.slug, name: topic.name },
      // Channels only for instagram — the youtube adapter should not be asked.
      topicChannels: new Map([[topic.slug, { instagram: ["@someone"] }]]),
      now: clock,
    });

    expect(adapter.channelCalls).toHaveLength(0);
  });

  it("keeps the keyword rows when a channel read fails, and does not fail the platform", async () => {
    const adapter = new TopicChannelFake(
      "youtube",
      [aShort({ platform: "youtube", platform_video_id: "kw1" })],
      [aShort({ platform: "youtube", platform_video_id: "ch1" })],
      { channelThrows: "yt-dlp exited 1: channel listing refused" },
    );

    const report = await getLatestShorts({
      adapters: [adapter],
      store: new MemoryShortsStore(),
      limit: 50,
      minViews: 500_000,
      maxDurationSeconds: 120,
      platforms: ["youtube"],
      topics: [topic],
      topic: { slug: topic.slug, name: topic.name },
      topicChannels: new Map([[topic.slug, { youtube: ["UC_broken"] }]]),
      now: clock,
    });

    // The channel read threw, but the keyword row survives and YouTube is not "failed".
    const youtube = report.platforms.find((o) => o.platform === "youtube");
    expect(youtube?.status).toBe("ok");
    expect(report.shorts.map((s) => s.platform_video_id)).toEqual(["kw1"]);
  });
});
