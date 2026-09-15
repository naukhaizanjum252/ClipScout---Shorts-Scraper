import { describe, expect, it } from "vitest";

import {
  activeChannelsByPlatform,
  MemoryTopicChannelStore,
  TopicChannelStoreError,
  type TopicChannel,
} from "@/lib/shorts/topic-channels";

/**
 * THE PER-TOPIC CHANNEL STORE, UNDER TEST.
 *
 * `MemoryTopicChannelStore` is the faithful stand-in for the Supabase one — same
 * identity `(topic_slug, platform, channel)`, same reactivate-on-re-add,
 * same deactivate-never-delete — so proving the workflow here proves it about the
 * rules the real store also keeps. SQL, paging and grants are covered separately
 * (migrations.test.ts).
 */
describe("per-topic channels", () => {
  it("attaches a channel to a topic, active, and scopes the list to that topic", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: "UC_beyonce" });
    await store.addChannel({ topicSlug: "shark-tank", platform: "youtube", channel: "UC_abc" });

    const forTopic = await store.listChannels("american-artists");
    expect(forTopic.map((c) => c.channel)).toEqual(["UC_beyonce"]);
    expect(forTopic[0]?.active).toBe(true);
    expect(forTopic[0]?.source).toBe("manual");

    expect((await store.listChannels()).length).toBe(2);
  });

  it("deactivates rather than deletes, and reactivates on re-add without resetting added_at", async () => {
    const store = new MemoryTopicChannelStore();
    const added = await store.addChannel({
      topicSlug: "american-artists",
      platform: "instagram",
      channel: "@beyonce",
      addedAt: "2026-09-01T00:00:00.000Z",
    });

    const off = await store.setChannelActive("american-artists", "instagram", "@beyonce", false, null, "2026-09-14T00:00:00.000Z");
    expect(off.active).toBe(false);
    expect(off.deactivated_at).toBe("2026-09-14T00:00:00.000Z");
    // Still present, just off — deactivate, never delete.
    expect((await store.listChannels("american-artists")).length).toBe(1);

    const back = await store.addChannel({ topicSlug: "american-artists", platform: "instagram", channel: "@beyonce" });
    expect(back.active).toBe(true);
    expect(back.deactivated_at).toBeNull();
    // The original attribution survived the round trip.
    expect(back.added_at).toBe(added.added_at);
  });

  it("records who/when auto-added rows come from, distinct from manual", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: "UC_auto", source: "auto" });
    const [row] = await store.listChannels("american-artists");
    expect(row?.source).toBe("auto");
  });

  it("refuses a blank channel or a blank topic", async () => {
    const store = new MemoryTopicChannelStore();
    await expect(
      store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: "   " }),
    ).rejects.toThrow(TopicChannelStoreError);
    await expect(
      store.addChannel({ topicSlug: "  ", platform: "youtube", channel: "UC_x" }),
    ).rejects.toThrow(TopicChannelStoreError);
  });

  it("refuses to toggle a channel that is not there, rather than silently succeeding", async () => {
    const store = new MemoryTopicChannelStore();
    await expect(
      store.setChannelActive("american-artists", "youtube", "UC_missing", false),
    ).rejects.toThrow(TopicChannelStoreError);
  });

  it("removes all of one topic's channels and leaves other topics' alone", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: "UC_a" });
    await store.addChannel({ topicSlug: "american-artists", platform: "instagram", channel: "@b" });
    await store.addChannel({ topicSlug: "shark-tank", platform: "youtube", channel: "UC_c" });

    await store.removeChannelsForTopic("american-artists");

    expect(await store.listChannels("american-artists")).toEqual([]);
    expect((await store.listChannels("shark-tank")).map((c) => c.channel)).toEqual(["UC_c"]);
  });
});

describe("activeChannelsByPlatform", () => {
  const row = (over: Partial<TopicChannel>): TopicChannel => ({
    topic_slug: "american-artists",
    platform: "youtube",
    channel: "UC_x",
    active: true,
    source: "manual",
    note: null,
    added_at: null,
    added_by: null,
    deactivated_at: null,
    deactivated_by: null,
    last_fetched_ok_at: null,
    nexlev_seeded_at: null,
    ...over,
  });

  it("folds active channels into the per-platform shape the adapters consume", () => {
    const map = activeChannelsByPlatform([
      row({ platform: "youtube", channel: "UC_a" }),
      row({ platform: "youtube", channel: "UC_b" }),
      row({ platform: "instagram", channel: "@c" }),
      row({ platform: "youtube", channel: "UC_off", active: false }),
      row({ platform: "instagram", channel: "   " }),
    ]);
    expect(map.youtube).toEqual(["UC_a", "UC_b"]);
    expect(map.instagram).toEqual(["@c"]);
    expect(map.tiktok).toEqual([]);
  });
});
