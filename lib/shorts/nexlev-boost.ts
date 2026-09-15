/**
 * THE NEXLEV BOOSTER — the OPTIONAL, YouTube-only accelerator on the self-grow.
 *
 * lib/shorts/grow-channels.ts adopts the creators that already performed for a
 * topic. This goes one hop further: it asks NexLev for channels SIMILAR to a
 * topic's existing YouTube channels and adopts the strong matches, broadening a
 * niche beyond what the topic's own runs have surfaced. NexLev is a YouTube
 * tool, so this touches YouTube alone; the evidence-based grow covers the rest.
 *
 * ---------------------------------------------------------------------------
 * IT IS RATIONED, BECAUSE THE QUOTA IS TINY.
 * ---------------------------------------------------------------------------
 *
 * A similar-channels call costs 20 of a ~5,000/month quota — about 250 calls a
 * MONTH. So this must never loop over every channel every run. Two brakes:
 *
 *   - SEEDED ONCE. A channel is used as a similarity seed at most once
 *     (`nexlev_seeded_at`), so total calls track how many NEW channels appear —
 *     which is slow, because new channels come from the grow loop — not how
 *     often a run fires. Once every channel has been seeded, this spends nothing.
 *   - A PER-RUN BUDGET. At most `callBudget` calls per invocation, so even a
 *     sudden pile of new channels is worked through over several runs rather than
 *     in one quota-blowing burst.
 *
 * BEST-EFFORT AND ISOLATED. A NexLev failure (a 429, a network blip) stops the
 * boost for this run and never touches the run's results or the grow loop. It
 * runs on the SCHEDULED pass only — never on the interactive button, which must
 * stay fast and must not spend a research quota on a click.
 */
import type { NexLevClient } from "../discovery/nexlev";
import type { Platform } from "../platform/types";
import { AUTO_CHANNEL_CAP } from "./grow-channels";
import type { TopicChannel, TopicChannelStore } from "./topic-channels";

/** NexLev is a YouTube tool; this booster deals with that platform alone. */
const YOUTUBE: Platform = "youtube";

/** A `UC…` channel id — the only shape NexLev takes and returns. */
const UC_ID = /^UC[0-9A-Za-z_-]{20,}$/;

/** Keep only strong matches. Below this, NexLev's lookalikes are too loose to adopt. */
export const NEXLEV_MIN_SIMILARITY = 50;

/** How many NexLev calls one scheduled pass may spend. Conservative against the quota. */
export const NEXLEV_CALLS_PER_RUN = 3;

/** The one method the booster needs, so tests can drive it with a fake. */
export interface SimilarChannelSource {
  similarChannels: NexLevClient["similarChannels"];
}

export interface BoostResult {
  /** NexLev calls spent this run (each 20 quota). */
  readonly calls: number;
  /** Channels newly adopted across all topics. */
  readonly added: number;
}

/**
 * Broaden each topic's YouTube channels with their NexLev lookalikes, within the
 * quota. Additive and capped exactly like the evidence-based grow, and it never
 * touches an existing row.
 */
export async function boostTopicChannelsWithNexlev(options: {
  readonly store: TopicChannelStore;
  readonly nexlev: SimilarChannelSource;
  readonly cap?: number;
  readonly callBudget?: number;
  readonly minSimilarity?: number;
}): Promise<BoostResult> {
  const cap = options.cap ?? AUTO_CHANNEL_CAP;
  const budget = options.callBudget ?? NEXLEV_CALLS_PER_RUN;
  const minSimilarity = options.minSimilarity ?? NEXLEV_MIN_SIMILARITY;
  if (budget <= 0) return { calls: 0, added: 0 };

  const byTopic = new Map<string, TopicChannel[]>();
  for (const channel of await options.store.listChannels()) {
    if (channel.platform !== YOUTUBE) continue;
    const list = byTopic.get(channel.topic_slug) ?? [];
    list.push(channel);
    byTopic.set(channel.topic_slug, list);
  }

  let calls = 0;
  let added = 0;

  for (const [slug, channels] of byTopic) {
    if (calls >= budget) break;

    const present = new Set(channels.map((c) => c.channel));
    let count = channels.length;
    if (count >= cap) continue; // this topic's YouTube list is already full

    // Seeds: active, UC-shaped, and NOT YET used as a similarity seed.
    const seeds = channels.filter(
      (c) => c.active && UC_ID.test(c.channel) && c.nexlev_seeded_at === null,
    );

    for (const seed of seeds) {
      if (calls >= budget || count >= cap) break;

      let similar;
      try {
        similar = await options.nexlev.similarChannels(seed.channel);
      } catch (cause) {
        // A rate limit or a failure ends NexLev for this run. The seed is left
        // UNMARKED so it is retried next time, and the grow loop is untouched.
        console.error("[nexlev] similar-channels failed; ending the boost this run:", cause);
        return { calls, added };
      }
      calls += 1;
      // Marked whether or not it yielded anything, so a barren seed is not paid
      // for twice — that is the point of the once-only brake.
      await options.store.markChannelsSeeded(slug, YOUTUBE, [seed.channel]);

      for (const match of similar) {
        if (count >= cap) break;
        if (match.similarityScore < minSimilarity) continue;
        if (!UC_ID.test(match.channelId)) continue;
        if (present.has(match.channelId)) continue;
        try {
          await options.store.addChannel({
            topicSlug: slug,
            platform: YOUTUBE,
            channel: match.channelId,
            source: "auto",
          });
          present.add(match.channelId);
          count += 1;
          added += 1;
        } catch {
          // One bad add must not stop the rest.
        }
      }
    }
  }

  return { calls, added };
}
