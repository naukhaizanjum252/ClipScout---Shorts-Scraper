// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Platform, ShortRecord } from "@/lib/platform/types";
import type { LatestShortsReport, PlatformOutcome } from "@/lib/shorts/run";

import { ShortsConsole } from "@/app/(admin)/admin/shorts/shorts-console";
import type {
  DownloadOutcome,
  EstimateOutcome,
  RunOutcome,
  RunRequest,
} from "@/app/(admin)/admin/shorts/view";

/**
 * "EXPORT ALL LINKS", UNDER TEST.
 *
 * Erik, 2026-09-05: *"give me an 'Export All' button that gives me ALL of the
 * links so these videos can be downloaded."* One press per row was the whole of
 * "links to download them" before this, and a hundred and forty-eight presses
 * is not a way to take a list anywhere.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS ACTUALLY GUARDING, AND IT IS NOT THE HAPPY PATH
 * ------------------------------------------------------------------------
 *
 * An export is a file that leaves the page, and the page's honesty rules stop
 * applying to it the moment it does. Every assertion below is about a way the
 * file could quietly claim more than it knows:
 *
 *   - A SHORT FILE HANDED OVER IN SILENCE. Ninety-six links out of a hundred
 *     and forty-eight, with nothing said, reads as a hundred and forty-eight.
 *     The rows that refused and the rows nobody asked for are different
 *     absences and both are counted on screen.
 *   - PAYING TWICE FOR THE SAME ROW. Every resolve is a lookup and on X it is
 *     $0.005. A row already asked — answered OR refused — is never asked again,
 *     so the second press of a finished export costs nothing.
 *   - A `javascript:` URL REACHING A FILE. `safeHref` guards the anchors on the
 *     page; the export is a second way out of the same adapter output and it
 *     has to hold the same line.
 *   - "ALL" MEANING "THE PART YOU CAN SEE". The tables print a slice; the
 *     export is the run.
 *
 * It lives in its own file rather than in tests/shorts-console.test.tsx because
 * the export is its own feature with its own bargain — cost, expiry and
 * completeness — and that file is already the place where the five platform
 * states are kept apart.
 */

afterEach(cleanup);

const CONFIGURED_THRESHOLD = 500_000;
const DEFAULT_LIMIT = 50;

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

function readOutcome(platform: Platform, shorts: readonly ShortRecord[]): PlatformOutcome {
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
    shorts,
  } as PlatformOutcome;
}

function report(shorts: readonly ShortRecord[]): LatestShortsReport {
  return {
    startedAt: "2026-09-04T10:00:00.000Z",
    finishedAt: "2026-09-04T10:00:09.000Z",
    minViews: CONFIGURED_THRESHOLD,
    minDurationSeconds: 0,
    maxDurationSeconds: 120,
    limit: DEFAULT_LIMIT,
    persistence: { status: "written", rows: shorts.length },
    platforms: [readOutcome("youtube", shorts)],
    shorts,
  } as LatestShortsReport;
}

function mount(options: {
  readonly shorts: readonly ShortRecord[];
  readonly resolveDownload?: (short: ShortRecord) => Promise<DownloadOutcome>;
}) {
  const run = vi.fn(
    async () => ({ ok: true, report: report(options.shorts) }) as RunOutcome,
  ) as unknown as (request: RunRequest) => Promise<RunOutcome>;
  const resolveDownload = vi.fn(
    options.resolveDownload ??
      (async (s: ShortRecord) => ({
        ok: true,
        url: `https://cdn.example.test/${s.platform_video_id}.mp4?sig=abc`,
      }) as DownloadOutcome),
  );
  render(
    <ShortsConsole
      defaultMinViews={CONFIGURED_THRESHOLD}
      defaultLimit={DEFAULT_LIMIT}
      defaultMinDuration={0}
      maxDurationSeconds={120}
      topics={{ list: [], note: null }}
      run={run}
      resolveDownload={resolveDownload}
      costPerDownload="about 19 MB of proxy traffic"
      estimate={undefined as unknown as (request: RunRequest) => Promise<EstimateOutcome>}
    />,
  );
  return { resolveDownload };
}

/** Press the run button and wait for the export panel to arrive. */
async function runThenFindPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /get latest shorts/i }));
  return (await screen.findByRole("region", { name: /every link, in one file/i })) as HTMLElement;
}

const exportButton = () => screen.getByRole("button", { name: /export all links/i });
const box = () => screen.getByRole("textbox", { name: /links/i }) as HTMLTextAreaElement;

const THREE = [
  short({ platform_video_id: "vid-1", url: "https://www.youtube.com/shorts/vid-1" }),
  short({ platform_video_id: "vid-2", url: "https://www.youtube.com/shorts/vid-2" }),
  short({ platform_video_id: "vid-3", url: "https://www.youtube.com/shorts/vid-3" }),
];

describe("the export panel", () => {
  it("is not offered by a run that found nothing, because there is nothing to export", async () => {
    const user = userEvent.setup();
    mount({ shorts: [] });
    await user.click(screen.getByRole("button", { name: /get latest shorts/i }));

    // The run finished — the report is on screen — and the panel is not.
    await screen.findByText(/platforms read/i);
    expect(screen.queryByRole("region", { name: /every link, in one file/i })).toBeNull();
  });

  it("says how many shorts the RUN found, not how many the table prints", async () => {
    const user = userEvent.setup();
    // Twelve rows, which is more than any table on this page prints at once.
    const many = Array.from({ length: 12 }, (_unused, index) =>
      short({
        platform_video_id: `vid-${index}`,
        url: `https://www.youtube.com/shorts/vid-${index}`,
      }),
    );
    mount({ shorts: many });
    const panel = await runThenFindPanel(user);

    expect(panel.textContent).toMatch(/12 shorts cleared the threshold/i);
  });
});

describe("exporting the video file links", () => {
  it("resolves every row on the run and puts one URL per line in the box", async () => {
    const user = userEvent.setup();
    const { resolveDownload } = mount({ shorts: THREE });
    await runThenFindPanel(user);

    await user.click(exportButton());

    await waitFor(() => expect(resolveDownload).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(box().value).toBe(
        [
          "https://cdn.example.test/vid-1.mp4?sig=abc",
          "https://cdn.example.test/vid-2.mp4?sig=abc",
          "https://cdn.example.test/vid-3.mp4?sig=abc",
        ].join("\n") + "\n",
      ),
    );
  });

  it("lights the row buttons it resolved, because it is the same state they are", async () => {
    const user = userEvent.setup();
    mount({ shorts: THREE });
    await runThenFindPanel(user);

    await user.click(exportButton());

    // Every row now offers the file it resolved rather than a button to ask.
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: /download the video/i })).toHaveLength(3),
    );
    expect(screen.queryAllByRole("button", { name: /get the video file link/i })).toHaveLength(0);
  });

  it("does not ask again for a row somebody already opened by hand", async () => {
    const user = userEvent.setup();
    const { resolveDownload } = mount({ shorts: THREE });
    await runThenFindPanel(user);

    // One row, opened the slow way first.
    await user.click(screen.getAllByRole("button", { name: /get the video file link/i })[0]);
    await waitFor(() => expect(resolveDownload).toHaveBeenCalledTimes(1));

    await user.click(exportButton());

    // Three rows, three lookups in total — not four. On a platform that bills
    // per lookup this assertion is the difference between a press and a charge.
    await waitFor(() => expect(resolveDownload).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(box().value.split("\n").filter(Boolean)).toHaveLength(3));
  });

  it("charges nothing for a second press once the whole list has been asked", async () => {
    const user = userEvent.setup();
    const { resolveDownload } = mount({ shorts: THREE });
    const panel = await runThenFindPanel(user);

    await user.click(exportButton());
    await waitFor(() => expect(resolveDownload).toHaveBeenCalledTimes(3));

    await user.click(exportButton());

    await waitFor(() =>
      expect(panel.textContent).toMatch(/already been asked, so that press resolved nothing/i),
    );
    expect(resolveDownload).toHaveBeenCalledTimes(3);
  });

  it("counts what is missing rather than handing over a short file in silence", async () => {
    const user = userEvent.setup();
    mount({
      shorts: THREE,
      resolveDownload: async (s) =>
        s.platform_video_id === "vid-2"
          ? {
              ok: false,
              message:
                "The YouTube adapter could not get the file for this post. It said: Sign in to " +
                "confirm you're not a bot. The post link above still works.",
            }
          : { ok: true, url: `https://cdn.example.test/${s.platform_video_id}.mp4` },
    });
    const panel = await runThenFindPanel(user);

    await user.click(exportButton());

    await waitFor(() => expect(box().value.split("\n").filter(Boolean)).toHaveLength(2));
    // Two of three, said out loud in the label AND accounted for underneath.
    expect(within(panel).getByText(/2 of 3/)).toBeTruthy();
    expect(panel.textContent).toMatch(
      /Missing from this file: 1 the adapter would not give a file for/i,
    );
  });

  it("never lets an adapter's non-http answer into the file", async () => {
    const user = userEvent.setup();
    mount({
      shorts: [THREE[0]],
      resolveDownload: async () => ({ ok: true, url: "javascript:alert(1)" }),
    });
    const panel = await runThenFindPanel(user);

    await user.click(exportButton());

    // `resolveDownloadUrl` refuses this on the server too. The box is the other
    // way out of the same string, and it holds the same line: nothing arrives.
    await waitFor(() => expect(panel.textContent).toMatch(/Missing from this file/i));
    expect(box().value).not.toMatch(/javascript:/);
  });
});

describe("exporting the post links", () => {
  it("is ready before anything is resolved, and costs nothing to fill", async () => {
    const user = userEvent.setup();
    const { resolveDownload } = mount({ shorts: THREE });
    await runThenFindPanel(user);

    await user.click(screen.getByRole("radio", { name: /post links/i }));

    expect(box().value).toBe(
      [
        "https://www.youtube.com/shorts/vid-1",
        "https://www.youtube.com/shorts/vid-2",
        "https://www.youtube.com/shorts/vid-3",
      ].join("\n") + "\n",
    );
    // The whole point of this list: no lookup, no charge, no expiry.
    expect(resolveDownload).not.toHaveBeenCalled();
  });

  it("says these do not expire, where the file links say they do", async () => {
    const user = userEvent.setup();
    mount({ shorts: THREE });
    const panel = await runThenFindPanel(user);

    expect(panel.textContent).toMatch(/These expire/);

    await user.click(screen.getByRole("radio", { name: /post links/i }));
    expect(panel.textContent).toMatch(/they do not expire/i);
    expect(panel.textContent).not.toMatch(/These expire/);
  });

  it("drops a post URL that is not an http address, and says it did", async () => {
    const user = userEvent.setup();
    mount({
      shorts: [THREE[0], short({ platform_video_id: "vid-9", url: "javascript:alert(1)" })],
    });
    const panel = await runThenFindPanel(user);

    await user.click(screen.getByRole("radio", { name: /post links/i }));

    expect(box().value).toBe("https://www.youtube.com/shorts/vid-1\n");
    expect(panel.textContent).toMatch(/1 row gave a post URL that is not an http/i);
  });
});
