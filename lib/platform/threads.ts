/**
 * THREADS, AND THE ONE THING IT IS GOOD AT.
 *
 * Erik, 2026-09-08: "We need to add threads."
 *
 * ============================================================================
 * THIS IS THE FIRST META SURFACE THAT CAN BE ASKED A QUESTION
 * ============================================================================
 *
 * Instagram and Facebook, through Meta's official API, can only read accounts
 * the operator already administers. Neither has a public-content search of any
 * kind, which is why lib/platform/topical.ts has to tell an operator that
 * Facebook cannot be searched for a subject "by this tool or by any tool it can
 * buy".
 *
 * Threads is the exception. `GET /v1.0/keyword_search` on graph.threads.net
 * returns OTHER PEOPLE'S public posts, takes `media_type=VIDEO`, and takes a
 * date window. That is precisely the shape migration 14 taught this tool to
 * ask for, so Threads is topical-first: the subject run is the real one and the
 * untargeted run is the one that cannot be built.
 *
 * ============================================================================
 * AND IT CAN NEVER MEASURE. EVERY ROW IS UNVERIFIED, FOREVER.
 * ============================================================================
 *
 * Read this before wiring anything to a threshold.
 *
 *   NO VIEW COUNT. Meta's insights endpoint (/{threads-media-id}/insights) is
 *   where `views` lives, and it is documented to answer for the authenticated
 *   user's OWN media. There is no view count for somebody else's post, at any
 *   price, with any scope. Keyword search does not return one either.
 *
 *   NO DURATION. There is no duration field anywhere in the Threads API — not
 *   on a search result, not on the media node, not on insights. Duration is the
 *   only thing that DEFINES a Short (see `ShortRecord`), so this platform
 *   cannot prove that anything it returns is a Short at all.
 *
 * Both are therefore null on every row, always, and that is a fact about the
 * API rather than a gap this adapter could close by trying harder. The rows
 * land in the run report's `unverified` list, shown to the operator as things
 * nobody could measure. THAT IS THE CORRECT OUTCOME and it is why this adapter
 * was worth writing anyway: an unmeasured video about the right subject is a
 * lead, and the alternative — inventing a number so the row survives a filter —
 * is the exact failure `parsePlatform` and `DroppedBreakdown` were built to
 * prevent. A Threads row that ever reaches `report.shorts` is a bug.
 *
 * ============================================================================
 * WHY THE UNTARGETED READ REFUSES RATHER THAN RETURNING NOTHING
 * ============================================================================
 *
 * `latestShorts` — the no-subject run — throws. Threads has no "popular right
 * now" edge, no trending endpoint and no way to enumerate a stranger's posts
 * without a keyword, so there is no honest untargeted read to make. Returning
 * `[]` would say "Threads had no big videos today", which is a claim about
 * Threads; throwing says "this tool cannot ask Threads that question", which is
 * a claim about the tool and is the true one. Same argument as the header of
 * lib/platform/types.ts: "could not be read" must never collapse into "no
 * results".
 */
import type { LatestShortsQuery } from "./adapter";
import type { PlatformAdapter } from "./adapter";
import {
  MetaCallBudget,
  MetaUnreadableError,
  edgeRows,
  metaGet,
  resolveMetaToken,
  type MetaEdge,
  type MetaTokenSource,
} from "./meta-client";
import { READS_TOPICS, type TopicalAdapter } from "./topical";
import type { Platform, ShortRecord } from "./types";
import { PlatformUnavailableError } from "./unavailable";
import { cleanTerms, type Topic } from "../shorts/topics";

const PLATFORM: Platform = "threads";
const DISCOVERED_BY = "meta:threads-keyword-search";

/**
 * Threads is its own host and its own version line, NOT graph.facebook.com.
 *
 * `metaGet` is reused wholesale — its token scrubbing, its usage-header
 * parsing, its error taxonomy and its budget metering are all correct here and
 * rewriting them for a second Meta host would be two copies of the code that
 * once leaked an access token into an exception message. Only the base changes.
 */
const THREADS_HOST = "https://graph.threads.net";
const THREADS_VERSION = "v1.0";

/** Meta's documented ceiling for one keyword_search page. */
const MAX_RESULTS_PER_SEARCH = 100;

/**
 * The fields keyword search will actually return.
 *
 * DELIBERATELY NOT `media_url` OR ANY INSIGHTS FIELD. Meta documents the search
 * response as id, text, media_type, permalink, timestamp, username,
 * has_replies, is_quote_post and is_reply — `owner` is excluded outright — and
 * asking for a field the edge does not serve makes the whole call fail rather
 * than dropping that one key. The absent fields are the subject of this file's
 * header; they are not an oversight in this string.
 */
const SEARCH_FIELDS =
  "id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply";

const GAP_TOKEN =
  "a Threads access token from threads.net's own OAuth, carrying threads_basic AND " +
  "threads_keyword_search (save one on /admin/credentials under the Threads provider)";

function refusal(gaps: readonly string[]): string {
  return (
    `Threads is not configured: this build needs ${gaps.join("; and ")}. ` +
    "Know what it buys before configuring it. Threads is the only Meta surface this tool can " +
    "search for a subject — its keyword search returns other people's public video posts, which " +
    "Instagram and Facebook cannot do at any price. What it will never return is a NUMBER: " +
    "Meta's insights endpoint answers for your own posts only, and the API has no duration field " +
    "at all, so every Threads row arrives with unknown views and unknown length and is reported " +
    "as unverified rather than counted against the 500,000 threshold."
  );
}

/**
 * THE TOKEN IS NOT A FACEBOOK PAGE TOKEN AND NOT AN INSTAGRAM ONE.
 *
 * It is issued by threads.net through a separate OAuth flow with its own
 * scopes. Sharing the Meta credential here would let an operator paste a Page
 * token and watch Threads report itself configured and then fail every call —
 * the same class of fault the registry header describes, arrived at from the
 * other direction. It has its own `credential_provider` enum value for this
 * reason; see supabase/migrations/20260908_15_threads.sql.
 */
export interface ThreadsAdapterOptions {
  readonly token?: MetaTokenSource | null;
  /**
   * ITS OWN BUDGET AND NOT THE SHARED META ONE.
   *
   * `MetaCallBudget`'s ceiling is global across the platforms that share the
   * instance — `take(platform)` names who to blame in the error, it does not
   * give each platform its own allowance. Instagram and Facebook share one
   * because they share graph.facebook.com and its quota. Threads is a different
   * host with a different quota, so folding it in would make an Instagram run
   * fail because a Threads run spent the hour, which is a false report about
   * Instagram.
   */
  readonly budget?: MetaCallBudget;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /**
   * TOP or RECENT. Meta's default is TOP and so is this one.
   *
   * TOP is what the product wants: the operator is hunting for clips that
   * travelled, and RECENT is an unranked firehose of whatever was posted in the
   * last few minutes. It is an option rather than a constant only because a
   * subject with very little volume is better served by RECENT, and that is a
   * judgement about a topic that this file cannot make.
   */
  readonly searchType?: "TOP" | "RECENT";
}

/** One row of Meta's keyword_search response. Every field is optional: Meta omits rather than nulls. */
interface ThreadsPost {
  readonly id?: string;
  readonly text?: string;
  readonly media_type?: string;
  readonly permalink?: string;
  readonly timestamp?: string;
  readonly username?: string;
  readonly has_replies?: boolean;
  readonly is_quote_post?: boolean;
  readonly is_reply?: boolean;
}

export class ThreadsAdapter implements PlatformAdapter, TopicalAdapter {
  readonly platform: Platform = PLATFORM;

  private readonly tokenSource: MetaTokenSource | null;
  private readonly budget: MetaCallBudget;
  private readonly options: ThreadsAdapterOptions;
  private readonly now: () => Date;

  constructor(options: ThreadsAdapterOptions = {}) {
    this.options = options;
    this.tokenSource = options.token ?? null;
    this.budget = options.budget ?? new MetaCallBudget();
    this.now = options.now ?? (() => new Date());
  }

  describe(): string {
    return (
      "Threads, via Meta's official keyword search — the only Meta surface that can be asked " +
      "about a SUBJECT rather than about accounts you already administer. It returns other " +
      "people's public video posts for a topic's terms, which Instagram and Facebook cannot do " +
      "at any price. It cannot measure them: Meta publishes view counts for your own posts only " +
      "and publishes no duration field at all, so every row arrives with unknown views and " +
      "unknown length and is listed as unverified rather than counted as a Short over 500,000 " +
      "views. There is also no untargeted read — with no subject there is nothing to search for, " +
      "and that run refuses instead of reporting an empty Threads. Nothing here has been run " +
      "against Meta."
    );
  }

  async unavailableReason(): Promise<string | null> {
    const token = await resolveMetaToken(this.tokenSource);
    return token ? null : refusal([GAP_TOKEN]);
  }

  /**
   * THE NO-SUBJECT RUN, WHICH REFUSES. See this file's header for why an empty
   * list would be a lie about Threads rather than a fact about it.
   */
  async latestShorts(_query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);
    throw new PlatformUnavailableError(
      PLATFORM,
      "Threads can only be read for a SUBJECT. Its keyword search needs terms, and Meta " +
        "publishes no trending edge, no popular-videos edge and no way to enumerate a stranger's " +
        "posts without one — so a run with no topic has no question to ask it. This is a refusal " +
        "and not an empty result on purpose: reporting no shorts would say Threads had nothing " +
        "big today, which nobody here has checked. Switch a topic on under “What to look for”, " +
        "or aim this run at one.",
    );
  }

  /**
   * NOTHING TO DOWNLOAD, AND NOT BECAUSE IT IS UNIMPLEMENTED.
   *
   * Keyword search does not return `media_url`, so this adapter never holds a
   * file address for a post — only its permalink, which is already on the row.
   * Null is the honest answer and it is the documented meaning of null here:
   * "this source offers no direct media URL".
   *
   * A FOREIGN ROW STILL THROWS, and it is worth saying why when the answer for
   * every genuine Threads row is null anyway. Null is a claim ABOUT THIS
   * PLATFORM — /admin/shorts renders it as "the Threads adapter has no file for
   * this post. It was asked and it answered" — and making that claim about a
   * TikTok row would be this adapter answering for a platform it knows nothing
   * about. Routing is lib/platform/registry.ts's job and a mistake in it is a
   * caller's bug, not a missing file. Same guard, same words, as the other five.
   */
  async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== PLATFORM) {
      throw new MetaUnreadableError(
        PLATFORM,
        `asked for a ${short.platform} download URL. Each adapter resolves only its own platform's ` +
          "media; routing by platform is lib/platform/registry.ts's job.",
      );
    }
    return null;
  }

  // --------------------------------------------------------------- by subject

  readonly [READS_TOPICS] = true as const;

  async topicUnavailableReason(topic: Topic): Promise<string | null> {
    const base = await this.unavailableReason();
    if (base) return base;

    if (cleanTerms(topic.terms).length === 0) {
      return (
        `The topic ${JSON.stringify(topic.name)} has no search terms, so there is nothing to ` +
        "search Threads for. Add at least one term."
      );
    }
    return null;
  }

  async latestShortsForTopic(topic: Topic, query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.topicUnavailableReason(topic);
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new MetaUnreadableError(PLATFORM, `limit must be a positive integer, got ${query.limit}`);
    }

    const token = (await resolveMetaToken(this.tokenSource)) as string;
    const terms = cleanTerms(topic.terms);
    const discoveredAt = this.now().toISOString();

    // ONE REQUEST PER TERM, and the ids are de-duplicated across them because a
    // post matching two of a topic's terms is one post. Merging later in the
    // run would also catch it, but only after it had been counted twice in this
    // adapter's own share of the call budget — and the duplicate would be
    // reported as the platform returning it twice, which it did not.
    const seen = new Set<string>();
    const rows: ShortRecord[] = [];

    for (const term of terms) {
      const { body } = await metaGet<MetaEdge<ThreadsPost>>({
        platform: PLATFORM,
        path: "keyword_search",
        params: {
          q: term,
          media_type: "VIDEO",
          search_type: this.options.searchType ?? "TOP",
          fields: SEARCH_FIELDS,
          limit: Math.min(query.limit, MAX_RESULTS_PER_SEARCH),
        },
        token,
        fetchImpl: this.options.fetchImpl,
        apiBase: this.options.apiBase ?? THREADS_HOST,
        version: this.options.version ?? THREADS_VERSION,
        budget: this.budget,
        timeoutMs: this.options.timeoutMs,
      });

      const posts = edgeRows(body);

      // THE `media_type=VIDEO` FILTER IS CHECKED AND NOT TRUSTED. It is a
      // parameter on somebody else's endpoint, and a text post filed as a
      // short would be a row this tool invented. A page that returned posts
      // and labelled NONE of them is a different fault — an unreadable
      // listing rather than an empty one — and says so rather than passing
      // for a quiet search, the same distinction the Facebook adapter draws
      // about its attachments field.
      if (posts.length > 0 && posts.every((p) => p.media_type === undefined)) {
        throw new MetaUnreadableError(
          PLATFORM,
          `keyword_search returned ${posts.length} posts for ${JSON.stringify(term)} and not one ` +
            "carried a media_type, so no post could be identified as a video at all. That is an " +
            "unreadable listing, not an empty one. The usual cause is a token without the " +
            "threads_keyword_search scope. Refusing to report it as 'no shorts found'.",
        );
      }

      for (const post of posts) {
        if ((post.media_type ?? "").toUpperCase() !== "VIDEO") continue;
        const record = this.toRecord(post, topic, discoveredAt);
        if (!record) continue;
        if (seen.has(record.platform_video_id)) continue;
        seen.add(record.platform_video_id);
        rows.push(record);
      }
    }

    return rows;
  }

  /**
   * One search result as a `ShortRecord`, or null when it cannot be one.
   *
   * A ROW WITHOUT AN ID OR A PERMALINK IS DROPPED RATHER THAN PATCHED. Identity
   * is (platform, platform_video_id) and `url` is documented ALWAYS PRESENT, so
   * a synthesised id or a URL built by pasting the username into a template
   * would put a row in the database that nothing can look up again. Meta omits
   * fields rather than nulling them, so an absent id is a real possibility and
   * not a hypothetical.
   */
  private toRecord(post: ThreadsPost, topic: Topic, discoveredAt: string): ShortRecord | null {
    const id = post.id?.trim();
    const permalink = post.permalink?.trim();
    if (!id || !permalink) return null;

    const username = post.username?.trim() || null;
    const text = post.text?.trim() || null;

    return {
      platform: PLATFORM,
      platform_video_id: id,
      url: permalink,
      // The post's text IS its title — Threads has no title field, and a video
      // post's caption is the only human-readable name it has.
      title: text,
      creator_handle: username,
      // `owner` is excluded from keyword_search responses by documentation, so
      // there is no numeric creator id to record. Null means the source did not
      // say, which is exactly what happened.
      creator_id: null,
      creator_url: username ? `https://www.threads.net/@${username}` : null,
      // NOT MEASURABLE. See the header — these four are null on every Threads
      // row that will ever exist, and the run reports them as unverified.
      duration_seconds: null,
      view_count: null,
      like_count: null,
      comment_count: null,
      published_at: post.timestamp?.trim() || null,
      // keyword_search returns no media_url and no thumbnail of any kind.
      thumbnail_url: null,
      discovered_at: discoveredAt,
      discovered_by: DISCOVERED_BY,
      // Set here because this call is the one that chose the subject — the
      // contract in `ShortRecord.topic_slug`.
      topic_slug: topic.slug,
    };
  }
}
