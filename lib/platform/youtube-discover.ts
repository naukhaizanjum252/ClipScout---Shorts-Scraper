/**
 * Finding YouTube channels with no seed list and no key.
 *
 * WHY THIS EXISTS — THE BOOTSTRAP DEADLOCK. Migration 11 automated the seed
 * list as "a rolling weekly top 200", ranked by `shorts_scraper.top_creators`.
 * That function ranks creators found in the `shorts` TABLE. So:
 *
 *     no seeds -> no run -> no shorts -> nothing to rank -> no seeds
 *
 * Verified against the live database on 2026-09-05: `refresh_auto_seeds()`
 * returned 0, `platform_seeds` held 0 rows, `shorts` held 0 rows, and every
 * platform on /admin/shorts read "will not run". The ranking is the right way
 * to MAINTAIN a seed list and cannot produce the first one. Erik, plainly:
 * "THIS IS SUPPOSE TO BE AUTOMATED FIX IT YOURSELF" — so the answer is not a
 * hand-written starter list in an env var, it is a discovery pass that needs
 * nobody.
 *
 * WHAT ACTUALLY WORKS, measured rather than assumed (2026-09-05, yt-dlp
 * 2026.07.04, from this machine and from the Hetzner box):
 *
 *   https://www.youtube.com/feed/trending   ERROR, redirects to the home page
 *   ytsearchN:<query>                       works, returns videos
 *   https://www.youtube.com/hashtag/<tag>   works, and is what this uses
 *
 * The hashtag feed is chosen because its flat-playlist entries already carry
 * `channel_id`, `channel`, `view_count` and `duration` — the ranking can be
 * done on the discovery response itself, with no second request per video.
 * `ytsearch` returns the same shape but is a relevance search over all of
 * YouTube; a hashtag feed is closer to "what is actually circulating as a
 * Short right now", which is the product's question.
 *
 * THIS IS DISCOVERY, NOT THE PRODUCT. It finds CHANNELS worth watching. The
 * run then reads each channel's uploads properly through `YouTubeAdapter`,
 * applies the 500,000-view threshold and the 120-second ceiling, and stores
 * what survives. Nothing here is treated as a result row: the view counts
 * below are only used to rank channels against each other, because a hashtag
 * feed's numbers are a snapshot of whatever the feed felt like returning and
 * are not the audited per-video figures the product reports.
 *
 * ONLY YOUTUBE. TikTok has no keyless equivalent — tested the same day:
 * `https://www.tiktok.com/tag/fyp` returns "No working app info is available"
 * and `entries: [null]`, `explore` is an unsupported URL, and yt-dlp's
 * tiktok:tag / :sound / :effect extractors are marked CURRENTLY BROKEN
 * upstream. TikTok therefore cannot bootstrap itself without the vendor key,
 * and `bootstrapReason` says so rather than letting it look like an oversight.
 */
import type { Platform } from "./types";
import { ytDlpJson, type YtDlpRunner } from "./ytdlp";

/**
 * Hashtags the discovery pass walks.
 *
 * Deliberately generic and English-language-agnostic where possible: these are
 * a net for "what is circulating", not an editorial choice about the client's
 * niche. Once the first run lands rows in `shorts`, migration 11's weekly top
 * 200 takes over and the list drifts toward whatever actually performs — so a
 * wrong guess here is corrected by the data within a week rather than being
 * baked in.
 */
export const DISCOVERY_HASHTAGS: readonly string[] = [
  "shorts",
  "shortsviral",
  "shortsfeed",
  "youtubeshorts",
  "viralshorts",
];

export interface DiscoveredChannel {
  /** The `UC...` id — stable, unlike a handle, which can be changed by its owner. */
  readonly channelId: string;
  /** For logs and the seeds table's label. Display only. */
  readonly channelName: string | null;
  /** Summed across the discovery sample. RANKING ONLY — see the header. */
  readonly sampledViews: number;
  /** How many of this channel's Shorts appeared in the sample. */
  readonly sampledShorts: number;
}

export interface DiscoverOptions {
  readonly hashtags?: readonly string[];
  /** Entries to pull per hashtag. */
  readonly perHashtag?: number;
  /** Channels to return, best first. */
  readonly limit?: number;
  /** The Shorts ceiling, so discovery does not rank channels on long videos. */
  readonly maxDurationSeconds?: number;
}

interface FlatEntry {
  readonly channel_id?: unknown;
  readonly channel?: unknown;
  readonly view_count?: unknown;
  readonly duration?: unknown;
}

const DEFAULTS = { perHashtag: 100, limit: 200, maxDurationSeconds: 120 } as const;

/**
 * Channels behind the Shorts currently circulating under these hashtags,
 * ranked by the views they contributed to the sample.
 *
 * A hashtag that fails does NOT fail the pass — it is skipped and the others
 * still count. One dead tag must not cost the deployment its whole seed list,
 * and a partial list is what this returns rather than an exception. A pass
 * where EVERY hashtag failed returns an empty array, and the caller decides
 * what that means; it is not silently reported as "no channels exist".
 */
export async function discoverYouTubeChannels(
  run: YtDlpRunner,
  options: DiscoverOptions = {},
): Promise<DiscoveredChannel[]> {
  const hashtags = options.hashtags ?? DISCOVERY_HASHTAGS;
  const perHashtag = options.perHashtag ?? DEFAULTS.perHashtag;
  const limit = options.limit ?? DEFAULTS.limit;
  const maxDuration = options.maxDurationSeconds ?? DEFAULTS.maxDurationSeconds;

  const tally = new Map<string, { name: string | null; views: number; count: number }>();

  for (const tag of hashtags) {
    let body: { entries?: unknown } | null;
    try {
      body = (await ytDlpJson(run, "youtube" satisfies Platform, [
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--playlist-end",
        String(perHashtag),
        `https://www.youtube.com/hashtag/${encodeURIComponent(tag)}`,
      ])) as { entries?: unknown } | null;
    } catch {
      // Skipped, not fatal. See the doc comment.
      continue;
    }

    const entries = Array.isArray(body?.entries) ? (body.entries as unknown[]) : [];
    for (const raw of entries) {
      // A flat playlist can contain literal nulls for entries it could not
      // expand — TikTok's broken tag extractor returns an array of them.
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as FlatEntry;

      const channelId = typeof entry.channel_id === "string" ? entry.channel_id.trim() : "";
      // `UC` + 22 characters. Anything else is not a channel id, and seeding a
      // malformed one would produce a run that fails on every pass.
      if (!/^UC[\w-]{22}$/.test(channelId)) continue;

      // Duration is the Shorts ceiling. An entry with no duration is KEPT —
      // absent is not "long", and the adapter re-checks it properly later —
      // but one that is definitely too long is dropped, so a channel of
      // half-hour videos cannot rank its way into a Shorts seed list.
      const duration = typeof entry.duration === "number" ? entry.duration : null;
      if (duration !== null && duration > maxDuration) continue;

      const views = typeof entry.view_count === "number" && entry.view_count > 0 ? entry.view_count : 0;
      const name = typeof entry.channel === "string" && entry.channel.trim() ? entry.channel.trim() : null;

      const seen = tally.get(channelId);
      if (seen) {
        seen.views += views;
        seen.count += 1;
        seen.name ??= name;
      } else {
        tally.set(channelId, { name, views, count: 1 });
      }
    }
  }

  return [...tally.entries()]
    .map(([channelId, v]) => ({
      channelId,
      channelName: v.name,
      sampledViews: v.views,
      sampledShorts: v.count,
    }))
    .sort(
      (a, b) =>
        b.sampledViews - a.sampledViews ||
        b.sampledShorts - a.sampledShorts ||
        a.channelId.localeCompare(b.channelId),
    )
    .slice(0, Math.max(1, limit));
}

/**
 * Why a platform cannot discover its own seeds, or null if it can.
 *
 * Exists so "TikTok has no seeds" reads as a fact about TikTok rather than as
 * something nobody got round to. Measured, not assumed — see the header.
 */
export function bootstrapReason(platform: Platform): string | null {
  switch (platform) {
    case "youtube":
      return null;
    case "tiktok":
      return (
        "TikTok cannot discover its own seeds without a key. Tested 2026-09-05 with yt-dlp " +
        "2026.07.04: https://www.tiktok.com/tag/<tag> returns `No working app info is available` " +
        "and an entries array of nulls, /explore is an unsupported URL, and yt-dlp's tiktok:tag, " +
        "tiktok:sound and tiktok:effect extractors are all marked CURRENTLY BROKEN upstream. A " +
        "ScrapeCreators key reaches TikTok; nothing keyless does."
      );
    case "instagram":
    case "facebook":
      return (
        "Meta's APIs have no discovery surface at all: Business Discovery reads accounts you " +
        "already name, and the Pages API reads Pages you administer. There is nothing to " +
        "enumerate from, with or without a key."
      );
    case "x":
      return (
        "X has no keyless path of any kind — yt-dlp has no user-timeline extractor for it — so " +
        "there is nothing to discover from until a Bearer token is configured."
      );
    default:
      return "This platform has no discovery path.";
  }
}
