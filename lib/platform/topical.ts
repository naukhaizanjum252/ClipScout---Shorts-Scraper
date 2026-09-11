/**
 * THE SEAM FOR "SEARCH THIS PLATFORM FOR THIS SUBJECT".
 *
 * `PlatformAdapter` has four methods and its header says, in capitals, no more.
 * That rule is about not growing curation methods on the shape every platform
 * must implement, and it is right: topical search is something SOME sources can
 * do and three of the five provably cannot, so putting it on the base interface
 * would force three adapters to implement a method whose only honest body is a
 * throw.
 *
 * So this file follows the idiom this repo already uses for optional
 * capabilities — `SpendAccountant` and `asAccounting` in lib/shorts/run.ts. An
 * adapter that can be aimed at a subject declares it with a symbol; everything
 * else is asked through `asTopical` and gets null, which the caller must turn
 * into a sentence rather than into an empty list.
 *
 * ---------------------------------------------------------------------------
 * WHICH PLATFORMS CAN BE AIMED, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 *   YOUTUBE     YES, keylessly. `ytsearchN:<terms> #shorts` through yt-dlp
 *               returns flat-playlist entries carrying `duration`,
 *               `view_count`, `channel_id` and `channel` — everything a row
 *               needs. Measured 2026-09-05 on yt-dlp 2026.07.04; the numbers
 *               are in lib/shorts/topics.ts. No API key, no quota, no billing.
 *
 *   TIKTOK      YES, with a ScrapeCreators key. `/v1/tiktok/search/keyword`
 *               takes a `query` and the adapter already models it as a
 *               `TikTokKeywordSource`. Metered and billed per request, so a
 *               topic run costs money on this platform and the caller is told
 *               so before it spends.
 *
 *   INSTAGRAM   YES, with a ScrapeCreators key. `/v2/instagram/reels/search`
 *               takes a `query` and is already modelled as an
 *               `InstagramKeywordSource`. Note what lib/platform/
 *               scrapecreators.ts records about it: its documented response
 *               carries no view count, so rows from it cannot clear a view
 *               threshold. That is the endpoint's shape, not a defect here,
 *               and it means an Instagram topic search reports what it found
 *               and why most of it could not be proven.
 *
 *   X           YES, with the operator's own bearer token AND a configured
 *               query. X bills $0.005 per Post RETURNED, so the topic is ANDed
 *               onto `X_SEARCH_QUERY` rather than replacing it: the subject
 *               narrows what the operator already costed, and every guard they
 *               set stays in the string. See `X_TOPIC_NOTE`.
 *
 *   FACEBOOK    NO, and not for want of trying. Meta's Graph API documents no
 *               public-content search and no read on a Page's video edges
 *               (lib/credentials/providers.ts, read 2026-09-04), and no vendor
 *               sells Facebook Reels discovery, ScrapeCreators included
 *               (lib/platform/registry.ts). There is no mechanism, paid or
 *               free, by which this tool can search Facebook for a subject.
 *
 * ---------------------------------------------------------------------------
 * A TOPICAL ADAPTER MAY NOT FALL BACK TO ITS UNTARGETED READ
 * ---------------------------------------------------------------------------
 *
 * This is the honesty rule from `PlatformAdapter`, applied to the new axis, and
 * it is the whole reason this file exists as a seam instead of as an optional
 * argument on `latestShorts`. If a topic were passed in and an adapter that
 * could not use it simply ignored it, the run would come back full of exactly
 * the untargeted 500,000-view Shorts that Luka asked us to stop returning — and
 * they would be LABELLED with the topic, which is worse than returning nothing,
 * because now the tool is asserting a subject it never searched for.
 */
import { cleanTerms, type Topic } from "../shorts/topics";
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import type { Platform, ShortRecord } from "./types";
import {
  asKeywordSearching,
  PlatformUnavailableError,
  type KeywordSearchingProvider,
  type ProviderClient,
} from "./unavailable";

/**
 * The marker. A symbol rather than a `kind` string so nothing can claim the
 * capability by accident, and `Symbol.for` so two copies of this module loaded
 * under different bundler identities still agree — the same reasoning as
 * `METERS_ITS_OWN_SPEND` in lib/shorts/run.ts.
 */
export const READS_TOPICS: unique symbol = Symbol.for("shorts-scraper.reads-topics");

/** An adapter that can be pointed at a subject. */
export interface TopicalAdapter extends PlatformAdapter {
  readonly [READS_TOPICS]: true;

  /**
   * Why this adapter cannot search for THIS topic right now, or null if it can.
   *
   * Separate from `unavailableReason()` because the two questions have
   * different answers: X with a bearer token and no topic support configured is
   * perfectly able to run its own query, and reporting it as unavailable would
   * be a lie in the other direction.
   */
  topicUnavailableReason(topic: Topic): Promise<string | null>;

  /**
   * The latest shorts about this subject. Only called when
   * `topicUnavailableReason` returned null.
   *
   * Same contract as `latestShorts`: an adapter that finds itself unable to
   * read mid-run throws; it does not return `[]`.
   */
  latestShortsForTopic(topic: Topic, query: LatestShortsQuery): Promise<ShortRecord[]>;
}

/** The capability test. Null for every adapter that cannot be aimed. */
export function asTopical(adapter: PlatformAdapter): TopicalAdapter | null {
  const candidate = adapter as Partial<TopicalAdapter>;
  if (candidate[READS_TOPICS] !== true) return null;
  if (typeof candidate.topicUnavailableReason !== "function") return null;
  if (typeof candidate.latestShortsForTopic !== "function") return null;
  return adapter as TopicalAdapter;
}

/**
 * Why a platform has no topical reader AT ALL, as a sentence for the screen.
 *
 * This is the fallback for `asTopical` returning null. It names the missing
 * thing — a key, an endpoint, or the fact that no such endpoint is sold —
 * because "Facebook: no results" and "Facebook cannot be searched by anybody"
 * are different sentences and only one of them is true.
 */
export function noTopicalReaderReason(platform: Platform): string {
  switch (platform) {
    case "youtube":
      return (
        "YouTube can be searched by subject keylessly and this deployment is not doing it, which " +
        "means the adapter was built without its yt-dlp runner. That is a wiring fault, not a " +
        "limit of the platform."
      );
    case "tiktok":
      return (
        "TikTok can only be searched by subject through a data provider. Its keyword search is " +
        "ScrapeCreators' /v1/tiktok/search/keyword; yt-dlp's own tag, sound and effect extractors " +
        "are marked CURRENTLY BROKEN upstream, so there is no keyless alternative. Save a " +
        "ScrapeCreators key on /admin/credentials and this platform joins the topic run."
      );
    case "instagram":
      return (
        "Instagram can only be searched by subject through a data provider — ScrapeCreators' " +
        "/v2/instagram/reels/search. Meta's own Business Discovery reads accounts you already " +
        "name and has no search of any kind. Save a ScrapeCreators key on /admin/credentials to " +
        "enable it."
      );
    case "x":
      return (
        "X is searched by query and needs the operator's own bearer token. Save one on " +
        "/admin/credentials; note that X bills $0.005 for every Post it returns, so a topic run " +
        "on X costs money in proportion to what the subject matches."
      );
    case "facebook":
      return (
        "Facebook cannot be searched for a subject by this tool or by any tool it can buy. Meta's " +
        "Graph API documents no public-content search and no read on a Page's video edges, and no " +
        "data vendor sells Facebook Reels discovery — ScrapeCreators included. Facebook can only " +
        "ever return the Pages somebody names, whatever they are about."
      );
    case "threads":
      return (
        "Threads IS searchable for a subject — it is the only Meta surface that is — and this " +
        "deployment is not doing it, which means no Threads token has been saved. Meta's " +
        "keyword search needs one carrying threads_basic and threads_keyword_search, from " +
        "threads.net's own OAuth rather than from a Facebook Page. Save one on " +
        "/admin/credentials. Worth knowing before you do: Threads can find the clips and can " +
        "never measure them, so everything it returns is reported as unverified rather than as " +
        "a Short over the threshold."
      );
    default:
      return "This platform has no way to be searched for a subject.";
  }
}

/**
 * The two provider-backed halves of `TopicalAdapter`, written once.
 *
 * TikTok and Instagram both reach their subject search through a data provider
 * and would otherwise carry the same fifteen lines twice. Facebook extends the
 * same base class and must NOT get them — it has no search endpoint at any
 * price — so this is a pair of functions the two adapters call rather than
 * behaviour on `ProviderBackedAdapter`, where the third subclass would inherit
 * a capability that does not exist.
 */
export async function providerTopicUnavailableReason(
  platform: Platform,
  provider: ProviderClient | null,
  topic: Topic,
): Promise<string | null> {
  if (cleanTerms(topic.terms).length === 0) {
    return (
      `The topic ${JSON.stringify(topic.name)} has no search terms, so there is nothing to ask ` +
      `${platform} for. Add at least one term — the words a person would type to find this kind ` +
      "of clip."
    );
  }
  if (!asKeywordSearching(provider)) return noTopicalReaderReason(platform);
  return null;
}

export async function providerTopicShorts(
  platform: Platform,
  provider: ProviderClient | null,
  topic: Topic,
  query: LatestShortsQuery,
): Promise<ShortRecord[]> {
  const reason = await providerTopicUnavailableReason(platform, provider, topic);
  if (reason) throw new PlatformUnavailableError(platform, reason);
  // Non-null: `providerTopicUnavailableReason` returned null, which it only
  // does once the capability test has passed.
  const searching = asKeywordSearching(provider) as KeywordSearchingProvider;
  const rows = await searching.latestShortsForKeywords(cleanTerms(topic.terms), query);
  /*
   * LABELLED HERE AND NOT IN THE VENDOR MAPPER, which is the one exception to
   * "the adapter that searched is the one that labels" and it is a deliberate
   * one. `ScrapeCreatorsProvider` builds one source per phrase and hands the
   * merged list back; its per-endpoint mappers are shared with the untargeted
   * creator and page reads and do not know a topic exists. This function is the
   * nearest object that DID ask the question, so it is the last honest place to
   * record what was asked. Nothing between here and there merges in rows from
   * anywhere else — `latestShortsForKeywords` deliberately ignores the
   * configured sources — so every row in this list came from these phrases.
   */
  return rows.map((row) => ({ ...row, topic_slug: topic.slug }));
}

/**
 * What an operator has to understand about X and topics.
 *
 * The topic is COMBINED with the configured query, never substituted for it —
 * see `topicQuery` in lib/platform/x.ts. The combination can only narrow, so a
 * topic run on X cannot cost more than the untargeted run it replaces, which is
 * why there is no separate switch guarding it. What it still cannot do is run
 * with no query configured at all: a topic supplies a subject and not the
 * `has:video_link`, `-is:retweet` and `min_likes:` guards that stand between
 * a per-Post endpoint and a bill, and inventing those is exactly what
 * lib/platform/x.ts refuses to do.
 */
export const X_TOPIC_NOTE =
  "On X a topic narrows the query you configured rather than replacing it, so it cannot cost more " +
  "than an untargeted run. X still needs a query of its own first — the topic supplies the " +
  "subject, not the has:video_link and min_likes: guards that cap what a run can be billed for.";
