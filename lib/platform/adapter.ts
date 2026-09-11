/**
 * THE SEAM EVERY PLATFORM IMPLEMENTS.
 *
 * One action — "Get latest shorts" — reads five platforms and returns one list
 * grouped by platform. This interface is what makes that a loop over five
 * objects instead of five branches. Everything downstream of it (the view
 * threshold, the duration ceiling, the sort, the grouping, the UI) is written
 * once and is identical for every platform, which is the whole point: a code
 * path that can ask which platform it is holding is a code path that will grow
 * five behaviours and four of them will be wrong.
 *
 * THE HONESTY RULE, PER PLATFORM
 *
 * As of 2026-09-04, verified on this machine with yt-dlp 2026.07.04
 * (`yt-dlp --list-extractors`): YouTube works and also has an official Data API
 * v3 path; `tiktok:user` exists; `instagram:user` is labelled CURRENTLY BROKEN
 * by yt-dlp itself; and there is no page/profile enumerator for Facebook and no
 * user-timeline enumerator for X at all. Three of five cannot be served, and
 * which third-party data provider will serve them is an open question with
 * Erik.
 *
 * So this interface has `unavailableReason()`, and it is not a nicety. An
 * adapter that cannot run MUST say so in a sentence naming what is missing. It
 * must NOT return `[]`, because an empty array is the same shape as "this
 * platform genuinely had no shorts over 500,000 views today", and those two
 * things must never look the same on the screen. That confusion is how a tool
 * quietly reports that Instagram has no viral content. It is the single most
 * important rule in this repo and this method is where it is enforced.
 *
 * WHY THERE IS NO `search`, `resolveCreator` OR `enumerateChannel` HERE
 *
 * The product is one action. The previous version of this repo was a channel
 * inventory with a review queue, and it grew those methods because the seam
 * invited them. Four methods, none of which is about curating a creator.
 */
import type { Platform, ShortRecord } from "./types";

/**
 * What "get the latest shorts" asks a source for.
 *
 * `minViews` and the two duration bounds are passed IN rather than applied only
 * afterwards, so that a source which can filter server-side does — asking
 * TikTok for 50 posts and throwing 48 away is 48 posts of somebody else's
 * bandwidth and, on a metered API, real money. An adapter that cannot filter
 * upstream simply ignores them; the caller filters again regardless, because
 * the threshold is the product's promise and it may not depend on five
 * different sources each being trusted to honour it.
 */
export interface LatestShortsQuery {
  /** Max rows to ask the source for. A ceiling on cost, not a target. */
  readonly limit: number;
  /** The view threshold, so a source that can filter, does. */
  readonly minViews: number;
  /**
   * The shortest a video may be, in seconds. Zero means no floor.
   *
   * IT IS A PREFERENCE AND THE CEILING IS A DEFINITION, which is why they read
   * so differently in the comments either side of this one. Nothing about a
   * three-second clip stops it being a Short; an operator who does not want to
   * scroll past six-second loops is expressing taste, and this is where that
   * taste is applied. It defaults to nothing being excluded for exactly that
   * reason — a floor nobody asked for would silently shrink the inventory.
   */
  readonly minDurationSeconds: number;
  /** The Shorts duration ceiling in seconds — the only thing defining a Short. */
  readonly maxDurationSeconds: number;
}

/** What a platform adapter must be able to do. Four methods. No more. */
export interface PlatformAdapter {
  /** Which platform this reads. Recorded on every row, so provenance is never guessed. */
  readonly platform: Platform;

  /**
   * A human sentence for the UI: what this adapter is and what it needs.
   *
   * Shown next to the platform whether or not it can run, so an operator
   * looking at an empty group can tell "yt-dlp reads the public TikTok page,
   * needs no key" from "needs a data provider nobody has chosen yet". Plain
   * prose, no jargon, no key material.
   */
  describe(): string;

  /**
   * Can this adapter run right now?
   *
   * NULL MEANS YES — nothing is missing, go ahead. A STRING is the reason it
   * CANNOT, written for a person: which key is absent, which provider has not
   * been chosen, which upstream is broken. The name is the semantics: it is the
   * reason for being unavailable, so having one means unavailable.
   *
   * Callers must ask this BEFORE `latestShorts`, and must render the returned
   * sentence rather than an empty list. See the honesty rule above.
   */
  unavailableReason(): Promise<string | null>;

  /**
   * The latest shorts this platform can show us, newest-first from the source.
   *
   * Only called when `unavailableReason()` returned null. An adapter that finds
   * itself unable to read mid-run throws — it does not return `[]`.
   */
  latestShorts(query: LatestShortsQuery): Promise<ShortRecord[]>;

  /**
   * Resolve a direct media URL, ON DEMAND. Null when this adapter cannot.
   *
   * WHY THIS IS RESOLVED ON DEMAND AND NEVER STORED: a direct media URL from
   * any of these platforms is signed and expires in minutes to hours. Storing
   * one produces a table full of dead links that look alive — the worst
   * possible failure, because nothing about the row says it has rotted until
   * somebody clicks it. The canonical post `url` on the record is what
   * persists; this is resolved at the moment a person actually wants the file.
   *
   * Null is a legitimate answer and means "this adapter has no way to get you
   * the file", which the UI must show as such rather than as a broken button.
   */
  downloadUrl(short: ShortRecord): Promise<string | null>;
}
