/**
 * Facebook, through Meta's OFFICIAL Graph API — which can only ever show the
 * operator their own Pages, and cannot show them a view count or a duration
 * even there.
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST META. There is no Meta token on
 * this machine. Every claim below was read from developers.facebook.com on
 * 2026-09-04 and carries its page. "Documented" is not "working".
 *
 * ============================================================================
 * THE THREE FINDINGS THAT SHAPE THIS FILE
 * ============================================================================
 *
 * 1. THE VIDEO EDGES CANNOT BE READ AT ALL — BY ANYBODY.
 *
 *    The obvious route is `GET /{page-id}/videos`. Its Reading section says, in
 *    full: "You can't perform this operation on this endpoint."
 *    (https://developers.facebook.com/docs/graph-api/reference/page/videos/,
 *    read 2026-09-04. The page carries a POST section with a full parameter
 *    table, so the edge exists — it is publish-only.) The Reels edge,
 *    `GET /{page-id}/video_reels`, says the same thing
 *    (.../reference/page/video_reels/, same day): POST only, no read, no
 *    update, no delete.
 *
 *    THIS IS STRONGER THAN "IT REFUSES PAGES YOU DO NOT ADMINISTER". It refuses
 *    everyone, including the Page's own admin. So FACEBOOK REELS CANNOT BE READ
 *    THROUGH THE OFFICIAL GRAPH API AT ALL — the only Reels edge is for
 *    publishing them. The Page feed's own limitations page says as much in
 *    passing: "Reels use a separate endpoint", and that endpoint is the
 *    publish-only one.
 *
 * 2. WHAT IS READABLE IS THE PAGE'S POST FEED, FOR PAGES THE OPERATOR HAS A
 *    ROLE ON.
 *
 *    `GET /{page-id}/posts` and `GET /{page-id}/feed` do support reading
 *    (.../reference/page/posts/ and .../reference/page/feed/, read 2026-09-04).
 *    Verbatim permissions: "The pages_read_engagement permission and The
 *    pages_read_user_content permission". The token holder must be able to
 *    perform a Page task — CREATE_CONTENT, MANAGE or MODERATE — which is what
 *    "a Page you administer" means in Meta's vocabulary. For Pages the operator
 *    does not manage, the docs point at "The Page Public Content Access
 *    Feature", a restricted App Review feature.
 *
 *    Documented limitations on that edge, which bound the product hard:
 *    approximately 600 ranked published posts per year are returned; a maximum
 *    of 100 feed posts with the `limit` field; and — the one that matters most
 *    here — "video posts require admin status".
 *
 *    SO THIS ADAPTER READS THE OPERATOR'S OWN PAGES AND NOTHING ELSE. It cannot
 *    find other people's viral Reels. It will never be able to, through this
 *    API, and no amount of App Review changes that: the Reels read edge does not
 *    exist. That is a product fact and it is stated in `describe()` and in the
 *    refusal, in those words, so nobody mistakes it for a configuration problem.
 *
 * 3. THERE IS NO VIEW COUNT AND NO DURATION ON ANYTHING READABLE HERE.
 *
 *    Post fields on the readable feed edges: id, created_time, message, story,
 *    permalink_url, is_published, privacy, from, actions, attachments,
 *    targeting. The attachment (StoryAttachment, .../reference/story-attachment/)
 *    carries description, description_tags, media, media_type, target, title,
 *    type, url, unshimmed_url, subattachments. The Video node
 *    (.../reference/video/) carries id, created_time, description, embed_html,
 *    format, event, from, icon, name, picture, place, source, updated_time.
 *
 *    NOT ONE OF THOSE THREE LISTS CONTAINS A VIEW COUNT OR A LENGTH. So every
 *    row this adapter produces carries `view_count: null` and
 *    `duration_seconds: null`, and lib/shorts/run.ts counts them under
 *    `unknownDuration`. A run reports
 *
 *        Facebook — ran, returned 9, kept 0, unknownDuration 9
 *
 *    which is the truthful answer: nine video posts were found on the seeded
 *    Pages and the official API said nothing about how long they are or how many
 *    people watched them. That is a real result and it is not an empty list.
 *
 * ============================================================================
 * THE VIEW COUNT SCAR — WHY A NUMBER FROM ELSEWHERE WOULD NOT FIX IT EITHER
 * ============================================================================
 *
 * The obvious repair is to fetch a view count from some other route and fill
 * the null. DO NOT, without labelling it. Measured locally on 2026-09-04, a
 * Facebook reel whose own on-page badge read 9.8K came back with a view count
 * of 408 — off by a factor of twenty-four, in the direction that hides a viral
 * post rather than inventing one. A number that can be wrong by an order of
 * magnitude cannot be compared against a 500,000 threshold and be believed;
 * feeding it in silently would produce a filter that looks precise and is not.
 *
 * `ShortRecord` has no field for "this number is unreliable", so this adapter
 * takes the only honest option available to it: it writes `view_count: null`,
 * which the vocabulary already defines as "the source did not say". If a
 * reliability flag is ever added to the record, THIS is the platform it was
 * added for.
 *
 * ============================================================================
 * WHAT IS NOT BUILT, AND MUST NOT BE
 * ============================================================================
 *
 * Meta Content Library — the CrowdTangle replacement — is the only Meta product
 * that offers real Facebook public-content search. It is restricted to academic
 * and non-profit researchers. Lucky35 is a for-profit and is explicitly
 * ineligible. Nothing here builds toward it, and routing an application through
 * an eligible third party would be a false representation on somebody's
 * application form. It is named here so the idea dies in the file rather than in
 * a meeting.
 *
 * The third-party `ProviderClient` path (lib/platform/unavailable.ts) still
 * short-circuits everything below and is still the drop-in for the day a data
 * provider is chosen.
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
import { PlatformUnavailableError, ProviderBackedAdapter, type ProviderClient } from "./unavailable";

const PLATFORM: Platform = "facebook";

const DISCOVERED_BY = "meta:facebook-page-posts";

/**
 * Meta's own ceiling on this edge: "a maximum of 100 feed posts with the
 * `limit` field". Asking for more is not an error that says so — it is a
 * silently smaller page — so the request is clamped here where the reason is
 * written down.
 */
const MAX_POSTS_PER_PAGE = 100;

/**
 * Post fields requested. Every name is from the Page Posts / Page Feed reading
 * documentation cited in the header.
 *
 * `attachments` is what makes a post identifiable as a video post at all: the
 * post node itself has no media type. There is no field here for views or
 * length because no such field exists on any of these nodes.
 */
const POST_FIELDS =
  "id,created_time,message,permalink_url,is_published," +
  "from{id,name}," +
  "attachments{media_type,type,title,description,url,unshimmed_url,target{id,url}}";

/**
 * Which attachment types count as a video post.
 *
 * `media_type` is documented as "Type of the media such as (photo, video, link
 * etc)" and `type`'s documented value list includes `video` and
 * `video_autoplay`. Both are checked, and `type` is matched by prefix, because
 * the documented list is explicitly open-ended ("etc") and a new `video_*`
 * value appearing would otherwise silently stop matching. Matching too widely
 * here is cheap — a non-video row that slips through carries a null duration
 * and is dropped downstream anyway — while matching too narrowly loses posts
 * without saying so.
 */
function isVideoAttachment(attachment: StoryAttachment | undefined): boolean {
  if (!attachment) return false;
  if (attachment.media_type?.toLowerCase() === "video") return true;
  return (attachment.type ?? "").toLowerCase().startsWith("video");
}

interface StoryAttachmentTarget {
  readonly id?: string;
  readonly url?: string;
  readonly unshimmed_url?: string;
}

interface StoryAttachment {
  readonly media_type?: string;
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly url?: string;
  readonly unshimmed_url?: string;
  readonly target?: StoryAttachmentTarget;
}

interface PagePost {
  readonly id?: string;
  readonly created_time?: string;
  readonly message?: string;
  readonly permalink_url?: string;
  readonly is_published?: boolean;
  readonly from?: { readonly id?: string; readonly name?: string };
  readonly attachments?: MetaEdge<StoryAttachment>;
}

/** The two things the official path needs, written once so they cannot drift. */
const GAP_TOKEN =
  "a Meta Page access token from someone with a CREATE_CONTENT, MANAGE or MODERATE task on the " +
  "Page, carrying pages_read_engagement and pages_read_user_content (save one on /admin/credentials)";

const GAP_SEEDS =
  "at least one Facebook Page id THE OPERATOR ADMINISTERS (PLATFORM_SEEDS_FACEBOOK) — the feed " +
  "edges are the only readable ones and they only answer for Pages you hold a role on";

/**
 * The refusal.
 *
 * It ends by saying what a working token still will not buy, because the whole
 * point of scaffolding this route was to find out whether it can serve the
 * product, and the documentation already answers that: it cannot.
 */
function refusal(gaps: readonly string[]): string {
  return (
    `Facebook is not configured: this build needs ${gaps.join("; and ")}. ` +
    "Before configuring it, know what it buys. Meta's official Graph API has no page or profile " +
    "enumerator for other people's content, and its two video edges — /{page-id}/videos and " +
    "/{page-id}/video_reels — both answer \"You can't perform this operation on this endpoint\" for " +
    "reads, for everyone, including a Page's own admin. So Facebook Reels cannot be read through " +
    "the official API at all, and the readable post feed only ever returns Pages the operator " +
    "administers. It carries no view count and no duration either, so nothing from Facebook can " +
    "clear the 500,000 threshold or be shown to be under the 120-second ceiling. The Meta Content " +
    "Library, which does offer public-content search, is academic and non-profit only and this " +
    "business is ineligible. Nothing in this adapter has been run against Meta."
  );
}

/**
 * Which reader answered. Mirrors `TikTokMode` and `InstagramMode` — the three
 * provider-backed platforms all have two routes and all three must say which
 * one ran.
 */
export type FacebookMode = "vendor" | "meta";

export interface FacebookAdapterOptions {
  /** Page ids the operator administers. */
  readonly seeds?: readonly string[];
  /** Where the Meta Page token comes from. A function, because a lease is async. */
  readonly token?: MetaTokenSource | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly version?: string;
  /** Share ONE of these with the Instagram adapter — see meta-client.ts's header. */
  readonly budget?: MetaCallBudget;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class FacebookAdapter extends ProviderBackedAdapter {
  readonly platform: Platform = PLATFORM;

  private readonly seeds: readonly string[];
  private readonly tokenSource: MetaTokenSource | null;
  private readonly options: FacebookAdapterOptions;
  private readonly budget: MetaCallBudget;
  private readonly now: () => Date;

  /**
   * The first parameter is still the third-party provider, positional, still
   * defaulting to null — lib/platform/registry.ts constructs this as
   * `new FacebookAdapter(o.providers?.facebook ?? null)` and that call must keep
   * compiling untouched. The official-API configuration is a second, optional
   * argument the registry can start passing whenever it is wired up.
   */
  constructor(provider: ProviderClient | null = null, options: FacebookAdapterOptions = {}) {
    super(provider);
    this.options = options;
    this.seeds = (options.seeds ?? []).map((s) => s.trim()).filter(Boolean);
    this.tokenSource = options.token ?? null;
    this.budget = options.budget ?? new MetaCallBudget();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Which reader will answer. Mirrors `TikTokAdapter.mode` and
   * `InstagramAdapter.mode`, for the reason those two give: the official route
   * and a vendor route answer different questions under different limits.
   */
  get mode(): FacebookMode {
    return this.provider ? "vendor" : "meta";
  }

  /**
   * SCAR, 2026-09-08 — the same one `InstagramAdapter.describe()` carries, found
   * in the same sweep.
   *
   * This returned the Meta paragraph below UNCONDITIONALLY, including when a
   * `ProviderClient` had been handed in, and a provider short-circuits every
   * read method in this file. So a vendor-backed Facebook card told the
   * operator it "can only ever show you Pages you administer" and that nothing
   * here had been run against Meta — while the read that actually happened went
   * to a data vendor, was asked for PUBLIC page URLs, and never touched Meta at
   * all. Two of those claims are false in vendor mode and the third is about an
   * API that was not called.
   *
   * The view-count caveat is the one thing that DOES carry across both modes,
   * and it is kept in both branches deliberately: it is a measured fact about
   * Facebook's own numbers, not about a route.
   */
  describe(): string {
    if (this.mode === "vendor") {
      return (
        "Facebook, through a third-party data provider rather than Meta. META IS NOT CALLED ON " +
        "THIS PATH, and the official route's hardest limit is therefore not the one in force: " +
        "Graph API refuses GET on a Page's video and Reels edges for everybody, so it can only " +
        "ever show Pages the operator administers, whereas a provider is asked for public pages " +
        "by URL. What it can and cannot answer is its own business and is reported per run rather " +
        "than promised here. One thing carries over unchanged, because it is a fact about " +
        "Facebook and not about a route: Facebook's view numbers are not to be trusted near a " +
        "threshold — a reel whose own badge read 9.8K reported 408 here on 2026-09-04. WHAT THIS " +
        "BUILD DOES ABOUT THAT CHANGED ON 2026-09-08: rather than refusing to compare the " +
        "vendor's figure, it multiplies it by a configured factor and compares the result, so " +
        "rows on this path can clear 500,000 and be saved on a number nobody measured. The " +
        "vendor's own figure is kept beside every row and the estimate is marked as one wherever " +
        "it is shown. The provider is metered and billed per request. Nothing on this path has " +
        "been run against a live vendor key."
      );
    }

    return (
      "Facebook, via Meta's official Graph API — and it can only ever show you Pages you " +
      "administer. There is no public-content search: the two video edges refuse reads for " +
      "everyone, so Facebook Reels cannot be read through the official API at all, and what is " +
      "left is a Page's own post feed. That feed carries no view count and no duration, so nothing " +
      "from Facebook can be shown to clear 500,000 views or to be under the 120-second ceiling — " +
      "rows arrive with both unknown and the run report says so. Facebook's view numbers are not " +
      "to be trusted near a threshold in any case: a reel whose own badge read 9.8K reported 408 " +
      "here on 2026-09-04. This adapter will never find other people's viral Reels. Nothing here " +
      "has been run against Meta."
    );
  }

  /**
   * NO NETWORK CALL HAPPENS HERE — this runs on every page load for all five
   * platforms, and a Graph call per load would spend the hourly allowance on
   * looking at a screen.
   */
  override async unavailableReason(): Promise<string | null> {
    if (this.provider) return null;

    const token = await resolveMetaToken(this.tokenSource);
    const gaps: string[] = [];
    if (!token) gaps.push(GAP_TOKEN);
    if (this.seeds.length === 0) gaps.push(GAP_SEEDS);

    return gaps.length === 0 ? null : refusal(gaps);
  }

  /** The same prose, for the state where nothing at all is configured. */
  protected missing(): string {
    return refusal([GAP_TOKEN, GAP_SEEDS]);
  }

  /**
   * Video posts from the seeded Pages, newest-first as the edge returns them.
   *
   * NOTHING IS FILTERED BY VIEWS OR DURATION HERE, because there is nothing to
   * filter with. Every row goes back with both null and lib/shorts/run.ts
   * accounts for them under `unknownDuration`. That is the honest shape of this
   * platform's answer and it is why this method does not use `matchesQuery`
   * from lib/platform/ytdlp.ts — that helper would drop every row, and the
   * adapter would hand back `[]`, which on screen is indistinguishable from
   * "Facebook had nothing over 500,000 views today". It never had a chance to.
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
    const rows: ShortRecord[] = [];

    for (const pageId of this.seeds) {
      const { body } = await metaGet<MetaEdge<PagePost>>({
        platform: PLATFORM,
        path: `${pageId}/posts`,
        params: { fields: POST_FIELDS, limit: Math.min(query.limit, MAX_POSTS_PER_PAGE) },
        token,
        fetchImpl: this.options.fetchImpl,
        apiBase: this.options.apiBase,
        version: this.options.version,
        budget: this.budget,
        timeoutMs: this.options.timeoutMs,
      });

      const posts = edgeRows(body);

      // The shape/permission guard. Meta documents that "video posts require
      // admin status" on this edge, so a feed that comes back with posts but
      // never once mentions attachments is very likely a token without the role
      // rather than a Page that has posted no media. Those two must not look
      // the same, so this refuses rather than returning nothing.
      if (posts.length > 0 && posts.every((p) => p.attachments === undefined)) {
        throw new MetaUnreadableError(
          PLATFORM,
          `Page ${pageId} returned ${posts.length} posts and not one carried an attachments field, ` +
            "so no post could be identified as a video at all. That is an unreadable listing, not " +
            "an empty one. Meta documents that video posts on this edge require admin status — the " +
            "usual cause is a token whose holder has no CREATE_CONTENT, MANAGE or MODERATE task on " +
            "this Page. Refusing to report it as 'no shorts found'.",
        );
      }

      for (const post of posts) {
        const record = this.toRecord(post, pageId, discoveredAt);
        if (record) rows.push(record);
      }
    }

    return rows;
  }

  /**
   * A playable file URL, resolved on demand and never stored.
   *
   * Two calls, both on documented fields, because the post does not carry the
   * video's id and the video does not carry the post's:
   *
   *   GET /{post-id}?fields=attachments{target{id}}   -> the video id
   *   GET /{video-id}?fields=source                   -> "A URL to the raw,
   *                                                      playable video file."
   *
   * NULL MEANS ONE THING ONLY: both calls were made and this post had no video
   * source in the answer. It does NOT mean a call failed, and until 2026-09-08
   * it did — every exception was caught here and returned as null, which
   * /admin/shorts renders as "It was asked and it answered — nothing failed and
   * nothing was refused". A missing `pages_read_engagement`, a spent call
   * budget and an expired Page token all arrived as that reassurance. Same
   * defect, same day and same fix as `InstagramAdapter.downloadUrl` and
   * `YouTubeAdapter.downloadUrl`; a failure throws and
   * app/(admin)/admin/shorts/actions.ts is what answers it. The page is not at
   * risk: that call site has caught around this since it was written.
   *
   * THE PLATFORM GUARD RUNS FIRST IN BOTH MODES, as TikTok's does — a misrouted
   * row must not reach a metered vendor.
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

    const token = (await resolveMetaToken(this.tokenSource)) as string;
    const common = {
      platform: PLATFORM,
      token,
      fetchImpl: this.options.fetchImpl,
      apiBase: this.options.apiBase,
      version: this.options.version,
      budget: this.budget,
      timeoutMs: this.options.timeoutMs,
    } as const;

    // NOT WRAPPED IN A CATCH — see the note above this method.
    const { body: post } = await metaGet<PagePost>({
      ...common,
      path: short.platform_video_id,
      params: { fields: "attachments{target{id}}" },
    });
    // A true null: the post was read and its attachment names no video.
    const videoId = edgeRows(post?.attachments)[0]?.target?.id?.trim();
    if (!videoId) return null;

    const { body: video } = await metaGet<{ readonly source?: string }>({
      ...common,
      path: videoId,
      params: { fields: "source" },
    });
    return video?.source?.trim() || null;
  }

  /**
   * One post to a `ShortRecord`, or null when it is not a video post or is too
   * incomplete to be a row.
   *
   * BOTH COUNTS ARE HARDCODED NULL and there is no branch that could ever set
   * them. Nothing readable on this path carries either number; see the header's
   * third finding, and the scar about the 408-against-a-9.8K-badge measurement
   * before reaching for one from somewhere else.
   */
  private toRecord(post: PagePost, pageId: string, discoveredAt: string): ShortRecord | null {
    const attachment = edgeRows(post.attachments)[0];
    if (!isVideoAttachment(attachment)) return null;

    const id = post.id?.trim();
    // `permalink_url` is the canonical link and it is the half of "links to
    // download them" that survives. A post without one cannot be a row: there
    // would be nothing for a person to open.
    const url = post.permalink_url?.trim() ?? attachment?.unshimmed_url?.trim() ?? attachment?.url?.trim();
    if (!id || !url) return null;

    const pageName = post.from?.name?.trim() || null;
    const creatorId = post.from?.id?.trim() || pageId;

    return {
      platform: PLATFORM,
      platform_video_id: id,
      url,
      title: attachment?.title?.trim() || post.message?.trim() || null,
      creator_handle: pageName,
      creator_id: creatorId,
      creator_url: `https://www.facebook.com/${creatorId}`,
      duration_seconds: null,
      view_count: null,
      like_count: null,
      comment_count: null,
      published_at: post.created_time?.trim() || null,
      thumbnail_url: null,
      discovered_at: discoveredAt,
      discovered_by: DISCOVERED_BY,
      topic_slug: null,
    };
  }
}
