/**
 * What a topic is, and the two rules that keep one honest.
 *
 * The interesting assertions here are not the string munging — they are
 * `matchesTopic` refusing to match on the `#shorts` token, and `topicProblems`
 * refusing a topic with no terms. Both of those are the difference between
 * "this run searched for Shark Tank" and "this run searched for everything and
 * called it Shark Tank", which is the complaint the whole feature answers.
 */
import { describe, expect, it } from "vitest";

import type { ShortRecord } from "../platform/types";
import {
  cleanTerms,
  matchesTopic,
  planTopics,
  PLAN_TOPICS,
  slugify,
  topicProblems,
  youtubeSearchTerm,
} from "./topics";

function aShort(over: Partial<ShortRecord> = {}): ShortRecord {
  return {
    platform: "youtube",
    platform_video_id: "abc",
    url: "https://example.test/abc",
    title: null,
    creator_handle: null,
    creator_id: null,
    creator_url: null,
    duration_seconds: 30,
    view_count: 800_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-05T00:00:00.000Z",
    discovered_by: "test",
    topic_slug: null,
    ...over,
  };
}

describe("slugify", () => {
  it("drops an apostrophe rather than hyphenating it", () => {
    // `america-s-got-talent` would be the naive answer and it is ugly in every
    // URL and log line it ever appears in.
    expect(slugify("America's Got Talent")).toBe("americas-got-talent");
    expect(slugify("America’s Got Talent")).toBe("americas-got-talent");
  });

  it("strips accents rather than dropping the letters they sit on", () => {
    expect(slugify("Café Clips")).toBe("cafe-clips");
  });

  it("produces the empty string for a name with nothing addressable in it", () => {
    // Not an error here — `topicProblems` is what refuses it, in a sentence.
    expect(slugify("!!!")).toBe("");
  });

  it("agrees with the check constraint the migration declares", () => {
    const constraint = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const topic of PLAN_TOPICS) {
      expect(constraint.test(slugify(topic.name)), topic.name).toBe(true);
    }
  });
});

describe("cleanTerms", () => {
  it("keeps the first spelling of a case-insensitive duplicate", () => {
    expect(cleanTerms(["Shark Tank", "shark tank", "SHARK TANK"])).toEqual(["Shark Tank"]);
  });

  it("collapses internal whitespace and drops empties", () => {
    expect(cleanTerms(["  top   gear ", "", "   "])).toEqual(["top gear"]);
  });
});

describe("topicProblems", () => {
  it("refuses a topic with no terms, because that is a run with no subject", () => {
    const problems = topicProblems({ name: "Shark Tank", terms: [] });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/at least one search term/i);
  });

  it("reports every problem at once rather than one per submission", () => {
    expect(topicProblems({ name: "", terms: [] }).length).toBe(2);
  });

  it("accepts the plan's own thirty", () => {
    for (const topic of PLAN_TOPICS) {
      expect(topicProblems(topic), topic.name).toEqual([]);
    }
  });
});

describe("youtubeSearchTerm", () => {
  it("appends the token that doubles the Shorts yield", () => {
    expect(youtubeSearchTerm("shark tank")).toBe("shark tank #shorts");
  });

  it("does not append a second copy when the operator typed one", () => {
    expect(youtubeSearchTerm("bodycam #shorts")).toBe("bodycam #shorts");
    expect(youtubeSearchTerm("bodycam #Shorts")).toBe("bodycam #Shorts");
  });
});

describe("matchesTopic", () => {
  const topic = { name: "Shark Tank", terms: ["shark tank pitch", "dragons den"] };

  it("matches on the topic's name", () => {
    expect(matchesTopic(topic, aShort({ title: "The Drip Drop - Shark Tank" }))).toBe(true);
  });

  it("matches on any term, not only the first", () => {
    expect(matchesTopic(topic, aShort({ title: "Best DRAGONS DEN moment" }))).toBe(true);
  });

  it("ignores accents and apostrophes on both sides", () => {
    expect(matchesTopic({ name: "Café", terms: [] }, aShort({ title: "A CAFE story" }))).toBe(true);
  });

  it("does not match a short with no title", () => {
    expect(matchesTopic(topic, aShort({ title: null }))).toBe(false);
  });

  it("NEVER matches on the bare #shorts token", () => {
    // The load-bearing one. `#shorts` appears in the title of a large fraction
    // of all Shorts ever posted, so a topic whose terms carried it would match
    // everything and every row on the page would claim every subject.
    const shortsy = { name: "Shorts", terms: ["#shorts", "shorts"] };
    expect(matchesTopic(shortsy, aShort({ title: "Cat does a backflip #shorts" }))).toBe(false);
  });
});

describe("planTopics", () => {
  it("is the thirty niches from the plan document, all switched on", () => {
    const topics = planTopics(() => new Date("2026-09-05T00:00:00.000Z"));
    expect(topics.length).toBe(30);
    expect(topics.every((t) => t.active)).toBe(true);
    expect(topics.every((t) => t.source === "plan")).toBe(true);
    expect(topics.every((t) => t.terms.length > 0)).toBe(true);
  });

  it("gives every topic a distinct address", () => {
    const slugs = planTopics().map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps NFL and Baseball apart even though they feed one channel", () => {
    // Two searches, so two topics. Folding them would halve the searches and
    // file baseball clips under a football subject.
    const topics = planTopics();
    const nfl = topics.find((t) => t.slug === "nfl");
    const baseball = topics.find((t) => t.slug === "baseball");
    expect(nfl?.publishesTo).toBe("@realnflzone");
    expect(baseball?.publishesTo).toBe("@realnflzone");
    expect(nfl?.terms).not.toEqual(baseball?.terms);
  });
});
