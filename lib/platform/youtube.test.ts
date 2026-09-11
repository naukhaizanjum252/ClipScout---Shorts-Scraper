/**
 * The YouTube adapter.
 *
 * Nothing here spawns a process or opens a socket: the yt-dlp runner is
 * injected and answers from the RECORDED fixture, and the Data API client is
 * given a fake `fetch`. That is what makes it worth running — the invariants
 * this file protects (a listing that cannot be read is never reported as empty;
 * a seed that cannot be resolved says so before the run starts) are proved in
 * milliseconds, on a machine with no key and no network.
 */
import { describe, expect, it } from "vitest";

import { YouTubeClient } from "../yt/client";
import uploadsFixture from "./fixtures/ytdlp-uploads-137.json";
import type { LatestShortsQuery } from "./adapter";
import { PlatformUnavailableError } from "./unavailable";
import { YouTubeAdapter, channelUrl } from "./youtube";
import { YtDlpError, type YtDlpRunner } from "./ytdlp";

const QUERY: LatestShortsQuery = { limit: 50, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };
const NOW = () => new Date("2026-09-04T12:00:00.000Z");
const CHANNEL = "UCX6OQ3DkcsbYNE6H8uQQuVA";

/** Records every invocation so a test can assert WHICH URL was read. */
function scripted(handler: (args: readonly string[]) => string): { run: YtDlpRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: YtDlpRunner = async (args) => {
    calls.push([...args]);
    return handler(args);
  };
  return { run, calls };
}

/** A runner that behaves like a working yt-dlp reading the recorded fixture. */
function workingRunner(playlist: unknown = uploadsFixture) {
  return scripted((args) => {
    if (args.includes("--version")) return "2026.07.04\n";
    if (args.includes("--print")) return "https://media.test/file.mp4\n";
    if (args.some((a) => a.includes("playlist?list="))) return JSON.stringify(playlist);
    return JSON.stringify({ channel_id: CHANNEL, uploader_id: "@MrBeast" });
  });
}

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "vid1",
    url: "https://www.youtube.com/watch?v=vid1",
    title: "a short",
    duration: 30,
    view_count: 1_000_000,
    channel_id: CHANNEL,
    uploader_id: "@MrBeast",
    ...over,
  };
}

describe("unavailableReason — the operator is told what to do, before anything runs", () => {
  it("says a seed list is needed, because YouTube cannot be browsed", () => {
    // Not a limitation to hide. Neither yt-dlp nor the Data API has a feed of
    // every latest Short, so the honest answer is "name some channels".
    const adapter = new YouTubeAdapter({ run: workingRunner().run });
    return expect(adapter.unavailableReason()).resolves.toMatch(/No YouTube channels have been seeded/);
  });

  it("names the seed that is not a channel reference", async () => {
    const adapter = new YouTubeAdapter({ seeds: ["https://vimeo.com/nope"], run: workingRunner().run });
    const reason = await adapter.unavailableReason();
    expect(reason).toContain("https://vimeo.com/nope");
  });

  it("checks the seeds WITHOUT spawning anything", async () => {
    // A settings page renders this for five platforms. Paying a process spawn
    // to discover a typo would make the page slow for no information.
    const { run, calls } = workingRunner();
    await new YouTubeAdapter({ seeds: ["not a handle!!"], run }).unavailableReason();
    expect(calls).toHaveLength(0);
  });

  it("reports a missing yt-dlp as the fixable thing it is", async () => {
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, "`yt-dlp` is not installed or not on PATH");
    };
    const reason = await new YouTubeAdapter({ seeds: [CHANNEL], run }).unavailableReason();
    expect(reason).toMatch(/not installed or not on PATH/);
  });

  it("returns null — nothing missing — once seeded and yt-dlp answers", () => {
    const adapter = new YouTubeAdapter({ seeds: [CHANNEL], run: workingRunner().run });
    return expect(adapter.unavailableReason()).resolves.toBeNull();
  });
});

/**
 * ONE BAD SEED IS ONE BAD ROW.
 *
 * SCAR, live database, 2026-09-05. Migration 11 ranks creators out of
 * `shorts.creator_handle`, and the keyless yt-dlp path fills that column with a
 * channel's DISPLAY NAME for some rows. Four of those — "Cocomelon - Nursery
 * Rhymes", "Ian Gunther", "Jose.elCook", "The BN Brothers" — were seeded beside
 * seventeen good handles, and this adapter refused the entire platform on the
 * first one it saw. /admin/shorts read "will not run" for YouTube while a
 * working seed list sat underneath it.
 *
 * Migration 13 stops writing them. This is the other half: whatever writes a
 * seed, a value this adapter cannot address costs its own row and nothing else.
 */
describe("a seed it cannot address costs its own row, not the platform", () => {
  const DISPLAY_NAME = "Cocomelon - Nursery Rhymes";

  it("still runs when some seeds are usable", async () => {
    const adapter = new YouTubeAdapter({ seeds: [DISPLAY_NAME, CHANNEL], run: workingRunner().run });
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });

  it("says which seeds it is skipping, rather than dropping them silently", () => {
    // A list that quietly shrinks is a list nobody ever fixes.
    const adapter = new YouTubeAdapter({ seeds: [DISPLAY_NAME, CHANNEL], run: workingRunner().run });
    const described = adapter.describe();
    expect(described).toContain(DISPLAY_NAME);
    expect(described).toMatch(/1 of 2 seeded values are not channel references/);
  });

  it("reads only the seeds it can address", async () => {
    const { run, calls } = workingRunner();
    const adapter = new YouTubeAdapter({ seeds: [DISPLAY_NAME, CHANNEL], run, now: NOW });
    await adapter.latestShorts(QUERY);
    const playlists = calls.filter((args) => args.some((a) => a.includes("playlist?list=")));
    expect(playlists).toHaveLength(1);
  });

  it("still refuses when NOT ONE seed is usable, and names them all", async () => {
    // Then there is nothing to read, and an empty run would be a lie about
    // YouTube rather than a quiet week.
    const adapter = new YouTubeAdapter({
      seeds: [DISPLAY_NAME, "The BN Brothers"],
      run: workingRunner().run,
    });
    const reason = await adapter.unavailableReason();
    expect(reason).toContain(DISPLAY_NAME);
    expect(reason).toContain("The BN Brothers");
  });

  it("keeps a dotted handle, which is a real handle and not a URL", async () => {
    // `Jose.elCook` was in the four. `parseChannelRef` reads a bare token with a
    // dot as a URL, so migration 13 emits it as `@Jose.elCook` — and this is the
    // half that proves the `@` form is accepted.
    const adapter = new YouTubeAdapter({ seeds: ["@Jose.elCook"], run: workingRunner().run });
    await expect(adapter.unavailableReason()).resolves.toBeNull();
  });
});

describe("latestShorts", () => {
  it("reads the UPLOADS PLAYLIST, not the /shorts tab", async () => {
    // The tab has no duration on any entry (fixtures/ytdlp-shorts-tab-3.json),
    // and duration is the only thing that defines a Short.
    const { run, calls } = workingRunner();
    await new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY);
    const read = calls.flat().find((a) => a.startsWith("https://www.youtube.com/"));
    expect(read).toBe(`https://www.youtube.com/playlist?list=UU${CHANNEL.slice(2)}`);
  });

  it("spends no call resolving a seed that is already a channel id", async () => {
    const { run, calls } = workingRunner();
    await new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY);
    // --version, then the playlist. A resolve would be a third.
    expect(calls).toHaveLength(2);
  });

  it("resolves a handle seed once and reuses it", async () => {
    const { run, calls } = workingRunner();
    const adapter = new YouTubeAdapter({ seeds: ["@MrBeast"], run, now: NOW });
    await adapter.latestShorts(QUERY);
    await adapter.latestShorts(QUERY);
    const resolves = calls.filter((c) => c.some((a) => a === "https://www.youtube.com/@MrBeast"));
    expect(resolves).toHaveLength(1);
  });

  it("keeps exactly the recorded entries that clear both thresholds", async () => {
    // Measured against the recorded fixture: 137 uploads, 103 of them at or
    // under 120s, and all 103 of those over 500,000 views.
    const { run } = workingRunner();
    const shorts = await new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY);
    expect(shorts).toHaveLength(103);
    expect(shorts.every((s) => (s.duration_seconds ?? 999) <= 120)).toBe(true);
    expect(shorts.every((s) => (s.view_count ?? 0) >= 500_000)).toBe(true);
  });

  it("drops the long video and the quiet one, and keeps the row on the line", async () => {
    const { run } = workingRunner({
      channel_id: CHANNEL,
      entries: [
        entry({ id: "long", duration: 121 }),
        entry({ id: "quiet", view_count: 499_999 }),
        entry({ id: "exact", duration: 120, view_count: 500_000 }),
      ],
    });
    const shorts = await new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY);
    expect(shorts.map((s) => s.platform_video_id)).toEqual(["exact"]);
  });

  it("stamps provenance rather than leaving it to be inferred later", async () => {
    const { run } = workingRunner({ channel_id: CHANNEL, entries: [entry()] });
    const [short] = await new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY);
    expect(short.platform).toBe("youtube");
    expect(short.discovered_by).toBe("ytdlp:youtube-uploads-playlist");
    expect(short.discovered_at).toBe("2026-09-04T12:00:00.000Z");
  });

  it("THROWS when it cannot run — it does not return an empty list", async () => {
    // The single most important rule in the repo. [] means "nothing was over
    // 500,000 views"; this is "we did not look".
    const adapter = new YouTubeAdapter({ run: workingRunner().run });
    await expect(adapter.latestShorts(QUERY)).rejects.toBeInstanceOf(PlatformUnavailableError);
  });

  it("THROWS when the listing comes back with no durations", async () => {
    // The /shorts-tab shape. Every row would fail the ceiling and the platform
    // would look empty when it is actually unreadable.
    const { run } = workingRunner({
      channel_id: CHANNEL,
      entries: [entry({ duration: undefined }), entry({ id: "b", duration: undefined })],
    });
    await expect(
      new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW }).latestShorts(QUERY),
    ).rejects.toThrow(/not one carried a duration/);
  });

  it("refuses a seed that does not resolve, rather than walking a 404", async () => {
    const run: YtDlpRunner = async (args) => {
      if (args.includes("--version")) return "2026.07.04\n";
      return JSON.stringify({ title: "not a channel" });
    };
    await expect(new YouTubeAdapter({ seeds: ["@ghost"], run }).latestShorts(QUERY)).rejects.toThrow(
      /did not resolve to a channel/,
    );
  });
});

describe("hydration with an operator key — the pooled operation, never the rationed one", () => {
  function clientReturning(items: unknown[], budgetUnits = 100) {
    const asked: string[] = [];
    const fetchStub = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { client: new YouTubeClient({ apiKey: "k", fetch: fetchStub, budgetUnits }), asked };
  }

  it("fills in what the keyless walk cannot see, and says it did", async () => {
    const { run } = workingRunner({ channel_id: CHANNEL, entries: [entry()] });
    const { client, asked } = clientReturning([
      {
        id: "vid1",
        snippet: { publishedAt: "2026-09-01T10:00:00Z" },
        contentDetails: { duration: "PT31S" },
        statistics: { viewCount: "1000001", likeCount: "222", commentCount: "33" },
      },
    ]);
    const [short] = await new YouTubeAdapter({ seeds: [CHANNEL], run, client, now: NOW }).latestShorts(QUERY);

    expect(short.like_count).toBe(222);
    expect(short.comment_count).toBe(33);
    expect(short.published_at).toBe("2026-09-01T10:00:00Z");
    // Provenance changes when the numbers change hands. A row whose counts came
    // from the API must not claim they came off a public page.
    expect(short.discovered_by).toBe("ytdlp:youtube-uploads-playlist+videos.list");
    expect(asked[0]).toContain("/videos");
    // Hydration must never touch `/search`. Both endpoints cost 1 unit, so the
    // client's unit budget cannot tell them apart and would not stop this —
    // `search.list` draws on a separate bucket of 100 calls a day, and a
    // hydration pass that reached for it would silently spend the day's
    // discovery capacity on rows it had already found. This assertion is the
    // only thing enforcing the separation.
    expect(asked.join()).not.toContain("/search");
  });

  it("leaves rows alone when the budget is gone, rather than inventing halves", async () => {
    const { run } = workingRunner({ channel_id: CHANNEL, entries: [entry()] });
    // A budget of 0 cannot afford `videos.list` at 1 declared unit, so the
    // hydration walk stops before it starts and no request goes out.
    const { client, asked } = clientReturning([], 0);
    const [short] = await new YouTubeAdapter({ seeds: [CHANNEL], run, client, now: NOW }).latestShorts(QUERY);

    expect(asked).toHaveLength(0);
    expect(short.like_count).toBeNull();
    expect(short.published_at).toBeNull();
    expect(short.discovered_by).toBe("ytdlp:youtube-uploads-playlist");
  });
});

describe("downloadUrl — resolved now, never stored", () => {
  it("returns the URL yt-dlp printed", async () => {
    const { run } = workingRunner();
    const adapter = new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl(short)).resolves.toBe("https://media.test/file.mp4");
  });

  it("throws yt-dlp's reason rather than flattening it into 'no file'", async () => {
    // A refusal for one video is a fact about that video, and this used to be
    // said with a null — which is the value that means "this adapter has no
    // way to get you the file" and renders as a claim about YouTube itself.
    // Measured 2026-09-08: the real refusal was a per-IP bot check that named
    // its own fix, and none of that survived the catch.
    let first = true;
    const run: YtDlpRunner = async (args) => {
      if (args.includes("--version")) return "2026.07.04\n";
      if (args.includes("--print")) {
        throw new YtDlpError(
          null,
          "yt-dlp exited 1: ERROR: [youtube] vid1: Sign in to confirm you're not a bot. " +
            "Use --cookies-from-browser or --cookies for the authentication.",
        );
      }
      first = false;
      return JSON.stringify({ channel_id: CHANNEL, entries: [entry()] });
    };
    const adapter = new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    expect(first).toBe(false);
    await expect(adapter.downloadUrl(short)).rejects.toThrow(/not a bot/);
  });

  it("still answers null when yt-dlp ran and simply had no URL to print", async () => {
    // The one thing null is allowed to mean on this seam.
    const run: YtDlpRunner = async (args) => {
      if (args.includes("--version")) return "2026.07.04\n";
      if (args.includes("--print")) return "\n";
      return JSON.stringify({ channel_id: CHANNEL, entries: [entry()] });
    };
    const adapter = new YouTubeAdapter({ seeds: [CHANNEL], run, now: NOW });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl(short)).resolves.toBeNull();
  });

  it("refuses another platform's row instead of guessing", async () => {
    const adapter = new YouTubeAdapter({ seeds: [CHANNEL], run: workingRunner().run });
    const [short] = await adapter.latestShorts(QUERY);
    await expect(adapter.downloadUrl({ ...short, platform: "tiktok" })).rejects.toThrow(YtDlpError);
  });
});

describe("channelUrl", () => {
  it("sends an id to /channel/ and a handle to /@", () => {
    expect(channelUrl(CHANNEL)).toBe(`https://www.youtube.com/channel/${CHANNEL}`);
    expect(channelUrl("MrBeast")).toBe("https://www.youtube.com/@MrBeast");
    expect(channelUrl("@MrBeast")).toBe("https://www.youtube.com/@MrBeast");
  });
});
