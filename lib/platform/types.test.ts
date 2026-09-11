import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { MIN_VIEWS_DEFAULT, minViews } from "../config";
import type { LatestShortsQuery, PlatformAdapter } from "./adapter";
import {
  PLATFORMS,
  UnknownPlatformError,
  isPlatform,
  parsePlatform,
  platformLabel,
  type Platform,
  type ShortRecord,
} from "./types";

describe("the platform list", () => {
  it("is the six, and all six are first-class even where nothing can read them", () => {
    // Erik, 2026-09-02: "you scrape ALL platforms". Three of these five have no
    // verified reader as of 2026-09-04 (yt-dlp calls `instagram:user` broken and
    // has no enumerator for X or Facebook at all). They are in the list anyway,
    // because a platform absent from the vocabulary is a platform the UI cannot
    // even say it failed to read — and "could not be read" must never collapse
    // into "no results". Dropping one from this array to match what works today
    // is the change this assertion exists to stop.
    expect([...PLATFORMS]).toEqual(["youtube", "tiktok", "instagram", "x", "facebook", "threads"]);
  });

  it("has no duplicates, so grouping by platform cannot produce two of one heading", () => {
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
  });
});

describe("platformLabel", () => {
  it("spells every platform the way that platform spells itself", () => {
    // Capitalising the first letter gets three of these wrong. The labels are a
    // lookup for exactly that reason, and this is the assertion that catches
    // somebody "simplifying" it back into string surgery.
    expect(PLATFORMS.map(platformLabel)).toEqual([
      "YouTube",
      "TikTok",
      "Instagram",
      "X",
      "Facebook",
      "Threads",
    ]);
  });

  it("covers the whole list, so a new platform cannot ship label-less", () => {
    // The Record<Platform, string> makes this a compile error too, but a type
    // error is invisible to anyone running only the suite.
    for (const p of PLATFORMS) {
      expect(platformLabel(p), `no label for ${p}`).toBeTruthy();
    }
  });
});

describe("parsePlatform", () => {
  it("round-trips every platform in the list", () => {
    for (const p of PLATFORMS) {
      expect(parsePlatform(p)).toBe(p);
    }
  });

  it("normalises case and surrounding whitespace, because that is how people type URLs", () => {
    // `?platform=YouTube` from a hand-typed link, and "X" from anyone writing
    // that platform's actual name.
    expect(parsePlatform("YouTube")).toBe("youtube");
    expect(parsePlatform("  TikTok\n")).toBe("tiktok");
    expect(parsePlatform("X")).toBe("x");
  });

  it("REFUSES an unknown value instead of defaulting to youtube", () => {
    // The whole reason this function exists rather than a cast. A default here
    // would file a TikTok under YouTube and nothing downstream would ever
    // notice: the row looks exactly like a real one. A throw announces itself at
    // the boundary, where the caller still knows what it was reading.
    for (const bad of ["", "youtub", "reels", "shorts", "vimeo", "snapchat"]) {
      expect(() => parsePlatform(bad), `${JSON.stringify(bad)} was accepted`).toThrow(UnknownPlatformError);
    }
  });

  it("refuses another source's vocabulary rather than guessing the mapping", () => {
    // yt-dlp says "twitter", some providers say "ig". Those are that source's
    // words. Mapping them belongs in the adapter that meets them, where somebody
    // can be sure the mapping is right — not in a synonym table here guessing on
    // behalf of code it cannot see.
    expect(() => parsePlatform("twitter")).toThrow(UnknownPlatformError);
    expect(() => parsePlatform("ig")).toThrow(UnknownPlatformError);
    expect(() => parsePlatform("fb")).toThrow(UnknownPlatformError);
  });

  it("refuses non-strings, which is what a missing query param or a null column looks like", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], ["youtube"]]) {
      expect(() => parsePlatform(bad), `${JSON.stringify(bad)} was accepted`).toThrow(UnknownPlatformError);
    }
  });

  it("says what it was given and what it wanted, so the error is actionable in a log", () => {
    // An error reading only "invalid platform" sends whoever finds it back to
    // the source to work out which of five values was expected.
    let caught: unknown;
    try {
      parsePlatform("twitter");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownPlatformError);
    expect((caught as UnknownPlatformError).raw).toBe("twitter");
    expect((caught as Error).message).toContain("twitter");
    for (const p of PLATFORMS) {
      expect((caught as Error).message).toContain(p);
    }
  });
});

describe("isPlatform", () => {
  it("narrows without throwing, for callers that want to branch", () => {
    expect(isPlatform("instagram")).toBe(true);
    expect(isPlatform("twitter")).toBe(false);
    expect(isPlatform(null)).toBe(false);
    expect(isPlatform(7)).toBe(false);
  });

  it("is exact — it does not normalise, so it cannot silently disagree with parsePlatform", () => {
    // parsePlatform("X") succeeds because it normalises first; isPlatform("X")
    // is false because "X" is not a member. That asymmetry is intentional and
    // written down here so nobody "fixes" one of them into the other.
    expect(isPlatform("X")).toBe(false);
    expect(parsePlatform("X")).toBe("x");
  });
});

describe("identity is (platform, platform_video_id) and nothing validates the id's shape", () => {
  const record = (platform: Platform, id: string, url: string): ShortRecord => ({
    platform,
    platform_video_id: id,
    url,
    title: null,
    creator_handle: null,
    creator_id: null,
    creator_url: null,
    duration_seconds: null,
    view_count: null,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: "2026-09-04T00:00:00.000Z",
    discovered_by: "types.test",

    topic_slug: null,
  });

  it("holds all five id formats in one field, unrewritten", () => {
    // A YouTube id is 11 characters of base64url, a TikTok id is a 19-digit
    // number, an Instagram shortcode is 11 characters of a DIFFERENT alphabet,
    // an X post id is a snowflake, a Facebook reel id is a 16-digit number. The
    // previous schema asserted the YouTube shape in a check constraint; it was
    // right about YouTube and is the single specific reason this repo was
    // single-platform. Any one validator admitting all five admits nearly
    // everything, so it validates nothing while still looking like a guarantee.
    //
    // Most of the force of this test is the COMPILE — six shapes into one
    // field with nothing rejecting any of them. The assertion below is the
    // cheap half: the field is a passthrough and nobody has grown a normaliser.
    const ids = [
      "dQw4w9WgXcQ",
      "7412345678901234567",
      "C_9xYzAbCdE",
      "1834567890123456789",
      "1234567890123456",
      // Threads issues the same snowflake-shaped numeric id its parent company
      // uses elsewhere, and it is stored unrewritten like every other one.
      "18023456789012345",
    ];
    const rows = PLATFORMS.map((p, i) => record(p, ids[i], `https://example.invalid/${ids[i]}`));
    expect(rows.map((r) => r.platform_video_id)).toEqual(ids);
  });

  it("treats the same id string on two platforms as two different shorts", () => {
    // The reason the key is a pair. Numeric ids collide across platforms far
    // more readily than they look like they would, and a single-column id would
    // silently deduplicate two unrelated videos into one row.
    const a = record("tiktok", "1834567890123456789", "https://www.tiktok.com/@a/video/1834567890123456789");
    const b = record("x", "1834567890123456789", "https://x.com/b/status/1834567890123456789");
    const byKey = new Map<string, ShortRecord>();
    for (const r of [a, b]) byKey.set(`${r.platform} ${r.platform_video_id}`, r);
    expect(byKey.size).toBe(2);
  });

  it("lets every optional field be null, because null means the source did not say", () => {
    // Not zero. A short with view_count null has not been shown to be under the
    // threshold and has not been shown to be over it. If these fields were
    // non-nullable an adapter would have to invent a 0, and 0 views reads as a
    // measurement.
    const r = record("youtube", "dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(r.view_count).toBeNull();
    expect(r.duration_seconds).toBeNull();
    expect(r.published_at).toBeNull();
  });

  it("keeps the five fields that may NEVER be null non-nullable", () => {
    // These four assignments are the assertion, and they are checked by tsc
    // rather than at runtime: widening any of these fields to `| null` stops
    // this file compiling. A runtime `expect(...).not.toBeNull()` would not
    // catch it, because the fixture below would still be passing a real value.
    //
    // Why these five and not the others: a short you cannot LINK to is not a
    // result Erik can use ("links to download them"); a row with no PLATFORM and
    // no ID has no identity, which is the primary key; and a row with no
    // discovery PROVENANCE cannot be explained after the fact when somebody asks
    // where it came from.
    const r = record("tiktok", "7412345678901234567", "https://example.invalid/7412345678901234567");
    const platform: Platform = r.platform;
    const id: string = r.platform_video_id;
    const url: string = r.url;
    const discoveredAt: string = r.discovered_at;
    const discoveredBy: string = r.discovered_by;
    expect([id, url, discoveredAt, discoveredBy].every((v) => v.length > 0)).toBe(true);
    expect(platform).toBe("tiktok");
  });
});

/**
 * The named mistake, as a guard.
 *
 * The brief is explicit that the YouTube assumption "must not come back in
 * another shape". The shape it would come back in is a validator: a quantified
 * character class asserting an id is 11 characters, or a URL builder with a
 * platform's domain hardcoded. Either one belongs behind the per-platform seam
 * (an adapter), never in the vocabulary every platform shares.
 */
const ID_SHAPE_REGEX = /\[[^\]\n]*\]\s*\{\s*\d+\s*(?:,\s*\d*\s*)?\}/;
const HARDCODED_DOMAIN = /\b(?:youtube|youtu|tiktok|instagram|facebook|fb|twitter|x)\.(?:com|be)\b/i;

function vocabularyOffences(source: string): string[] {
  const offences: string[] = [];
  // CRLF is normalised away FIRST, and that is not cosmetic. `$` in a non-global
  // JS regex will not match before a `\r`, and `.` will not consume one, so on a
  // Windows checkout every comment-stripping pattern below silently stops
  // working and the guard reports its own explanatory prose as an offence. Found
  // by mutation-testing this file on 2026-09-04: the mutation script rewrote
  // types.ts in text mode, the endings flipped to CRLF, and the guard went red
  // on a line of comment. A guard that fires on prose is a guard somebody
  // deletes.
  for (const [i, line] of source.replace(/\r\n?/g, "\n").split("\n").entries()) {
    // Comments are where this rule is explained, and forbidding the words there
    // would forbid explaining it. Prose is stripped; code is judged.
    //
    // The `[^:]` guard on the line-comment strip is not fussiness: a naive
    // /\/\/.*$/ eats everything after the `//` in `https://`, which is exactly
    // the offender this guard exists to catch. That version of this function
    // passed its own positive control by deleting the evidence.
    const code = line
      .replace(/(^|[^:])\/\/.*$/, "$1")
      .replace(/^\s*\*.*$/, "")
      .replace(/^\s*\/\*.*$/, "");
    if (ID_SHAPE_REGEX.test(code) || HARDCODED_DOMAIN.test(code)) {
      offences.push(`${i + 1}: ${line.trim()}`);
    }
  }
  return offences;
}

describe("no platform-specific assumption may live in the shared vocabulary", () => {
  it("holds for lib/platform/types.ts and lib/platform/adapter.ts", () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    for (const file of ["types.ts", "adapter.ts"]) {
      for (const o of vocabularyOffences(fs.readFileSync(path.join(dir, file), "utf8"))) {
        offenders.push(`${file}:${o}`);
      }
    }
    expect(offenders, `platform-specific assumptions in the vocabulary:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("still fires on the constraint that made this repo single-platform", () => {
    // The narrowing above is only worth having if the guard still catches the
    // thing it was written for. This is the check constraint from the old
    // schema, transcribed into TypeScript.
    expect(vocabularyOffences('const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;')).toHaveLength(1);
    expect(vocabularyOffences('const url = `https://www.youtube.com/shorts/${id}`;')).toHaveLength(1);
  });

  it("does not fire on prose explaining the rule", () => {
    // If this goes red the guard has widened out and the explanation gets pushed
    // out of the code — which is how a real check gets deleted as noise.
    const source = [
      " * The previous schema asserted /^[A-Za-z0-9_-]{11}$/ on every id, which was",
      " * correct about youtube.com and wrong about everything else.",
    ].join("\n");
    expect(vocabularyOffences(source)).toEqual([]);
  });

  it("does not fire on that same prose in a file with Windows line endings", () => {
    // The regression above, pinned. Every developer on this project is on
    // Windows and git can hand any of them a CRLF checkout, so a guard that only
    // works on LF is a guard that goes red for half the team on a file nobody
    // touched.
    const source = [
      " * The previous schema asserted /^[A-Za-z0-9_-]{11}$/ on every id, which was",
      " * correct about youtube.com and wrong about everything else.",
    ].join("\r\n");
    expect(vocabularyOffences(source)).toEqual([]);
  });

  it("still fires on a real offender with Windows line endings", () => {
    // The other half: normalising endings must not turn the guard off.
    expect(vocabularyOffences("const a = 1;\r\nconst VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;\r\n")).toHaveLength(1);
  });
});

describe("the adapter seam", () => {
  /**
   * A stub that can run, and one that cannot. Between them they pin the seam's
   * shape (a signature change stops this file compiling) and the one semantic
   * that is easy to read backwards: `unavailableReason()` returns NULL when the
   * adapter CAN run, and a SENTENCE when it cannot. Getting that inverted would
   * make every stub adapter look healthy and every working one look broken.
   */
  const working: PlatformAdapter = {
    platform: "youtube",
    describe: () => "Reads the public Shorts feed with yt-dlp. Needs no key.",
    unavailableReason: async () => null,
    latestShorts: async () => [],
    downloadUrl: async () => "https://example.invalid/media.mp4",
  };

  const stub: PlatformAdapter = {
    platform: "facebook",
    describe: () => "No reader yet. Facebook needs a third-party data provider.",
    unavailableReason: async () =>
      "No adapter can read Facebook: yt-dlp has no page or profile enumerator, and no data provider has been chosen.",
    latestShorts: async () => {
      throw new Error("must not be called while unavailableReason() returns a reason");
    },
    downloadUrl: async () => null,
  };

  it("says an adapter can run by returning null, not by returning a reason", async () => {
    await expect(working.unavailableReason()).resolves.toBeNull();
  });

  it("makes an adapter that cannot run say WHY, in a sentence a person can act on", async () => {
    // THE HONESTY RULE. An adapter that cannot run must not return `[]` — an
    // empty array is the same shape as "this platform genuinely had nothing over
    // the threshold today", and those two must never look the same on screen.
    const reason = await stub.unavailableReason();
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/provider|key|enumerator|broken/i);
    expect(await stub.latestShorts({ limit: 1, minViews: 1, minDurationSeconds: 0, maxDurationSeconds: 1 }).catch(() => "threw")).toBe(
      "threw",
    );
  });

  it("resolves a download URL on demand and allows null when it cannot", async () => {
    // The URL is never stored: a signed media URL from any of these platforms
    // expires in minutes to hours, and a stored one is a dead link that still
    // looks alive. Null is a legitimate answer, not an error.
    const short: ShortRecord = {
      platform: "facebook",
      platform_video_id: "1234567890123456",
      url: "https://example.invalid/1234567890123456",
      title: null,
      creator_handle: null,
      creator_id: null,
      creator_url: null,
      duration_seconds: null,
      view_count: null,
      like_count: null,
      comment_count: null,
      published_at: null,
      thumbnail_url: null,
      discovered_at: "2026-09-04T00:00:00.000Z",
      discovered_by: "types.test",

      topic_slug: null,
    };
    await expect(stub.downloadUrl(short)).resolves.toBeNull();
    await expect(working.downloadUrl(short)).resolves.toBeTypeOf("string");
  });

  it("passes the threshold and both length bounds INTO the query, so a source that can filter, does", () => {
    // Asking a metered API for 50 rows and discarding 48 is somebody else's
    // bandwidth and, on a paid provider, real money.
    const query: LatestShortsQuery = {
      limit: 50,
      minViews: MIN_VIEWS_DEFAULT,
      minDurationSeconds: 0,
      maxDurationSeconds: 120,
    };
    expect(query.minViews).toBe(500_000);
    expect(query.maxDurationSeconds).toBe(120);
    // Zero is the ordinary floor and it excludes nothing: the control exists so
    // an operator CAN narrow the window, not so the tool narrows it for them.
    expect(query.minDurationSeconds).toBe(0);
  });
});

describe("the view threshold", () => {
  it("is 500,000, which is Erik's own instruction and not an assumption", () => {
    // Erik, 2026-09-02: "come back with shorts over 500k views categorized by
    // platform, AXE the rest." It has a default for the same reason the Shorts
    // ceiling does — the person who decides said the number himself.
    expect(MIN_VIEWS_DEFAULT).toBe(500_000);
    expect(minViews({})).toBe(500_000);
  });

  it("is config, so the day the client wants a different number is one env var", () => {
    expect(minViews({ MIN_VIEWS: "200000" })).toBe(200_000);
    expect(minViews({ MIN_VIEWS: " 1000000 " })).toBe(1_000_000);
  });

  it("refuses a value that is not a whole number rather than falling back to the default", () => {
    // Silently ignoring MIN_VIEWS=500k would run the product on 500,000 while
    // the operator believed they had changed it. A misconfigured threshold that
    // works is worse than one that stops.
    expect(() => minViews({ MIN_VIEWS: "500k" })).toThrow();
    expect(() => minViews({ MIN_VIEWS: "5e5" })).toThrow();
    expect(() => minViews({ MIN_VIEWS: "-1" })).toThrow();
    expect(() => minViews({ MIN_VIEWS: "1.5" })).toThrow();
  });

  it("rejects zero instead of reading it as 'no threshold'", () => {
    // MIN_VIEWS=0 is a request to turn the product's one promise off, and it is
    // far likelier to be a misread env file than an intention. Deleting the
    // filter is a code change and should look like one.
    expect(() => minViews({ MIN_VIEWS: "0" })).toThrow();
  });

  it("treats unset and empty as unset, so a blank line in .env is not a crash", () => {
    expect(minViews({ MIN_VIEWS: "" })).toBe(MIN_VIEWS_DEFAULT);
    expect(minViews({ MIN_VIEWS: "   " })).toBe(MIN_VIEWS_DEFAULT);
  });
});
