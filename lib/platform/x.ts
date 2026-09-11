/**
 * X. The one platform with an official API this tool is actually paying for.
 *
 * WHAT CHANGED, AND WHAT THE OLD HEADER GOT RIGHT
 *
 * Until 2026-09-04 this file was an honest refusal. Its reasoning still holds
 * and is worth keeping, because it is why the answer is an API and not a
 * scraper: yt-dlp 2026.07.04 has six Twitter extractors — TwitterIE,
 * TwitterCardIE, TwitterAmplifyIE, TwitterBroadcastIE, TwitterSpacesIE,
 * TwitterShortenerIE — and every one of them takes a URL to something you
 * already know exists. There is no user-timeline extractor. Not a broken one:
 * none. The gap was always DISCOVERY, and no amount of waiting fixes it.
 *
 * Erik, 2026-09-04: *"for tiktok, can we build an automated system... Lets build
 * X."* He is paying for X. So the refusal is replaced by a reader built on X API
 * v2 recent search, and the refusal path stays underneath it for the ordinary
 * days when the key is missing, revoked or out of credit.
 *
 * ON THE NAME. This platform is `x` in our vocabulary and `twitter` in yt-dlp's.
 * lib/platform/types.ts deliberately refuses to keep a synonym table, because
 * translating another source's words belongs in the adapter that meets them.
 * This paragraph is that translation and it is the only place it exists.
 *
 * ----------------------------------------------- why X is one request, not two
 *
 * Every other platform in this repo needs two hops: a listing that says what
 * exists, then something else to say how long a video is and how many times it
 * was watched. X does not. One `GET /2/tweets/search/recent` with
 * `expansions=attachments.media_keys,author_id` and
 * `media.fields=duration_ms,public_metrics,variants,…` returns, in one response:
 *
 *   the post          id, text, created_at, author
 *   the DURATION      media.duration_ms — "available when type is video"
 *   the VIEW COUNT    media.public_metrics.view_count
 *   the PLAYABLE FILE media.variants[] — bit_rate, content_type, url
 *
 * Both halves of this product's filter and the download link, paid for once.
 * That is why there is no yt-dlp hop here and why `downloadUrl` does not shell
 * out to anything.
 *
 * ---------------------------------- THE ONE THING NOBODY HAS CONFIRMED, AND IT
 * ---------------------------------- IS THE THING THE WHOLE LEG RESTS ON
 *
 * `media.public_metrics.view_count` is documented as a PUBLIC metric — the data
 * dictionary lists it under `public_metrics` ("Public engagement metrics for the
 * media content at the time of the request", example `"view_count": 6865141`),
 * as against `non_public_metrics`, `organic_metrics` and `promoted_metrics`,
 * every one of which says "Requires user context authentication". The documented
 * example response is a third party's post read with an app-only bearer token
 * and it carries `"view_count": 6909260`.
 *
 * THAT IS DOCUMENTATION, NOT EVIDENCE. A field being described as publicly
 * readable is not the same as it being POPULATED on arbitrary third-party posts
 * with the access level Lucky35 will actually hold. Nobody here has run a single
 * request against X. So this adapter is built so that the answer is impossible
 * to miss on the first real run, in three layers:
 *
 *   1. A null view count is carried as NULL. It is never coerced to 0 and never
 *      substituted from `public_metrics.impression_count` on the Post, which is
 *      a different measurement — an impression is the post appearing on a
 *      timeline, a view is somebody playing the video. Filling the column the
 *      500,000 threshold reads with a larger, different number would let every
 *      row clear a bar it never cleared.
 *   2. A PARTIALLY null result is returned intact. lib/shorts/run.ts already
 *      counts `unknownViews` separately from `belowThreshold`, so those rows show
 *      up on the report as "the source did not say" rather than as a quiet day.
 *   3. A TOTALLY null result THROWS. If X returns video posts and not one of
 *      them carries a view count, every row would be dropped by the threshold
 *      and X would render as "nothing over 500,000 views" when what actually
 *      happened is that the field is not readable at this access level. That is
 *      the exact failure this repo exists to prevent, and it is the same rule
 *      `requireReadableCounts` enforces for yt-dlp durations.
 *
 * WHAT THE FIRST REAL RUN WILL TELL US. Either rows come back with view counts,
 * and this leg works and the paragraph above can be rewritten as a measurement —
 * or `XViewCountUnreadableError` is thrown, and we know inside one capped run —
 * a hundred posts is fifty cents — that X's official API cannot answer the only
 * question this product asks. Both outcomes are worth that. Neither is a
 * surprise three months and several invoices later.
 *
 * ------------------------------------------------- the query is not ours to set
 *
 * X charges $0.005 per Post RETURNED, so what the query matches IS what the run
 * costs, and what Lucky35 wants to find will change. The query therefore comes
 * from configuration with NO DEFAULT: an unconfigured X is unavailable and says
 * so, rather than running somebody's card against a query a developer invented.
 * `lib/platform/x-client.ts` validates it against the documented operator list
 * before spending — the three mistakes the docs themselves call out (`min_faves:`,
 * `min_retweets:`, `has:videos`), the 512-character self-serve ceiling, and a
 * query made only of conjunction-required operators, which X rejects outright.
 *
 * A workable shape, for the settings page rather than for this file:
 *
 *   min_likes:20000 has:video_link -is:retweet -is:reply lang:en
 *
 * `min_likes:` is a STANDALONE operator (the operators reference), so it can
 * carry the query on its own, and it is the only lever that narrows by
 * popularity BEFORE the bill. It is not the view threshold and must not be
 * mistaken for one — likes are not views. It is a cost control.
 *
 * ---------------------------------------------------------------- the spend cap
 *
 * `X_MAX_POSTS_PER_RUN` HAS NO DEFAULT, on purpose, for the same reason
 * `dailyQuotaUnits()` in lib/config.ts has none: it is the single number that
 * decides how much a run may cost, nobody with the authority to set it has said
 * one, and a default here would be this file spending somebody's money on a
 * figure it made up. Unset means unavailable, with a sentence saying so.
 */
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import type { Platform, ShortRecord } from "./types";
import { READS_TOPICS, type TopicalAdapter } from "./topical";
import { cleanTerms, type Topic } from "../shorts/topics";
import { markSafeToShow } from "../shorts/run";
import { PlatformUnavailableError } from "./unavailable";
import {
  bestMp4Variant,
  estimateUsd,
  formatSpend,
  queryProblems,
  startTimeFor,
  worstCaseBilledPosts,
  XSpendCapError,
  type XClient,
  type XMedia,
  type XPost,
  type XSpend,
  type XUser,
} from "./x-client";

const PLATFORM: Platform = "x";

/** Provenance written onto every row. Names the endpoint, not just the vendor. */
const DISCOVERED_BY = "x-api-v2:tweets/search/recent";

/**
 * The operator's query, narrowed to a subject.
 *
 * `(phrase one OR phrase two) <the configured query>` — an OR-group ANDed onto
 * whatever was already there, which is X's own grouping syntax and is why this
 * is a string concatenation rather than a parser. Three properties follow, and
 * each of them is why the topic is COMBINED rather than substituted:
 *
 *   IT CAN ONLY NARROW. Every post matching the combination already matched the
 *   configured query, so a topic run cannot be billed for more posts than the
 *   untargeted run it replaces. That is what makes topics on X safe without a
 *   separate spend switch.
 *
 *   THE COST CONTROLS SURVIVE. `min_likes:`, `has:video_link`, `-is:retweet`
 *   and `lang:` are still in the string. A topic that replaced the query would
 *   have thrown all of them away and left a bare phrase matching the platform.
 *
 *   A MULTI-WORD PHRASE IS QUOTED, because X treats unquoted words as an
 *   implicit AND anywhere in the post rather than as a phrase. `shark tank`
 *   unquoted matches a post about a shark and a fish tank; `"shark tank"` does
 *   not. A phrase that already carries its own quotes is left alone, and a
 *   quote inside a phrase is dropped rather than escaped — X's query syntax
 *   documents no escape for it, and a phrase with a stray quote is a query that
 *   fails at the API after the counts request has been paid for.
 */
export function topicQuery(configured: string, terms: readonly string[]): string {
  const phrases = terms
    .map((t) => t.trim().replace(/["“”]/g, "").replace(/\s+/g, " "))
    .filter(Boolean)
    .map((t) => (/\s/.test(t) ? `"${t}"` : t));
  if (phrases.length === 0) return configured.trim();
  return `(${phrases.join(" OR ")}) ${configured.trim()}`.trim();
}

/**
 * Thrown when X returned video posts and not one carried a view count.
 *
 * Its own type rather than a generic error because it is the answer to the one
 * question this whole leg was bought to settle, and a caller that wants to say
 * "the X leg does not work and here is why" should not have to match on a
 * string to find out.
 */
export class XViewCountUnreadableError extends Error {
  constructor(
    readonly videoPosts: number,
    readonly spend: XSpend,
  ) {
    super(
      `X returned ${videoPosts} video posts and not one carried ` +
        "media.public_metrics.view_count. That field is documented as a public metric, but " +
        "documentation is not evidence and this is the first time anyone has asked X for it " +
        "with a real key. Every row would be dropped by the 500,000-view threshold, and X would " +
        "render as 'nothing over 500,000 views' when the truth is that the view count is not " +
        "readable at this access level. Refusing to report that as a quiet day. " +
        `This run cost ${formatSpend(spend)}.`,
    );
    this.name = "XViewCountUnreadableError";
  }
}

/** Thrown when the query matched posts but none of them had a video attached. */
export class XNoVideoError extends Error {
  constructor(
    readonly posts: number,
    readonly spend: XSpend,
  ) {
    super(
      `X returned ${posts} posts and not one had a video attached. The query is not selecting ` +
        "video, so every row would be dropped for having no duration and X would look empty. " +
        "Add `has:video_link` (native X videos) to the query — `has:videos` is not an operator. " +
        `This run cost ${formatSpend(spend)}.`,
    );
    this.name = "XNoVideoError";
  }
}

/** A row for another platform arrived at this adapter. A caller's routing bug. */
export class XRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XRoutingError";
  }
}

/**
 * WHICH OF THESE A PERSON ACTUALLY SEES ON /admin/shorts.
 *
 * SCAR, 2026-09-08. `markSafeToShow` in lib/shorts/run.ts documents WHY it
 * exists, and the example it gives — verbatim — is "X returned 40 video posts
 * and not one carried a view count". That is `XViewCountUnreadableError`'s
 * message, composed in this file for an operator to read, and it was never
 * marked. So the one answer this leg was bought to settle went to a log file
 * and the screen said "the thrown message is in this deployment's server log".
 * lib/shorts/run.test.ts even asserts the behaviour using a locally-declared
 * `SafeError` carrying that exact sentence: the mechanism was proven and the
 * wiring was absent, which is the defect this repo keeps finding in itself.
 *
 * The rule these two are safe under is the same one lib/platform/
 * scrapecreators.ts states: every message above is composed HERE, out of
 * counts this file did and a spend figure from a published price table. No URL,
 * no bearer token and no upstream body text goes into either of them.
 * `XApiError` and anything else carrying X's own response text stays unmarked,
 * exactly as `ScrapeCreatorsError` does.
 */
markSafeToShow(XViewCountUnreadableError);
markSafeToShow(XNoVideoError);
markSafeToShow(XRoutingError);

export interface XAdapterOptions {
  /**
   * A constructed, credential-bearing client. Null is a normal state and means
   * "no X key is configured", which this adapter reports as unavailable.
   */
  readonly client?: XClient | null;
  /** The search query, verbatim from configuration. No default anywhere. */
  readonly query?: string | null;
  /**
   * Hard ceiling on billable Post reads for one run. NO DEFAULT — see the
   * header. Null means unset, which makes the adapter unavailable.
   */
  readonly maxPostsPerRun?: number | null;
  /**
   * How far back to search, in hours. Null means X's own recent window, which
   * the OpenAPI spec documents as the last 7 days. Clamped to that either way.
   */
  readonly windowHours?: number | null;
  /** Injected so `discovered_at` is not clock-dependent under test. */
  readonly now?: () => Date;
}

/** What one run actually did and cost. Read after `latestShorts`. */
export interface XRunStats {
  /** Posts the counts probe said the query matches in the window. */
  readonly matchedInWindow: number;
  readonly postsReturned: number;
  readonly postsWithVideo: number;
  readonly postsWithViewCount: number;
  readonly rowsProduced: number;
  readonly spend: XSpend;
  readonly estimateUsd: { readonly low: number; readonly high: number };
}

export class XAdapter implements TopicalAdapter {
  readonly platform = PLATFORM;

  private readonly client: XClient | null;
  private readonly query: string | null;
  private readonly maxPostsPerRun: number | null;
  private readonly windowHours: number | null;
  private readonly now: () => Date;

  /** The last run's accounting. Null until `latestShorts` has been called. */
  private stats: XRunStats | null = null;

  constructor(options: XAdapterOptions = {}) {
    this.client = options.client ?? null;
    const q = options.query?.trim();
    this.query = q ? q : null;
    this.maxPostsPerRun = options.maxPostsPerRun ?? null;
    this.windowHours = options.windowHours ?? null;
    this.now = options.now ?? (() => new Date());
  }

  get lastRun(): XRunStats | null {
    return this.stats;
  }

  describe(): string {
    return (
      "X. Read through X API v2 recent search with an operator's own bearer token. One request " +
      "returns the post, the video's duration, its view count and a playable MP4, so nothing here " +
      "needs a downloader. X bills $0.005 for every Post it returns, so the search query and a " +
      "hard per-run cap on posts retrieved are both configuration, and a run that would exceed " +
      "the cap stops instead of quietly costing more."
    );
  }

  /**
   * Everything that has to be true before a run may cost money.
   *
   * IT MAKES NO NETWORK CALL, and that is deliberate rather than lazy. This is
   * called once per platform every time a status page renders, and the cheapest
   * thing X sells is a $0.005 counts request — five status renders an hour would
   * be a slow drip on somebody's card for information that changes only when
   * configuration does. Everything below is answerable locally.
   */
  async unavailableReason(): Promise<string | null> {
    if (!this.client) {
      return (
        "no X credential is configured. X API v2 needs an app-only Bearer token from an X " +
        "developer project with credits on it; paste it on the credentials page as the X key. " +
        "Unlike YouTube there is no keyless fallback — yt-dlp has no user-timeline extractor for " +
        "X at all, so without a key this platform cannot be read rather than merely read less well."
      );
    }
    if (!this.query) {
      return (
        "no X search query is configured. X charges per Post returned, so what the query matches " +
        "is what the run costs — this tool will not invent one. Set X_SEARCH_QUERY to something " +
        "like `min_likes:20000 has:video_link -is:retweet lang:en`, which narrows by popularity " +
        "before the bill rather than after it."
      );
    }
    const problems = queryProblems(this.query);
    if (problems.length > 0) {
      return `the configured X search query cannot be used: ${problems.join(" ")}`;
    }
    if (this.maxPostsPerRun === null) {
      return (
        "no per-run post cap is configured for X. This is the one number that decides what a run " +
        "can cost — at $0.005 per Post returned, a cap of 200 is a $1.00 ceiling — and it has no " +
        "default because nobody has said what Lucky35's budget per run is. Set " +
        "X_MAX_POSTS_PER_RUN before this platform will spend anything."
      );
    }
    if (!Number.isSafeInteger(this.maxPostsPerRun) || this.maxPostsPerRun <= 0) {
      return (
        `the X per-run post cap reads as ${String(this.maxPostsPerRun)}, which is not a positive ` +
        "whole number of posts. Set X_MAX_POSTS_PER_RUN to the most Posts one run may be billed for."
      );
    }
    return null;
  }

  /**
   * The run. Four steps, and the money is spent in exactly two of them.
   *
   *   1. Cap arithmetic. Local, free, and it can stop the run.
   *   2. Counts probe. $0.005. Says how many posts the query matches in the
   *      window before a single Post is paid for.
   *   3. Search. $0.005 per Post returned, bounded by the cap.
   *   4. Map, and refuse to be quietly empty.
   */
  async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);
    return await this.runSearch(this.query as string, query);
  }

  /**
   * The four steps above, against ONE query string.
   *
   * Split out so `latestShortsForTopic` can run a narrowed query through the
   * identical path — the cap arithmetic, the counts probe, the truncation
   * check and the empty-result refusal are the money-safety of this adapter and
   * a second copy of them for topics would be a second place to get them wrong.
   * The caller has already proven the query is usable.
   */
  private async runSearch(
    searchQuery: string,
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]> {
    // Proven by the `unavailableReason` the caller ran; the compiler has not
    // been told.
    const client = this.client as XClient;
    const cap = this.maxPostsPerRun as number;

    // ---- 1. cap arithmetic, before anything is sent -------------------------
    if (query.limit > cap) {
      throw new XSpendCapError(
        query.limit,
        cap,
        `This run asked X for ${query.limit} posts and X_MAX_POSTS_PER_RUN authorises ${cap}. ` +
          "Stopping rather than silently returning fewer than was asked for: a short list that " +
          "looks like a complete answer is worse than no answer. Lower the run's limit, or raise " +
          `the cap deliberately — ${query.limit} posts would cost about ` +
          `$${(query.limit * 0.005).toFixed(2)} in Post reads.`,
      );
    }
    const worstCase = worstCaseBilledPosts(query.limit);
    if (worstCase > cap) {
      throw new XSpendCapError(
        worstCase,
        cap,
        `This run asked X for ${query.limit} posts, but recent search has a documented minimum ` +
          `\`max_results\` of 10, so the smallest request that can serve it is billed for ` +
          `${worstCase} Posts — more than the ${cap} X_MAX_POSTS_PER_RUN authorises. Raise the ` +
          "cap to at least that, or ask for enough posts that the minimum page size is not " +
          "wasted.",
      );
    }

    const startTime = startTimeFor(this.windowHours, this.now()) ?? undefined;

    // ---- 2. what would this cost? ------------------------------------------
    const matched = await client.countRecent(searchQuery, startTime);

    if (matched === 0) {
      // A real answer about X, bought for half a cent, and not an inference
      // from an empty search we would have paid per-post to run.
      this.stats = this.record(matched, [], 0, [], client.spend);
      return [];
    }
    if (matched > cap) {
      throw new XSpendCapError(
        matched,
        cap,
        `This query matches ${matched.toLocaleString("en-US")} posts in the window and ` +
          `X_MAX_POSTS_PER_RUN authorises ${cap}. Retrieving ${cap} of them would be an ` +
          "arbitrary recency slice of a much larger set presented as though it were the answer, " +
          "so the run stops here instead. The counts request that found this out cost $0.005; " +
          `retrieving all ${matched.toLocaleString("en-US")} would have cost about ` +
          `$${(matched * 0.005).toFixed(2)}. Narrow the query — raise \`min_likes:\`, add a ` +
          "`lang:`, drop a keyword — or shorten X_WINDOW_HOURS, either of which makes the sample " +
          "honest rather than merely smaller.",
      );
    }

    // ---- 3. the only step that pays per post -------------------------------
    const result = await client.searchRecent({
      query: searchQuery,
      maxPosts: Math.min(query.limit, cap),
      startTime,
    });

    if (result.truncatedByCap) {
      // The counts probe said this fits and pagination disagreed. Rare, and it
      // means the rows in hand are a slice of something larger — which is the
      // one thing this adapter may not hand back without saying so.
      throw new XSpendCapError(
        matched,
        cap,
        `X's counts endpoint said this query matches ${matched} posts in the window, which fits ` +
          `inside the ${cap}-post cap, but the search still had more pages after ${cap}. The two ` +
          "endpoints disagree, so what is in hand is a slice of an unknown whole rather than the " +
          `answer. This run cost ${formatSpend(client.spend)}. Narrow the query or shorten the ` +
          "window until counts and search agree.",
      );
    }

    // ---- 4. map, and refuse to be quietly empty ----------------------------
    const rows = result.posts
      .map((post) => this.toRecord(post, result.media, result.users))
      .filter((row): row is ShortRecord => row !== null);

    const videoPosts = result.posts.filter((p) => videoFor(p, result.media) !== null);
    this.stats = this.record(matched, result.posts, videoPosts.length, rows, client.spend);

    if (result.posts.length > 0 && videoPosts.length === 0) {
      throw new XNoVideoError(result.posts.length, client.spend);
    }
    if (videoPosts.length > 0 && rows.every((r) => r.view_count === null)) {
      throw new XViewCountUnreadableError(videoPosts.length, client.spend);
    }

    return rows;
  }

  // --------------------------------------------------------------- by subject

  /** This adapter can be pointed at a topic. See lib/platform/topical.ts. */
  readonly [READS_TOPICS] = true as const;

  /**
   * Why a topic cannot be searched for on X, or null.
   *
   * IT STILL REQUIRES A CONFIGURED QUERY, and that is the whole design here.
   * A topic supplies a SUBJECT — "shark tank", "dragons den". It does not
   * supply `has:video_link`, `-is:retweet`, `lang:en` or a `min_likes:` floor,
   * and those are what stand between a $0.005-per-Post endpoint and a bill. So
   * the topic is combined with the operator's query rather than replacing it,
   * and with no query configured this refuses in the same sentence
   * `unavailableReason` uses. Inventing the guard rails would be this adapter
   * inventing a query, which its header forbids for exactly this reason.
   */
  async topicUnavailableReason(topic: Topic): Promise<string | null> {
    const base = await this.unavailableReason();
    if (base) return base;

    const terms = cleanTerms(topic.terms);
    if (terms.length === 0) {
      return (
        `The topic ${JSON.stringify(topic.name)} has no search terms, so there is nothing to add ` +
        "to the X query. Add at least one term."
      );
    }

    const problems = queryProblems(topicQuery(this.query as string, terms));
    if (problems.length > 0) {
      return (
        `The topic ${JSON.stringify(topic.name)} cannot be combined with the configured X query: ` +
        `${problems.join(" ")} The combined query would have been ` +
        `${JSON.stringify(topicQuery(this.query as string, terms))}.`
      );
    }
    return null;
  }

  /**
   * The same run, narrowed to a subject.
   *
   * THE COMBINED QUERY MATCHES A SUBSET of what the configured query matches —
   * an OR-group of the topic's phrases ANDed onto it — so a topic run cannot
   * cost MORE than the untargeted one it replaces. That is the reason this
   * needs no separate opt-in switch: every guard the operator costed is still
   * in force, the counts probe still runs first, and the cap still stops the
   * run. What changes is that fewer posts match, which is the point.
   */
  async latestShortsForTopic(topic: Topic, query: LatestShortsQuery): Promise<ShortRecord[]> {
    const reason = await this.topicUnavailableReason(topic);
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    const rows = await this.runSearch(
      topicQuery(this.query as string, cleanTerms(topic.terms)),
      query,
    );
    // `toRecord` is shared with the untargeted read and does not take a topic.
    // This is the call that chose the subject, so it is the one that records it.
    return rows.map((row) => ({ ...row, topic_slug: topic.slug }));
  }

  /**
   * A playable MP4 for one row, resolved at the moment somebody wants it.
   *
   * IT COSTS $0.005 — one Post read — because a `ShortRecord` does not carry
   * variants and must not. The seam's rule is that a direct media URL is never
   * stored, and X is not being made the exception: the variant URLs in X's own
   * documentation carry no visible expiry, but "carries no expiry parameter in
   * one documented example" is not the same as "does not expire", and a table
   * of dead links that still look alive is the worst failure this repo has a
   * name for.
   *
   * Null means "no MP4 for THIS post" — the media is a photo, a GIF or an HLS
   * stream with no progressive file. It is a fact about one row, and the UI
   * shows it as such rather than as a broken button.
   *
   * A FOREIGN ROW THROWS AND NO LONGER RETURNS NULL, and the guard is the first
   * thing that happens. Every other adapter in this directory already threw
   * here; X returned null, which /admin/shorts renders as "It was asked and it
   * answered — nothing failed and nothing was refused, there is simply no media
   * URL for this one". That sentence is false about a routing bug, it names X
   * as the thing that came up empty, and it is the exact confusion this repo
   * exists to refuse. Routing by platform is
   * lib/platform/registry.ts's job and a mistake in it is the caller's bug, not
   * a missing file — so it is said, rather than absorbed. Guarding before
   * `unavailableReason()` also means a misrouted row is answered without
   * consulting a credential first.
   */
  async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (short.platform !== PLATFORM) {
      throw new XRoutingError(
        `asked for a ${short.platform} download URL. Each adapter resolves only its own platform's ` +
          "media; routing by platform is lib/platform/registry.ts's job.",
      );
    }

    const reason = await this.unavailableReason();
    if (reason) throw new PlatformUnavailableError(PLATFORM, reason);

    const { post, media } = await (this.client as XClient).lookupPost(short.platform_video_id);
    if (!post) return null;
    return bestMp4Variant(videoFor(post, media) ?? undefined);
  }

  // ------------------------------------------------------------------ private

  /**
   * One Post to one row, or null when it is not a Short at all.
   *
   * NULL IS ONLY EVER "THIS IS NOT A VIDEO POST". Everything else X declined to
   * say — a missing view count, a missing duration, a missing author — comes
   * back as a null FIELD on a real row, because a dropped row is invisible and a
   * null field is countable. lib/shorts/run.ts breaks those down by reason, and
   * that breakdown is how an operator tells a quiet day from a broken key.
   */
  private toRecord(
    post: XPost,
    media: ReadonlyMap<string, XMedia>,
    users: ReadonlyMap<string, XUser>,
  ): ShortRecord | null {
    if (!post.id) return null;
    const video = videoFor(post, media);
    if (!video) return null;

    const author = post.author_id ? users.get(post.author_id) : undefined;
    const handle = author?.username ?? null;

    return {
      platform: PLATFORM,
      // The POST id, not the media_key. Identity in this repo is the thing a
      // person can open, and `13_1263145212760805376` opens nothing.
      platform_video_id: post.id,
      url: handle
        ? `https://x.com/${handle}/status/${post.id}`
        : // No handle means the author expansion came back without this user.
          // `x.com/i/status/{id}` is the id-only form X's own share links use.
          `https://x.com/i/status/${post.id}`,
      // X posts have no title. The text is what a person recognises the post by,
      // and calling it a title here is the honest translation rather than a
      // fabricated one.
      title: post.text?.trim() || null,
      creator_handle: handle,
      creator_id: post.author_id ?? null,
      creator_url: handle ? `https://x.com/${handle}` : null,
      duration_seconds: typeof video.duration_ms === "number" ? Math.round(video.duration_ms / 1000) : null,
      // The load-bearing null. See this file's header.
      view_count: video.public_metrics?.view_count ?? null,
      like_count: post.public_metrics?.like_count ?? null,
      // X calls them replies. This repo calls them comments. One translation.
      comment_count: post.public_metrics?.reply_count ?? null,
      published_at: post.created_at ?? null,
      thumbnail_url: video.preview_image_url ?? null,
      discovered_at: this.now().toISOString(),
      discovered_by: DISCOVERED_BY,
      topic_slug: null,
    };
  }

  private record(
    matched: number,
    posts: readonly XPost[],
    videoPosts: number,
    rows: readonly ShortRecord[],
    spend: XSpend,
  ): XRunStats {
    return {
      matchedInWindow: matched,
      postsReturned: posts.length,
      // Counted from the posts, not from the rows: a post can carry a video and
      // still produce no row (no id), and collapsing the two would hide it.
      postsWithVideo: videoPosts,
      postsWithViewCount: rows.filter((r) => r.view_count !== null).length,
      rowsProduced: rows.length,
      spend,
      estimateUsd: estimateUsd(spend),
    };
  }
}

/**
 * The video attached to a post, or null.
 *
 * FIRST media whose `type` is exactly `"video"`. A post can carry four images, a
 * GIF and a video in any order, and only `video` has `duration_ms` — the data
 * dictionary says the field is "available when type is video". An
 * `animated_gif` is not a Short and is not treated as one.
 */
function videoFor(post: XPost, media: ReadonlyMap<string, XMedia>): XMedia | null {
  for (const key of post.attachments?.media_keys ?? []) {
    const m = media.get(key);
    if (m?.type === "video") return m;
  }
  return null;
}
