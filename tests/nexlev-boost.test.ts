import { describe, expect, it, vi } from "vitest";

import type { SimilarChannel } from "@/lib/discovery/nexlev";
import { boostTopicChannelsWithNexlev } from "@/lib/shorts/nexlev-boost";
import { MemoryTopicChannelStore } from "@/lib/shorts/topic-channels";

/**
 * THE NEXLEV BOOSTER, UNDER TEST — the OPTIONAL accelerator on the self-grow.
 * Its two brakes (seed a channel once; a per-run call budget) are what keep it
 * inside a ~250-call/month quota, so they are what these cases pin down.
 */
const SEED = "UCseedaaaaaaaaaaaaaaaaaa";
const STRONG = "UCstrongbbbbbbbbbbbbbbbb";
const WEAK = "UCweakccccccccccccccccc";

function match(channelId: string, similarityScore: number): SimilarChannel {
  return { channelId, similarityScore, channelName: null, subscriberCount: null };
}

describe("boostTopicChannelsWithNexlev", () => {
  it("adopts the strong lookalikes of a seed and marks the seed used", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: SEED });
    const nexlev = {
      similarChannels: vi.fn(async () => [match(STRONG, 80), match(WEAK, 20)]),
    };

    const result = await boostTopicChannelsWithNexlev({ store, nexlev, minSimilarity: 50 });

    expect(nexlev.similarChannels).toHaveBeenCalledWith(SEED);
    expect(result.calls).toBe(1);
    const channels = await store.listChannels("american-artists");
    // The strong match was adopted as auto; the weak one (score 20) was not.
    expect(channels.map((c) => c.channel).sort()).toEqual([SEED, STRONG]);
    expect(channels.find((c) => c.channel === STRONG)?.source).toBe("auto");
    // The seed is marked, so a second run does not spend on it again.
    expect(channels.find((c) => c.channel === SEED)?.nexlev_seeded_at).not.toBeNull();
  });

  it("never re-seeds a channel it has already used", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: SEED });
    // No matches, so nothing new is adopted to become a future seed — which
    // isolates the "seed once" brake: after the first run there is nothing left
    // to seed, so the second run spends nothing.
    const nexlev = { similarChannels: vi.fn(async (): Promise<SimilarChannel[]> => []) };

    await boostTopicChannelsWithNexlev({ store, nexlev });
    const second = await boostTopicChannelsWithNexlev({ store, nexlev });

    expect(nexlev.similarChannels).toHaveBeenCalledTimes(1);
    expect(second.calls).toBe(0);
  });

  it("lets an adopted channel become a future seed, so a niche keeps expanding", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "american-artists", platform: "youtube", channel: SEED });
    const nexlev = {
      similarChannels: vi.fn(async (id: string): Promise<SimilarChannel[]> =>
        id === SEED ? [match(STRONG, 90)] : [],
      ),
    };

    await boostTopicChannelsWithNexlev({ store, nexlev }); // seeds SEED, adopts STRONG
    await boostTopicChannelsWithNexlev({ store, nexlev }); // now seeds the adopted STRONG

    expect(nexlev.similarChannels.mock.calls.map((c) => c[0])).toEqual([SEED, STRONG]);
  });

  it("respects the per-run call budget across topics", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "a", platform: "youtube", channel: SEED });
    await store.addChannel({ topicSlug: "b", platform: "youtube", channel: STRONG });
    const nexlev = { similarChannels: vi.fn(async () => []) };

    const result = await boostTopicChannelsWithNexlev({ store, nexlev, callBudget: 1 });

    expect(result.calls).toBe(1);
    expect(nexlev.similarChannels).toHaveBeenCalledTimes(1);
  });

  it("only seeds from UC-shaped, active channels — not @handles or off ones", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "a", platform: "youtube", channel: "@ahandle" });
    await store.addChannel({ topicSlug: "a", platform: "youtube", channel: STRONG });
    await store.setChannelActive("a", "youtube", STRONG, false);
    const nexlev = { similarChannels: vi.fn(async () => []) };

    const result = await boostTopicChannelsWithNexlev({ store, nexlev });

    // @handle isn't a NexLev channelId and STRONG is switched off — neither seeds.
    expect(nexlev.similarChannels).not.toHaveBeenCalled();
    expect(result.calls).toBe(0);
  });

  it("stops on a NexLev failure and leaves the seed unmarked for a retry", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "a", platform: "youtube", channel: SEED });
    const nexlev = {
      similarChannels: vi.fn(async () => {
        throw new Error("429 rate limited");
      }),
    };

    const result = await boostTopicChannelsWithNexlev({ store, nexlev });

    expect(result).toEqual({ calls: 0, added: 0 });
    const [row] = await store.listChannels("a");
    expect(row?.nexlev_seeded_at).toBeNull(); // unmarked, so it retries next time
  });

  it("ignores non-YouTube channels entirely", async () => {
    const store = new MemoryTopicChannelStore();
    await store.addChannel({ topicSlug: "a", platform: "instagram", channel: "@someone" });
    const nexlev = { similarChannels: vi.fn(async () => []) };

    await boostTopicChannelsWithNexlev({ store, nexlev });
    expect(nexlev.similarChannels).not.toHaveBeenCalled();
  });
});
