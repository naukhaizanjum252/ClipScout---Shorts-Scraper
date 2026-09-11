// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { Platform, ShortRecord } from "@/lib/platform/types";
import { LibraryPanel } from "@/app/(admin)/admin/library/library-panel";
import type { LibraryRow, LibraryView } from "@/app/(admin)/admin/library/view";

/**
 * THE LIBRARY, AND ITS PLATFORM FILTER, UNDER TEST.
 *
 * Asad, 2026-09-10: *"The library should have a platform filter too so I can
 * see what's from youtube, whats from insta and so on."* These cases hold the
 * filter to what it promises — narrowing the list to one platform — and to the
 * rule that a platform with nothing saved is not offered as a dead choice.
 */
afterEach(() => cleanup());

function short(platform: Platform, id: string, title: string): ShortRecord {
  return {
    platform,
    platform_video_id: id,
    url: `https://example.test/${platform}/${id}`,
    title,
    creator_handle: "@someone",
    creator_id: "c1",
    creator_url: null,
    duration_seconds: 30,
    view_count: 900_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-04T10:00:00.000Z",
    discovered_by: `${platform}:test`,
    topic_slug: null,
  };
}

const row = (
  platform: Platform,
  id: string,
  title: string,
  used = false,
  unproven: readonly string[] | null = null,
): LibraryRow => ({
  short: short(platform, id, title),
  used,
  unproven,
});

function view(rows: readonly LibraryRow[]): LibraryView {
  return { rows, truncation: null, unavailable: null };
}

const noop = async () => ({ ok: true }) as const;
const noResolve = async () => ({ ok: false, message: "not resolved in this test" }) as const;

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("the library platform filter", () => {
  const rows = [
    row("youtube", "y1", "A YouTube clip"),
    row("youtube", "y2", "Another YouTube clip"),
    row("instagram", "i1", "An Instagram reel"),
  ];

  it("offers a chip per platform that has saved shorts, with a count", () => {
    render(<LibraryPanel view={view(rows)} onSetUsed={noop} onResolveDownload={noResolve} />);

    expect(tab(/all platforms/i)).toBeTruthy();
    expect(tab(/youtube/i).textContent).toContain("2");
    expect(tab(/instagram/i).textContent).toContain("1");
  });

  it("narrows the list to one platform when its chip is picked", async () => {
    const user = userEvent.setup();
    render(<LibraryPanel view={view(rows)} onSetUsed={noop} onResolveDownload={noResolve} />);

    await user.click(tab(/instagram/i));

    expect(screen.getByText("An Instagram reel")).toBeTruthy();
    expect(screen.queryByText("A YouTube clip")).toBeNull();
    expect(screen.queryByText("Another YouTube clip")).toBeNull();
  });

  it("does not offer a platform chip row when everything is one platform", () => {
    render(
      <LibraryPanel
        view={view([row("youtube", "y1", "Only YouTube here")])}
        onSetUsed={noop} onResolveDownload={noResolve}
      />,
    );

    // The used/unused tablist is always there; a platform tablist is not, with
    // nothing to choose between.
    expect(screen.queryByRole("tablist", { name: /platform/i })).toBeNull();
  });

  it("marks an unmeasured row so an estimate is not read as a measurement", () => {
    render(
      <LibraryPanel
        view={view([
          row("youtube", "y1", "A measured YouTube short"),
          row("instagram", "i1", "An Instagram reel with no duration", false, ["duration"]),
        ])}
        onSetUsed={noop} onResolveDownload={noResolve}
      />,
    );

    // The unverified one carries the badge; the measured one does not.
    const reel = screen.getByText("An Instagram reel with no duration").closest("article");
    expect(reel).not.toBeNull();
    expect(within(reel as HTMLElement).getByText(/unmeasured/i)).toBeTruthy();

    const measured = screen.getByText("A measured YouTube short").closest("article");
    expect(within(measured as HTMLElement).queryByText(/unmeasured/i)).toBeNull();
  });

  it("resolves a per-card file link on demand, and shows a refusal instead of a dead link", async () => {
    const user = userEvent.setup();
    render(
      <LibraryPanel
        view={view([row("instagram", "i1", "A reel")])}
        onSetUsed={noop}
        onResolveDownload={async () => ({ ok: true, url: "https://cdn.test/clip.mp4" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /video file link/i }));
    const link = await screen.findByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toBe("https://cdn.test/clip.mp4");

    // A refusal (e.g. YouTube's IP-bound link) shows as "no file", never a broken link.
    cleanup();
    render(
      <LibraryPanel
        view={view([row("youtube", "y1", "A yt short")])}
        onSetUsed={noop}
        onResolveDownload={async () => ({ ok: false, message: "blocked from this address" })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /video file link/i }));
    expect(await screen.findByText(/no file/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
  });

  it("combines the platform filter with used/unused", async () => {
    const user = userEvent.setup();
    render(
      <LibraryPanel
        view={view([
          row("youtube", "y1", "Unused YouTube"),
          row("youtube", "y2", "Used YouTube", true),
          row("instagram", "i1", "Unused Instagram"),
        ])}
        onSetUsed={noop} onResolveDownload={noResolve}
      />,
    );

    await user.click(tab(/youtube/i));
    await user.click(tab(/^Unused/i));

    expect(screen.getByText("Unused YouTube")).toBeTruthy();
    expect(screen.queryByText("Used YouTube")).toBeNull();
    // The Instagram unused one is filtered out by the platform choice.
    expect(screen.queryByText("Unused Instagram")).toBeNull();
  });
});
