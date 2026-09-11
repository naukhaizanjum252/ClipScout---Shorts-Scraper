/**
 * WHAT A RUN WITH TOPICS REPORTS.
 *
 * Three rules, and every one of them is a way the screen could lie:
 *
 *   A platform that cannot be searched is `unavailable`, never an empty `ok`.
 *   A platform that refused every topic is `unavailable`, never an empty `ok`.
 *   A platform that can be searched is never asked for its untargeted list.
 *
 * The third is the one Luka actually reported. The first two are the shapes it
 * would come back as if somebody "fixed" the third carelessly.
 */
import { describe, expect, it } from "vitest";

import type { LatestShortsQuery, PlatformAdapter } from "../platform/adapter";
import { READS_TOPICS, type TopicalAdapter } from "../platform/topical";
import type { Platform, ShortRecord } from "../platform/types";
import { MemoryShortsStore } from "./memory-store";
import { getLatestShorts, ran } from "./run";
import type { Topic } from "./topics";

function aTopic(slug: string, terms: string[] = ["a phrase"]): Topic {
  return {
    id: slug,
    name: slug,
    slug,
    terms,
    active: true,
    source: "manual",
    publishesTo: null,
    note: null,
    addedAt: "2026-09-05T00:00:00.000Z",
  };
}

function aShort(platform: Platform, id: string, topicSlug: string | null): ShortRecord {
  return {
    platform,
    platform_video_id: id,
    url: `https://example.test/${platform}/${id}`,
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
    topic_slug: topicSlug,
  };
}

/** Reads its platform, cannot be aimed. Facebook, permanently. */
class PlainAdapter implements PlatformAdapter {
  untargetedReads = 0;
  constructor(readonly platform: Platform) {}
  describe() {
    return "plain";
  }
  async unavailableReason() {
    return null;
  }
  async latestShorts(): Promise<ShortRecord[]> {
    this.untargetedReads += 1;
    return [aShort(this.platform, "untargeted", null)];
  }
  async downloadUrl() {
    return null;
  }
}

/** Can be aimed. `refuse` names the slugs it will not search for. */
class TopicAdapter implements TopicalAdapter {
  readonly [READS_TOPICS] = true as const;
  untargetedReads = 0;
  readonly searched: string[] = [];

  constructor(
    readonly platform: Platform,
    private readonly refuse: ReadonlySet<string> = new Set(),
  ) {}

  describe() {
    return "topical";
  }
  async unavailableReason() {
    return null;
  }
  async latestShorts(): Promise<ShortRecord[]> {
    this.untargetedReads += 1;
    return [aShort(this.platform, "untargeted", null)];
  }
  async downloadUrl() {
    return null;
  }
  async topicUnavailableReason(topic: Topic) {
    return this.refuse.has(topic.slug) ? `no reader for ${topic.slug}` : null;
  }
  async latestShortsForTopic(topic: Topic, _query: LatestShortsQuery): Promise<ShortRecord[]> {
    this.searched.push(topic.slug);
    return [aShort(this.platform, `${topic.slug}-1`, topic.slug)];
  }
}

const RUN = {
  limit: 10,
  minViews: 500_000,
  maxDurationSeconds: 120,
  now: () => "2026-09-05T00:00:00.000Z",
};

describe("a run with topics", () => {
  it("searches every topic and never asks for the untargeted list", async () => {
    const youtube = new TopicAdapter("youtube");

    const report = await getLatestShorts({
      ...RUN,
      adapters: [youtube],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
      topics: [aTopic("shark-tank"), aTopic("top-gear")],
    });

    // THE ASSERTION LUKA'S COMPLAINT IS ABOUT.
    expect(youtube.untargetedReads).toBe(0);
    expect(youtube.searched).toEqual(["shark-tank", "top-gear"]);

    const outcome = report.platforms.find((o) => o.platform === "youtube")!;
    expect(outcome.status).toBe("ok");
    expect(ran(outcome) && outcome.topics).toEqual({
      searched: ["shark-tank", "top-gear"],
      refused: [],
    });
    expect(report.shorts.map((s) => s.topic_slug)).toEqual(["shark-tank", "top-gear"]);
  });

  it("reports a platform with no topical reader as unavailable, NOT as empty", async () => {
    const facebook = new PlainAdapter("facebook");

    const report = await getLatestShorts({
      ...RUN,
      adapters: [facebook],
      store: new MemoryShortsStore(),
      platforms: ["facebook"],
      topics: [aTopic("shark-tank")],
    });

    const outcome = report.platforms.find((o) => o.platform === "facebook")!;
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/no data vendor sells/i);
    // And it was NOT quietly read the old way to fill the page.
    expect(facebook.untargetedReads).toBe(0);
    expect(report.shorts).toEqual([]);
  });

  it("reports a platform that refused every topic as unavailable, NOT as empty", async () => {
    const tiktok = new TopicAdapter("tiktok", new Set(["shark-tank", "top-gear"]));

    const report = await getLatestShorts({
      ...RUN,
      adapters: [tiktok],
      store: new MemoryShortsStore(),
      platforms: ["tiktok"],
      topics: [aTopic("shark-tank"), aTopic("top-gear")],
    });

    const outcome = report.platforms.find((o) => o.platform === "tiktok")!;
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(
      /None of the 2 topics asked for could be searched/,
    );
    // The sentence has to say this is not a finding about the platform.
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/NOT a report/);
    expect(tiktok.untargetedReads).toBe(0);
  });

  it("keeps the topics it could search when one is refused", async () => {
    // One broken subject must not cost the other twenty-nine — the same rule
    // one bad seed must not cost a platform.
    const youtube = new TopicAdapter("youtube", new Set(["top-gear"]));

    const report = await getLatestShorts({
      ...RUN,
      adapters: [youtube],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
      topics: [aTopic("shark-tank"), aTopic("top-gear")],
    });

    const outcome = report.platforms.find((o) => o.platform === "youtube")!;
    expect(outcome.status).toBe("ok");
    expect(ran(outcome) && outcome.topics).toEqual({
      searched: ["shark-tank"],
      refused: [{ slug: "top-gear", reason: "no reader for top-gear" }],
    });
    expect(report.shorts.map((s) => s.topic_slug)).toEqual(["shark-tank"]);
  });

  it("drops a topic with no terms before any platform is asked about it", async () => {
    // Otherwise one malformed row is counted as a refusal five times over.
    const youtube = new TopicAdapter("youtube");

    const report = await getLatestShorts({
      ...RUN,
      adapters: [youtube],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
      topics: [aTopic("shark-tank"), aTopic("empty", [])],
    });

    const outcome = report.platforms.find((o) => o.platform === "youtube")!;
    expect(ran(outcome) && outcome.topics).toEqual({ searched: ["shark-tank"], refused: [] });
  });

  it("makes the untargeted run when no topics are given", async () => {
    // Every caller that existed before topics did — the CLI, the cron route —
    // has to keep working unchanged.
    const youtube = new TopicAdapter("youtube");

    const report = await getLatestShorts({
      ...RUN,
      adapters: [youtube],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
    });

    expect(youtube.untargetedReads).toBe(1);
    expect(youtube.searched).toEqual([]);
    const outcome = report.platforms.find((o) => o.platform === "youtube")!;
    expect(ran(outcome) && outcome.topics).toBeUndefined();
  });
});

/**
 * A RUN NARROWED TO ONE SUBJECT SAYS SO, AND CANNOT SAY IT FALSELY.
 *
 * The report is stored and put back on screen days later, where it captions a
 * table that looks identical whichever run made it. So `topic` is the one field
 * that says "this is the Shark Tank list and not the list" — and the only way
 * it could mislead is by disagreeing with what was actually searched, which is
 * why the run refuses that rather than reporting it.
 */
describe("a run narrowed to one subject", () => {
  it("records the subject on the report, so a stored list cannot be read as the whole of it", async () => {
    const youtube = new TopicAdapter("youtube");

    const report = await getLatestShorts({
      ...RUN,
      adapters: [youtube],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
      topics: [aTopic("shark-tank")],
      topic: { slug: "shark-tank", name: "Shark Tank" },
    });

    expect(report.topic).toEqual({ slug: "shark-tank", name: "Shark Tank" });
    expect(youtube.searched).toEqual(["shark-tank"]);
  });

  it("leaves the field off entirely when nobody narrowed anything", async () => {
    const report = await getLatestShorts({
      ...RUN,
      adapters: [new TopicAdapter("youtube")],
      store: new MemoryShortsStore(),
      platforms: ["youtube"],
      topics: [aTopic("shark-tank"), aTopic("top-gear")],
    });

    // ABSENT, not null and not one of the two. The report is stored as JSON and
    // a present-but-empty field is a different thing to read back.
    expect("topic" in report).toBe(false);
  });

  it("refuses a run whose stated subject is not the one it would search, before anything is read", async () => {
    const youtube = new TopicAdapter("youtube");

    await expect(
      getLatestShorts({
        ...RUN,
        adapters: [youtube],
        store: new MemoryShortsStore(),
        platforms: ["youtube"],
        topics: [aTopic("shark-tank"), aTopic("top-gear")],
        topic: { slug: "shark-tank", name: "Shark Tank" },
      }),
    ).rejects.toThrow(/narrowed to "shark-tank"/);

    // NOTHING WAS READ. The refusal is the whole point: a report claiming one
    // subject over two subjects' rows would be believed.
    expect(youtube.searched).toEqual([]);
    expect(youtube.untargetedReads).toBe(0);
  });
});
