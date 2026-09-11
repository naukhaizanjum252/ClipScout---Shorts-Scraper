// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORMS, type Platform, type ShortRecord } from "@/lib/platform/types";
import type { StoredRun } from "@/lib/shorts/report-store";
import type { LatestShortsReport, PlatformOutcome } from "@/lib/shorts/run";
import { shortKey } from "@/lib/shorts/store";

import {
  ShortsConsole,
  parseLimit,
  parseSeconds,
  parseThreshold,
} from "@/app/(admin)/admin/shorts/shorts-console";
import type {
  DownloadOutcome,
  EstimateOutcome,
  RunOutcome,
  RunRequest,
  TopicChoices,
} from "@/app/(admin)/admin/shorts/view";

/**
 * THE SCREEN THE CLIENT IS BUYING, UNDER TEST.
 *
 * The product is one sentence — "get latest shorts, all platforms, over 500k
 * views, categorized by platform" — and almost every way of getting it wrong is
 * a way of making two different things look the same. So that is what this file
 * is about. It is not a snapshot of the markup; it asserts the distinctions:
 *
 *   - nothing run yet    vs  ran and found nothing
 *   - ran and found none vs  could not be read
 *   - could not be read  vs  broke while being read
 *   - under the threshold vs the source never said what the views were
 *
 * Each of those pairs is a sentence somebody could delete to make the layout
 * tidier, and each deletion would ship a tool that quietly reports that
 * Instagram has no viral content. A comment saying so does not go red.
 *
 * WHY NOTHING IS MOCKED. The component takes its two server actions as props,
 * so this renders the real component with fake functions and no module
 * interception at all. The previous version of this repo mocked a whole
 * "use server" module to get a component onto a page; not needing to is the
 * point of passing the actions down from page.tsx.
 */

// React Testing Library's auto-cleanup only registers when vitest runs with
// globals, which this project does not. Without this the second render in the
// file finds two consoles and every query throws on the duplicate.
afterEach(cleanup);

const CONFIGURED_THRESHOLD = 500_000;

function short(over: Partial<ShortRecord> = {}): ShortRecord {
  return {
    platform: "youtube",
    platform_video_id: "vid-1",
    url: "https://www.youtube.com/shorts/vid-1",
    title: "A short that did well",
    creator_handle: "@someone",
    creator_id: "UC1",
    creator_url: "https://www.youtube.com/@someone",
    duration_seconds: 41,
    view_count: 900_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-04T10:00:00.000Z",
    discovered_by: "youtube:yt-dlp",
    topic_slug: null,
    ...over,
  };
}

function readOutcome(
  platform: Platform,
  over: Partial<Extract<PlatformOutcome, { status: "ok" }>> = {},
): PlatformOutcome {
  const shorts = over.shorts ?? [];
  return {
    platform,
    status: "ok",
    description: `The ${platform} adapter.`,
    returned: shorts.length,
    kept: shorts.length,
    duplicates: 0,
    dropped: {
      wrongPlatform: 0,
      unknownDuration: 0,
      tooLong: 0,
      tooShort: 0,
      unknownViews: 0,
      belowThreshold: 0,
    },
    ...over,
    shorts,
  };
}

/** Every platform accounted for, which is what the run always returns. */
function report(over: Partial<LatestShortsReport> = {}): LatestShortsReport {
  const platforms: readonly PlatformOutcome[] = over.platforms ?? [
    readOutcome("youtube"),
    readOutcome("tiktok"),
    readOutcome("instagram"),
    readOutcome("x"),
    readOutcome("facebook"),
  ];
  return {
    startedAt: "2026-09-04T10:00:00.000Z",
    finishedAt: "2026-09-04T10:00:09.000Z",
    minViews: CONFIGURED_THRESHOLD,
    minDurationSeconds: 0,
    maxDurationSeconds: 120,
    limit: 50,
    persistence: { status: "written", rows: 0 },
    shorts: platforms.flatMap((p) => (p.status === "ok" ? [...p.shorts] : [])),
    ...over,
    platforms,
  };
}

const DEFAULT_LIMIT = 50;
/**
 * A deployment with no subject to narrow to, which is what most cases here are
 * about — they predate the menu and are about the numbers beside it.
 */
const NO_TOPICS: TopicChoices = { list: [], note: null };
/** Two subjects, as /admin/topics would hand them over. */
const TWO_TOPICS: TopicChoices = {
  list: [
    { slug: "shark-tank", name: "Shark Tank" },
    { slug: "wholesome-animal", name: "Wholesome Animal" },
  ],
  note: null,
};
/**
 * The Shorts ceiling this screen is mounted with — and therefore both where the
 * "maximum length" box starts and the highest number it will take.
 */
const CEILING = 120;

function mount(
  options: {
    readonly run?: (request: RunRequest) => Promise<RunOutcome>;
    readonly resolveDownload?: (short: ShortRecord) => Promise<DownloadOutcome>;
    /** Passed only by the cases that assert on the estimate; absent hides it. */
    readonly estimate?: (request: RunRequest) => Promise<EstimateOutcome>;
    /** The stored run page.tsx would have found. Absent is a cold screen. */
    readonly restored?: StoredRun | null;
    /** The subjects on /admin/topics. Absent is a deployment with none. */
    readonly topics?: TopicChoices;
  } = {},
) {
  const run = vi.fn(options.run ?? (async () => ({ ok: true, report: report() }) as RunOutcome));
  const resolveDownload = vi.fn(
    options.resolveDownload ??
      (async () => ({ ok: false, message: "not asked for" }) as DownloadOutcome),
  );
  const estimate = options.estimate === undefined ? undefined : vi.fn(options.estimate);
  render(
    <ShortsConsole
      defaultMinViews={CONFIGURED_THRESHOLD}
      defaultLimit={DEFAULT_LIMIT}
      defaultMinDuration={0}
      maxDurationSeconds={CEILING}
      topics={options.topics ?? NO_TOPICS}
      restored={options.restored ?? null}
      run={run}
      resolveDownload={resolveDownload}
      costPerDownload="about 19 MB of proxy traffic"
      estimate={estimate}
    />,
  );
  return { run, resolveDownload, estimate };
}

/** One press with everything at its default, for the cases that vary one field. */
function press(over: Partial<RunRequest> = {}): RunRequest {
  return {
    minViews: CONFIGURED_THRESHOLD,
    limit: DEFAULT_LIMIT,
    minDurationSeconds: 0,
    maxDurationSeconds: CEILING,
    platforms: PLATFORMS,
    // Null is "every active subject", which is what an untouched menu sends.
    topicSlug: null,
    ...over,
  };
}

const runButton = () => screen.getByRole("button", { name: /get latest shorts/i });

describe("before anything has been fetched", () => {
  it("says so, rather than showing a page that could be read as an empty internet", () => {
    mount();

    // The distinction this assertion protects: a fresh load and a run that
    // returned nothing are different facts, and only one of them is a claim
    // about the platforms.
    expect(screen.getByText(/nothing has been fetched yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/none over the threshold/i)).toBeNull();
  });

  it("offers the configured threshold, spelled the way the tables spell figures", () => {
    mount();
    const input = screen.getByLabelText(/view threshold/i) as HTMLInputElement;
    expect(input.value).toBe("500,000");
  });
});

describe("the threshold control", () => {
  it("sends the number the operator sees, separators and all", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(screen.getByLabelText(/view threshold/i));
    await user.type(screen.getByLabelText(/view threshold/i), "600,000");
    await user.click(runButton());

    // Typing over a figure that was rendered with separators is the most
    // natural thing an operator can do, and refusing it would be the tool
    // telling them off for reading its own output.
    await waitFor(() => expect(run).toHaveBeenCalledWith(press({ minViews: 600_000 })));
  });

  it("refuses a threshold of zero and does not run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(screen.getByLabelText(/view threshold/i));
    await user.type(screen.getByLabelText(/view threshold/i), "0");
    await user.click(runButton());

    // Zero is a request to turn off the one thing this tool promises, and
    // lib/config.ts refuses it for the same reason. Running anyway would spend
    // five platforms' worth of quota returning everything.
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/turns off the one thing/i);
  });

  it("refuses something that is not a number and does not run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(screen.getByLabelText(/view threshold/i));
    await user.type(screen.getByLabelText(/view threshold/i), "lots");
    await user.click(runButton());

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/whole number of views/i);
  });

  it("parses the same way in isolation, at the edges", () => {
    expect(parseThreshold("500,000")).toEqual({ ok: true, value: 500_000 });
    expect(parseThreshold(" 1 ")).toEqual({ ok: true, value: 1 });
    expect(parseThreshold("0").ok).toBe(false);
    expect(parseThreshold("-5").ok).toBe(false);
    expect(parseThreshold("1.5").ok).toBe(false);
    expect(parseThreshold("").ok).toBe(false);
  });
});

describe("a platform that could not be read", () => {
  it("prints the adapter's own sentence and no table at all", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { shorts: [short()], returned: 1, kept: 1 }),
            readOutcome("tiktok"),
            {
              platform: "instagram",
              status: "unavailable",
              description: "Instagram. Needs a third-party data provider.",
              reason:
                "yt-dlp labels its Instagram profile reader as currently broken, and no data provider has been chosen.",
            },
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const instagram = await screen.findByRole("region", { name: "Instagram" });
    // THE RULE. The reason is the adapter's own words, rendered as written —
    // that is what unavailableReason() is for — and there is no table, no empty
    // row and no zero anywhere in the section.
    expect(within(instagram).getByText(/currently broken/i)).toBeTruthy();
    expect(within(instagram).queryByRole("table")).toBeNull();
    expect(instagram.textContent).not.toMatch(/was read/i);
  });

  it("does not look like a platform that ran and found nothing", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 12,
              kept: 0,
              dropped: {
                wrongPlatform: 0,
                unknownDuration: 0,
                tooLong: 0,
                tooShort: 0,
                unknownViews: 0,
                belowThreshold: 12,
              },
            }),
            readOutcome("tiktok"),
            { platform: "instagram", status: "unavailable", description: "d", reason: "No provider chosen." },
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    // THE PAIR THAT MUST NEVER COLLAPSE. YouTube answered and had nothing over
    // the bar — a fact about YouTube today, printed with the twelve rows that
    // back it. Instagram was never read — no fact about Instagram at all.
    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(youtube.textContent).toMatch(/was read and nothing came back/i);
    expect(youtube.textContent).toMatch(/12 rows returned/i);
    expect(youtube.textContent).toMatch(/12 under the threshold/i);

    const instagram = screen.getByRole("region", { name: "Instagram" });
    expect(instagram.textContent).not.toMatch(/was read/i);
    expect(instagram.textContent).toMatch(/no provider chosen/i);
  });

  it("says nothing looked when no adapter is configured, in the run's words", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube"),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            {
              platform: "facebook",
              status: "no-adapter",
              reason:
                "No adapter is configured to read facebook. That is not a statement about facebook: nothing looked.",
            },
          ],
        }),
      }),
    });

    await user.click(runButton());

    const facebook = await screen.findByRole("region", { name: "Facebook" });
    expect(facebook.textContent).toMatch(/nothing looked/i);
    expect(within(facebook).queryByRole("table")).toBeNull();
  });
});

describe("a platform that broke while it was being read", () => {
  it("is told apart from one that was never going to run", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            {
              platform: "youtube",
              status: "failed",
              description: "YouTube. Reads seeded channels with yt-dlp.",
              error: "HTTP 403 for https://www.googleapis.com/youtube/v3/videos?key=AIzaSyTOPSECRET",
            },
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(youtube.textContent).toMatch(/broke while it was being read/i);
    expect(youtube.textContent).not.toMatch(/was read and nothing came back/i);
  });

  it("never puts the thrown message on the page, because it can carry the operator's API key", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            {
              platform: "youtube",
              status: "failed",
              description: "YouTube.",
              error: "HTTP 403 for https://www.googleapis.com/youtube/v3/videos?key=AIzaSyTOPSECRET",
            },
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());
    await screen.findByRole("region", { name: "YouTube" });

    // THE LEAK THIS REPO HAS ALREADY WRITTEN TWICE. These adapters call metered
    // APIs with the key in the query string, and a thrown message routinely
    // quotes the URL that failed. Around forty people at LookUp Media open and
    // screenshot this page. The message belongs in the server log.
    expect(document.body.textContent).not.toMatch(/AIzaSyTOPSECRET/);
    expect(document.body.textContent).not.toMatch(/googleapis\.com/);
    expect(document.body.textContent).toMatch(/server log/i);
  });
});

describe("the list itself", () => {
  it("groups by platform and keeps the run's highest-views-first order", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 2,
              kept: 2,
              shorts: [
                short({ platform_video_id: "big", title: "Bigger", view_count: 4_100_000 }),
                short({ platform_video_id: "small", title: "Smaller", view_count: 900_000 }),
              ],
            }),
            readOutcome("tiktok", {
              returned: 1,
              kept: 1,
              shorts: [
                short({
                  platform: "tiktok",
                  platform_video_id: "7123",
                  title: "A TikTok",
                  view_count: 2_000_000,
                  url: "https://www.tiktok.com/@a/video/7123",
                  creator_url: null,
                  creator_handle: "@a",
                }),
              ],
            }),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    const cards = within(youtube).getAllByRole("article");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Bigger"),
      expect.stringContaining("Smaller"),
    ]);

    // Grouping is what the client asked for by name: "categorized by platform".
    // The TikTok card must be in TikTok's section and nowhere near YouTube's.
    expect(youtube.textContent).not.toMatch(/A TikTok/);
    const tiktok = screen.getByRole("region", { name: "TikTok" });
    expect(within(tiktok).getByText("A TikTok")).toBeTruthy();
  });

  it("renders every card of a long list and does not shorten it", async () => {
    const user = userEvent.setup();
    // Fourteen, in the descending view order a run hands them over in.
    const fourteen = Array.from({ length: 14 }, (_, i) =>
      short({
        platform_video_id: `vid-${i}`,
        url: `https://www.youtube.com/shorts/vid-${i}`,
        title: `Short ${i}`,
        view_count: 3_000_000 - i * 1_000,
      }),
    );
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 14, kept: 14, shorts: fourteen }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    // EVERY CARD IS RENDERED. The fear is a shortened list dressed up as a full
    // one — an earlier version of this screen sliced the array. The card grid
    // shows all fourteen and the page scrolls to reach them, so the assertion
    // that catches the regression is the count.
    const youtube = await screen.findByRole("region", { name: "YouTube" });
    const cards = within(youtube).getAllByRole("article");
    expect(cards).toHaveLength(14);
    expect(cards[0].textContent).toContain("Short 0");
    expect(cards[13].textContent).toContain("Short 13");

    // And the accounting still counts the run.
    expect(youtube.textContent).toMatch(/14 kept of 14 rows returned/);
  });

  it("leaves a short list unboxed, so nothing is scrollable that has nothing to scroll to", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 2, kept: 2, shorts: [short(), short({
              platform_video_id: "vid-2",
              url: "https://www.youtube.com/shorts/vid-2",
              title: "A second short",
            })] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(within(youtube).queryAllByRole("region")).toHaveLength(0);
    // No sentence about scrolling either. A page that explains a scrollbar
    // nobody has is a page that has stopped describing itself.
    expect(youtube.textContent).not.toMatch(/scrolls after the first/);
  });

  it("never abbreviates a view count, because they get compared down a column", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 1,
              kept: 1,
              shorts: [short({ view_count: 4_100_000, duration_seconds: 118 })],
            }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(within(youtube).getByText("4,100,000")).toBeTruthy();
    expect(within(youtube).getByText("1:58")).toBeTruthy();
  });

  it("marks a derived view count so it cannot be read as a measured one", async () => {
    /**
     * ERIK, 2026-09-08: Instagram keyword-search rows get a view count computed
     * from the like count, and Facebook rows get the vendor's figure multiplied.
     * Both land in the same column as numbers a source actually reported, and
     * both can put a row in the kept list.
     *
     * So this asserts the three signals that separate them, because a plain
     * 800,000 here is indistinguishable from a measured 800,000: the "≈" that
     * survives a screenshot, the note that explains the arithmetic, and the
     * screen-reader word that carries the same fact without the glyph.
     */
    const user = userEvent.setup();
    const derived = {
      ...short({ view_count: 800_000, like_count: 200_000, duration_seconds: 41 }),
      measurement_caveat: {
        field: "view_count" as const,
        basis: "derived" as const,
        reportedValue: null,
        note: "This view count is an ESTIMATE, not a measurement. 200,000 likes x 4 = 800,000.",
      },
    };

    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube"),
            readOutcome("tiktok"),
            readOutcome("instagram", { returned: 1, kept: 1, shorts: [derived] }),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const instagram = await screen.findByRole("region", { name: "Instagram" });
    const cell = within(instagram).getByTitle(/ESTIMATE, not a measurement/);
    expect(cell.textContent).toContain("800,000");
    expect(cell.textContent).toContain("≈");
    expect(within(instagram).getByText("estimated,")).toBeTruthy();
  });

  it("leaves a measured view count unmarked, so the mark means something", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 1,
              kept: 1,
              shorts: [short({ view_count: 800_000 })],
            }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(within(youtube).getByText("800,000")).toBeTruthy();
    expect(within(youtube).queryByText("estimated,")).toBeNull();
  });

  it("fills absent fields with a placeholder, never a fabricated value", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 1,
              kept: 1,
              shorts: [short({ title: null, creator_handle: null, thumbnail_url: null })],
            }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    const card = within(youtube).getByRole("article");
    // A card fills absent TEXT fields with a plain placeholder rather than a
    // fabricated value — never a "0", a "null", or a blank that reads as a bug.
    // (An absent view count, where it occurs, still carries a titled em dash;
    // see the unverified cards.)
    expect(within(card).getByText(/untitled short/i)).toBeTruthy();
    expect(within(card).getByText(/unknown creator/i)).toBeTruthy();
    expect(card.textContent).not.toMatch(/null|NaN/);
  });

  it("renders a post URL that is not a web address as text rather than a link", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 1,
              kept: 1,
              shorts: [short({ url: "javascript:alert(1)" })],
            }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    expect(within(youtube).queryByRole("link", { name: /open the post/i })).toBeNull();
    expect(within(youtube).getByText(/no usable link/i)).toBeTruthy();
  });
});

describe("what happened to the rows that are not on screen", () => {
  it("keeps rows with no view count out of the under-the-threshold count", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", {
              returned: 30,
              kept: 1,
              shorts: [short()],
              dropped: {
                wrongPlatform: 0,
                unknownDuration: 2,
                tooLong: 4,
                tooShort: 0,
                unknownViews: 3,
                belowThreshold: 20,
              },
            }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
    });

    await user.click(runButton());

    const youtube = await screen.findByRole("region", { name: "YouTube" });
    const text = youtube.textContent ?? "";

    // Every bucket is named separately. Folding the three "the source did not
    // say" rows into the twenty genuinely-small ones would put five made-up
    // rows into the one number the product exists to produce, and would hide
    // the thing an operator actually needs to see: a source that has stopped
    // reporting view counts is a bug to chase, not a quiet day.
    expect(text).toMatch(/20 under the threshold/);
    expect(text).toMatch(/3 with no view count reported/);
    expect(text).toMatch(/2 with no duration reported/);
    expect(text).toMatch(/4 longer than the Shorts ceiling/);
    expect(text).toMatch(/not judged against the threshold either way/i);

    // And the headline figure counts only the genuinely-small ones.
    const figure = screen.getByText("Dropped beneath it").parentElement;
    expect(figure?.textContent).toContain("20");
  });

  it("counts the platforms it could not read as unread rather than as empty", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 1, kept: 1, shorts: [short()] }),
            { platform: "tiktok", status: "unavailable", description: "d", reason: "No key." },
            { platform: "instagram", status: "unavailable", description: "d", reason: "No provider." },
            { platform: "x", status: "failed", description: "d", error: "boom" },
            { platform: "facebook", status: "no-adapter", reason: "Nothing looked." },
          ],
        }),
      }),
    });

    await user.click(runButton());

    await screen.findByRole("region", { name: "YouTube" });
    expect(screen.getByText("Platforms read").parentElement?.textContent).toContain("1/5");
    expect(screen.getByText("Not read").parentElement?.textContent).toContain("4");
  });
});

describe("a run that was read but not saved", () => {
  it("says so loudly and does not print the store's own words", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 1, kept: 1, shorts: [short()] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
          persistence: {
            status: "failed",
            rows: 1,
            error: 'relation "shorts_scraper.shorts" does not exist',
          },
        }),
      }),
    });

    await user.click(runButton());

    // A store that refuses does not make the shorts wrong — but a run that
    // silently did not persist will meet the same shorts tomorrow and call them
    // new. The operator has to know. The database's sentence, which quotes
    // schema and table names, does not belong on the page.
    const notice = await screen.findByText(/read, but not saved/i);
    expect(notice).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/relation "shorts_scraper/);
    expect(
      within(await screen.findByRole("region", { name: "YouTube" })).getAllByRole("article").length,
    ).toBeGreaterThan(0);
  });
});

describe("the video file", () => {
  it("is resolved when asked for, and the link says it will not last", async () => {
    const user = userEvent.setup();
    const { resolveDownload } = mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 1, kept: 1, shorts: [short()] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
      resolveDownload: async () => ({ ok: true, url: "https://cdn.example.test/v.mp4?sig=abc" }),
    });

    await user.click(runButton());
    await user.click(await screen.findByRole("button", { name: /get the video file link/i }));

    const link = await screen.findByRole("link", { name: /download the video/i });
    expect(link.getAttribute("href")).toBe("https://cdn.example.test/v.mp4?sig=abc");
    // A signed URL that dies in an hour must not be presented as a permanent
    // one. This sentence is the difference between a link and a lie.
    expect(screen.getByText(/short-lived/i)).toBeTruthy();

    // Resolved on demand, for the row that was asked about, and only then.
    expect(resolveDownload).toHaveBeenCalledTimes(1);
    expect(resolveDownload.mock.calls[0][0].platform_video_id).toBe("vid-1");
  });

  it("says why there is no file rather than leaving a dead button", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 1, kept: 1, shorts: [short()] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
      resolveDownload: async () => ({
        ok: false,
        message: "The YouTube adapter could not get a media URL for this post.",
      }),
    });

    await user.click(runButton());
    await user.click(await screen.findByRole("button", { name: /get the video file link/i }));

    expect(await screen.findByText(/could not get a media URL/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /download the video/i })).toBeNull();
  });

  it("refuses to link a resolved URL that is not a web address", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { returned: 1, kept: 1, shorts: [short()] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
        }),
      }),
      resolveDownload: async () => ({ ok: true, url: "javascript:alert(1)" }),
    });

    await user.click(runButton());
    await user.click(await screen.findByRole("button", { name: /get the video file link/i }));

    // An adapter is code we own today and a third-party provider's client
    // tomorrow. The last line before an href is this component's.
    expect(await screen.findByText(/not a web address/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /download the video/i })).toBeNull();
  });
});

describe("a run that could not be made at all", () => {
  it("is not reported as five empty platforms", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: false,
        message: "You are not signed in, so nothing was read.",
      }),
    });

    await user.click(runButton());

    expect(await screen.findByText(/the run did not happen/i)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "YouTube" })).toBeNull();
    expect(screen.queryByText(/platforms read/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which platforms, and how many videos
// ---------------------------------------------------------------------------

const checkbox = (label: string) => screen.getByRole("checkbox", { name: label });
const limitInput = () => screen.getByLabelText(/most videos per platform/i) as HTMLInputElement;
const minLengthInput = () => screen.getByLabelText(/minimum length/i) as HTMLInputElement;
const maxLengthInput = () => screen.getByLabelText(/maximum length/i) as HTMLInputElement;

/**
 * THE TWO CONTROLS ERIK ASKED FOR, 2026-09-05: *"checkboxes for the platforms to
 * be used, and a maximum amount of videos to display"*.
 *
 * Both of them change what a press COSTS as well as what it shows — an unticked
 * platform is not asked, and the maximum is how many rows a platform that bills
 * per row is asked for. So the cases below are as much about what does not
 * happen as about what appears.
 */
describe("choosing which platforms to read", () => {
  it("starts with all six ticked, which is the brief this screen was built from", () => {
    mount();

    for (const label of ["YouTube", "TikTok", "Instagram", "X", "Facebook", "Threads"]) {
      expect((checkbox(label) as HTMLInputElement).checked).toBe(true);
    }
  });

  it("sends only the ticked platforms, in the vocabulary's order and not click order", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    // Unticked in an order that is not the vocabulary's, and re-ticked, so a
    // request built by appending clicks would come out as ["tiktok","youtube"].
    await user.click(checkbox("YouTube"));
    await user.click(checkbox("Instagram"));
    await user.click(checkbox("Facebook"));
    await user.click(checkbox("YouTube"));
    await user.click(runButton());

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(press({ platforms: ["youtube", "tiktok", "x", "threads"] })),
    );
  });

  it("takes the lit-chip class from React rather than from the stylesheet", async () => {
    const user = userEvent.setup();
    mount();

    // SCAR, 2026-09-05, found by unticking a box in Chrome rather than in
    // jsdom. The label used to be lit by `.check:has(input:checked)` in
    // app/globals.css, and Chrome does not repaint a `:has()` rule when React
    // flips the `checked` property — so an operator unticking TikTok watched
    // TikTok stay violet while the run went ahead without it. jsdom cannot
    // reproduce a browser's paint, so what is asserted instead is the fix: the
    // class comes from the same state that builds the request, and going back
    // to the sheet version removes it and fails here.
    expect(checkbox("TikTok").closest("label")?.className).toContain("check-on");

    await user.click(checkbox("TikTok"));

    expect(checkbox("TikTok").closest("label")?.className).not.toContain("check-on");
    expect(checkbox("YouTube").closest("label")?.className).toContain("check-on");
  });

  it("refuses an empty selection instead of reading all of them", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    for (const label of ["YouTube", "TikTok", "Instagram", "X", "Facebook", "Threads"]) {
      await user.click(checkbox(label));
    }
    await user.click(runButton());

    // The expensive misreading. "Nothing ticked" and "everything ticked" are
    // opposite intentions, and on X the second one is a bill.
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not read as all of them/i);
  });

  it("drops a stale price when the selection changes, because it priced a different run", async () => {
    const user = userEvent.setup();
    mount({
      estimate: async () => ({
        ok: true,
        forecast: {
          forecastAt: "2026-09-05T10:00:00.000Z",
          minViews: CONFIGURED_THRESHOLD,
          minDurationSeconds: 0,
          maxDurationSeconds: CEILING,
          limit: DEFAULT_LIMIT,
          platforms: PLATFORMS.map((platform) => ({
            platform,
            kind: "unpriced" as const,
            usdMicros: null,
            note: "no price quoted",
          })),
          knownUsdMicros: 0,
          unpriced: PLATFORMS.length,
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: /what will this cost/i }));
    expect(await screen.findByText(/estimated cost of one run/i)).toBeTruthy();

    await user.click(checkbox("X"));

    // A quote for five platforms sitting beside four tick boxes is the one way
    // this panel could mislead about money.
    expect(screen.queryByText(/estimated cost of one run/i)).toBeNull();
  });

  it("prints the reason a platform will not run, on the page and not in a tooltip", async () => {
    /*
     * SCAR, 2026-09-05. This panel put each platform's `note` in a `title`
     * attribute and then told the reader, in the paragraph underneath, that
     * "each platform above says what it is waiting for". It did not: every row
     * read "will not run" and the sentence that would have fixed the deployment
     * in five minutes was reachable only by hovering — which on a touch screen
     * is not reachable at all. Erik's question that morning was one word: WHY?
     */
    const user = userEvent.setup();
    mount({
      estimate: async () => ({
        ok: true,
        forecast: {
          forecastAt: "2026-09-05T10:00:00.000Z",
          minViews: CONFIGURED_THRESHOLD,
          minDurationSeconds: 0,
          maxDurationSeconds: CEILING,
          limit: DEFAULT_LIMIT,
          platforms: PLATFORMS.map((platform) => ({
            platform,
            kind: "not-running" as const,
            usdMicros: null,
            note: `No ${platform} channels have been seeded.`,
          })),
          knownUsdMicros: 0,
          unpriced: 0,
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: /what will this cost/i }));
    expect(await screen.findByText(/estimated cost of one run/i)).toBeTruthy();

    // Visible text, not an attribute. `getByText` reads what a person reads.
    expect(screen.getByText(/No youtube channels have been seeded/)).toBeTruthy();
    expect(screen.getByText(/No facebook channels have been seeded/)).toBeTruthy();
  });

  it("folds a paragraph-long reason down to its first sentence", async () => {
    /*
     * SCAR, 2026-09-05, the same morning and the opposite failure. Having put
     * every `note` on the page, the panel then printed all of it: Facebook's
     * reason alone runs eleven lines about Page tasks and the Meta Content
     * Library, and five platforms of that is an essay where somebody asked for
     * a price. Erik's second question was "WHY ARE THERE SO MANY TEXT LINES?"
     * The lead sentence answers the question; the rest waits behind a click.
     */
    const user = userEvent.setup();
    const lead = "Facebook is not configured.";
    const rest =
      "This build needs a Meta Page access token from someone with a CREATE_CONTENT, MANAGE or " +
      "MODERATE task on the Page, and at least one Page id the operator administers.";
    mount({
      estimate: async () => ({
        ok: true,
        forecast: {
          forecastAt: "2026-09-05T10:00:00.000Z",
          minViews: CONFIGURED_THRESHOLD,
          minDurationSeconds: 0,
          maxDurationSeconds: CEILING,
          limit: DEFAULT_LIMIT,
          platforms: PLATFORMS.map((platform) => ({
            platform,
            kind: "not-running" as const,
            usdMicros: null,
            note: `${lead} ${rest}`,
          })),
          knownUsdMicros: 0,
          unpriced: 0,
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: /what will this cost/i }));
    expect(await screen.findByText(/estimated cost of one run/i)).toBeTruthy();

    // The sentence a person needs is on the line, unclicked.
    expect(screen.getAllByText(new RegExp(lead)).length).toBe(PLATFORMS.length);

    // The paragraph is in the document but folded away — `details` without
    // `open` is closed, which is the whole difference between a line and a wall.
    const folds = screen.getAllByText(new RegExp(rest.slice(0, 40)));
    expect(folds.length).toBe(PLATFORMS.length);
    for (const fold of folds) {
      expect(fold.closest("details")?.hasAttribute("open")).toBe(false);
    }

    // And a click still opens it, on the page, with no hover anywhere.
    await user.click(screen.getAllByText(/^Why$/)[0]!);
    expect(folds[0]!.closest("details")?.hasAttribute("open")).toBe(true);
  });
});

describe("the per-platform maximum", () => {
  it("offers the default and sends what the operator typed", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    expect(limitInput().value).toBe(String(DEFAULT_LIMIT));

    await user.clear(limitInput());
    await user.type(limitInput(), "20");
    await user.click(runButton());

    await waitFor(() => expect(run).toHaveBeenCalledWith(press({ limit: 20 })));
  });

  it("refuses more than the ceiling and does not run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(limitInput());
    await user.type(limitInput(), "5000");
    await user.click(runButton());

    // An extra zero here is an extra zero on the invoice, and the refusal names
    // the number that would have been accepted.
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at most 200 videos/i);
  });

  it("refuses zero, because asking a platform for no videos is not a run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(limitInput());
    await user.type(limitInput(), "0");
    await user.click(runButton());

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at least one/i);
  });

  it("parses the same way in isolation, at the edges", () => {
    expect(parseLimit("50")).toEqual({ ok: true, value: 50 });
    expect(parseLimit(" 1 ")).toEqual({ ok: true, value: 1 });
    expect(parseLimit("200").ok).toBe(true);
    expect(parseLimit("201").ok).toBe(false);
    expect(parseLimit("0").ok).toBe(false);
    expect(parseLimit("-5").ok).toBe(false);
    expect(parseLimit("1.5").ok).toBe(false);
    expect(parseLimit("").ok).toBe(false);
  });
});

/**
 * THE LENGTH WINDOW — Erik, 2026-09-05, asked for "a minimum and maximum
 * length" on this bar.
 *
 * The cases below are mostly about the difference between its two ends. The
 * floor is a preference that starts at nothing; the ceiling starts at, and
 * cannot pass, the number that makes a video a Short at all.
 */
describe("the length window", () => {
  it("starts as the whole window, so an untouched screen runs what it always ran", () => {
    mount();
    expect(minLengthInput().value).toBe("0");
    expect(maxLengthInput().value).toBe(String(CEILING));
  });

  it("sends both bounds as typed", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(minLengthInput());
    await user.type(minLengthInput(), "30");
    await user.clear(maxLengthInput());
    await user.type(maxLengthInput(), "60");
    await user.click(runButton());

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(press({ minDurationSeconds: 30, maxDurationSeconds: 60 })),
    );
  });

  it("refuses a maximum above the Shorts ceiling and does not run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(maxLengthInput());
    await user.type(maxLengthInput(), "300");
    await user.click(runButton());

    // The ceiling is what makes a video a Short, so this is not a preference
    // the screen may overrule — and the refusal says so rather than silently
    // running 120.
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at or under 120 seconds/i);
  });

  it("refuses a window with nothing in it and does not run", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(minLengthInput());
    await user.type(minLengthInput(), "90");
    await user.clear(maxLengthInput());
    await user.type(maxLengthInput(), "30");
    await user.click(runButton());

    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/window with nothing in it/i);
  });

  it("keeps a floor of zero, because that is how you ask for no minimum", async () => {
    const user = userEvent.setup();
    const { run } = mount();

    await user.clear(minLengthInput());
    await user.type(minLengthInput(), "0");
    await user.click(runButton());

    await waitFor(() => expect(run).toHaveBeenCalledWith(press({ minDurationSeconds: 0 })));
  });

  it("says which box is wrong rather than putting one message under both", async () => {
    const user = userEvent.setup();
    mount();

    await user.clear(maxLengthInput());
    await user.type(maxLengthInput(), "abc");
    await user.click(runButton());

    expect(maxLengthInput().getAttribute("aria-invalid")).toBe("true");
    expect(minLengthInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("names the length window on the report when there was a floor, and does not invent one", async () => {
    const user = userEvent.setup();
    cleanup();
    render(
      <ShortsConsole
        defaultMinViews={CONFIGURED_THRESHOLD}
        defaultLimit={DEFAULT_LIMIT}
        defaultMinDuration={0}
        maxDurationSeconds={CEILING}
        topics={{ list: [], note: null }}
        run={async () => ({ ok: true, report: report({ minDurationSeconds: 30 }) })}
        resolveDownload={async () => ({ ok: false, message: "not asked for" })}
        costPerDownload="about 19 MB of proxy traffic"
      />,
    );

    await user.click(runButton());

    // A list shortened by a length the operator typed has to say so, or the
    // next person to read it takes it for the whole inventory. The window chip
    // names both ends, so a floor of 30s reads as a window, not a ceiling.
    const windowChip = await screen.findByTitle(/Length window/i);
    expect(within(windowChip).getByText(/30s/)).toBeTruthy();
    expect(within(windowChip).getByText(/120s/)).toBeTruthy();
  });

  it("parses the same way in isolation, at the edges", () => {
    const asMin = { floor: 0, ceiling: 120, label: "minimum" };
    const asMax = { floor: 1, ceiling: 120, label: "maximum" };

    expect(parseSeconds("30", asMin)).toEqual({ ok: true, value: 30 });
    expect(parseSeconds(" 0 ", asMin)).toEqual({ ok: true, value: 0 });
    expect(parseSeconds("120", asMax)).toEqual({ ok: true, value: 120 });
    expect(parseSeconds("121", asMax).ok).toBe(false);
    expect(parseSeconds("0", asMax).ok).toBe(false);
    expect(parseSeconds("-5", asMin).ok).toBe(false);
    expect(parseSeconds("1.5", asMin).ok).toBe(false);
    expect(parseSeconds("", asMin).ok).toBe(false);
  });
});

describe("a platform nobody asked for is not a platform that could not be read", () => {
  it("counts an unticked platform apart, hides its section, and does not shrink the denominator", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { shorts: [short()] }),
            { platform: "tiktok", status: "not-asked", reason: "TikTok was not selected for this run." },
            { platform: "instagram", status: "not-asked", reason: "Instagram was not selected for this run." },
            { platform: "x", status: "not-asked", reason: "X was not selected for this run." },
            { platform: "facebook", status: "not-asked", reason: "Facebook was not selected for this run." },
          ],
        }),
      }),
    });

    await user.click(runButton());

    // ONE OF ONE, NOT ONE OF FIVE. An operator who ticked one platform and got
    // it must not read "1/5 platforms read" and go looking for four failures.
    const figures = await screen.findByText(/platforms read/i);
    expect(figures.parentElement?.textContent).toMatch(/1\/1/);

    // Its own figure, and it must not be inside "Not read" — which is a row of
    // things that need attention, and an unticked box does not. The label is
    // matched on the figure's own key element, because the same two words are
    // the chip on each skipped platform's heading, which is the point.
    const notAsked = screen.getAllByText(/^Not asked$/).find((node) => node.className === "k");
    expect(notAsked?.parentElement?.textContent).toMatch(/^4/);
    const unread = screen.getByText(/^Not read$/).parentElement;
    expect(unread?.textContent).toMatch(/^0/);

    // A platform the operator did not tick gets NO section — it is counted in
    // the figures above and nowhere else, so the results are not four paragraphs
    // of "was not selected" burying the one platform that was read.
    expect(screen.queryByRole("region", { name: "TikTok" })).toBeNull();
    expect(screen.queryByRole("region", { name: "X" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Facebook" })).toBeNull();
    // The one that WAS asked is still shown.
    expect(screen.getByRole("region", { name: "YouTube" })).toBeTruthy();
  });
});

/**
 * THE RUN THAT SURVIVES A RELOAD.
 *
 * Erik, 2026-09-05: *"The run should not disappear after a while."* Nothing was
 * expiring it — the report lived in this component's state and nowhere else, so
 * a refresh, a walk to another admin page and back, or a restored tab put an
 * operator in front of "Nothing has been fetched yet" minutes after a run.
 *
 * The fix is one prop, and the risk it introduces is the one this file is about
 * from top to bottom: a restored list and a fresh one are the same markup, and
 * on a shared store the restored one may be somebody else's run from days ago.
 * So every case below is a distinction rather than a rendering:
 *
 *   restored run  vs  a run just made
 *   restored run  vs  nothing to restore
 *   the controls  vs  the list they claim to describe
 */
describe("a run put back after a reload", () => {
  const SAVED_AT = "2026-09-05T03:05:00.000Z";

  function stored(over: Partial<LatestShortsReport> = {}): StoredRun {
    return { savedAt: SAVED_AT, report: report(over) };
  }

  it("shows the list again instead of the never-been-run sentence", () => {
    mount({ restored: stored({ platforms: [readOutcome("youtube", { shorts: [short()] })] }) });

    expect(screen.queryByText(/nothing has been fetched yet/i)).toBeNull();
    expect(screen.getByText("A short that did well")).toBeTruthy();
  });

  /**
   * THE ASSERTION THE WHOLE FEATURE TURNS ON. A restored page of Shorts is
   * indistinguishable from a fresh one unless it says so, and it may be a run
   * this operator did not make.
   */
  it("says when it was fetched, so it cannot be read as a run that just happened", () => {
    mount({ restored: stored() });

    expect(screen.getByText(/showing your last run/i)).toBeTruthy();
    // Pinned to UTC and labelled — see `formatSavedAt`. A bare clock time that
    // is neither the reader's nor named is worse than a foreign one that says so.
    expect(screen.getByText(/5 September at 03:05 UTC/)).toBeTruthy();
  });

  /**
   * THE AGE IS WRITTEN BY AN EFFECT, so it exists only in a browser — which is
   * the point (a clock read on the server and again on the client is a
   * hydration mismatch) and is also why it needs its own assertion. Without
   * one, deleting the effect would leave the timestamp behind and every other
   * case in this block would still pass.
   */
  it("adds how long ago that was, once it is in a browser", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    mount({ restored: { savedAt: threeHoursAgo, report: report() } });

    expect(await screen.findByText(/3 hours ago/)).toBeTruthy();
  });

  it("says nothing has been read since, rather than implying the platforms are like this now", () => {
    mount({ restored: stored() });

    expect(screen.getByText(/nothing has been read since/i)).toBeTruthy();
  });

  /**
   * The panel is the caption for the list underneath it. A restored list
   * gathered at 250,000 views under a box reading 500,000 is a screen answering
   * a question nobody asked — and a stale threshold looks exactly like a fresh
   * one, which is what makes it worth a test.
   */
  it("sets the controls to the terms the restored run was gathered on", () => {
    mount({
      restored: stored({ minViews: 250_000, limit: 25, minDurationSeconds: 30, maxDurationSeconds: 90 }),
    });

    expect((screen.getByLabelText(/view threshold/i) as HTMLInputElement).value).toBe("250,000");
    expect(limitInput().value).toBe("25");
    expect(minLengthInput().value).toBe("30");
    expect(maxLengthInput().value).toBe("90");
  });

  /**
   * A run of two platforms restored under five ticked boxes would report three
   * of them as missing when what happened is that nobody asked for them.
   */
  it("puts back the platforms the restored run actually asked for", () => {
    mount({
      restored: stored({
        platforms: [
          readOutcome("youtube"),
          readOutcome("tiktok"),
          { platform: "instagram", status: "not-asked", reason: "Not selected." },
          { platform: "x", status: "not-asked", reason: "Not selected." },
          { platform: "facebook", status: "not-asked", reason: "Not selected." },
        ],
      }),
    });

    expect((checkbox("YouTube") as HTMLInputElement).checked).toBe(true);
    expect((checkbox("TikTok") as HTMLInputElement).checked).toBe(true);
    expect((checkbox("X") as HTMLInputElement).checked).toBe(false);
  });

  /**
   * THE OTHER DIRECTION OF THE SAME LIE. "Fetched 3 hours ago" over a run being
   * made right now is the caption being wrong the other way round, and it would
   * teach an operator to ignore the one banner on this screen that qualifies a
   * number.
   */
  it("drops the restored caption the moment a new run is pressed", async () => {
    const user = userEvent.setup();
    mount({ restored: stored() });

    expect(screen.getByText(/showing your last run/i)).toBeTruthy();

    await user.click(runButton());

    await waitFor(() =>
      expect(screen.queryByText(/showing your last run/i)).toBeNull(),
    );
  });

  /**
   * NOTHING TO RESTORE IS NOT A RUN THAT FOUND NOTHING, and it is not a claim
   * about the platforms either. It is the same empty state as before this
   * feature existed, with one clause added so it does not silently mean two
   * things.
   */
  it("falls back to the honest empty state when there is nothing to put back", () => {
    mount({ restored: null });

    expect(screen.getByText(/no earlier run could be put back/i)).toBeTruthy();
    expect(screen.queryByText(/showing your last run/i)).toBeNull();
  });

  /** A run made in this session is this session's, and carries no caption. */
  it("does not caption a run made from a cold screen", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(runButton());

    expect(await screen.findByText(/platforms read/i)).toBeTruthy();
    expect(screen.queryByText(/showing your last run/i)).toBeNull();
  });
});

/**
 * CHOOSING WHAT KIND OF SHORT TO LOOK FOR.
 *
 * Luka, 2026-09-05: *"we need the scraper to be able to search for those
 * specific clips, not any random shorts with 500k+ views."* The run has
 * searched by subject since that day; this menu is how one press is aimed at
 * ONE of those subjects, which is what somebody gathering clips for a single
 * channel actually wants.
 *
 * Every case here is about a pair of things that would look the same on screen:
 *
 *   every active subject   vs  one subject, chosen
 *   a subject that is on   vs  one that was switched off after the page loaded
 *   an empty menu          vs  a menu that could not be read
 *
 * The first pair is the feature. The other two are how it would quietly become
 * a run nobody asked for.
 */
describe("choosing which subject to look for", () => {
  // The subject picker is a custom combobox (a trigger button + a popover with
  // a search box and a list), not a native <select>. The trigger's accessible
  // name is the label plus the current value, so /look for/i finds it; opening
  // it reveals the options as role="option".
  const topicTrigger = () => screen.getByRole("button", { name: /look for/i });
  const openTopics = (user: ReturnType<typeof userEvent.setup>) => user.click(topicTrigger());
  const chooseTopic = (user: ReturnType<typeof userEvent.setup>, name: string | RegExp) =>
    user.click(screen.getByRole("button", { name }));

  it("offers every active subject, and starts on all of them", async () => {
    const user = userEvent.setup();
    mount({ topics: TWO_TOPICS });

    expect(topicTrigger().textContent).toContain("Every active subject");

    await openTopics(user);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Every active subject",
      "Shark Tank",
      "Wholesome Animal",
    ]);
  });

  it("asks for every active subject when nobody opens the menu", async () => {
    const user = userEvent.setup();
    const { run } = mount({ topics: TWO_TOPICS });

    await user.click(runButton());

    // NULL, NOT "" AND NOT A LIST OF SLUGS. The server reads null as "every
    // subject that is switched on", which is the run this button has always
    // made — an empty string would reach it as a subject that matches nothing.
    await waitFor(() => expect(run).toHaveBeenCalledWith(press({ topicSlug: null })));
  });

  it("sends the chosen subject's slug and nothing else about it", async () => {
    const user = userEvent.setup();
    const { run } = mount({ topics: TWO_TOPICS });

    await openTopics(user);
    await chooseTopic(user, "Shark Tank");
    await user.click(runButton());

    // THE SLUG ALONE. The words that get searched are read from the store on
    // the server; a page that posted terms would let a stale tab search for
    // anything and have the rows labelled with a subject somebody trusts.
    await waitFor(() => expect(run).toHaveBeenCalledWith(press({ topicSlug: "shark-tank" })));
  });

  it("names the subject on the report, so the list cannot be read as the whole of what was there", async () => {
    const user = userEvent.setup();
    mount({
      topics: TWO_TOPICS,
      run: async () => ({
        ok: true,
        report: report({ topic: { slug: "shark-tank", name: "Shark Tank" } }),
      }),
    });

    await user.click(runButton());

    // The name is IN the subject chip, not merely somewhere on the page — the
    // menu above carries the same words and matching those would prove nothing.
    const chip = await screen.findByText(/^Topic:/i);
    expect(within(chip).getByText("Shark Tank")).toBeTruthy();
  });

  it("says nothing about a subject on a run that was not narrowed", async () => {
    const user = userEvent.setup();
    mount({ topics: TWO_TOPICS });

    await user.click(runButton());

    await screen.findByText(/platforms read/i);
    // The distinction: a run of every active subject has no subject to name,
    // and inventing a phrase for it would put a claim on a list that has none.
    expect(screen.queryByText(/^Topic:/i)).toBeNull();
  });

  it("invalidates a price when the subject changes, because a run reads once per subject", async () => {
    const user = userEvent.setup();
    mount({
      topics: TWO_TOPICS,
      estimate: async () => ({
        ok: true,
        forecast: {
          forecastAt: "2026-09-05T00:00:00.000Z",
          minViews: CONFIGURED_THRESHOLD,
          minDurationSeconds: 0,
          maxDurationSeconds: CEILING,
          limit: DEFAULT_LIMIT,
          platforms: [],
          knownUsdMicros: 0,
          unpriced: 0,
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: /what will this cost/i }));
    expect(await screen.findByText(/estimated cost of one run/i)).toBeTruthy();

    await openTopics(user);
    await chooseTopic(user, "Shark Tank");

    expect(screen.queryByText(/estimated cost of one run/i)).toBeNull();
  });

  it("keeps a restored run's subject in the menu even when it is no longer active, and says so", () => {
    mount({
      topics: TWO_TOPICS,
      restored: {
        savedAt: "2026-09-05T09:00:00.000Z",
        report: report({ topic: { slug: "top-gear", name: "Top Gear" } }),
      },
    });

    // A control whose value is not among its options would render blank, which
    // would be it silently disagreeing with the list beside it. The trigger
    // shows the restored subject, flagged as gone.
    expect(topicTrigger().textContent).toContain("Top Gear — no longer active");
  });

  it("puts a restored run's subject back, so the menu describes the list underneath it", () => {
    mount({
      topics: TWO_TOPICS,
      restored: {
        savedAt: "2026-09-05T09:00:00.000Z",
        report: report({ topic: { slug: "shark-tank", name: "Shark Tank" } }),
      },
    });

    expect(topicTrigger().textContent).toContain("Shark Tank");
  });

  it("says why the menu is empty rather than showing a silent one", () => {
    mount({
      topics: {
        list: [],
        note: "The list of subjects could not be read, so there is nothing to choose from.",
      },
    });

    // The three ways of arriving at an empty menu are a decision, an unfinished
    // deployment and a fault, and only the fault means the run is about to
    // refuse. A bare empty menu would render all three identically.
    expect(screen.getByText(/could not be read, so there is nothing to choose from/i)).toBeTruthy();
  });
});

/**
 * HIDING WHAT IS ALREADY IN THE LIBRARY.
 *
 * Asad, 2026-09-10: *"I just dont wanna see the clips on the search page that
 * are already in the library."* The run marks which kept shorts were in the
 * library before it ran (`carriedOverKeys`), and this screen hides those by
 * default. The rule these cases hold to is the same one the rest of this file
 * is about: a hidden row must be SAID to be hidden, never silently dropped, or
 * "already in your library" becomes indistinguishable from "found fewer".
 */
describe("clips already in the library", () => {
  const oldShort = short({ platform_video_id: "y-old", title: "Seen this one before" });
  const newShort = short({ platform_video_id: "y-new", title: "Brand new to this run" });

  function ranReport(over: Partial<LatestShortsReport> = {}): LatestShortsReport {
    return report({
      platforms: [
        readOutcome("youtube", { shorts: [newShort, oldShort] }),
        readOutcome("tiktok"),
        readOutcome("instagram"),
        readOutcome("x"),
        readOutcome("facebook"),
      ],
      carriedOverKeys: [shortKey(oldShort)],
      ...over,
    });
  }

  it("hides a clip already in the library and says how many it hid", async () => {
    const user = userEvent.setup();
    mount({ run: async () => ({ ok: true, report: ranReport() }) });
    await user.click(runButton());

    // The new one is on the page; the already-seen one is not.
    expect(await screen.findByText("Brand new to this run")).toBeTruthy();
    expect(screen.queryByText("Seen this one before")).toBeNull();
    // And the page says it hid one, rather than looking like it found one.
    expect(screen.getByText(/already in your library and hidden/i)).toBeTruthy();
  });

  it("shows the hidden clip when asked, and never pretends it was not found", async () => {
    const user = userEvent.setup();
    mount({ run: async () => ({ ok: true, report: ranReport() }) });
    await user.click(runButton());

    await user.click(screen.getByRole("button", { name: /show them/i }));
    expect(screen.getByText("Seen this one before")).toBeTruthy();
  });

  it("does not read a platform whose only finds are all in the library as 'found nothing'", async () => {
    const user = userEvent.setup();
    // YouTube found exactly one short and it is already in the library.
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { shorts: [oldShort] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
          carriedOverKeys: [shortKey(oldShort)],
        }),
      }),
    });
    await user.click(runButton());

    // The card is hidden, but the section says the platform DID find one and it
    // is already saved — "YouTube found 1 ... all already in your library" —
    // not that it came back empty. (The other platforms, which genuinely found
    // nothing, still say so; that is why this asserts on YouTube's own note.)
    const note = await screen.findByText(/found .* all already in your library/i);
    expect(note.textContent).toContain("YouTube");
    expect(screen.queryByText("Seen this one before")).toBeNull();
  });

  it("hides nothing when the run carried nothing over", async () => {
    const user = userEvent.setup();
    mount({
      run: async () => ({
        ok: true,
        report: report({
          platforms: [
            readOutcome("youtube", { shorts: [newShort, oldShort] }),
            readOutcome("tiktok"),
            readOutcome("instagram"),
            readOutcome("x"),
            readOutcome("facebook"),
          ],
          carriedOverKeys: [],
        }),
      }),
    });
    await user.click(runButton());

    expect(await screen.findByText("Brand new to this run")).toBeTruthy();
    expect(screen.getByText("Seen this one before")).toBeTruthy();
    expect(screen.queryByText(/already in your library and hidden/i)).toBeNull();
  });
});
