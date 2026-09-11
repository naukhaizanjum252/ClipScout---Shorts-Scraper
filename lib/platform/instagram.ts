/**
 * Instagram, through Meta's OFFICIAL Graph API — and the one field that decides
 * whether this platform can ever serve the product.
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST META. There is no Meta token on
 * this machine. Every field name and limitation below was read from
 * developers.facebook.com on 2026-09-04 and each carries its page. The first
 * real token is the experiment. Nothing here may be described as working.
 *
 * ============================================================================
 * THE HOLE, STATED FIRST BECAUSE EVERYTHING ELSE FOLLOWS FROM IT
 * ============================================================================
 *
 * THERE IS NO DURATION FIELD ON INSTAGRAM MEDIA. The full readable field list
 * for the IG Media node
 * (https://developers.facebook.com/docs/instagram-platform/reference/instagram-media,
 * read 2026-09-04) is: alt_text, boost_ads_list, boost_eligibility_info,
 * caption, comments_count, copyright_check_information, id, is_ai_generated,
 * is_comment_enabled, is_shared_to_feed, legacy_instagram_media_id, like_count,
 * media_audio_type, media_product_type, media_type, media_url, owner,
 * permalink, reposts_count, saved_count, shares_count, shortcode,
 * thumbnail_url, timestamp, total_comments_count, total_like_count,
 * total_views_count, username, view_count. There is no `duration`, no `length`,
 * no `video_duration`. Not hidden behind a permission — absent.
 *
 * Duration is the ONLY thing that defines a Short (lib/platform/types.ts). So
 * the official Instagram API cannot tell this product whether a post is a
 * Short. That is a genuine product hole, it is Meta's, and it is not going to
 * be papered over here.
 *
 * WHAT THIS ADAPTER DOES ABOUT IT: it returns every qualifying row with
 * `duration_seconds: null`, always, unconditionally. It never guesses, never
 * substitutes a default and never omits the row.
 *
 * WHY NULL AND NOT A PROXY. The tempting proxy is `media_product_type ===
 * "REELS"`. It does not work, and the documentation is what says so:
 * media_product_type is defined as "Surface where the media is published. Can
 * be AD, FEED, STORY or REELS". A SURFACE IS NOT A LENGTH. Filtering on it
 * would put rows in front of a person under a heading that promises ≤120s,
 * having tested nothing about their length — which is precisely the dishonesty
 * this repo is built to refuse. (Widely-repeated third-party figures put the
 * maximum Reel well above 120 seconds. No Meta-domain source for that was found
 * on 2026-09-04, so it is not stated here as fact; it does not need to be. The
 * surface/length argument stands on the documented definition alone.)
 *
 * WHY NULL AND NOT SILENTLY DROPPING THE ROWS. Because
 * `lib/shorts/run.ts` already has exactly the right machinery: `keepReason`
 * counts a null duration as `unknownDuration`, a named line in the report that
 * is separate from `tooLong` for this reason — "the source did not say" and
 * "the source said, and it is too long" are different facts. So a run reports
 *
 *     Instagram — ran, returned 12, kept 0, unknownDuration 12
 *
 * which reads, correctly: twelve Instagram Reels cleared 500,000 views and the
 * official API cannot tell us how long any of them are. That sentence IS the
 * answer to "does the official Instagram API work for this". An empty list
 * would have said "Instagram had nothing", which is false.
 *
 * IF THAT ANSWER IS UNACCEPTABLE, the routes out are, in order of honesty:
 * resolve duration per surviving candidate from a second source keyed on the
 * permalink (few calls, since only rows past 500k need it, but it is a second
 * source with its own failure modes and it is not built here because it cannot
 * be tested); or accept Instagram rows as "long-form-unknown" with their own
 * heading in the UI, which is a product decision and Erik's to make.
 *
 * ============================================================================
 * WHAT IS BUILT: BUSINESS DISCOVERY
 * ============================================================================
 *
 * Verified shape, from
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/business-discovery
 * read 2026-09-04 — the sample request on that page, verbatim:
 *
 *   GET https://graph.facebook.com/v25.0/17841405309211844
 *     ?fields=business_discovery.username(bluebottle){followers_count,media_count,media}
 *     &access_token=<YOUR_APP_USERS_INSTAGRAM_USER_ACCESS_TOKEN>
 *
 * Note the shape: you address YOUR OWN professional account's node and ask for
 * a field expansion named after SOMEBODY ELSE'S username. So this needs two
 * pieces of configuration, not one — the operator's own IG user id, and the
 * seeded usernames to look up.
 *
 * `view_count` is the field the whole 500,000 threshold rests on, and it is
 * documented as "View count for Instagram Reels, which includes both paid and
 * organic metrics" and marked **available for Business Discovery API only**.
 * PAID AND ORGANIC TOGETHER is worth knowing: a promoted Reel's number includes
 * spend. This adapter does not adjust for it — there is no field to adjust with
 * — but a row over the threshold may be over it because somebody bought it.
 *
 * Documented limitation, verbatim: "Data about age-gated Instagram
 * professional accounts will not be returned." Also, this is per-account. There
 * is no cross-account search here; the operator names the creators.
 *
 * ============================================================================
 * WHY HASHTAG SEARCH IS NOT IMPLEMENTED AND MUST NOT BE
 * ============================================================================
 *
 * It is the obvious way to get real cross-account discovery, and it cannot
 * serve this product. Hashtag Search returns caption, children, comments_count,
 * id, like_count, media_type, media_url, permalink and timestamp — NO VIEW
 * COUNT and no duration. A 500,000-view filter cannot be applied to data with
 * no view count, so every row would be dropped and Instagram would look empty
 * while actually being unfiltered. It is additionally capped at 30 unique
 * hashtags per rolling 7 days and needs the restricted "Instagram Public
 * Content Access" feature. Written down here so nobody re-discovers it as
 * though it were an oversight.
 *
 * ============================================================================
 * ACCESS
 * ============================================================================
 *
 * Advanced Access is required to read professional accounts the operator does
 * not own or manage, Advanced Access requires App Review, and Business
 * Verification is required for all apps requesting Advanced Access
 * (developers.facebook.com, read 2026-09-04). The exact permission names for
 * this endpoint could not be confirmed on a Meta page and are therefore NOT
 * asserted anywhere in this file — the App Review flow tells the operator which
 * ones it wants, and a guessed permission name in a UI is somebody's wasted
 * afternoon.
 *
 * ============================================================================
 * THE THIRD-PARTY PATH IS STILL HERE
 * ============================================================================
 *
 * Passing a `ProviderClient` (lib/platform/unavailable.ts) still short-circuits
 * everything below and is still the drop-in for the day a data provider is
 * chosen. The official path is what runs when there is no provider and a Meta
 * credential exists. Neither has been proven; both refuse loudly when
 * unconfigured, and neither ever returns `[]` to mean "could not read".
 */
import type { LatestShortsQuery } from "./adapter";
import {
  MetaCallBudget,
  MetaUnreadableError,
  edgeRows,
  metaGet,
  resolveMetaToken,
  type MetaEdge,
  type MetaTokenSource,
} from "./meta-client";
import type { Platform, ShortRecord } from "./types";
import {
  providerTopicShorts,
  providerTopicUnavailableReason,
  READS_TOPICS,
  type TopicalAdapter,
} from "./topical";
import type { Topic } from "../shorts/topics";
import { PlatformUnavailableError, ProviderBackedAdapter, type ProviderClient } from "./unavailable";

const PLATFORM: Platform = "instagram";

const DISCOVERED_BY = "meta:instagram-business-discovery";

/**
 * The media fields asked for, as one string.
 *
 * Every name here is on the IG Media readable-field list cited in the header.
 * `duration` is not among them because it does not exist; that absence is the
 * whole point of this file and there is deliberately no commented-out line
 * pretending it is coming.
 */
const MEDIA_FIELDS = [
  "id",
  "shortcode",
  "permalink",
  "timestamp",
  "caption",
  "media_type",
  "media_product_type",
  "like_count",
  "comments_count",
  "view_count",
  "username",
  "thumbnail_url",
].join(",");

/** One media row, as Business Discovery returns it. Every field optional: Meta omits rather than nulls. */
interface IgMedia {
  readonly id?: string;
  readonly shortcode?: string;
  readonly permalink?: string;
  readonly timestamp?: string;
  readonly caption?: string;
  readonly media_type?: string;
  readonly media_product_type?: string;
  readonly like_count?: number;
  readonly comments_count?: number;
  readonly view_count?: number;
  readonly username?: string;
  readonly thumbnail_url?: string;
  readonly media_url?: string;
}

interface BusinessDiscovery {
  readonly id?: string;
  readonly username?: string;
  readonly followers_count?: number;
  readonly media_count?: number;
  readonly media?: MetaEdge<IgMedia>;
}

interface BusinessDiscoveryResponse {
  readonly business_discovery?: BusinessDiscovery;
  readonly id?: string;
}

/**
 * The three things the official path needs, as three sentences, written once.
 *
 * They are constants rather than inline strings so that `missing()` and
 * `unavailableReason()` cannot drift into two descriptions of one gap.
 */
const GAP_TOKEN = "a Meta access token (save one on /admin/credentials)";

const GAP_IG_USER_ID =
  "the operator's own Instagram professional account id — Business Discovery is a field " +
  "expansion on your own account node, so there is nothing to address without it";

const GAP_SEEDS =
  "at least one Instagram professional-account username to look up (PLATFORM_SEEDS_INSTAGRAM) — " +
  "Business Discovery is per-account and there is no cross-account search that carries view counts";

/**
 * The refusal, built from whichever gaps apply.
 *
 * It ends with the duration hole every time, deliberately. Somebody about to
 * start Business Verification and App Review to make this platform work deserves
 * to read, before they begin, that the finished result still cannot tell this
 * tool how long a Reel is.
 */
function refusal(gaps: readonly string[]): string {
  return (
    `Instagram is not configured: this build needs ${gaps.join("; and ")}. ` +
    "The route being scaffolded is Meta's official Graph API Business Discovery — there is no " +
    "keyless alternative, since yt-dlp marks its own instagram:user extractor CURRENTLY BROKEN, " +
    "and no third-party data provider has been chosen. Business Discovery needs Advanced Access, " +
    "which needs App Review and Business Verification. Be warned before spending that effort: " +
    "Instagram media carries NO duration field at all, so even a working token cannot tell this " +
    "tool whether a Reel is under the 120-second ceiling. That is a documented hole in Meta's API, " +
    "not a gap in this configuration. Nothing in this adapter has been run against Meta."
  );
}

/**
 * Which reader answered — the two are answering different questions, and under
 * different limits. Mirrors `TikTokMode` in lib/platform/tiktok.ts.
 */
export type InstagramMode = "vendor" | "meta";

export interface InstagramAdapterOptions {
  /**
   * The OPERATOR'S OWN Instagram professional account id — the node addressed
   * in the request. Not the creator being looked up. Business Discovery is a
   * field expansion on your own account, so without this there is nothing to
   * address and no request can be built.
   */
  readonly igUserId?: string | null;
  /** Instagram professional-account usernames to look up, without the leading @. */
  readonly seeds?: readonly string[];
  /** Where the Meta token comes from. A function, because a lease is async and must not be cached. */
  readonly token?: MetaTokenSource | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly version?: string;
  /** Share ONE of these with the Facebook adapter — see meta-client.ts's header. */
  readonly budget?: MetaCallBudget;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class InstagramAdapter extends ProviderBackedAdapter implements TopicalAdapter {
  readonly platform: Platform = PLATFORM;

  private readonly igUserId: string | null;
  private readonly seeds: readonly string[];
  private readonly tokenSource: MetaTokenSource | null;
  private readonly options: InstagramAdapterOptions;
  private readonly budget: MetaCallBudget;
  private readonly now: () => Date;

  /**
   * THE FIRST PARAMETER IS STILL THE THIRD-PARTY PROVIDER, POSITIONAL, AND
   * STILL DEFAULTS TO NULL. lib/platform/registry.ts constructs this as
   * `new InstagramAdapter(o.providers?.instagram ?? null)` and that call must
   * keep compiling untouched; the official-API configuration is a second,
   * optional argument the registry can start passing whenever it is wired up.
   * An adapter that forces its own caller to change on the same commit is an
   * adapter that will not land.
   */
  constructor(provider: ProviderClient | null = null, options: InstagramAdapterOptions = {}) {
    super(provider);
    this.options = options;
    this.igUserId = options.igUserId?.trim() || null;
    this.seeds = (options.seeds ?? [])
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    this.tokenSource = options.token ?? null;
    this.budget = options.budget ?? new MetaCallBudget();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Which reader will answer. The same getter, for the same reason, as
   * `TikTokAdapter.mode`: "Meta's Business Discovery over accounts you named"
   * and "a data vendor's Instagram leg" are different questions with different
   * limits, and a report that does not say which one was asked cannot be
   * checked by anybody.
   */
  get mode(): InstagramMode {
    return this.provider ? "vendor" : "meta";
  }

  /**
   * SCAR, 2026-09-08. This returned the Meta paragraph below UNCONDITIONALLY,
   * including when a `ProviderClient` had been handed in — and a provider
   * short-circuits every read method in this file, so the sentence on the
   * platform card described a route that had not been taken.
   *
   * It was seen on /admin/shorts: an Instagram card reading "via Meta's
   * official Graph API — Business Discovery … Nothing here has been run against
   * Meta", directly above a failure notice saying ScrapeCreators was out of
   * credits. Both sentences were rendered by this build, one of them was false,
   * and the false one was the one telling the operator what they were looking
   * at. `TikTokAdapter.describe()` already branched on its provider; this did
   * not, and neither did `FacebookAdapter`.
   *
   * WHAT THE VENDOR BRANCH MAY AND MAY NOT CLAIM. It may say Meta is not being
   * called, because that is this object's own doing. It may NOT promise what
   * the provider returns — this adapter is handed something that can read
   * Instagram and deliberately knows nothing else about it (see
   * lib/platform/unavailable.ts). So the vendor sentence retires the Meta
   * limits, which are provably not in force, and leaves what DID arrive to the
   * run report, which counted it.
   */
  describe(): string {
    if (this.mode === "vendor") {
      return (
        "Instagram, through a third-party data provider. META IS NOT CALLED ON THIS PATH, so none " +
        "of the official route's limits are the ones in force: Business Discovery's missing " +
        "duration field is a fact about Meta's API and says nothing about what a provider " +
        "returns, and no Meta token, no professional account id of your own and no Advanced " +
        "Access review is involved in this read. What the provider can and cannot answer is its " +
        "own business, so whether a row arrived with a length is reported per run rather than " +
        "promised here. ONE THING IS NO LONGER TAKEN AS THE PROVIDER GAVE IT, since 2026-09-08: " +
        "the keyword-search endpoint publishes no view count at all, so rows found that way carry " +
        "a view count this build computed from the like count and compared against 500,000. Those " +
        "rows can be kept and saved on an estimated number; it is marked as an estimate wherever " +
        "it is shown. Rows found by naming a creator carry the provider's real play count and are " +
        "untouched. The provider is metered and billed per request, so " +
        "what it is asked for is the operator's configuration and never a default. Nothing on " +
        "this path has been run against a live vendor key."
      );
    }

    return (
      "Instagram, via Meta's official Graph API — Business Discovery, which reads the recent " +
      "media of professional accounts you name by username. It returns view counts, and it CANNOT " +
      "return duration: Instagram media has no duration field of any kind, so the 120-second " +
      "Shorts ceiling cannot be evaluated from official data and every row comes back with an " +
      "unknown length. Rows that clear 500,000 views therefore appear in the run report under " +
      '"unknown duration" rather than as passing shorts. It also cannot search across accounts — ' +
      "hashtag search returns no view counts, so it cannot serve the threshold. There is no " +
      "keyless alternative either: yt-dlp marks its own instagram:user extractor CURRENTLY BROKEN. " +
      "Needs the operator's own Instagram professional account id, seeded usernames, and a Meta " +
      "token with Advanced Access. Nothing here has been run against Meta."
    );
  }

  /**
   * Available when a third-party provider was handed in, or when all three
   * pieces of the official path are present. Otherwise a sentence naming
   * exactly which piece is missing — not "not configured", which tells an
   * operator nothing they can act on.
   *
   * NO NETWORK CALL HAPPENS HERE. This runs on every page load for all five
   * platforms; a Graph call per load would spend the hourly allowance on
   * looking at a screen. Whether the token WORKS is only ever learned by using
   * it, which is what the run and the credentials page's test button are for.
   */
  override async unavailableReason(): Promise<string | null> {
    if (this.provider) return null;

    const token = await resolveMetaToken(this.tokenSource);
    const gaps: string[] = [];
    if (!token) gaps.push(GAP_TOKEN);
    if (!this.igUserId) gaps.push(GAP_IG_USER_ID);
    if (this.seeds.length === 0) gaps.push(GAP_SEEDS);

    return gaps.length === 0 ? null : refusal(gaps);
  }

  /**
   * The base class's sentence for "nothing at all is configured".
   *
   * It is the same prose `unavailableReason()` produces, from the same
   * generator, with all three gaps listed — because that IS the state it
   * describes. One problem gets one explanation; two wordings for one problem
   * is how people conclude a tool is guessing.
   */
  protected missing(): string {
    return refusal([GAP_TOKEN, GAP_IG_USER_ID, GAP_SEEDS]);
  }

  // --------------------------------------------------------------- by subject

  /**
   * This adapter can be pointed at a topic. See lib/platform/topical.ts.
   *
   * ONLY THROUGH THE PROVIDER. There is no keyless subject search for Instagram,
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
   * Business Discovery, one call per seeded username.
   *
   * WHAT IS FILTERED HERE AND WHAT IS DELIBERATELY NOT:
   *
   *   media_product_type !== "REELS"   dropped. A feed photo or a carousel is
   *                                    not a candidate for a Shorts list under
   *                                    any reading. This is a SURFACE filter and
   *                                    it is emphatically NOT a duration proxy;
   *                                    see the header.
   *   view_count < minViews            dropped. The one half of the product's
   *                                    promise this data CAN answer.
   *   duration                         NOT filtered, because there is nothing to
   *                                    filter on. Every surviving row carries
   *                                    `duration_seconds: null` and lib/shorts/run.ts
   *                                    counts it as `unknownDuration`.
   *
   * So this method's contract is precise: what it returns is "Reels by the
   * seeded creators that are over the view threshold and whose length is
   * unknown". It is not, and must never be described as, a list of Shorts.
   */
  override async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    if (this.provider) return this.provider.latestShorts(query);

    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new MetaUnreadableError(PLATFORM, `limit must be a positive integer, got ${query.limit}`);
    }

    const token = (await resolveMetaToken(this.tokenSource)) as string;
    const discoveredAt = this.now().toISOString();
    const kept: ShortRecord[] = [];

    for (const username of this.seeds) {
      const { body } = await metaGet<BusinessDiscoveryResponse>({
        platform: PLATFORM,
        path: this.igUserId as string,
        params: {
          fields:
            `business_discovery.username(${username})` +
            `{id,username,followers_count,media_count,media.limit(${query.limit}){${MEDIA_FIELDS}}}`,
        },
        token,
        fetchImpl: this.options.fetchImpl,
        apiBase: this.options.apiBase,
        version: this.options.version,
        budget: this.budget,
        timeoutMs: this.options.timeoutMs,
      });

      const discovery = body?.business_discovery;
      if (!discovery) {
        // A 200 with no business_discovery block is not "this creator posts
        // nothing" — it is a response we do not understand, and the difference
        // matters more here than anywhere else in the file.
        throw new MetaUnreadableError(
          PLATFORM,
          `Business Discovery for @${username} answered without a business_discovery block. That is ` +
            "an unreadable response, not an empty account, and it is not being reported as " +
            "'no shorts found'. The usual cause is that @" +
            username +
            " is not an Instagram professional account, or is age-gated — Meta documents that " +
            '"Data about age-gated Instagram professional accounts will not be returned."',
        );
      }

      const media = edgeRows(discovery.media);
      const reels = media.filter((m) => m.media_product_type === "REELS");

      // The shape-change guard, mirroring `requireReadableCounts` in
      // lib/platform/ytdlp.ts. It checks VIEW COUNTS ONLY. It deliberately does
      // NOT check durations, because a missing duration here is documented and
      // permanent rather than a symptom of breakage — running the yt-dlp
      // version of this guard against Instagram would throw on every single
      // successful call.
      if (reels.length > 0 && reels.every((m) => typeof m.view_count !== "number")) {
        throw new MetaUnreadableError(
          PLATFORM,
          `Business Discovery returned ${reels.length} Reels for @${username} and not one carried a ` +
            "view_count. The 500,000 threshold cannot be applied, so every row would be dropped and " +
            "Instagram would look empty when it is actually unreadable. view_count is documented as " +
            "available to the Business Discovery API only — the usual cause is that this app has " +
            "Standard rather than Advanced Access. Refusing to report it as 'no shorts found'.",
        );
      }

      for (const item of reels) {
        const record = this.toRecord(item, discovery, discoveredAt);
        if (!record) continue;
        if (record.view_count === null || record.view_count < query.minViews) continue;
        kept.push(record);
      }
    }

    return kept;
  }

  /**
   * A playable media URL, resolved on demand and never stored.
   *
   * It re-runs the Business Discovery lookup for that creator and picks the row
   * out by id, asking for `media_url` — documented as "The URL for the media."
   * Reading `/{ig-media-id}` directly would be one call instead of one call,
   * but nothing on a Meta page confirms that node is readable for media the
   * operator does not own, so the verified path is the one used. That costs one
   * call against the hourly budget per press, which is the honest price.
   *
   * NULL MEANS ONE THING ONLY: this adapter ran, and there is no media URL for
   * THIS row — no handle to look it back up by, or the post has fallen out of
   * that creator's recent window. It does NOT mean the lookup failed, and until
   * 2026-09-08 it did: every exception was caught here and flattened to null,
   * which /admin/shorts renders as "It was asked and it answered — nothing
   * failed and nothing was refused". An expired token, a spent call budget and
   * a Meta refusal all reached the operator as that sentence, which is false in
   * all three cases. That is the same defect `YouTubeAdapter.downloadUrl`
   * records as its own scar on the same day; Instagram and Facebook were left
   * behind by that fix and are caught up here. A failure now throws, and
   * app/(admin)/admin/shorts/actions.ts answers it — printing the adapter's own
   * sentence when the error class declared itself fit to print, and pointing at
   * the log when it did not. A download button cannot take the page down: that
   * call site has caught this since it was written.
   *
   * THE PLATFORM GUARD RUNS FIRST IN BOTH MODES, the same way TikTok's does. A
   * row from another platform arriving here is a routing bug in the caller, and
   * handing it to a metered vendor spends a credit on somebody else's video to
   * find that out.
   */
  override async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== PLATFORM) {
      throw new MetaUnreadableError(
        PLATFORM,
        `asked for a ${short.platform} download URL. Each adapter resolves only its own platform's ` +
          "media; routing by platform is lib/platform/registry.ts's job.",
      );
    }
    if (this.provider) return this.provider.downloadUrl(short);

    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    const username = short.creator_handle?.trim().replace(/^@/, "");
    if (!username) return null;

    const token = (await resolveMetaToken(this.tokenSource)) as string;
    // NOT WRAPPED IN A CATCH. See the note above this method: a refusal from
    // Meta is a refusal, and flattening it to null told the operator the
    // opposite in a sentence composed to sound reassuring.
    const { body } = await metaGet<BusinessDiscoveryResponse>({
      platform: PLATFORM,
      path: this.igUserId as string,
      params: {
        fields: `business_discovery.username(${username}){media.limit(50){id,media_url}}`,
      },
      token,
      fetchImpl: this.options.fetchImpl,
      apiBase: this.options.apiBase,
      version: this.options.version,
      budget: this.budget,
      timeoutMs: this.options.timeoutMs,
    });
    const hit = edgeRows(body?.business_discovery?.media).find(
      (m) => m.id === short.platform_video_id,
    );
    // The one true null: the lookup succeeded and this post was not in it.
    return hit?.media_url?.trim() || null;
  }

  /**
   * One media row to a `ShortRecord`, or null when it is too incomplete to be
   * one.
   *
   * `duration_seconds` IS HARDCODED NULL. Not "defaults to", not "when absent" —
   * always. There is no field to read it from and this line is where somebody
   * would otherwise be tempted to invent one.
   */
  private toRecord(
    media: IgMedia,
    discovery: BusinessDiscovery,
    discoveredAt: string,
  ): ShortRecord | null {
    const id = media.id?.trim();
    const url = media.permalink?.trim();
    // Identity is (platform, platform_video_id) and the canonical URL is what
    // persists; a row without both is not a row this repo can hold.
    if (!id || !url) return null;

    const handle = (media.username ?? discovery.username)?.trim() || null;

    return {
      platform: PLATFORM,
      platform_video_id: id,
      url,
      // Instagram has no title, only a caption. The caption is what a person
      // recognises the post by, so it goes in the title slot as written —
      // untruncated, because deciding where to cut somebody else's sentence is
      // the UI's job and not this file's.
      title: media.caption?.trim() || null,
      creator_handle: handle,
      creator_id: discovery.id?.trim() || null,
      creator_url: handle ? `https://www.instagram.com/${handle}/` : null,
      duration_seconds: null,
      view_count: typeof media.view_count === "number" ? media.view_count : null,
      like_count: typeof media.like_count === "number" ? media.like_count : null,
      comment_count: typeof media.comments_count === "number" ? media.comments_count : null,
      published_at: media.timestamp?.trim() || null,
      thumbnail_url: media.thumbnail_url?.trim() || null,
      discovered_at: discoveredAt,
      discovered_by: DISCOVERED_BY,
      topic_slug: null,
    };
  }
}
