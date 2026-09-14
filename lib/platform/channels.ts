/**
 * THE SEAM FOR "ENUMERATE THESE SPECIFIC CREATORS/CHANNELS".
 *
 * A topic can now own a set of channels (lib/shorts/topic-channels.ts), and a
 * topic run enumerates them alongside its keyword search. This is the optional
 * capability an adapter declares when it can list a *named* creator's latest
 * shorts — YouTube (a channel id/@handle), Instagram (a handle), TikTok (a
 * sec_uid). It follows the exact idiom of `TopicalAdapter` in ./topical.ts: a
 * `Symbol.for` marker so nothing claims it by accident and two module copies
 * still agree, and an `asChannelReader` test that returns null for adapters that
 * cannot do it (X and Facebook), which the caller turns into "not enumerated"
 * rather than a crash.
 *
 * WHY A CAPABILITY AND NOT A REBUILD. The obvious alternative — build a fresh
 * adapter per topic seeded with that topic's channels — creates a SECOND
 * ScrapeCreators client per topic, and two clients answering for one platform is
 * two request meters against one credit balance (see lib/platform/registry.ts).
 * So enumeration reuses the ONE adapter instance the run already built: one
 * client, one meter, one budget. That is the whole reason this is a method on
 * the existing adapter and not a re-wire.
 */
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import type { ShortRecord } from "./types";

/** The marker. `Symbol.for` so two bundler copies of this module still agree. */
export const READS_CHANNELS: unique symbol = Symbol.for("shorts-scraper.reads-channels");

/** An adapter that can list a named creator's latest shorts. */
export interface ChannelReadingAdapter extends PlatformAdapter {
  readonly [READS_CHANNELS]: true;

  /**
   * The latest shorts of these specific channels, in the platform's own terms
   * (a YouTube channel id/@handle, an Instagram handle, a TikTok sec_uid).
   *
   * SAME CONTRACT AS `latestShorts`: an adapter that finds itself unable to read
   * mid-run throws; it does not return `[]`. Rows come back UNTAGGED — the caller
   * that asked for a topic's channels is the one that labels them with the
   * topic, exactly as `providerTopicShorts` does for keyword rows.
   *
   * A channel the platform cannot address (a blank, or the wrong shape for this
   * platform) is skipped rather than thrown on, the same way `latestShorts`
   * treats an unusable seed — one bad channel must not cost the others.
   */
  latestShortsForChannels(
    channels: readonly string[],
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]>;
}

/** The capability test. Null for every adapter that cannot enumerate a creator. */
export function asChannelReader(adapter: PlatformAdapter): ChannelReadingAdapter | null {
  const candidate = adapter as Partial<ChannelReadingAdapter>;
  if (candidate[READS_CHANNELS] !== true) return null;
  if (typeof candidate.latestShortsForChannels !== "function") return null;
  return adapter as ChannelReadingAdapter;
}

/**
 * The identifier a later run could enumerate this short's creator by, or null
 * when this platform's run rows do not carry one. The per-platform fact the
 * self-grow loop (lib/shorts/grow-channels.ts) ranks on — kept HERE, behind the
 * platform seam, because "how do I address this creator again" is exactly the
 * kind of per-platform knowledge lib/platform/types.ts says must not leak into
 * the rest of the tree.
 *
 * YouTube: the `UC…` channel id (`creator_id`), or an `@handle` if that is all a
 * row carries. Instagram: the `@handle` (`creator_handle`). Everything else:
 * null — TikTok's enumerable id is a `sec_uid`, which a flat-playlist row does
 * not expose, and X/Facebook cannot be enumerated by creator at all.
 */
export function enumerableChannel(short: ShortRecord): string | null {
  if (short.platform === "youtube") {
    const id = short.creator_id?.trim();
    if (id && /^UC[0-9A-Za-z_-]{20,}$/.test(id)) return id;
    const handle = short.creator_handle?.trim();
    if (handle && handle.startsWith("@")) return handle;
    return null;
  }
  if (short.platform === "instagram") {
    const handle = short.creator_handle?.trim();
    return handle ? handle : null;
  }
  return null;
}
