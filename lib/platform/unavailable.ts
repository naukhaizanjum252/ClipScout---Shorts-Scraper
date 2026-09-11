/**
 * "This platform could not be read", as a type — and the shape of the adapter
 * that will one day be able to read it.
 *
 * WHY THIS FILE EXISTS
 *
 * Three of the five platforms have no verified way to enumerate a timeline.
 * Verified on this machine, yt-dlp 2026.07.04, `yt-dlp --list-extractors`:
 * `instagram:user` is labelled CURRENTLY BROKEN by yt-dlp itself, there is no
 * Facebook page/profile enumerator, and there is no X user-timeline enumerator.
 * Erik has been asked which third-party data provider to use and has not
 * answered. Until he does, nobody may write a client for an API they cannot
 * verify, and nobody may return `[]` and let it read as "no viral shorts on
 * Instagram today".
 *
 * So Instagram, X and Facebook are REAL adapters that refuse, loudly and
 * specifically, rather than stubs that quietly succeed at nothing.
 *
 * THE DROP-IN, DESIGNED SO IT IS A SMALL CHANGE
 *
 * `ProviderBackedAdapter` takes a `ProviderClient` or null. Null is today: every
 * method refuses with that platform's own sentence. Non-null is the day a
 * provider is chosen: write one class implementing two methods, pass it in
 * through lib/platform/registry.ts, and the adapter becomes available with no
 * edit to the adapter file at all. That is the whole change. It is written this
 * way so that "we picked a provider" cannot turn into a rewrite, and so that
 * the refusal path stays in the code afterwards for the case where the key is
 * missing.
 *
 * WHY `latestShorts` THROWS AND DOES NOT RETURN []
 *
 * Because `[]` is a RESULT and this is a FAILURE, and on screen they are the
 * same three words. Everything in this repo bends around keeping those two
 * apart. `unavailableReason()` is how a caller finds out cheaply and in
 * advance; the throw is what happens to a caller that did not ask.
 */
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import type { Platform, ShortRecord } from "./types";

/**
 * Thrown when an adapter is asked to do work it has already said it cannot do.
 *
 * Carries the reason verbatim, so the sentence an operator reads in an error is
 * the same sentence they read next to the platform in the UI. Two different
 * explanations of one problem is how people conclude a tool is lying to them.
 */
export class PlatformUnavailableError extends Error {
  constructor(
    readonly platform: Platform,
    readonly reason: string,
  ) {
    super(`${platform} cannot be read: ${reason}`);
    this.name = "PlatformUnavailableError";
  }
}

/**
 * The two things a third-party data provider has to do for us.
 *
 * Deliberately the smallest possible surface: this is a promise about an API
 * nobody has chosen yet, and every method added here before that choice is a
 * guess about somebody else's product. Two methods are enough to serve the one
 * action the product has.
 */
export interface ProviderClient {
  /** The latest shorts, already normalised. Throws on failure; never returns [] to mean "broken". */
  latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]>;
  /** A direct media URL, resolved on demand. Null when this provider cannot get one. */
  downloadUrl(short: ShortRecord): Promise<string | null>;
}

/**
 * The marker for a provider that can also be asked for WORDS rather than only
 * for the sources it was constructed with.
 *
 * A THIRD METHOD ON `ProviderClient` WAS THE OTHER OPTION AND IT IS WRONG. That
 * interface's comment says two methods, deliberately, because every method on
 * it before it is needed is a guess about somebody else's product — and the
 * guess would be real here: Facebook's provider has no search endpoint to
 * implement, so a required third method would force `ScrapeCreatorsProvider` to
 * carry a throw for one of the three platforms it serves. An optional
 * capability, tested for, says the true thing: some providers can search, and
 * the one that cannot is asked and answers no.
 *
 * `Symbol.for` for the same reason as everywhere else in this repo — two copies
 * of the module under different bundler identities must still agree.
 */
export const SEARCHES_KEYWORDS: unique symbol = Symbol.for("shorts-scraper.searches-keywords");

/**
 * A provider that can be pointed at a subject.
 *
 * The seam is WORDS, not the vendor's own source objects, and that is the whole
 * point of it being here rather than in lib/platform/scrapecreators.ts: "search
 * this platform for these phrases" is a thing any data vendor either sells or
 * does not, while `TikTokKeywordSource` is one vendor's spelling of it. A
 * second vendor drops in against this seam; it would have to be rewritten
 * against the other one.
 */
export interface KeywordSearchingProvider extends ProviderClient {
  readonly [SEARCHES_KEYWORDS]: true;
  /**
   * The latest shorts this platform returns for these phrases, already
   * normalised. Same contract as `latestShorts`: throws on failure, and never
   * returns `[]` to mean "broken".
   */
  latestShortsForKeywords(
    keywords: readonly string[],
    query: LatestShortsQuery,
  ): Promise<ShortRecord[]>;
}

/** The capability test. Null for a provider that cannot be asked for words. */
export function asKeywordSearching(
  provider: ProviderClient | null,
): KeywordSearchingProvider | null {
  if (!provider) return null;
  const candidate = provider as Partial<KeywordSearchingProvider>;
  if (candidate[SEARCHES_KEYWORDS] !== true) return null;
  if (typeof candidate.latestShortsForKeywords !== "function") return null;
  return provider as KeywordSearchingProvider;
}

/**
 * An adapter for a platform whose reader has to come from outside yt-dlp.
 *
 * Subclasses supply three things and nothing else: which platform, the human
 * sentence for the UI, and the sentence explaining what is missing. Everything
 * about refusing correctly is here so that three files cannot drift into three
 * different ideas of how to fail.
 */
export abstract class ProviderBackedAdapter implements PlatformAdapter {
  abstract readonly platform: Platform;

  /**
   * `null` today. The day a provider is chosen, registry.ts constructs the
   * subclass with a client and every method below starts working.
   */
  constructor(protected readonly provider: ProviderClient | null = null) {}

  abstract describe(): string;

  /**
   * What is missing, in a sentence a person can act on: which provider, which
   * credential, which upstream is broken. Never "not implemented" — that tells
   * an operator nothing they can do anything about.
   */
  protected abstract missing(): string;

  async unavailableReason(): Promise<string | null> {
    return this.provider ? null : this.missing();
  }

  async latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]> {
    if (!this.provider) throw new PlatformUnavailableError(this.platform, this.missing());
    return this.provider.latestShorts(query);
  }

  /**
   * THROWS when there is no provider, rather than returning null.
   *
   * Null on this method means "this adapter works, and it cannot get you the
   * file for THIS video" — a members-only post, a geo-block, a DRM stream. That
   * is a fact about one row. Having no provider at all is a fact about the whole
   * platform, and it is already impossible to be holding a genuine
   * `ShortRecord` for a platform nothing can read: no adapter produced one. So a
   * call here is a bug in the caller, and it is told so.
   */
  async downloadUrl(short: ShortRecord): Promise<string | null> {
    if (!this.provider) throw new PlatformUnavailableError(this.platform, this.missing());
    return this.provider.downloadUrl(short);
  }
}
