/**
 * TikTok. Reachable two ways, and neither is the way anyone expects: keylessly
 * with yt-dlp from a seed of an unusual shape, or through a paid data provider
 * that can do the one thing yt-dlp cannot — browse.
 *
 * ============================================================================
 * TWO MODES, AND THIS ADAPTER SAYS WHICH ONE IT IS IN
 * ============================================================================
 *
 * VENDOR MODE — a `ProviderClient` was handed in. TikTok is the ONLY platform
 * where a third-party vendor buys genuine DISCOVERY rather than a nicer way to
 * read seeds the operator already had: a regional trending feed, keyword search
 * and hashtag search, none of which exists keylessly (see the extractor table
 * below). Everything about which endpoint, what it costs and what its fields
 * mean lives behind the seam in lib/platform/unavailable.ts; this file knows
 * only that something can answer `latestShorts`.
 *
 * YT-DLP MODE — no provider. The keyless path below, over creators the operator
 * named by sec_uid. It still works, it still costs nothing, and it is NOT
 * removed when a vendor appears: a key that expires must not take TikTok with
 * it.
 *
 * `mode` and `describe()` both say which one is live, because the two answer
 * different questions — "what is trending in the US" versus "what did these
 * three creators post" — and an operator who cannot tell them apart cannot
 * tell whether the tool answered the question they asked.
 *
 * SCAR, 2026-09-04. Until this round `TikTokAdapter` took an options object as
 * its FIRST AND ONLY argument and had no provider slot at all, so
 * lib/platform/registry.ts could not hand it a client even once one existed.
 * That is why registry.ts narrowed `providers` to "instagram" | "facebook":
 * `providers: { tiktok: client }` compiled, type-checked and was silently
 * thrown away. The constructor now matches `InstagramAdapter` and
 * `FacebookAdapter` exactly — provider first and positional, configuration
 * second — so the wiring is a compile error to omit rather than a silence.
 *
 * WHAT TO ASK THE VENDOR FOR IS CONFIGURATION AND IS NOT DECIDED HERE. A
 * TikTok seed is a sec_uid; a TikTok VENDOR SOURCE is a region or a keyword.
 * They are different things, one cannot be derived from the other, and this
 * file builds neither: it is handed a provider that already knows what to ask,
 * or it is handed nothing. When a vendor key exists and nobody has said what to
 * ask it for, lib/platform/registry.ts says so on the platform card in a
 * sentence naming the two environment variables that would fix it — it is the
 * object that knows a key was leased, and one gap gets exactly one explanation.
 * What must never happen, and is tested here, is that gap turning into a
 * default region (which silently decides what the operator is looking for and
 * charges a credit for it) or into an empty list (which reads as "TikTok had
 * nothing"). The keyless path below keeps running in the meantime.
 *
 * WHAT WAS CHECKED RATHER THAN ASSUMED — yt-dlp 2026.07.04, this machine, 2026-09-04
 *
 * `yt-dlp --list-extractors` lists seven TikTok extractors. THREE OF THE FOUR
 * THAT COULD DISCOVER ANYTHING ARE MARKED CURRENTLY BROKEN BY YT-DLP ITSELF:
 *
 *   TikTok                one post, by URL
 *   tiktok:user           a creator's posts            <- the only usable feed
 *   tiktok:collection     a named collection
 *   tiktok:live           a live stream
 *   tiktok:tag            (CURRENTLY BROKEN)
 *   tiktok:sound          (CURRENTLY BROKEN)
 *   tiktok:effect         (CURRENTLY BROKEN)
 *
 * There is no trending extractor and no "for you" extractor. So there is NO
 * keyless way to browse TikTok for what is popular right now. Same trade as
 * YouTube: you name the creators, or you pay a vendor.
 *
 * AND THE OBVIOUS SEED DOES NOT WORK. Run against two unrelated public
 * profiles, https://www.tiktok.com/@tiktok and https://www.tiktok.com/@khaby.lame,
 * `--flat-playlist -J --no-warnings --playlist-end 3` exited 1 both times with
 * yt-dlp's own message:
 *
 *   ERROR: [tiktok:user] tiktok: Unable to extract secondary user ID. If you are
 *   able to get the channel_id from a video posted by this user, try using
 *   "tiktokuser:channel_id" as the input URL (replacing `channel_id` with its
 *   actual value)
 *
 * Reading the extractor confirms why. `TikTokUserIE._real_extract` only skips
 * the profile-page scrape when the id matches `MS4wLjABAAAA[\w-]{64}` — a
 * sec_uid, TikTok's internal creator key. Anything else is treated as a
 * @username and goes through the profile webpage, which is the step that failed
 * above. So the seed for this adapter is a SEC_UID, not a handle, and this file
 * refuses handles with that message rather than letting a run die inside a loop.
 *
 * WHAT IS AND IS NOT VERIFIED
 *
 * VERIFIED: the extractor list, the two handle failures, and the field set — the
 * listing entries come from `_parse_aweme_video_web(..., extract_flat=True)`,
 * which yields `id`, `title`, `duration`, `view_count` (playCount), `like_count`,
 * `comment_count`, `timestamp`, `channel_id` (the sec_uid), `uploader` (the
 * @name), `channel_url`, `uploader_url` and thumbnails. That is everything a
 * `ShortRecord` needs, so no field here is a hope.
 *
 * NOT VERIFIED: that a sec_uid seed actually returns posts from this machine.
 * No sec_uid was obtainable to test with — getting one requires reading a video
 * that creator has already posted. `describe()` says so out loud. What this file
 * will NOT do is convert that uncertainty into an empty list: if the listing
 * comes back unreadable, `requireReadableCounts` throws, and if TikTok demands a
 * login yt-dlp exits non-zero and that message is what the operator sees.
 *
 * ALSO NOT VERIFIED, AND SAID HERE BECAUSE THE SEAM IS NEW: nothing in the
 * vendor path has ever been run against a live ScrapeCreators key either. See
 * the header of lib/platform/scrapecreators.ts. This adapter's vendor mode is
 * proven against a provider, not against a vendor.
 *
 * WHERE A SEC_UID COMES FROM, so the reason is actionable rather than a shrug:
 *   yt-dlp -J "https://www.tiktok.com/@someone/video/<post id>"
 * and take `channel_id` from the JSON.
 */
import type { LatestShortsQuery } from "./adapter";
import type { Platform, ShortRecord } from "./types";
import {
  providerTopicShorts,
  providerTopicUnavailableReason,
  READS_TOPICS,
  type TopicalAdapter,
} from "./topical";
import { READS_CHANNELS, type ChannelReadingAdapter } from "./channels";
import type { Topic } from "../shorts/topics";
import { PlatformUnavailableError, ProviderBackedAdapter, type ProviderClient } from "./unavailable";
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

const PLATFORM: Platform = "tiktok";

const DISCOVERED_BY = "ytdlp:tiktok-user";

/**
 * The seed shape, copied from yt-dlp's `TikTokUserIE._real_extract`:
 *
 *   if re.fullmatch(r'MS4wLjABAAAA[\w-]{64}', user_name):
 *
 * Matching it is the difference between the sec_uid path and the profile-page
 * path that is verified broken. This is a fact about TikTok living inside the
 * TikTok adapter, which is the only place a per-platform id shape may live.
 */
const SEC_UID = /^MS4wLjABAAAA[\w-]{64}$/;

/** yt-dlp's own sentence, quoted so the operator reads one explanation, not two. */
const UPSTREAM_HANDLE_FAILURE =
  'Unable to extract secondary user ID. If you are able to get the channel_id from a video ' +
  'posted by this user, try using "tiktokuser:channel_id" as the input URL';

/**
 * The keyless gaps, written once so the sentence an operator reads in an error
 * is the sentence they read on the platform card.
 */
const GAP_SEEDS =
  "No TikTok creators have been seeded. TikTok cannot be browsed keylessly — yt-dlp's " +
  "tiktok:tag, tiktok:sound and tiktok:effect extractors are all marked CURRENTLY BROKEN " +
  "upstream and there is no trending extractor — so this adapter reads creators you name. " +
  "Seed them by sec_uid (PLATFORM_SEEDS_TIKTOK), or give a data provider a region or a keyword " +
  "to browse with.";

const GAP_YTDLP =
  "`yt-dlp` is not installed or not on PATH, and without a data provider it is the only reader " +
  "TikTok has here. Install it (https://github.com/yt-dlp/yt-dlp).";

/** Which reader answered — the two are answering different questions. */
export type TikTokMode = "vendor" | "yt-dlp";

export interface TikTokAdapterOptions {
  /**
   * Creators to read KEYLESSLY, as sec_uids (`MS4wLjABAAAA...`, 76 characters).
   * NOT @handles — see the file header for why, and for how to get one.
   *
   * THESE ARE NOT VENDOR SOURCES. A vendor is asked for a region or a keyword;
   * a sec_uid means nothing to it. The two lists are separate on purpose and
   * neither is derived from the other.
   */
  readonly seeds?: readonly string[];
  readonly run?: YtDlpRunner;
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export class TikTokAdapter extends ProviderBackedAdapter implements TopicalAdapter, ChannelReadingAdapter {
  readonly platform: Platform = PLATFORM;

  private readonly seeds: readonly string[];
  /** The seeds that are sec_uids. The only list the keyless path walks. */
  private readonly usable: readonly string[];
  /** The seeds that are not. Named in the refusal, never silently dropped. */
  private readonly unusable: readonly string[];
  private readonly run: YtDlpRunner;
  private readonly now: () => Date;
  /** Cached: null once probed and fine, or the sentence saying why not. */
  private unavailableProbe: Promise<string | null> | null = null;

  /**
   * Provider first and positional, configuration second — the same shape as
   * `InstagramAdapter` and `FacebookAdapter`, so lib/platform/registry.ts
   * builds all three the same way and cannot forget one of them quietly.
   */
  constructor(provider: ProviderClient | null = null, options: TikTokAdapterOptions = {}) {
    super(provider);
    this.seeds = (options.seeds ?? []).map((s) => s.trim()).filter(Boolean);
    // The same split, for the same reason, as YouTube's: see the scar in
    // lib/platform/youtube.ts. One unusable seed is one platform's row, not the
    // whole platform.
    this.usable = this.seeds.filter((seed) => SEC_UID.test(seed));
    this.unusable = this.seeds.filter((seed) => !SEC_UID.test(seed));
    this.run = options.run ?? makeYtDlpRunner(options.binary, options.timeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Which reader will answer. Not cosmetic: "the US trending feed" and "these
   * three creators' recent posts" are different questions, and a run report
   * that does not say which one was asked cannot be checked by anybody.
   */
  get mode(): TikTokMode {
    return this.provider ? "vendor" : "yt-dlp";
  }

  describe(): string {
    if (this.mode === "vendor") {
      return (
        "TikTok, through a third-party data provider — the one platform where paying for a vendor " +
        "buys real discovery rather than a nicer way to read seeds you already had: a regional " +
        "trending feed, keyword search and hashtag search, none of which exists keylessly. " +
        "yt-dlp's tag, sound and effect extractors are all marked broken upstream and it has no " +
        "trending extractor at all. The provider is metered and billed per request, so what this " +
        "asks for is the operator's configuration and never a default. Nothing on this path has " +
        "been run against a live vendor key."
      );
    }

    return (
      "TikTok. Reads a named creator's recent posts with yt-dlp — no key, no quota. It cannot " +
      "browse TikTok for what is trending: yt-dlp's tag, sound and effect extractors are all " +
      "marked broken upstream and there is no trending extractor at all. It also cannot take an " +
      "@handle: verified on 2026-09-04, yt-dlp cannot turn a handle into the internal creator id " +
      "it needs, so each creator must be seeded by sec_uid. That path has not been proven on this " +
      "machine, because getting a sec_uid needs one of that creator's posts to read first." +
      // Said out loud rather than quietly dropped, the same as YouTube's.
      (this.unusable.length > 0 && this.usable.length > 0
        ? ` ${this.unusable.length} of ${this.seeds.length} seeded values are not sec_uids and ` +
          `are being skipped: ${this.unusable.map((x) => JSON.stringify(x)).join(", ")}.`
        : "")
    );
  }

  /**
   * What is missing, in a sentence the operator can act on.
   *
   * A PROVIDER IS ENOUGH ON ITS OWN. With one, no seed and no yt-dlp are
   * required: the vendor browses TikTok without either, which is the whole
   * reason for paying it.
   *
   * WHY THERE IS NO "you have a key and have not said what to ask it" GAP HERE.
   * That state is real and it is reported — by lib/platform/registry.ts, which
   * is the object that knows a key was leased and that the environment named no
   * region and no keyword. This adapter is handed a provider or it is not, and
   * inventing a second, differently-worded explanation of one gap is how a
   * person concludes a tool is lying to them.
   */
  override async unavailableReason(): Promise<string | null> {
    if (this.provider) return null;

    if (this.seeds.length === 0) return GAP_SEEDS;

    // ONLY WHEN NOT ONE OF THEM IS USABLE. A handle among sec_uids is a row
    // that cannot be read; it is not a reason to stop reading the ones that can.
    if (this.usable.length === 0) {
      return (
        `These TikTok seeds are not sec_uids: ${this.unusable.map((s) => JSON.stringify(s)).join(", ")}. ` +
        "yt-dlp cannot start from an @handle — run against two public profiles on 2026-09-04 it " +
        `failed both times with: "${UPSTREAM_HANDLE_FAILURE}". A sec_uid looks like ` +
        "MS4wLjABAAAA followed by 64 more characters; get one with " +
        '`yt-dlp -J "https://www.tiktok.com/@someone/video/<post id>"` and take `channel_id`.'
      );
    }

    // The runner's OWN words rather than GAP_YTDLP's fixed sentence, which
    // assumed a missing local binary and was wrong once a remote runner existed.
    return await this.ytDlpUnavailable();
  }

  /** Nothing at all is configured: no provider, no seeds. */
  protected missing(): string {
    return GAP_SEEDS;
  }

  // --------------------------------------------------------------- by subject

  /**
   * This adapter can be pointed at a topic. See lib/platform/topical.ts.
   *
   * ONLY THROUGH THE PROVIDER. There is no keyless subject search for TikTok,
   * so with no key this declares the capability and then refuses in a sentence
   * naming the key — which is the right way round: "no key" and "this platform
   * cannot be searched by anybody" are different facts, and Facebook is the one
   * that means the second.
   */
  readonly [READS_TOPICS] = true as const;

  async topicUnavailableReason(topic: Topic): Promise<string | null> {
    return await providerTopicUnavailableReason(PLATFORM, this.provider, topic);
  }

  async latestShortsForTopic(topic: Topic, query: LatestShortsQuery): Promise<ShortRecord[]> {
    return await providerTopicShorts(PLATFORM, this.provider, topic, query);
  }

  /**
   * The latest shorts, from whichever reader is live.
   *
   * WITH A PROVIDER this delegates whole. It does not filter, re-sort or
   * second-guess the rows: a metered vendor's drop tally is the receipt for
   * what was paid for, and lib/shorts/run.ts is the one place that keeps it.
   *
   * WITHOUT ONE, a seeded creator's recent posts, filtered to Shorts over the
   * threshold. Every TikTok post is under the Shorts ceiling in practice, but
   * the ceiling is applied anyway and from the same config as every other
   * platform. A filter that is skipped "because it never matters here" is a
   * filter that is wrong the day TikTok raises its own length limit, which it
   * has done twice.
   */
  override async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    if (this.provider) return this.provider.latestShorts(query);

    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    return this.walkUsers(this.usable, query);
  }

  /** This adapter can enumerate a named creator (by sec_uid). See lib/platform/channels.ts. */
  readonly [READS_CHANNELS] = true as const;

  /**
   * The latest shorts of a topic's own TikTok creators, by sec_uid, through
   * yt-dlp — ALWAYS the keyless path, even when a ScrapeCreators provider is
   * configured, because that vendor sells TikTok keyword/region search but no
   * creator enumeration. Unusable values (not a sec_uid) are dropped and an
   * empty list returns [] rather than failing; yt-dlp itself still has to be
   * reachable, which surfaces as a throw the caller reports.
   */
  async latestShortsForChannels(
    channels: readonly string[],
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]> {
    const usable = channels.map((c) => c.trim()).filter(Boolean).filter((c) => SEC_UID.test(c));
    if (usable.length === 0) return [];
    const ytdlp = await this.ytDlpUnavailable();
    if (ytdlp) throw new PlatformUnavailableError(PLATFORM, ytdlp);
    return this.walkUsers(usable, query);
  }

  /**
   * The yt-dlp `tiktokuser:` walk over a given list of sec_uids — the shared body
   * of the no-provider `latestShorts` and `latestShortsForChannels`.
   */
  private async walkUsers(
    seeds: readonly string[],
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new YtDlpError(PLATFORM, `limit must be a positive integer, got ${query.limit}`);
    }

    const discoveredAt = this.now().toISOString();
    const kept: ShortRecord[] = [];

    for (const seed of seeds) {
      const body = (await ytDlpJson(this.run, PLATFORM, [
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--playlist-end",
        String(query.limit),
        `tiktokuser:${seed}`,
      ])) as FlatPlaylist;

      const records = shortsFromFlatPlaylist({
        platform: PLATFORM,
        playlist: body ?? {},
        discoveredBy: DISCOVERED_BY,
        discoveredAt,
        // TikTok's @name is `uploader`; `uploader_id` is a numeric author id.
        // The other way round from YouTube — see FlatToShortsOptions.
        handleFields: ["uploader", "uploader_id"],
      });

      requireReadableCounts(PLATFORM, entryCount(body ?? {}), records, `tiktokuser:${seed}`);

      for (const record of records) {
        if (matchesQuery(record, query)) kept.push(record);
      }
    }

    return kept;
  }

  /**
   * A media URL, from the provider when there is one and from yt-dlp otherwise.
   *
   * THE PLATFORM GUARD RUNS FIRST IN BOTH MODES. A row from another platform
   * arriving here is a routing bug in the caller, not a missing file, and it is
   * told so rather than being handed back a null it would read as "no download
   * available". Same mechanism and the same warning as YouTube on the keyless
   * side: signed, short-lived, never stored — and, keyless, a yt-dlp refusal is
   * thrown carrying yt-dlp's own words rather than flattened into a null the
   * page would read as "TikTok media is not something this can do".
   */
  override async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== PLATFORM) {
      throw new YtDlpError(
        PLATFORM,
        `asked for a ${short.platform} download URL. Each adapter resolves only its own platform's ` +
          "media; routing by platform is lib/platform/registry.ts's job.",
      );
    }
    if (this.provider) return this.provider.downloadUrl(short);
    return await resolveMediaUrl(this.run, PLATFORM, short.url);
  }

  private async ytDlpUnavailable(): Promise<string | null> {
    this.unavailableProbe ??= ytDlpUnavailableReason(this.run);
    return this.unavailableProbe;
  }
}
