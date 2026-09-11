/**
 * YouTube. The one platform that provably works today.
 *
 * WHICH URL IT READS, AND WHY THAT WAS A REAL DECISION
 *
 * "Get latest shorts" needs, per video, a DURATION and a VIEW COUNT: duration
 * because it is the only thing that defines a Short, views because 500,000 is
 * the threshold Erik named. There are three ways to get a listing out of
 * YouTube and only one of them carries both.
 *
 *   1. The /shorts TAB — https://www.youtube.com/@handle/shorts
 *      Definitionally Shorts, and it carries NO DURATION. Recorded, not
 *      remembered: fixtures/ytdlp-shorts-tab-3.json, pulled from this machine on
 *      2026-09-04, has `id`, `title`, `view_count` and `url` on every entry and
 *      no `duration` key at all. This repo's rule is that a null duration is not
 *      a Short and must never be filed as one, so a listing that cannot state a
 *      duration cannot produce a row. The tab is REJECTED, and the fixture is
 *      kept as the evidence for why.
 *
 *   2. The UPLOADS PLAYLIST — https://www.youtube.com/playlist?list=UU...
 *      Carries `duration` AND `view_count` on every entry:
 *      fixtures/ytdlp-uploads-137.json, 137 of 137. It also carries the
 *      channel's long videos, which the <=120s ceiling then removes — and that
 *      is the right way round, because the ceiling is doing the defining rather
 *      than YouTube's own idea of what a Short is. This is what the adapter
 *      reads. `UC` -> `UU` is derived, not fetched (lib/yt/channel-ref.ts).
 *
 *   3. `search.list` on the Data API. NOT USED, for three independent reasons,
 *      any one of which would be enough on its own.
 *
 *      IT DOES NOT SELECT SHORTS. `videoDuration=short` means "under four
 *      minutes", not "under 120 seconds". It would hand back long videos this
 *      repo would have to filter out anyway, so it buys no filtering at all.
 *
 *      IT DOES NOT BROWSE. It still needs a `q` or a `channelId`, so it is not
 *      the feed-of-everything that would justify reaching for it.
 *
 *      IT IS RATIONED. `search.list` costs 1 unit, the same as every other
 *      operation here, but it draws on a bucket of its own limited to 100 CALLS
 *      a day — a hard ceiling that spending from the 10,000-unit pool cannot
 *      raise (Google's quota-cost table,
 *      https://developers.google.com/youtube/v3/determine_quota_cost, fetched
 *      2026-09-04). Against a keyless yt-dlp walk with no ceiling at all, that
 *      is 100 shots a day traded for a filter that does not filter the right
 *      thing. Google's own `search.list` reference separately advises against
 *      using it to fetch a channel's recent uploads.
 *
 * SO IT NEEDS SEEDS, AND IT SAYS SO
 *
 * There is no feed of "every latest Short on YouTube" behind any of the three.
 * Rather than pretend to browse the platform, this adapter takes a seed list of
 * channels and says in `describe()` and `unavailableReason()` that it does.
 * That is the same trade `tf/channels.py` states in one line — you pick the
 * channels instead of browsing all of Twitch — and it is honest about being a
 * trade.
 *
 * THE OPTIONAL KEY
 *
 * The keyless walk cannot see publish dates, likes or comments; 137 of 137
 * recorded entries carry `timestamp: null`. When an operator credential exists,
 * the rows that survive the filter are hydrated with `videos.list` at 1 declared
 * unit per 50 videos — the POOLED operation, drawing on the 10,000-unit daily
 * allowance shared by everything except `search.list`, and never `search.list`
 * itself, whose 100-calls-a-day bucket is not something a hydration pass should
 * ever be allowed to touch — and their `discovered_by` says so. Without a key
 * the adapter still runs and those three fields stay null, which is the truth
 * rather than a degradation.
 */
import {
  BYTES_PER_LISTING_WALK_ESTIMATE,
  bandwidthUsdMicros,
} from "../config";
import { METERS_ITS_OWN_SPEND, type SpendForecast } from "../shorts/run";
import { maxPageSize } from "../yt/cost";
import type { YouTubeClient } from "../yt/client";
import { parseDurationSeconds } from "../yt/duration";
import { isChannelId, parseChannelRef, uploadsPlaylistId } from "../yt/channel-ref";
import type { LatestShortsQuery } from "./adapter";
import { READS_TOPICS, type TopicalAdapter } from "./topical";
import { cleanTerms, youtubeSearchTerm, type Topic } from "../shorts/topics";
import type { Platform, ShortRecord } from "./types";
import { PlatformUnavailableError } from "./unavailable";
import {
  entryCount,
  makeYtDlpRunner,
  matchesQuery,
  resolveMediaUrl,
  requireReadableCounts,
  shortsFromFlatPlaylist,
  ytDlpJson,
  ytDlpUnavailableReason,
  YtDlpError,
  type FlatPlaylist,
  type YtDlpRunner,
} from "./ytdlp";

const PLATFORM: Platform = "youtube";

/** Provenance written onto every row this adapter produces. */
const DISCOVERED_BY = "ytdlp:youtube-uploads-playlist";
/** Suffix added when a row's counts were refreshed from the Data API. */
const HYDRATED_SUFFIX = "+videos.list";
/** Provenance for rows a TOPIC search produced, so the two paths are never confused. */
const TOPIC_DISCOVERED_BY = "ytdlp:youtube-search";

export interface YouTubeAdapterOptions {
  /**
   * Channels to read. `UC...` ids, `@handles`, bare handles or channel URLs —
   * whatever an operator pastes. Anything that is not already a `UC...` costs
   * one extra yt-dlp call to resolve, once per run.
   */
  readonly seeds?: readonly string[];
  /** Injected in tests so nothing spawns. */
  readonly run?: YtDlpRunner;
  readonly binary?: string;
  readonly timeoutMs?: number;
  /**
   * An operator's Data API client, when one exists. Used ONLY to hydrate rows
   * that already survived the filter, at 1 unit per 50. Null is a supported,
   * normal state — the adapter's main path needs no key.
   */
  readonly client?: YouTubeClient | null;
  /** Injected so `discovered_at` is not clock-dependent under test. */
  readonly now?: () => Date;
}

interface VideoResource {
  id?: string;
  snippet?: { publishedAt?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export class YouTubeAdapter implements TopicalAdapter {
  readonly platform = PLATFORM;

  /**
   * IT COSTS MONEY NOW, AND IT DID NOT USED TO.
   *
   * This adapter's whole pitch was "keyless, no quota, no billing", and the
   * estimate panel said in as many words that YouTube "does not report what a
   * run costs". That was true while the reads went out from the machine
   * running them. It stopped being true on 2026-09-08, when YouTube began
   * refusing this deployment's address and every read started going through a
   * proxy that bills by the gigabyte.
   *
   * A platform that spends and reports nothing is the exact failure
   * lib/shorts/run.ts carries a scar for: "$0.00 is a floor, not a total" is
   * what a screen says when it has no idea, and an operator reads it as free.
   */
  readonly [METERS_ITS_OWN_SPEND] = true as const;

  /**
   * EVERY SEED HANDED IN, kept whole for reporting. `usable` is what this
   * adapter actually reads; `unusable` is what it refuses and names.
   */
  private readonly seeds: readonly string[];
  /** The seeds `parseChannelRef` accepts. The only list `latestShorts` walks. */
  private readonly usable: readonly string[];
  /** The seeds it does not. Named in `describe()`, never silently dropped. */
  private readonly unusable: readonly string[];
  private readonly run: YtDlpRunner;
  private readonly client: YouTubeClient | null;
  private readonly now: () => Date;
  /** Seed -> channel id, for this adapter's lifetime. One resolve per run, not per call. */
  private readonly resolved = new Map<string, string>();
  /** Cached: null once probed and fine, or the sentence saying why not. */
  private unavailableProbe: Promise<string | null> | null = null;

  constructor(options: YouTubeAdapterOptions = {}) {
    this.seeds = (options.seeds ?? []).map((s) => s.trim()).filter(Boolean);
    // SORTED ONCE, HERE, so `unavailableReason`, `describe` and `latestShorts`
    // cannot disagree about which seeds this adapter is reading.
    this.usable = this.seeds.filter((seed) => parses(seed));
    this.unusable = this.seeds.filter((seed) => !parses(seed));
    this.run = options.run ?? makeYtDlpRunner(options.binary, options.timeoutMs);
    this.client = options.client ?? null;
    this.now = options.now ?? (() => new Date());
  }

  describe(): string {
    return (
      "YouTube. Reads the newest uploads of the channels you seed, keyless, with yt-dlp — no API " +
      "key, no quota, no billing — and keeps the ones at or under the Shorts duration ceiling. " +
      "It cannot browse all of YouTube: there is no feed of every latest Short, so it needs a " +
      "seed list of channels. With an operator API key it also fills in publish dates, likes and " +
      "comments, at 1 quota unit per 50 videos." +
      // The skipped seeds are said out loud rather than quietly dropped. A list
      // that silently shrinks is a list nobody ever fixes.
      (this.unusable.length > 0 && this.usable.length > 0
        ? ` ${this.unusable.length} of ${this.seeds.length} seeded values are not channel ` +
          `references and are being skipped: ${nameThem(this.unusable)}. The other ` +
          `${this.usable.length} are being read.`
        : "")
    );
  }

  async unavailableReason(): Promise<string | null> {
    if (this.seeds.length === 0) {
      return (
        "No YouTube channels have been seeded. This adapter reads the newest uploads of channels " +
        "you name; neither yt-dlp nor the YouTube Data API offers a feed of every latest Short, so " +
        "there is nothing to read until at least one channel is configured. Add handles or " +
        "channel ids (PLATFORM_SEEDS_YOUTUBE, or seeds passed to the registry)."
      );
    }

    // ONE BAD SEED MUST NOT COST THE OTHER 199.
    //
    // SCAR, live database, 2026-09-05. Migration 11's `refresh_auto_seeds`
    // ranks creators out of `shorts.creator_handle`, and yt-dlp fills that
    // column with a channel's DISPLAY NAME for some rows — "Cocomelon -
    // Nursery Rhymes", "Ian Gunther", "The BN Brothers". Four such names
    // landed in `platform_seeds` beside seventeen good handles, this branch
    // refused on the first one it saw, and /admin/shorts reported YouTube as
    // "will not run" with a working seed list sitting underneath it. The
    // migration that stopped writing them is 13; this is the half that means a
    // future bad seed costs its own row and nothing else.
    //
    // A LIST THAT IS ENTIRELY UNUSABLE STILL REFUSES, because then there is
    // nothing to read and an empty run would be a lie about YouTube.
    if (this.usable.length === 0) {
      return (
        `These YouTube seeds are not channel references: ${nameThem(this.unusable)}. ` +
        "Expected a `UC...` channel id, an @handle, or a youtube.com channel URL. Legacy `/c/` " +
        "URLs cannot be resolved — open the channel and copy its /@handle or /channel/UC... URL."
      );
    }

    // The runner's OWN words, not a guess. See `ytDlpUnavailableReason`: with a
    // remote runner configured, "not installed" was actively misleading.
    return await this.ytDlpUnavailable();
  }

  /**
   * The newest uploads of every seed, filtered to Shorts over the threshold.
   *
   * `query.limit` is spent as the SCAN DEPTH per seed — `--playlist-end N` on
   * each channel's uploads playlist — because that is where the cost is. It is
   * not a cap on the returned rows: `limit` is documented on the seam as a
   * ceiling on cost rather than a target, and truncating the merged list would
   * silently drop a 12-million-view Short from the last seed in favour of a
   * 501,000-view one from the first.
   *
   * Rows come back in each seed's own newest-first order, seeds in the order
   * they were configured. They are NOT interleaved by date, because the keyless
   * listing has no dates to interleave by — 137 of 137 recorded entries carry
   * `timestamp: null`. Ordering the one list is the caller's job and it orders
   * by views, which is what the product promises.
   */
  async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    const discoveredAt = this.now().toISOString();
    const kept: ShortRecord[] = [];
    // ONE UNREADABLE CHANNEL MUST NOT COST THE OTHER 199.
    //
    // `requireReadableCounts` throws per SEED, and this loop used to let that
    // escape, so a single bad channel failed the whole platform. That was fine
    // when a human curated a handful of seeds and is wrong now that the list is
    // discovered automatically and 200 long: measured 2026-09-05, some uploads
    // playlists return view counts under --flat-playlist and some return none
    // for the same yt-dlp and the same flags — "Goodland Short" gave zero while
    // MrBeast gave three out of three.
    //
    // The honesty rule is kept exactly, only at the right granularity: an
    // unreadable channel is still never counted as an empty one. It is skipped
    // and remembered, and if EVERY seed was unreadable the platform still
    // fails, because that is a broken extractor rather than a quiet week.
    const unreadable: string[] = [];

    for (const seed of this.usable) {
      const channelId = await this.channelId(seed);
      const playlist = uploadsPlaylistId(channelId);
      const body = (await ytDlpJson(this.run, PLATFORM, [
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--playlist-end",
        String(scanDepth(query.limit)),
        `https://www.youtube.com/playlist?list=${playlist}`,
      ])) as FlatPlaylist;

      const records = shortsFromFlatPlaylist({
        platform: PLATFORM,
        playlist: body ?? {},
        discoveredBy: DISCOVERED_BY,
        discoveredAt,
      });

      try {
        requireReadableCounts(PLATFORM, entryCount(body ?? {}), records, `uploads playlist ${playlist}`);
      } catch (cause) {
        unreadable.push(cause instanceof Error ? cause.message : String(cause));
        continue;
      }

      for (const record of records) {
        if (matchesQuery(record, query)) kept.push(record);
      }
    }

    // Every single seed came back unreadable. That is the extractor breaking,
    // not YouTube having a quiet week, and it must not arrive as an empty list.
    if (this.usable.length > 0 && unreadable.length === this.usable.length) {
      throw new YtDlpError(
        PLATFORM,
        `all ${this.usable.length} readable seed(s) came back unreadable. First: ${unreadable[0]}`,
      );
    }

    return this.client ? await this.hydrate(kept) : kept;
  }

  /**
   * What this run will pull through the proxy, before it pulls any of it.
   *
   * IT DOES NOT ASK ANYBODY. There is no cheap endpoint to consult here the way
   * X has `/2/tweets/counts/recent`; the cost is bandwidth, and bandwidth is
   * arithmetic over a measured figure — about 2.1MB per seed's listing walk,
   * measured through the live gateway. So this is a forecast in the honest
   * sense: a number derived from a measurement, not a quote from a vendor.
   *
   * A READ IS NOT WHAT COSTS. The note says so, every time, because the figure
   * this returns is small enough to be reassuring and the download that follows
   * is ten times a whole run. An operator who reads "about $0.02" and presses
   * Export all links on two hundred rows should not be surprised by the bill.
   */
  async forecastSpend(): Promise<SpendForecast> {
    const bytes = this.usable.length * BYTES_PER_LISTING_WALK_ESTIMATE;
    const megabytes = Math.round(bytes / 1_000_000);
    const seeds = `${this.usable.length} seed${this.usable.length === 1 ? "" : "s"}`;
    const usdMicros = bandwidthUsdMicros(bytes);

    const cost =
      usdMicros === null
        ? "and this deployment has not said what its proxy costs, so there is no figure to " +
          "put on it — set YTDLP_PROXY_USD_PER_GB"
        : "at this deployment's configured rate";

    return {
      usdMicros,
      note:
        `About ${megabytes}MB of proxy traffic — ${seeds} at roughly 2.1MB a listing walk, ` +
        `measured 2026-09-08 — ${cost}. Reading is the cheap half: a FILE is about 19MB, ` +
        "and it is spent when somebody presses Download rather than when the run is made.",
    };
  }

  // --------------------------------------------------------------- by subject

  /**
   * This adapter can be pointed at a topic. See lib/platform/topical.ts.
   *
   * `as const` so the type is the literal `true` the `TopicalAdapter` interface
   * demands, rather than the widened `boolean` a bare initialiser would give.
   */
  readonly [READS_TOPICS] = true as const;

  /**
   * Why a topic cannot be searched for, or null.
   *
   * NOTE WHAT IS NOT CHECKED HERE: seeds. A topical read does not use them and
   * must not require them, and that is not a shortcut — it is the point. The
   * untargeted read needs a seed list because there is no feed of every latest
   * Short (see this file's header); a SEARCH needs only the words. So a
   * deployment with zero seeds, which `unavailableReason()` correctly refuses,
   * can still run every topic. Requiring seeds here would have reproduced the
   * bootstrap deadlock that lib/platform/youtube-discover.ts exists to break.
   */
  async topicUnavailableReason(topic: Topic): Promise<string | null> {
    if (cleanTerms(topic.terms).length === 0) {
      return (
        `The topic ${JSON.stringify(topic.name)} has no search terms, so there is nothing to ask ` +
        "YouTube for. Add at least one term — the words a person would type to find this kind of " +
        "clip."
      );
    }
    return await this.ytDlpUnavailable();
  }

  /**
   * Shorts about one subject, found by searching rather than by seed.
   *
   * ONE SEARCH PER TERM, results unioned and de-duplicated by video id. Terms
   * overlap by design — "shark tank" and "shark tank pitch" return many of the
   * same videos — and a union that counted them twice would report a topic as
   * twice the size it is.
   *
   * `query.limit` is spent as SEARCH DEPTH per term, the same convention as the
   * seeded read spends it as scan depth per seed: it is a ceiling on cost, not
   * a target for rows returned. It needs to be generous here, and the reason is
   * measured rather than guessed — see the yield table in lib/shorts/topics.ts.
   * A hundred entries pulled for "shark tank #shorts" contained thirteen Shorts
   * and three that also cleared 500,000 views. A search depth of 50 against a
   * narrow topic will routinely and legitimately return nothing.
   *
   * THE ROWS ARE FULLY-FORMED RESULTS, unlike the ones in
   * lib/platform/youtube-discover.ts, which are ranking material only. The
   * difference is what the numbers are used for: discovery sums a feed's view
   * counts to compare channels, this filters each video against the product's
   * own threshold. Every entry carries `duration` and `view_count`, so the
   * filter is applied to a stated number and never to an assumption — and the
   * `channel_id` on every entry is a `UC...` id, which is exactly what
   * migration 13's `seed_from_short` can address. A topic run therefore also
   * feeds the weekly seed ranking, for free, as a side effect of doing its job.
   */
  async latestShortsForTopic(topic: Topic, query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.topicUnavailableReason(topic);
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    const terms = cleanTerms(topic.terms);
    const depth = scanDepth(query.limit);
    const discoveredAt = this.now().toISOString();
    const kept: ShortRecord[] = [];
    const seen = new Set<string>();
    // ONE UNREADABLE SEARCH MUST NOT COST THE OTHER TERMS — the same rule the
    // seeded read applies per seed, and for the same reason.
    const unreadable: string[] = [];

    for (const term of terms) {
      const search = `ytsearch${depth}:${youtubeSearchTerm(term)}`;
      const body = (await ytDlpJson(this.run, PLATFORM, [
        "--flat-playlist",
        "-J",
        "--no-warnings",
        search,
      ])) as FlatPlaylist;

      const records = shortsFromFlatPlaylist({
        platform: PLATFORM,
        playlist: body ?? {},
        discoveredBy: TOPIC_DISCOVERED_BY,
        discoveredAt,
        topicSlug: topic.slug,
      });

      try {
        requireReadableCounts(
          PLATFORM,
          entryCount(body ?? {}),
          records,
          `search for ${JSON.stringify(youtubeSearchTerm(term))}`,
        );
      } catch (cause) {
        unreadable.push(cause instanceof Error ? cause.message : String(cause));
        continue;
      }

      for (const record of records) {
        if (!matchesQuery(record, query)) continue;
        if (seen.has(record.platform_video_id)) continue;
        seen.add(record.platform_video_id);
        kept.push(record);
      }
    }

    // Every term came back unreadable: the extractor is broken, not the topic
    // unpopular. An empty list here would say the wrong one.
    if (terms.length > 0 && unreadable.length === terms.length) {
      throw new YtDlpError(
        PLATFORM,
        `all ${terms.length} search(es) for ${JSON.stringify(topic.name)} came back unreadable. ` +
          `First: ${unreadable[0]}`,
      );
    }

    return this.client ? await this.hydrate(kept) : kept;
  }

  /**
   * A direct media URL for one short, resolved now and never stored.
   *
   * Six hours is what one of these lasts — measured, see `firstMediaUrl` in
   * lib/platform/ytdlp.ts.
   *
   * A REFUSAL IS THROWN, NOT FLATTENED TO NULL. This method used to swallow
   * every yt-dlp failure and hand back null, on the reasoning that a refusal
   * for one video is a fact about that video rather than about the adapter.
   * The reasoning holds; null was the wrong way to say it, because null on this
   * seam means "this adapter has no way to get you the file" and the page
   * renders it as exactly that. It is what hid "Sign in to confirm you're not a
   * bot. Use --cookies-from-browser or --cookies" behind a sentence claiming
   * YouTube media was something this adapter cannot do at all. The measurement
   * is on `resolveMediaUrl` in lib/platform/ytdlp.ts.
   */
  async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== PLATFORM) {
      throw new YtDlpError(
        PLATFORM,
        `asked for a ${short.platform} download URL. Each adapter resolves only its own platform's ` +
          "media; routing by platform is lib/platform/registry.ts's job.",
      );
    }
    return await resolveMediaUrl(this.run, PLATFORM, short.url);
  }

  // ------------------------------------------------------------------ private

  private async ytDlpUnavailable(): Promise<string | null> {
    this.unavailableProbe ??= ytDlpUnavailableReason(this.run);
    return this.unavailableProbe;
  }

  /** A seed -> its `UC...` id. Free for an id, one yt-dlp call for anything else. */
  private async channelId(seed: string): Promise<string> {
    const cached = this.resolved.get(seed);
    if (cached) return cached;

    if (isChannelId(seed)) {
      this.resolved.set(seed, seed);
      return seed;
    }

    // `--playlist-end 1` because the listing is not wanted here, only the
    // channel identity attached to it. One entry is the cheapest way to get it.
    const body = (await ytDlpJson(this.run, PLATFORM, [
      "--flat-playlist",
      "-J",
      "--no-warnings",
      "--playlist-end",
      "1",
      channelUrl(seed),
    ])) as FlatPlaylist;

    const id = typeof body?.channel_id === "string" ? body.channel_id.trim() : "";
    if (!isChannelId(id)) {
      throw new YtDlpError(
        PLATFORM,
        `the seed ${JSON.stringify(seed)} did not resolve to a channel — yt-dlp returned no usable ` +
          "`channel_id`. Check the handle exists and is spelled as YouTube spells it.",
      );
    }
    this.resolved.set(seed, id);
    return id;
  }

  /**
   * Fill in what the keyless listing cannot see, using the pooled operation.
   *
   * 1 declared unit per 50 videos (`videos.list`), charged through the client's
   * budget before each request goes out. It draws on the shared 10,000-unit
   * daily allowance, never on the separate 100-call `search.list` bucket, which
   * is the whole reason hydration is affordable at all: a pass over rows we
   * already have must not compete with discovery for a rationed endpoint.
   * If the budget runs out mid-way the walk
   * STOPS and the remaining rows keep their keyless values — nulls where the
   * source did not say. A partially hydrated list is honest; inventing the
   * missing halves would not be.
   */
  private async hydrate(records: readonly ShortRecord[]): Promise<ShortRecord[]> {
    const client = this.client;
    if (!client || records.length === 0) return [...records];

    const batch = maxPageSize("videos.list");
    const byId = new Map<string, VideoResource>();
    for (let i = 0; i < records.length; i += batch) {
      if (!client.canAfford("videos.list")) break;
      const slice = records.slice(i, i + batch);
      const body = await client.call<{ items?: VideoResource[] }>("videos.list", {
        part: "snippet,contentDetails,statistics",
        id: slice.map((r) => r.platform_video_id).join(","),
        maxResults: batch,
      });
      for (const item of body.items ?? []) {
        if (item.id) byId.set(item.id, item);
      }
    }

    return records.map((record) => {
      const item = byId.get(record.platform_video_id);
      if (!item) return record;
      return {
        ...record,
        duration_seconds: durationOf(item) ?? record.duration_seconds,
        view_count: countOf(item.statistics?.viewCount) ?? record.view_count,
        like_count: countOf(item.statistics?.likeCount) ?? record.like_count,
        comment_count: countOf(item.statistics?.commentCount) ?? record.comment_count,
        published_at: item.snippet?.publishedAt ?? record.published_at,
        discovered_by: `${record.discovered_by}${HYDRATED_SUFFIX}`,
      };
    });
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Which public URL identifies a channel.
 *
 * Handles and ids only, moved here verbatim from the old lib/source/ytdlp.ts.
 * It deliberately does not fall back to a search: a search fallback turns a
 * free named lookup into a guess at a broad one, and on the API side it spends
 * one of the day's 100 `search.list` calls each time — a ration in its own
 * bucket, which no amount of leftover unit budget can buy back.
 */
export function channelUrl(reference: string): string {
  const ref = reference.trim();
  if (isChannelId(ref)) return `https://www.youtube.com/channel/${ref}`;
  if (/^https?:\/\//i.test(ref)) return ref;
  const handle = ref.startsWith("@") ? ref : `@${ref}`;
  return `https://www.youtube.com/${handle}`;
}

/**
 * Does this seed name a channel at all? Pure, so `unavailableReason()` can
 * report a typo without spawning anything or touching the network.
 */
/** The seeds, quoted, for a sentence a person has to act on. */
function nameThem(seeds: readonly string[]): string {
  return seeds.map((s) => JSON.stringify(s)).join(", ");
}

export function parses(seed: string): boolean {
  try {
    parseChannelRef(seed);
    return true;
  } catch {
    return false;
  }
}

function scanDepth(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new YtDlpError(PLATFORM, `limit must be a positive integer, got ${limit}`);
  }
  return limit;
}

function durationOf(item: VideoResource): number | null {
  const raw = item.contentDetails?.duration;
  if (!raw) return null;
  try {
    const parsed = parseDurationSeconds(raw);
    // `P0D` is a live broadcast with no known end. Zero is not a duration.
    return parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function countOf(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : null;
}
