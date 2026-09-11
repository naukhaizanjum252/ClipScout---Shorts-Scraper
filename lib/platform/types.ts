/**
 * THE PLATFORM VOCABULARY. Every other module imports its nouns from here.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Erik, 2026-09-02: "you scrape ALL platforms, come back with shorts over 500k
 * views categorized by platform". Five platforms, one list. Before this file
 * there was no word for "platform" in the codebase — YouTube was not a value,
 * it was an assumption baked into column names, id formats and regexes. A
 * second platform could not be added without editing every one of them, which
 * is exactly the position this repo was in.
 *
 * IDENTITY IS (platform, platform_video_id). THAT IS THE PRIMARY KEY.
 *
 * There is no global id format and no regex that says what a video id looks
 * like. The previous schema had one: a check constraint asserting an 11-character
 * YouTube video id. It was correct about YouTube and it was the single specific
 * mistake that made this repo single-platform, because a TikTok id is a 19-digit
 * number, an Instagram shortcode is base64-ish and 11 characters of a *different*
 * alphabet, and an X post id is a snowflake. Any one validator that admits all
 * four admits nearly everything, so it validates nothing while still looking
 * like a guarantee. The id is therefore stored AS THAT PLATFORM ISSUES IT, and
 * the `platform` column is what makes it unambiguous.
 *
 * The lesson is not "drop the constraint". It is that a per-platform fact must
 * live behind the per-platform seam (lib/platform/adapter.ts) and never in a
 * shared shape that pretends to be neutral. If a YouTube-shaped assumption comes
 * back — as a regex, as an id parser, as a URL builder with youtube.com in it
 * outside the YouTube adapter — this is the paragraph it violated.
 *
 * EVERY PLATFORM IS FIRST-CLASS HERE EVEN WHERE NOTHING CAN READ IT YET.
 * As of 2026-09-04 only YouTube has a working reader and TikTok has a plausible
 * one; Instagram, X and Facebook have no verified way to enumerate a timeline.
 * That is a fact about ADAPTERS, not about the vocabulary. A platform missing
 * from this list would be a platform the UI cannot even say it failed to read,
 * and "could not be read" must never collapse into "no results".
 */

/**
 * The six. Order is the order the UI groups by, so it is deliberate and not
 * alphabetical: YouTube first because it is the only one that provably works.
 *
 * THREADS IS LAST AND IT IS LAST ON PURPOSE. It joined on 2026-09-08 and it is
 * the only member that can be searched for a subject but can never be measured:
 * Meta's keyword search returns other people's public posts, and Meta's
 * insights endpoint answers for your own media only. So a Threads row arrives
 * with no view count and no duration, every time, by design of the API and not
 * by accident of this build — see lib/platform/threads.ts. Appending rather
 * than inserting also keeps this tuple in the same order as the Postgres enum,
 * where `alter type ... add value` appends unless told otherwise. Two lists
 * that disagree about order would be a diffing hazard nobody would look for.
 */
export const PLATFORMS = ["youtube", "tiktok", "instagram", "x", "facebook", "threads"] as const;

export type Platform = (typeof PLATFORMS)[number];

/**
 * One short, normalised, from any platform.
 *
 * Snake_case because this shape crosses the wire into the database and a rename
 * in the middle is a bug waiting to happen.
 *
 * EVERY COUNT IS NULLABLE AND NULL MEANS "THE SOURCE DID NOT SAY". It does not
 * mean zero. A short with `view_count: null` has not been shown to be under the
 * threshold and has not been shown to be over it; whatever the filter does with
 * that, it must do it knowingly. Same for `duration_seconds`, which is the only
 * thing that defines a Short — a null duration is not a Short and must never be
 * filed as one.
 */
export interface ShortRecord {
  readonly platform: Platform;
  /** The id AS THAT PLATFORM ISSUES IT. Never reformatted, never validated by shape. */
  readonly platform_video_id: string;
  /**
   * Canonical post URL, ALWAYS PRESENT.
   *
   * This is the link that survives. It is the half of Erik's "links to download
   * them" that can be stored, because it does not expire — see `downloadUrl` on
   * the adapter for the half that cannot.
   */
  readonly url: string;
  readonly title: string | null;
  readonly creator_handle: string | null;
  readonly creator_id: string | null;
  readonly creator_url: string | null;
  readonly duration_seconds: number | null;
  readonly view_count: number | null;
  readonly like_count: number | null;
  readonly comment_count: number | null;
  readonly published_at: string | null;
  readonly thumbnail_url: string | null;
  readonly discovered_at: string;
  /** Which adapter/run found it. Provenance is recorded, never inferred later. */
  readonly discovered_by: string;
  /**
   * The topic this row was SEARCHED FOR, or null when nothing was.
   *
   * Null is not "we do not know what this is about" — it is "no subject was
   * asked for", which is what an untargeted read of a seeded channel is. That
   * distinction is the whole of Luka's 2026-09-05 complaint: a run with no
   * subject returns the biggest Shorts on earth, and a row from one must never
   * be presented as though it answered a question about Shark Tank.
   *
   * IT IS SET BY THE ADAPTER THAT DID THE SEARCHING, not by the caller
   * afterwards. The adapter is the only object that knows which of its requests
   * produced which row — a topic run over three phrases makes three requests,
   * and labelling the merged list later would be the run asserting a provenance
   * it did not observe. See lib/platform/topical.ts.
   *
   * A slug and not a name or an id, because it has to survive a topic being
   * renamed and has to be readable in a log without a join.
   */
  readonly topic_slug: string | null;
}

/**
 * How a platform is spelled for a human.
 *
 * A lookup and not a capitalise-the-first-letter, because four of the six are
 * wrong under that rule: YouTube has a capital T, TikTok has a capital T,
 * Instagram and Threads are the well-behaved ones, and X is a single capital
 * letter that `"x".toUpperCase()` would get right by accident and
 * `"x"[0].toUpperCase() + "x".slice(1)` would too — right up until the day the
 * list gains a platform where it is wrong. Spell them out once.
 */
const LABELS: Readonly<Record<Platform, string>> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
};

export function platformLabel(platform: Platform): string {
  return LABELS[platform];
}

/** Thrown by `parsePlatform` when a value is not one of the six. */
export class UnknownPlatformError extends Error {
  constructor(readonly raw: unknown) {
    super(
      `Not a platform: ${JSON.stringify(raw)}. Expected one of ${PLATFORMS.join(", ")}.`,
    );
    this.name = "UnknownPlatformError";
  }
}

/** Narrowing test for callers that want to branch rather than throw. */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Turn an outside string — a query parameter, a database row, a provider's
 * payload — into a `Platform`, or REFUSE.
 *
 * IT HAS NO DEFAULT AND IT NEVER WILL. Falling back to "youtube" on an
 * unrecognised value is the cheapest possible bug to write and one of the most
 * expensive to find: a mislabelled row looks exactly like a real one, gets
 * grouped under the wrong heading, and is only ever caught by somebody noticing
 * that a TikTok is filed under YouTube. A rejected row announces itself at the
 * boundary, where the caller still knows what it was reading.
 *
 * It normalises case and surrounding whitespace, because "X" is how that
 * platform spells itself and `?platform=YouTube` is how a person types a URL.
 * It does NOT translate foreign vocabulary — yt-dlp says "twitter", some
 * providers say "ig" or "reels". Those are that source's words, and mapping
 * them belongs in the adapter that meets them, where somebody can be sure the
 * mapping is right. A synonym table here would be this file guessing on behalf
 * of code it cannot see.
 */
export function parsePlatform(raw: unknown): Platform {
  if (typeof raw !== "string") throw new UnknownPlatformError(raw);
  const normalised = raw.trim().toLowerCase();
  if (!isPlatform(normalised)) throw new UnknownPlatformError(raw);
  return normalised;
}
