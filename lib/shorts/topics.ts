/**
 * WHAT KIND OF SHORT TO LOOK FOR.
 *
 * Luka, 2026-09-05, with a screenshot of /admin/shorts: "we need to tell it
 * what kinds of shorts to look for ... we need the scraper to be able to
 * search for those specific clips, not any random shorts with 500k+ views."
 *
 * That is a gap in the product's vocabulary, not a bug in its filters. Until
 * this file the tool had exactly two questions — how many views, how many
 * seconds — and both are SIZE. Nothing anywhere said SUBJECT. A run therefore
 * returned the biggest Shorts on earth, which is what was asked for and not
 * what is wanted: the client's plan (the "Lucky Plan" doc, read 2026-09-05)
 * is thirty niche channels, and a Shark Tank channel cannot be fed by whatever
 * happened to cross 500,000 views today.
 *
 * A TOPIC IS A SUBJECT PLUS THE WORDS THAT FIND IT. Nothing more. It is not a
 * category to file results under after the fact — that would still fetch the
 * same random inventory and then throw most of it away. It is pushed DOWN into
 * the source, so YouTube is asked for "shark tank #shorts" and the vendor APIs
 * are asked for the same words through their own keyword endpoints.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TERMS ARE A LIST AND WHY THE FIRST ONE IS NOT SPECIAL
 * ---------------------------------------------------------------------------
 *
 * One phrase per topic would be simpler and it loses the topics that are a
 * subject rather than a title. "Shark Tank" is a proper noun and one phrase
 * finds it; "Respect Moments" is not a thing anybody types, and the clips
 * behind it are found by "act of kindness", "restored my faith in humanity"
 * and half a dozen neighbours. So terms are a LIST, each searched separately,
 * and the union is the topic's catch. Every term is equal — there is no
 * primary — because a ranking between them would be a guess this file is not
 * in a position to make and an operator can express by deleting the bad ones.
 *
 * ---------------------------------------------------------------------------
 * THE #shorts SUFFIX IS MEASURED, NOT DECORATIVE
 * ---------------------------------------------------------------------------
 *
 * Recorded on this machine, yt-dlp 2026.07.04, 2026-09-05, 100 entries pulled
 * per query, counting how many were at or under 120 seconds and how many of
 * those also cleared 500,000 views:
 *
 *   ytsearch100:shark tank #shorts          13 shorts, 3 over 500k
 *   ytsearch100:shark tank shorts            6 shorts, 2 over 500k
 *   youtube.com/hashtag/sharktankshorts      0 entries — the tag does not exist
 *   youtube.com/hashtag/sharktank           25 entries, 0 at or under 120s
 *   ?search_query=shark+tank&sp=EgIYAQ==     7 entries, 1 at or under 120s
 *                                            (YouTube's own "short" filter)
 *
 * So: the #shorts token roughly doubles the Shorts yield over the bare word
 * "shorts"; a TOPICAL hashtag feed is a long-form feed and is useless here
 * (only the generic #shorts tag behaves, which is why lib/platform/youtube-
 * discover.ts uses those and this file does not); and YouTube's built-in
 * duration filter means "under four minutes", exactly as lib/platform/
 * youtube.ts already records against `search.list`, so it does not select
 * Shorts either.
 *
 * THE YIELD IS LOW AND THAT IS THE HONEST NUMBER. Three rows per hundred
 * fetched, for a topic as big as Shark Tank. A niche topic will do worse. That
 * is a fact about how much 500,000-view Shorts content exists on a given
 * subject, and the answer to it is an operator lowering the threshold for
 * narrow topics — not this file quietly widening the search until something
 * comes back.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not decide which platform can serve a topic. Three of five cannot
 * search at all, for reasons recorded per adapter, and pretending otherwise
 * here would put the dishonesty in the one place nobody looks. See
 * lib/platform/topical.ts, which is the seam that has to answer that question
 * in a sentence.
 */
import type { ShortRecord } from "../platform/types";

/**
 * A subject to search for, and the words that find it.
 *
 * camelCase rather than the snake_case of `ShortRecord`, because unlike that
 * shape this one is mapped column by column on its way to and from the
 * database — see `SupabaseTopicStore`, where every name is written out once.
 */
export interface Topic {
  /** Stable id. A uuid from the database, or the slug when the list is built in code. */
  readonly id: string;
  /** What a person calls it. "Shark Tank". Shown everywhere. */
  readonly name: string;
  /** URL- and log-safe form of the name. Unique; this is the topic's address. */
  readonly slug: string;
  /**
   * The searches. Each is sent separately and the results are unioned.
   *
   * NEVER EMPTY. A topic with no terms is a subject nothing can be asked for,
   * which is a topic that cannot run — `topicProblems` refuses it rather than
   * letting it become a run that reads everything.
   */
  readonly terms: readonly string[];
  /** Off means "do not search for this", not "delete it". History is kept. */
  readonly active: boolean;
  /** 'plan' = shipped from the client's plan document. 'manual' = somebody typed it. */
  readonly source: TopicSource;
  /**
   * The channel this topic's clips are being gathered FOR, when the plan names
   * one. Display only — nothing reads it, nothing posts to it. It exists so an
   * operator looking at a row can tell which of the thirty channels it feeds.
   */
  readonly publishesTo: string | null;
  readonly note: string | null;
  readonly addedAt: string;
}

export type TopicSource = "plan" | "manual";

/**
 * A TOPIC AS SOMETHING ELSE REFERS TO IT: the address, and the word for it.
 *
 * Two fields rather than one, and the second one is why this exists. A run is
 * recorded, stored as JSON and put back on screen days later, and a stored
 * `"shark-tank"` on its own is a caption that has to go and look the name up —
 * from a list the topic may since have been deleted from. Carrying the name
 * means the report can say what it was looking for without asking anybody, the
 * same call `PlatformSpend` makes by carrying its platform.
 *
 * IT IS NOT A `Topic`. Terms, `active` and `publishesTo` are the editable state
 * of a subject and they change; a reference to one is a fact about a run that
 * already happened, and copying the mutable half into it would make a report
 * quietly disagree with itself the moment somebody edited a term.
 */
export interface TopicRef {
  readonly slug: string;
  readonly name: string;
}

/** The reference to a topic. A narrowing, never a copy — see `TopicRef`. */
export function topicRef(topic: Pick<Topic, "slug" | "name">): TopicRef {
  return { slug: topic.slug, name: topic.name };
}

/** What a caller may set. The store fills in id, addedAt and the defaults. */
export interface NewTopic {
  readonly name: string;
  readonly terms: readonly string[];
  readonly active?: boolean;
  readonly source?: TopicSource;
  readonly publishesTo?: string | null;
  readonly note?: string | null;
}

/**
 * The two character classes that get stripped before anything is compared or
 * addressed. Written as escapes rather than as literal characters, because a
 * literal combining acute in a source file is invisible in every diff it ever
 * appears in and an editor that normalises the file silently changes the rule.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const APOSTROPHES = /['\u2019]/g;

/**
 * Slug rules, in one place because the database has the same ones as a check
 * constraint and the two must not drift.
 *
 * Lowercase, ASCII letters and digits, single hyphens between them. An
 * apostrophe is DROPPED rather than hyphenated so "America's Got Talent"
 * becomes `americas-got-talent` and not `america-s-got-talent`.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The longest a term may be. A paragraph is not a search. */
export const MAX_TERM_LENGTH = 120;
/** The most terms one topic may carry. Each term is a request; this is a cost ceiling. */
export const MAX_TERMS = 12;

/**
 * Everything wrong with a proposed topic, as sentences for a person, or an
 * empty array when it is fine.
 *
 * PLURAL ON PURPOSE. A form that reports one problem, gets it fixed, then
 * reports the next is a form somebody submits four times.
 */
export function topicProblems(topic: NewTopic): string[] {
  const problems: string[] = [];
  const name = typeof topic.name === "string" ? topic.name.trim() : "";

  if (!name) {
    problems.push("A topic needs a name — what a person would call this kind of clip.");
  } else if (name.length > 80) {
    problems.push(`That name is ${name.length} characters; 80 is the most.`);
  } else if (!slugify(name)) {
    problems.push(
      `"${name}" has no letters or digits in it, so it cannot be addressed. Give it a name a ` +
        "person would type.",
    );
  }

  const terms = cleanTerms(topic.terms ?? []);
  if (terms.length === 0) {
    problems.push(
      "A topic needs at least one search term. Without one there is nothing to ask any platform " +
        "for, and the run would fall back to reading everything — which is the exact problem " +
        "topics exist to fix.",
    );
  }
  if (terms.length > MAX_TERMS) {
    problems.push(
      `${terms.length} search terms is more than the ${MAX_TERMS} allowed. Every term is its own ` +
        "request to every platform, so the list is a cost as well as a net.",
    );
  }
  for (const term of terms) {
    if (term.length > MAX_TERM_LENGTH) {
      problems.push(
        `"${term.slice(0, 40)}…" is ${term.length} characters; ${MAX_TERM_LENGTH} is the most.`,
      );
    }
  }

  return problems;
}

/**
 * Trim, drop empties, and de-duplicate case-insensitively while KEEPING the
 * first spelling somebody typed.
 *
 * The order is deliberate: an operator who wrote "Shark Tank" and later
 * "shark tank" meant one search, and the one they see in the list should be
 * the one they wrote first rather than whichever the comparison happened to
 * favour.
 */
export function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * The token appended to a YouTube search so the results are Shorts.
 *
 * Kept here rather than in the adapter because the measurement that justifies
 * it is in this file's header, and a suffix whose evidence lives in another
 * module is a suffix somebody deletes as noise.
 */
export const SHORTS_TOKEN = "#shorts";

/**
 * One term, as YouTube should be asked for it.
 *
 * The token is not appended when the term already carries it, so an operator
 * who typed `bodycam #shorts` gets one copy and not two.
 */
export function youtubeSearchTerm(term: string): string {
  const t = term.trim().replace(/\s+/g, " ");
  return /#shorts\b/i.test(t) ? t : `${t} ${SHORTS_TOKEN}`;
}

/**
 * Does this row look like it is actually about the topic?
 *
 * WHY THIS EXISTS ALONGSIDE THE SEARCH. Two different paths produce rows and
 * only one of them was aimed:
 *
 *   A topical search returns what the platform thought matched. Platforms pad.
 *   A seeded-channel walk returns everything that channel posted, and a channel
 *   that is on the seed list because it posts Shark Tank clips also posts
 *   other things.
 *
 * So a row is checked against the topic's own words before it is called a
 * confident match. It is a TEXT test on the title, which is all a listing
 * gives us, and it is deliberately a weak one — see below.
 *
 * IT IS A LABEL, NOT A GATE, AND THE DIFFERENCE MATTERS. A false negative here
 * would throw away a real result whose title happens not to repeat the search
 * words, which is most good Shorts titles. So callers use this to say "this row
 * is confidently about the topic" and NOT to decide whether to keep it. What is
 * kept is what the search returned; what is flagged is what this agrees with.
 */
export function matchesTopic(topic: Pick<Topic, "terms" | "name">, short: ShortRecord): boolean {
  const haystack = normaliseForMatch(short.title ?? "");
  if (!haystack) return false;
  for (const term of [topic.name, ...topic.terms]) {
    const needle = normaliseForMatch(term).replace(/#/g, "");
    // The bare `#shorts` token matches every Short ever posted and would make
    // every topic match everything. It is a search hint, never evidence.
    if (!needle || needle === "shorts") continue;
    if (haystack.includes(needle)) return true;
  }
  return false;
}

/** Lowercase, accent-stripped, whitespace-collapsed. Comparison only. */
function normaliseForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE THIRTY NICHES FROM THE CLIENT'S PLAN, as shipped defaults.
 *
 * Source: the "Lucky Plan" document Luka linked on 2026-09-05. The NAME and the
 * `publishesTo` handle are read straight out of that document and are not
 * invented. THE SEARCH TERMS ARE NOT IN THE DOCUMENT — it names each niche and
 * gives example clips, and somebody has to turn "Respect Moments" into words a
 * search engine answers. These are that translation, and they are a starting
 * point an operator is expected to edit: they ship as ordinary editable rows,
 * not as constants the UI cannot reach.
 *
 * TWO PAIRS SHARE A CHANNEL in the plan — NFL and Baseball both feed
 * @realnflzone, American Artists and Female Artists both feed
 * @realtalentartists. They stay four topics, because they are four searches.
 */
export const PLAN_TOPICS: readonly NewTopic[] = [
  {
    name: "Wholesome Animal",
    publishesTo: "@animalsdreamtoo",
    terms: ["wholesome animal", "animal rescue", "cute animal moment"],
  },
  {
    name: "Respect Moments",
    publishesTo: "@yougottarespect",
    terms: ["respect moment", "act of kindness", "restored my faith in humanity"],
  },
  {
    name: "Military Clips",
    publishesTo: "@salutenow",
    terms: ["military moment", "soldier homecoming", "armed forces"],
  },
  {
    name: "Brave Risks",
    publishesTo: "@abitbrave",
    terms: ["brave rescue", "close call", "dangerous stunt"],
  },
  {
    name: "Smart Animals",
    publishesTo: "@sosoclever",
    terms: ["smart animal", "clever animal", "animal intelligence"],
  },
  {
    name: "Rich People Moves",
    publishesTo: "@wiredbymoney",
    terms: ["rich people", "luxury lifestyle", "millionaire mindset"],
  },
  {
    name: "Famous Chef Clips",
    publishesTo: "@thechefster",
    terms: ["gordon ramsay", "famous chef", "chef reaction"],
  },
  {
    name: "Top Gear Clips",
    publishesTo: "@topofgear",
    terms: ["top gear", "the grand tour", "jeremy clarkson"],
  },
  {
    name: "Car Facts",
    publishesTo: "@realmotorhub",
    terms: ["car facts", "supercar fact", "car engineering"],
  },
  {
    name: "NFL",
    publishesTo: "@realnflzone",
    terms: ["nfl highlight", "nfl moment", "football touchdown"],
  },
  {
    name: "Baseball",
    publishesTo: "@realnflzone",
    terms: ["mlb highlight", "baseball moment", "home run"],
  },
  {
    name: "NBA",
    publishesTo: "@faststepball",
    terms: ["nba highlight", "nba moment", "basketball crossover"],
  },
  {
    name: "American Rappers",
    publishesTo: "@nahthisisrap",
    terms: ["rapper interview", "rap freestyle", "hip hop moment"],
  },
  {
    name: "American Artists",
    publishesTo: "@realtalentartists",
    terms: ["live vocal performance", "singer live", "artist performance"],
  },
  {
    name: "Female Artists",
    publishesTo: "@realtalentartists",
    terms: ["female singer live", "female artist performance", "female vocalist"],
  },
  {
    name: "Bodycam",
    publishesTo: "@camonbodies",
    terms: ["bodycam footage", "police bodycam", "bodycam arrest"],
  },
  {
    name: "Family Guy",
    publishesTo: "@familyofguys",
    terms: ["family guy", "peter griffin", "family guy funny moment"],
  },
  {
    name: "Simpsons",
    publishesTo: "@simpofthesons",
    terms: ["the simpsons", "homer simpson", "simpsons prediction"],
  },
  {
    name: "Business Advice",
    publishesTo: "@nowthisisrich",
    terms: ["business advice", "entrepreneur advice", "business lesson"],
  },
  {
    name: "Shark Tank",
    publishesTo: "@pitchfastnow",
    terms: ["shark tank", "shark tank pitch", "dragons den"],
  },
  {
    name: "America's Got Talent",
    publishesTo: "@wowrealtalent",
    terms: ["americas got talent", "agt audition", "golden buzzer"],
  },
  {
    name: "Breaking Bad",
    publishesTo: "@breakingitsobad",
    terms: ["breaking bad", "walter white", "better call saul"],
  },
  {
    name: "Funny Movie Clips",
    publishesTo: "@makeurdayclips",
    terms: ["funny movie clip", "funny movie scene", "comedy movie moment"],
  },
  {
    name: "Artists Making Music",
    publishesTo: "@secretartistcam",
    terms: ["making a beat", "studio session", "producing a song"],
  },
  {
    name: "Funny Celebrities",
    publishesTo: "@celebshavefun",
    terms: ["funny celebrity moment", "celebrity interview funny", "celebrity bloopers"],
  },
  {
    name: "Court Cases",
    publishesTo: "@courtisnojoke",
    terms: ["courtroom moment", "court case", "judge reaction"],
  },
  {
    name: "Technology",
    publishesTo: "@seriousbitoftech",
    terms: ["new technology", "tech gadget", "future tech"],
  },
  {
    name: "Golf",
    publishesTo: "@holeinshorts",
    terms: ["golf shot", "golf highlight", "pga tour"],
  },
  {
    name: "Gangster Films",
    publishesTo: "@realgmovies",
    terms: ["gangster movie scene", "mafia movie", "goodfellas scene"],
  },
  {
    name: "Streamer Clips",
    publishesTo: "@ohtheystreamin",
    terms: ["streamer clip", "twitch clip", "streamer reaction"],
  },
];

/** The plan's topics as full `Topic` values, for the storeless path and for tests. */
export function planTopics(now: () => Date = () => new Date()): Topic[] {
  const addedAt = now().toISOString();
  return PLAN_TOPICS.map((t) => ({
    id: slugify(t.name),
    name: t.name,
    slug: slugify(t.name),
    terms: cleanTerms(t.terms),
    active: true,
    source: "plan" as const,
    publishesTo: t.publishesTo ?? null,
    note: "From the client's plan document, 2026-09-05.",
    addedAt,
  }));
}
