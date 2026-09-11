/**
 * THE HONESTY RULE ON THE SUBJECT AXIS.
 *
 * `adapter.test.ts`-style tests already prove that "could not be read" never
 * arrives as "no results". This file proves the same thing one level down: that
 * "could not be SEARCHED for this subject" never arrives as "this subject has
 * nothing", and — the failure that would be worse — that it never arrives as
 * the untargeted list wearing the subject's name.
 */
import { describe, expect, it } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import {
  asTopical,
  noTopicalReaderReason,
  providerTopicShorts,
  providerTopicUnavailableReason,
  READS_TOPICS,
  type TopicalAdapter,
} from "./topical";
import type { Platform, ShortRecord } from "./types";
import {
  asKeywordSearching,
  PlatformUnavailableError,
  SEARCHES_KEYWORDS,
  type KeywordSearchingProvider,
  type ProviderClient,
} from "./unavailable";
import type { Topic } from "../shorts/topics";

const QUERY: LatestShortsQuery = {
  limit: 10,
  minViews: 500_000,
  minDurationSeconds: 0,
  maxDurationSeconds: 120,
};

function aTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: "shark-tank",
    name: "Shark Tank",
    slug: "shark-tank",
    terms: ["shark tank", "dragons den"],
    active: true,
    source: "plan",
    publishesTo: "@pitchfastnow",
    note: null,
    addedAt: "2026-09-05T00:00:00.000Z",
    ...over,
  };
}

function aShort(platform: Platform, id: string): ShortRecord {
  return {
    platform,
    platform_video_id: id,
    url: `https://example.test/${id}`,
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
  };
}

/** An adapter that reads its platform but cannot be aimed at a subject. */
const plainAdapter: PlatformAdapter = {
  platform: "facebook",
  describe: () => "a plain adapter",
  unavailableReason: async () => null,
  latestShorts: async () => [],
  downloadUrl: async () => null,
};

describe("asTopical", () => {
  it("is null for an adapter that does not declare the capability", () => {
    expect(asTopical(plainAdapter)).toBeNull();
  });

  it("refuses an adapter that declares the symbol without the methods", () => {
    // A symbol is cheap to set and the methods are not. Claiming the capability
    // and then not having it would fail at the moment money is being spent,
    // which is the worst possible time to discover it.
    const liar = { ...plainAdapter, [READS_TOPICS]: true } as unknown as PlatformAdapter;
    expect(asTopical(liar)).toBeNull();
  });

  it("accepts an adapter that declares it properly", () => {
    const honest = {
      ...plainAdapter,
      [READS_TOPICS]: true as const,
      topicUnavailableReason: async () => null,
      latestShortsForTopic: async () => [],
    } satisfies TopicalAdapter;
    expect(asTopical(honest)).toBe(honest);
  });
});

describe("noTopicalReaderReason", () => {
  it("says of Facebook that nobody can search it, not that nothing is configured", () => {
    const reason = noTopicalReaderReason("facebook");
    expect(reason).toMatch(/no data vendor sells Facebook Reels discovery/i);
    // The distinction that matters: a sentence an operator could act on would
    // be a lie here, because there is no action.
    expect(reason).not.toMatch(/save a .* key/i);
  });

  it("names the key for the platforms a key would actually unlock", () => {
    expect(noTopicalReaderReason("tiktok")).toMatch(/ScrapeCreators key/);
    expect(noTopicalReaderReason("instagram")).toMatch(/ScrapeCreators key|ScrapeCreators' /);
    expect(noTopicalReaderReason("x")).toMatch(/bearer token/i);
  });
});

describe("the provider-backed halves", () => {
  function aProvider(rows: readonly ShortRecord[]): KeywordSearchingProvider & { asked: string[][] } {
    const asked: string[][] = [];
    return {
      asked,
      [SEARCHES_KEYWORDS]: true as const,
      latestShorts: async () => {
        throw new Error("the untargeted read must not be reached by a topic run");
      },
      downloadUrl: async () => null,
      latestShortsForKeywords: async (keywords) => {
        asked.push([...keywords]);
        return [...rows];
      },
    };
  }

  it("refuses when there is no provider, naming the key", async () => {
    const reason = await providerTopicUnavailableReason("tiktok", null, aTopic());
    expect(reason).toMatch(/ScrapeCreators/);
  });

  it("refuses when the provider cannot be asked for words", async () => {
    const plain: ProviderClient = { latestShorts: async () => [], downloadUrl: async () => null };
    expect(asKeywordSearching(plain)).toBeNull();
    expect(await providerTopicUnavailableReason("tiktok", plain, aTopic())).toMatch(/ScrapeCreators/);
  });

  it("refuses a topic with no terms rather than searching for nothing", async () => {
    const reason = await providerTopicUnavailableReason(
      "tiktok",
      aProvider([]),
      aTopic({ terms: [] }),
    );
    expect(reason).toMatch(/no search terms/i);
  });

  it("sends the terms and labels every row with the subject that found it", async () => {
    const provider = aProvider([aShort("tiktok", "1"), aShort("tiktok", "2")]);
    const rows = await providerTopicShorts("tiktok", provider, aTopic(), QUERY);

    expect(provider.asked).toEqual([["shark tank", "dragons den"]]);
    expect(rows.map((r) => r.topic_slug)).toEqual(["shark-tank", "shark-tank"]);
  });

  it("THROWS rather than falling back to the untargeted read", async () => {
    // The whole point. A provider that cannot search must not quietly answer
    // with the everything-that-is-big list — the fake above throws if
    // `latestShorts` is reached, and this asserts the refusal happens first.
    await expect(providerTopicShorts("tiktok", null, aTopic(), QUERY)).rejects.toBeInstanceOf(
      PlatformUnavailableError,
    );
  });
});
