import { describe, expect, it } from "vitest";

import type { Platform, ShortRecord } from "@/lib/platform/types";
import type { LatestShortsReport, PlatformOutcome } from "@/lib/shorts/run";

import {
  askedCount,
  askedPlatforms,
  belowThresholdTotal,
  describeAge,
  formatDuration,
  formatFigure,
  formatSavedAt,
  notAskedCount,
  readCount,
  safeHref,
  unreadCount,
} from "@/app/(admin)/admin/shorts/view";

/**
 * The four things the shorts page does to a report before a person sees it, in
 * isolation from the DOM.
 *
 * These are small functions and they are tested separately from the component
 * for one reason: three of them are the difference between an honest page and a
 * page that lies quietly. `safeHref` is the only thing standing between an
 * adapter's output and an `href`; the two counting helpers are what stops a
 * platform that could not be read from being counted as a platform with nothing
 * on it. A component test proves they are wired in. This file proves they are
 * right at the edges, which is where all three of them fail.
 */

function short(over: Partial<ShortRecord> = {}): ShortRecord {
  return {
    platform: "youtube",
    platform_video_id: "abc",
    url: "https://youtube.com/shorts/abc",
    title: "A short",
    creator_handle: "@someone",
    creator_id: "UC1",
    creator_url: "https://youtube.com/@someone",
    duration_seconds: 41,
    view_count: 900_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-04T10:00:00.000Z",
    discovered_by: "test",
    topic_slug: null,
    ...over,
  };
}

function readOutcome(platform: Platform, over: Partial<Extract<PlatformOutcome, { status: "ok" }>> = {}): PlatformOutcome {
  return {
    platform,
    status: "ok",
    description: `${platform} adapter`,
    returned: 0,
    kept: 0,
    duplicates: 0,
    dropped: {
      wrongPlatform: 0,
      unknownDuration: 0,
      tooLong: 0,
      tooShort: 0,
      unknownViews: 0,
      belowThreshold: 0,
    },
    shorts: [],
    ...over,
  };
}

function report(platforms: readonly PlatformOutcome[]): LatestShortsReport {
  return {
    startedAt: "2026-09-04T10:00:00.000Z",
    finishedAt: "2026-09-04T10:00:09.000Z",
    minViews: 500_000,
    minDurationSeconds: 0,
    maxDurationSeconds: 120,
    limit: 50,
    platforms,
    shorts: platforms.flatMap((p) => (p.status === "ok" ? [...p.shorts] : [])),
    persistence: { status: "written", rows: 0 },
  };
}

describe("safeHref", () => {
  it("passes http and https through", () => {
    expect(safeHref("https://www.tiktok.com/@a/video/7")).toBe("https://www.tiktok.com/@a/video/7");
    expect(safeHref("http://example.test/a")).toBe("http://example.test/a");
  });

  it("refuses javascript:, which is the whole reason it exists", () => {
    // React escapes TEXT. It does not stop an href from being a script that
    // runs on click, and every URL on this page came from a scraper or a
    // third-party provider's JSON.
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("refuses a javascript: URL smuggled past the check with a newline", () => {
    // THE SUBTLE ONE, and the reason this function returns the PARSED href
    // rather than the string it was given. The URL parser strips control
    // characters, so this parses as the javascript: scheme and is refused. If
    // it ever returned the original string on success, a variant that parsed as
    // https and rendered as something else would ship the unstripped text into
    // the attribute, where the browser strips it again and runs it.
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)  ")).toBeNull();
  });

  it("refuses data: and blob:, which can carry a whole document", () => {
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("blob:https://example.test/9")).toBeNull();
  });

  it("refuses what is not a URL at all, including null and empty", () => {
    // An adapter is allowed to have no creator URL. That must render as an
    // absence, never as a link to nowhere.
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
    expect(safeHref("/relative/path")).toBeNull();
  });
});

describe("the figures over a report", () => {
  it("counts only platforms that were read, so a platform that could not run is never a zero", () => {
    // THE HONESTY RULE AS ARITHMETIC. Instagram could not be read. If it were
    // folded into the read count, the page would report four platforms read and
    // one of them silently empty, which is the exact confusion this repo exists
    // to prevent.
    const r = report([
      readOutcome("youtube", { returned: 10, kept: 2, shorts: [short(), short({ platform_video_id: "b" })] }),
      { platform: "tiktok", status: "unavailable", description: "d", reason: "no key" },
      { platform: "instagram", status: "failed", description: "d", error: "boom" },
      { platform: "x", status: "no-adapter", reason: "nothing configured" },
      readOutcome("facebook", { returned: 3 }),
    ]);

    expect(readCount(r)).toBe(2);
    expect(unreadCount(r)).toBe(3);
    expect(readCount(r) + unreadCount(r)).toBe(5);
  });

  it("counts rows under the threshold and nothing else as under the threshold", () => {
    // A row whose view count the source never reported has NOT been shown to be
    // under 500,000. Adding it here would put a made-up row into the one number
    // this product exists to produce.
    const r = report([
      readOutcome("youtube", {
        returned: 20,
        dropped: {
          wrongPlatform: 1,
          unknownDuration: 2,
          tooLong: 3,
          tooShort: 0,
          unknownViews: 4,
          belowThreshold: 10,
        },
      }),
      readOutcome("tiktok", {
        returned: 5,
        dropped: {
          wrongPlatform: 0,
          unknownDuration: 0,
          tooLong: 0,
          tooShort: 0,
          unknownViews: 5,
          belowThreshold: 0,
        },
      }),
      { platform: "instagram", status: "unavailable", description: "d", reason: "no provider" },
    ]);

    expect(belowThresholdTotal(r)).toBe(10);
  });
});

describe("how a figure is spelled", () => {
  it("never abbreviates, because these get compared down a column", () => {
    // DESIGN.md: 1,284,000 rather than 1.28M. The locale is pinned so the same
    // figure does not depend on whose machine drew it.
    expect(formatFigure(1_284_000)).toBe("1,284,000");
    expect(formatFigure(0)).toBe("0");
  });

  it("writes a duration as m:ss so a reader can see which side of the ceiling it is on", () => {
    expect(formatDuration(41)).toBe("0:41");
    expect(formatDuration(118)).toBe("1:58");
    expect(formatDuration(120)).toBe("2:00");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("rounds a fractional duration rather than printing 0:41.6", () => {
    expect(formatDuration(41.6)).toBe("0:42");
  });
});

describe("the figures when the operator narrowed the run", () => {
  it("counts a platform nobody asked for apart from one that could not be read", () => {
    // THE FIGURES ROW IS WHERE THIS GOES WRONG QUIETLY. "Not read" sits in a
    // line of things that want attention; an unticked checkbox does not want
    // attention, and folding it in there would send an operator looking for a
    // broken adapter that does not exist.
    const r = report([
      readOutcome("youtube", { returned: 4, kept: 1, shorts: [short()] }),
      { platform: "tiktok", status: "failed", description: "d", error: "boom" },
      { platform: "instagram", status: "not-asked", reason: "not selected" },
      { platform: "x", status: "not-asked", reason: "not selected" },
      { platform: "facebook", status: "not-asked", reason: "not selected" },
    ]);

    expect(readCount(r)).toBe(1);
    expect(unreadCount(r)).toBe(1);
    expect(notAskedCount(r)).toBe(3);
    // The three still account for every platform, which is what lets the page
    // print a denominator instead of asking a person to count panels by eye.
    expect(readCount(r) + unreadCount(r) + notAskedCount(r)).toBe(5);
  });

  it("makes the denominator what was asked for, not always five", () => {
    const r = report([
      readOutcome("youtube", { returned: 4, kept: 1, shorts: [short()] }),
      readOutcome("tiktok", { returned: 2 }),
      { platform: "instagram", status: "not-asked", reason: "not selected" },
      { platform: "x", status: "not-asked", reason: "not selected" },
      { platform: "facebook", status: "not-asked", reason: "not selected" },
    ]);

    // "2/2", never "2/5". An operator who ticked two platforms and got both
    // must not read the second figure as three platforms gone missing.
    expect(askedCount(r)).toBe(2);
    expect(readCount(r)).toBe(2);
  });

  it("keeps the denominator at five when every platform was asked for", () => {
    const r = report([
      readOutcome("youtube"),
      readOutcome("tiktok"),
      { platform: "instagram", status: "failed", description: "d", error: "boom" },
      { platform: "x", status: "no-adapter", reason: "nothing configured" },
      { platform: "facebook", status: "unavailable", description: "d", reason: "no key" },
    ]);

    // The unnarrowed run, which is every run the scheduler and the CLI make.
    expect(askedCount(r)).toBe(5);
    expect(notAskedCount(r)).toBe(0);
    expect(unreadCount(r)).toBe(3);
  });
});

/**
 * THE CAPTION ON A RESTORED RUN.
 *
 * These three exist because a run now survives a reload (Erik, 2026-09-05), and
 * a restored list is the same markup as a fresh one. Everything that keeps the
 * two apart is a string these functions produce, so they are tested where the
 * DOM cannot hide a wrong one.
 */
describe("saying how old a restored run is", () => {
  const SAVED = "2026-09-05T03:00:00.000Z";
  const at = (iso: string) => describeAge(SAVED, new Date(iso));

  it("calls a run made moments ago what it is", () => {
    expect(at("2026-09-05T03:00:30.000Z")).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(at("2026-09-05T03:20:00.000Z")).toBe("20 minutes ago");
    expect(at("2026-09-05T04:00:00.000Z")).toBe("an hour ago");
    expect(at("2026-09-05T06:00:00.000Z")).toBe("3 hours ago");
    expect(at("2026-09-06T03:00:00.000Z")).toBe("yesterday");
    expect(at("2026-09-09T03:00:00.000Z")).toBe("4 days ago");
  });

  /**
   * A CLOCK SKEW MUST NOT PRODUCE A RUN FROM THE FUTURE. The timestamp comes
   * from Postgres and `now` from the operator's browser; the two disagree by
   * seconds routinely and by more when a machine's clock is wrong. "in 4
   * minutes" beside a list of Shorts is the kind of sentence that makes a
   * person distrust every other figure on the page.
   */
  it("does not run backwards when the browser's clock is behind the database's", () => {
    expect(at("2026-09-05T02:55:00.000Z")).toBe("just now");
  });

  it("says it does not know rather than inventing an age from an unparseable time", () => {
    expect(describeAge("whenever", new Date("2026-09-05T03:00:00.000Z"))).toBe("at an unknown time");
  });
});

describe("printing when a restored run was fetched", () => {
  /**
   * PINNED TO UTC, AND NAMED. The console is rendered on the server and then
   * hydrated in a browser, so a local-zone timestamp is formatted at two
   * different offsets and React hydrates one over the other. This is the same
   * call `formatFigure` makes about the locale, and the test is the guard: the
   * expected string below is only stable because the zone is pinned, so it goes
   * red on the machine of anybody who removes the pin.
   */
  it("spells the time out in a zone that does not depend on who is looking", () => {
    expect(formatSavedAt("2026-09-05T03:05:00.000Z")).toBe("5 September at 03:05 UTC");
  });

  it("says so rather than printing `Invalid Date` when the value is not a time", () => {
    expect(formatSavedAt("")).toBe("an unknown time");
  });
});

describe("putting back the platforms a restored run asked for", () => {
  /**
   * A run of two platforms restored under five ticked boxes would report three
   * of them as missing when what happened is that nobody asked for them. This
   * is the same derivation `askedCount` makes, and it must stay the same one:
   * a checkbox row that disagreed with the "n/m platforms read" figure directly
   * above it would leave an operator with two answers and no way to choose.
   */
  it("counts a platform that was read, one that stopped early, and one that broke", () => {
    const r = report([
      readOutcome("youtube"),
      { platform: "tiktok", status: "failed", description: "d", error: "boom" },
      { platform: "instagram", status: "not-asked", reason: "Not selected." },
      { platform: "x", status: "not-asked", reason: "Not selected." },
      { platform: "facebook", status: "unavailable", description: "d", reason: "no key" },
    ]);

    // A platform that could not be read WAS asked for, so its box stays ticked.
    // Unticking it would turn a deployment problem into a click the operator
    // then has to undo before their next run does what they meant.
    expect(askedPlatforms(r)).toEqual(["youtube", "tiktok", "facebook"]);
    expect(askedPlatforms(r).length).toBe(askedCount(r));
  });
});
