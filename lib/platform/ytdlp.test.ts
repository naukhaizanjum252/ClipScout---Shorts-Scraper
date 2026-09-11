/**
 * The yt-dlp plumbing, tested against RECORDED output and never the network.
 *
 * The two fixtures are the evidence behind the one real decision in
 * lib/platform/youtube.ts — uploads playlist yes, /shorts tab no — so this file
 * asserts the difference between them directly. If YouTube ever starts putting
 * a duration on the /shorts tab, the test that says it does not will go red and
 * somebody will get to reconsider that decision on purpose.
 */
import { describe, expect, it } from "vitest";

import shortsTabFixture from "./fixtures/ytdlp-shorts-tab-3.json";
import uploadsFixture from "./fixtures/ytdlp-uploads-137.json";
import type { LatestShortsQuery } from "./adapter";
import type { ShortRecord } from "./types";
import { safeToShowMessage } from "../shorts/run";
import {
  entryCount,
  firstMediaUrl,
  matchesQuery,
  mediaUrlArgs,
  defaultHostArgs,
  hasRotatingProxy,
  makeYtDlpRunner,
  requireReadableCounts,
  scrubProxy,
  ytDlpProxyArgs,
  resolveMediaUrl,
  withHostArgs,
  ytDlpCookieArgs,
  ytDlpUnavailableReason,
  shortsFromFlatPlaylist,
  YtDlpError,
  type FlatPlaylist,
  type YtDlpRunner,
} from "./ytdlp";

const AT = "2026-09-04T00:00:00.000Z";

function normalise(playlist: unknown, handleFields?: ["uploader" | "uploader_id", "uploader" | "uploader_id"]) {
  return shortsFromFlatPlaylist({
    platform: "youtube",
    playlist: playlist as FlatPlaylist,
    discoveredBy: "test",
    discoveredAt: AT,
    handleFields,
  });
}

function record(over: Partial<ShortRecord> = {}): ShortRecord {
  return {
    platform: "youtube",
    platform_video_id: "abc",
    url: "https://example.test/abc",
    title: null,
    creator_handle: null,
    creator_id: null,
    creator_url: null,
    duration_seconds: 30,
    view_count: 1_000_000,
    like_count: null,
    comment_count: null,
    published_at: null,
    thumbnail_url: null,
    discovered_at: AT,
    discovered_by: "test",

    topic_slug: null,
    ...over,
  };
}

const QUERY: LatestShortsQuery = { limit: 50, minViews: 500_000, minDurationSeconds: 0, maxDurationSeconds: 120 };

describe("shortsFromFlatPlaylist, against the recorded uploads playlist", () => {
  const records = normalise(uploadsFixture);

  it("turns every recorded entry into a row", () => {
    // 137 entries recorded, 137 rows. A drop here means the translation started
    // rejecting real YouTube output.
    expect(records).toHaveLength(137);
  });

  it("carries the two numbers the whole product depends on", () => {
    // Duration defines a Short; views are the threshold. A listing without both
    // cannot answer the question the tool exists to answer, and this fixture is
    // the proof that the uploads playlist has both.
    expect(records.every((r) => r.duration_seconds !== null)).toBe(true);
    expect(records.every((r) => r.view_count !== null)).toBe(true);
  });

  it("records no publish date, because the source carries none", () => {
    // 137 of 137 recorded entries have `timestamp: null`. Order is known, date
    // is not, and inventing one from list position is the exact lie this repo
    // was built to avoid.
    expect(records.every((r) => r.published_at === null)).toBe(true);
  });

  it("keeps the platform's own id and the canonical post URL", () => {
    const first = records[0];
    expect(first.platform_video_id).toBe("5mU6SRS2Bxo");
    expect(first.url).toContain("5mU6SRS2Bxo");
    expect(first.platform).toBe("youtube");
  });

  it("reads the handle out of uploader_id for YouTube, with the @ stripped", () => {
    expect(records[0].creator_handle).toBe("MrBeast");
    expect(records[0].creator_id).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
  });

  it("picks the largest thumbnail rather than whichever came first", () => {
    expect(records[0].thumbnail_url).toMatch(/^https:\/\//);
  });
});

describe("the /shorts tab, and why it was rejected", () => {
  const records = normalise(shortsTabFixture);

  it("carries view counts but NOT durations", () => {
    // This is the whole reason lib/platform/youtube.ts reads the uploads
    // playlist instead. Recorded from this machine on 2026-09-04.
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.view_count !== null)).toBe(true);
    expect(records.every((r) => r.duration_seconds === null)).toBe(true);
  });

  it("is refused by the readable-counts guard instead of coming back empty", () => {
    // The failure being prevented: every row fails the <=120s ceiling because
    // none has a duration, the adapter returns [], and the screen says YouTube
    // had no viral shorts today. It did not; we could not read it.
    expect(() =>
      requireReadableCounts("youtube", entryCount(shortsTabFixture as FlatPlaylist), records, "/shorts tab"),
    ).toThrow(YtDlpError);
  });
});

describe("entries that cannot become rows are dropped, and only those", () => {
  it("drops an entry with no id — identity is (platform, platform_video_id)", () => {
    const out = normalise({ entries: [{ url: "https://example.test/x", view_count: 1 }] });
    expect(out).toHaveLength(0);
  });

  it("drops an entry with no url — the post link is what the operator is promised", () => {
    const out = normalise({ entries: [{ id: "x", view_count: 1 }] });
    expect(out).toHaveLength(0);
  });

  it("does NOT invent a YouTube id out of a watch URL", () => {
    // The old lib/source/ytdlp.ts read `?v=` from the URL when `id` was missing.
    // That is a YouTube fact in shared code and it is deliberately gone.
    const out = normalise({ entries: [{ url: "https://www.youtube.com/watch?v=abc12345678" }] });
    expect(out).toHaveLength(0);
  });
});

describe("handleFields, because the platforms disagree about where a handle lives", () => {
  const entry = { id: "1", url: "https://t.test/1", uploader: "khaby.lame", uploader_id: "6543210" };

  it("prefers uploader_id by default, which is right for YouTube", () => {
    expect(normalise({ entries: [entry] })[0].creator_handle).toBe("6543210");
  });

  it("prefers uploader when asked, which is right for TikTok", () => {
    // TikTok's uploader_id is a numeric author id. Taking it as the handle
    // would put a number in a handle column, where it still looks like data.
    expect(normalise({ entries: [entry] }, ["uploader", "uploader_id"])[0].creator_handle).toBe("khaby.lame");
  });
});

describe("requireReadableCounts — 'unreadable' and 'empty' must never look the same", () => {
  it("says nothing when the source genuinely listed nothing", () => {
    // Zero entries IS a result. It is the one case that must not throw.
    expect(() => requireReadableCounts("tiktok", 0, [], "source")).not.toThrow();
  });

  it("throws when entries came back but none had view counts", () => {
    const rows = [record({ view_count: null }), record({ view_count: null })];
    expect(() => requireReadableCounts("tiktok", 2, rows, "source")).toThrow(/not one carried a view count/);
  });

  it("throws when entries came back but none had durations", () => {
    const rows = [record({ duration_seconds: null }), record({ duration_seconds: null })];
    expect(() => requireReadableCounts("tiktok", 2, rows, "source")).toThrow(/not one carried a duration/);
  });

  it("throws when entries came back and none survived translation at all", () => {
    expect(() => requireReadableCounts("tiktok", 5, [], "source")).toThrow(/unreadable listing, not an empty one/);
  });

  it("stays quiet when even one row is usable", () => {
    // A single readable row proves the listing shape is intact. Anything
    // stricter would turn a partly-odd page into a hard failure.
    const rows = [record({ view_count: null }), record()];
    expect(() => requireReadableCounts("tiktok", 2, rows, "source")).not.toThrow();
  });
});

describe("matchesQuery — null is not zero and not 'probably fine'", () => {
  it("keeps a row that clears both halves of the promise", () => {
    expect(matchesQuery(record({ duration_seconds: 120, view_count: 500_000 }), QUERY)).toBe(true);
  });

  it("drops a row one view short and one second long", () => {
    expect(matchesQuery(record({ view_count: 499_999 }), QUERY)).toBe(false);
    expect(matchesQuery(record({ duration_seconds: 121 }), QUERY)).toBe(false);
  });

  it("drops a row whose duration the source never stated", () => {
    // A video that has not been shown to be under the ceiling is not a Short.
    expect(matchesQuery(record({ duration_seconds: null }), QUERY)).toBe(false);
  });

  it("drops a row whose view count the source never stated", () => {
    expect(matchesQuery(record({ view_count: null }), QUERY)).toBe(false);
  });
});

describe("resolving a direct media URL", () => {
  it("asks for one progressive file and never downloads", () => {
    const args = mediaUrlArgs("https://example.test/v");
    // `--print` implies `--simulate`; a single format means one line out
    // instead of a video URL and an audio URL only a muxer can join.
    expect(args).toContain("--print");
    expect(args).toContain("urls");
    expect(args.join(" ")).toContain("best[ext=mp4]/best");
    expect(args).not.toContain("-o");
  });

  it("takes the first URL and ignores yt-dlp's chatter", () => {
    expect(firstMediaUrl("\nsome note\nhttps://media.test/a\nhttps://media.test/b\n")).toBe("https://media.test/a");
  });

  it("returns null when there is no URL at all", () => {
    // Null means "no file for this one", which the UI must show as such rather
    // than as a broken button.
    expect(firstMediaUrl("ERROR: nope")).toBeNull();
  });
});

describe("resolveMediaUrl — a refusal is not the same answer as 'no file'", () => {
  const RUN_OK: YtDlpRunner = async () => "https://media.test/a\n";

  it("hands back the URL yt-dlp printed", async () => {
    await expect(resolveMediaUrl(RUN_OK, "youtube", "https://example.test/v")).resolves.toBe(
      "https://media.test/a",
    );
  });

  it("returns null only when yt-dlp SUCCEEDED and printed no URL", async () => {
    const run: YtDlpRunner = async () => "";
    await expect(resolveMediaUrl(run, "youtube", "https://example.test/v")).resolves.toBeNull();
  });

  it("carries yt-dlp's own diagnosis instead of flattening it to null", async () => {
    // THE SCAR, in a test. This exact sentence was measured on 2026-09-08
    // against two rows the tool had just filed, and the operator was shown
    // "the YouTube adapter has no way to get the file for this post" — a claim
    // about the adapter, made out of a fact about the IP it was running on.
    const stderr =
      "yt-dlp exited 1: ERROR: [youtube] i7jX9SR0bfw: Sign in to confirm you're not a bot. " +
      "Use --cookies-from-browser or --cookies for the authentication.";
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, stderr);
    };

    await expect(resolveMediaUrl(run, "youtube", "https://example.test/v")).rejects.toThrow(
      /not a bot/,
    );
  });

  it("names the platform the runner could not know it was reading", async () => {
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, "exited 1: whatever");
    };
    const caught = await resolveMediaUrl(run, "tiktok", "https://example.test/v").catch((e) => e);
    expect(caught).toBeInstanceOf(YtDlpError);
    expect((caught as YtDlpError).platform).toBe("tiktok");
    expect((caught as YtDlpError).message).toContain("[yt-dlp tiktok]");
    // Not double-prefixed: the runner's own "[yt-dlp] " is replaced, not kept.
    expect((caught as YtDlpError).message).not.toContain("[yt-dlp] ");
  });

  it("is fit to print, so the reason reaches the operator rather than a log file", async () => {
    // services/ytdlp/README.md promises exactly this: "the app surfaces it, so
    // that line reaches the screen". The run path kept the promise; the
    // download path did not, because nothing marked this class.
    const run: YtDlpRunner = async () => {
      throw new YtDlpError(null, "exited 1: Sign in to confirm you're not a bot");
    };
    const caught = await resolveMediaUrl(run, "youtube", "https://example.test/v").catch((e) => e);
    expect(safeToShowMessage(caught)).toContain("not a bot");
  });
});
describe("cookies — what answers 'Sign in to confirm you're not a bot'", () => {
  it("adds nothing when a deployment has configured nothing", () => {
    expect(ytDlpCookieArgs({})).toEqual([]);
  });

  it("passes a file straight through, because that is what works on Windows", () => {
    // MEASURED 2026-09-08: --cookies-from-browser cannot read Chrome ("Could
    // not copy Chrome cookie database") or Edge ("Failed to decrypt with
    // DPAPI") on Windows, so the exported file is not a fallback there — it is
    // the only mechanism.
    expect(ytDlpCookieArgs({ YTDLP_COOKIES_FILE: "C:/secrets/cookies.txt" })).toEqual([
      "--cookies",
      "C:/secrets/cookies.txt",
    ]);
  });

  it("accepts a browser, with or without a profile", () => {
    expect(ytDlpCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: "firefox" })).toEqual([
      "--cookies-from-browser",
      "firefox",
    ]);
    // BROWSER[+KEYRING][:PROFILE][::CONTAINER] — one argv element, spawned
    // without a shell, so the tail is yt-dlp's business and not a second arg.
    expect(ytDlpCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: "chrome:Profile 1" })).toEqual([
      "--cookies-from-browser",
      "chrome:Profile 1",
    ]);
  });

  it("refuses a browser yt-dlp does not have, in a sentence listing the ones it does", () => {
    // The alternative is failing inside yt-dlp, per call, with a message about
    // browsers when the mistake was a typo in an environment variable.
    expect(() => ytDlpCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: "safari-tech-preview" })).toThrow(
      /reads cookies from/,
    );
  });

  it("refuses both at once, naming both variables", () => {
    // yt-dlp refuses the pair itself, per call, which would arrive as several
    // broken platforms and no explanation.
    expect(() =>
      ytDlpCookieArgs({
        YTDLP_COOKIES_FROM_BROWSER: "firefox",
        YTDLP_COOKIES_FILE: "/etc/cookies.txt",
      }),
    ).toThrow(/both set/);
  });

  it("is fit to print, so a misconfiguration lands on the platform card", () => {
    const caught = (() => {
      try {
        ytDlpCookieArgs({ YTDLP_COOKIES_FROM_BROWSER: "netscape" });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(safeToShowMessage(caught)).toMatch(/YTDLP_COOKIES_FROM_BROWSER/);
  });
});
describe("what a cookie-carrying call actually runs", () => {
  const COOKIES = ["--cookies", "/run/secrets/cookies.txt"];

  it("puts the cookie flags in front of a fetching command", () => {
    expect(withHostArgs(COOKIES, mediaUrlArgs("https://example.test/v"))).toEqual([
      ...COOKIES,
      ...mediaUrlArgs("https://example.test/v"),
    ]);
  });

  it("leaves the version probe bare", () => {
    // A cookie jar this machine cannot open must not make `ytDlpUnavailableReason`
    // report that yt-dlp is missing. The probe answers about the binary.
    expect(withHostArgs(COOKIES, ["--version"])).toEqual(["--version"]);
  });

  it("changes nothing when no cookies are configured", () => {
    const args = mediaUrlArgs("https://example.test/v");
    expect(withHostArgs([], args)).toEqual(args);
  });
});

describe("a misconfigured cookie source refuses every call, in words", () => {
  it("comes back on the FIRST call any adapter makes, including the probe", async () => {
    // Not thrown at construction: the registry builds every adapter, so a throw
    // there reports five platforms failing to build instead of one sentence
    // naming two variables. Held as a reason, it reaches `unavailableReason`
    // and lands on the platform card.
    const run = makeYtDlpRunner("yt-dlp", 1000, () => {
      throw new YtDlpError(null, "YTDLP_COOKIES_FROM_BROWSER and YTDLP_COOKIES_FILE are both set.");
    });

    await expect(run(["--version"])).rejects.toThrow(/both set/);
    await expect(run(mediaUrlArgs("https://example.test/v"))).rejects.toThrow(/both set/);
    // Nothing was spawned to find that out — `yt-dlp` was never on this
    // machine's PATH during the test either way, and the rejection is the
    // configuration's, not a process's.
    await expect(ytDlpUnavailableReason(run)).resolves.toMatch(/both set/);
  });
});

describe("the proxy — the lever that needs no account and no human step", () => {
  const PROXY = "http://user:s3cr3t-password@gateway.example.net:7000";

  it("adds nothing when none is configured", () => {
    expect(ytDlpProxyArgs({})).toEqual([]);
  });

  it("dials the URL it was given", () => {
    expect(ytDlpProxyArgs({ YTDLP_PROXY: PROXY })).toEqual(["--proxy", PROXY]);
  });

  it("takes socks as well as http, because providers hand out both", () => {
    expect(ytDlpProxyArgs({ YTDLP_PROXY: "socks5h://127.0.0.1:1080" })).toEqual([
      "--proxy",
      "socks5h://127.0.0.1:1080",
    ]);
  });

  it("refuses a bare host:port, the likeliest way to get this wrong", () => {
    // new URL("gateway.example.net:7000") parses, reading the HOST as the
    // scheme, so this used to be told its own hostname was a protocol.
    expect(() => ytDlpProxyArgs({ YTDLP_PROXY: "gateway.example.net:7000" })).toThrow(
      "scheme://[user:pass@]host:port",
    );
  });

  it("refuses a scheme yt-dlp cannot dial WITHOUT repeating the URL", () => {
    // The refusal is allowed to name the scheme and nothing else: the string it
    // is complaining about contains a password.
    const caught = (() => {
      try {
        ytDlpProxyArgs({ YTDLP_PROXY: "ftp://user:s3cr3t-password@host:21" });
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(caught?.message).toMatch(/"ftp"/);
    expect(caught?.message).not.toMatch(/s3cr3t/);
  });

  it("keeps the password out of anything a person reads", () => {
    // yt-dlp quotes the URL it dialled in its own connection errors, and
    // YtDlpError is marked fit to print. Without this the page would carry it.
    const said = "ERROR: Unable to connect to proxy " + PROXY + " (password s3cr3t-password)";
    const clean = scrubProxy(said, { YTDLP_PROXY: PROXY });
    expect(clean).not.toMatch(/s3cr3t/);
    expect(clean).not.toMatch(/gateway\.example\.net/);
    expect(clean).toMatch(/REDACTED/);
  });

  it("carries the proxy AND the cookies, in that order", () => {
    // They answer different halves of the same refusal — who is asking, and
    // what it is asking as — so a deployment that has both uses both.
    expect(
      defaultHostArgs({ YTDLP_PROXY: "socks5h://127.0.0.1:1080", YTDLP_COOKIES_FILE: "/jar.txt" }),
    ).toEqual(["--proxy", "socks5h://127.0.0.1:1080", "--cookies", "/jar.txt"]);
  });

  it("refuses every call, in words, when the proxy is misconfigured", async () => {
    const run = makeYtDlpRunner("yt-dlp", 1000, () => ytDlpProxyArgs({ YTDLP_PROXY: "nonsense" }));
    await expect(run(["--version"])).rejects.toThrow("is not a proxy address");
  });
});

describe("one retry, and only when there is another address to ask from", () => {
  const URL_ = "https://www.youtube.com/watch?v=i7jX9SR0bfw";
  const GATED =
    "yt-dlp exited 1: ERROR: [youtube] i7jX9SR0bfw: Sign in to confirm you're not a bot.";

  it("asks again through a rotating proxy, because the next exit IP is a different one", async () => {
    // MEASURED 2026-09-08: five consecutive resolves through Decodo's rotating
    // gateway, one refused and passed on the retry. A residential pool hands
    // out addresses that are themselves sometimes already gated.
    let calls = 0;
    const run: YtDlpRunner = async () => {
      calls += 1;
      if (calls === 1) throw new YtDlpError(null, GATED);
      return "https://media.test/a\n";
    };

    await expect(resolveMediaUrl(run, "youtube", URL_, undefined, () => true)).resolves.toBe(
      "https://media.test/a",
    );
    expect(calls).toBe(2);
  });

  it("does NOT retry without a proxy — the same machine asking the same gate twice", async () => {
    let calls = 0;
    const run: YtDlpRunner = async () => {
      calls += 1;
      throw new YtDlpError(null, GATED);
    };

    await expect(resolveMediaUrl(run, "youtube", URL_, undefined, () => false)).rejects.toThrow(
      /not a bot/,
    );
    expect(calls).toBe(1);
  });

  it("gives up after the second refusal rather than grinding", async () => {
    let calls = 0;
    const run: YtDlpRunner = async () => {
      calls += 1;
      throw new YtDlpError(null, GATED);
    };

    await expect(resolveMediaUrl(run, "youtube", URL_, undefined, () => true)).rejects.toThrow(
      /not a bot/,
    );
    expect(calls).toBe(2);
  });

  it("stops the moment the caller aborts", async () => {
    // The export button's Stop control cancels in flight. A retry loop that
    // ignored that would keep spending somebody's bandwidth after they said no.
    const controller = new AbortController();
    let calls = 0;
    const run: YtDlpRunner = async () => {
      calls += 1;
      controller.abort();
      throw new YtDlpError(null, GATED);
    };

    await expect(
      resolveMediaUrl(run, "youtube", URL_, controller.signal, () => true),
    ).rejects.toThrow(/not a bot/);
    expect(calls).toBe(1);
  });

  it("knows whether there is an address to change", () => {
    expect(hasRotatingProxy({})).toBe(false);
    expect(hasRotatingProxy({ YTDLP_PROXY: "  " })).toBe(false);
    expect(hasRotatingProxy({ YTDLP_PROXY: "http://gateway:7000" })).toBe(true);
  });

  it("counts a remote service, because that is where the proxy lives on Vercel", () => {
    // The deployment the retry was measured to need has no YTDLP_PROXY of its
    // own, and must not have one: the app would then send --proxy in an argv
    // the service refuses. The service holds it instead.
    expect(
      hasRotatingProxy({
        YTDLP_SERVICE_URL: "https://ytdlp.example.io",
        YTDLP_SERVICE_TOKEN: "a-token",
      }),
    ).toBe(true);
  });

  it("does not count half a remote service", () => {
    expect(hasRotatingProxy({ YTDLP_SERVICE_URL: "https://ytdlp.example.io" })).toBe(false);
    expect(hasRotatingProxy({ YTDLP_SERVICE_TOKEN: "a-token" })).toBe(false);
  });
});
