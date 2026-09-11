/**
 * The remote runner, and the service's argv matcher.
 *
 * THE MATCHER TESTS ARE THE POINT OF THIS FILE. `services/ytdlp/server.mjs`
 * hands an argv array to `spawn`. If the wrong array can get through, that is a
 * remote code execution endpoint, and yt-dlp makes it literal: `--exec` runs a
 * shell command, `-o` writes a file, `--cookies` reads one. So the refusals
 * below are asserted individually and by name rather than as one "rejects bad
 * input" case, because each names a specific capability that must not be
 * reachable.
 */
import { describe, expect, it, vi } from "vitest";

import { planFor, scrubProxy, withHostArgs } from "../../services/ytdlp/server.mjs";
import { YtDlpError } from "./ytdlp";
import { makeRemoteYtDlpRunner, remoteYtDlpFromEnv } from "./ytdlp-remote";

const PLAYLIST = [
  "--flat-playlist",
  "-J",
  "--no-warnings",
  "--playlist-end",
  "50",
  "https://www.youtube.com/playlist?list=UUX6OQ3DkcsbYNE6H8uQQuVA",
];

const MEDIA = [
  "--no-warnings",
  "--no-playlist",
  "-f",
  "best[ext=mp4]/best",
  "--print",
  "urls",
  "https://www.youtube.com/shorts/5mU6SRS2Bxo",
];

describe("the service accepts exactly the three commands this app issues", () => {
  it("accepts a flat-playlist walk and returns a rebuilt argv", () => {
    const plan = planFor(PLAYLIST);
    // Rebuilt, not echoed: equal by value, but constructed from literals in the
    // service plus the two validated values.
    expect(plan).toEqual(PLAYLIST);
  });

  it("accepts the media-URL resolution", () => {
    expect(planFor(MEDIA)).toEqual(MEDIA);
  });

  it("accepts --version", () => {
    expect(planFor(["--version"])).toEqual(["--version"]);
  });

  it("accepts the TikTok profile form yt-dlp uses", () => {
    const argv = ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "12", "tiktokuser:mrbeast"];
    expect(planFor(argv)).toEqual(argv);
  });
});

describe("the service refuses everything else", () => {
  // Each of these is a capability, not a formatting quibble.
  const refusals: readonly (readonly [string, readonly unknown[]])[] = [
    ["--exec, which runs a shell command per download", [...PLAYLIST, "--exec", "curl evil.example"]],
    ["-o, which writes a file on the host", ["--no-warnings", "-o", "/tmp/x", "https://www.youtube.com/watch?v=a"]],
    ["--cookies, which reads the host's cookie jar", [...MEDIA, "--cookies", "/etc/cookies.txt"]],
    ["--load-info-json, which reads a local file", ["--load-info-json", "/etc/passwd"]],
    ["a bare shell command", ["sh", "-c", "id"]],
    ["an http (not https) target", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "http://www.youtube.com/x"]],
    ["a file:// target", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "file:///etc/passwd"]],
    ["the cloud metadata endpoint", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "https://169.254.169.254/latest/meta-data/"]],
    ["an arbitrary host", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "https://evil.example/x"]],
    ["a host that merely ends in youtube.com", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "https://evil-youtube.com/x"]],
    ["a subdomain-prefixed lookalike", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "https://youtube.com.evil.example/x"]],
    ["a different -f format string", ["--no-warnings", "--no-playlist", "-f", "bestvideo", "--print", "urls", "https://www.youtube.com/watch?v=a"]],
    ["--print with a different template", ["--no-warnings", "--no-playlist", "-f", "best[ext=mp4]/best", "--print", "filename", "https://www.youtube.com/watch?v=a"]],
    ["a non-numeric playlist-end", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "; id", "https://www.youtube.com/x"]],
    ["a zero playlist-end", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "0", "https://www.youtube.com/x"]],
    ["an empty argv", []],
    ["a non-array", ["not-an-array"] as unknown as readonly unknown[]],
    ["a tiktokuser handle with a slash", ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "5", "tiktokuser:a/../b"]],
  ];

  for (const [what, argv] of refusals) {
    it(`refuses ${what}`, () => {
      expect(planFor(argv)).toBeNull();
    });
  }

  it("refuses a non-string element even inside an otherwise valid shape", () => {
    expect(planFor(["--flat-playlist", "-J", "--no-warnings", "--playlist-end", 5, "https://www.youtube.com/x"])).toBeNull();
  });

  it("clamps an enormous playlist-end rather than passing it through", () => {
    // Accepted, but not as asked: a caller cannot turn one press into a
    // 100,000-entry walk of somebody else's bandwidth.
    const plan = planFor(["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "100000", "https://www.youtube.com/x"]);
    expect(plan).not.toBeNull();
    expect(Number(plan?.[4])).toBeLessThanOrEqual(200);
  });
});

describe("the remote runner behaves like the local one", () => {
  const options = { url: "https://ytdlp.example.com", token: "a-token-at-least-16-chars" };

  it("posts the argv and returns stdout verbatim", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ stdout: "2026.07.04\n" }), { status: 200 }),
    );
    const run = makeRemoteYtDlpRunner({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await run(["--version"])).toBe("2026.07.04\n");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ytdlp.example.com/run");
    expect(JSON.parse(init.body as string)).toEqual({ args: ["--version"] });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${options.token}`);
  });

  it("does not double the slash when the URL has a trailing one", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ stdout: "" }), { status: 200 }),
    );
    const run = makeRemoteYtDlpRunner({ ...options, url: "https://ytdlp.example.com/", fetchImpl: fetchImpl as unknown as typeof fetch });
    await run(["--version"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://ytdlp.example.com/run");
  });

  it("throws rather than returning empty when the service refuses", async () => {
    // THE RULE THE WHOLE ADAPTER LAYER RESTS ON. An adapter that cannot read
    // must throw; returning "" here would be parsed as an empty playlist and
    // reported to an operator as "this channel posted nothing".
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "yt-dlp exited 1", stderr: "Sign in to confirm you're not a bot" }), {
          status: 502,
        }),
    );
    const run = makeRemoteYtDlpRunner({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(run(["--version"])).rejects.toThrow(YtDlpError);
  });

  it("carries yt-dlp's own stderr into the error, because that is the actionable part", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "yt-dlp exited 1", stderr: "Sign in to confirm you're not a bot" }), {
          status: 502,
        }),
    );
    const run = makeRemoteYtDlpRunner({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });

    // The single most likely production failure for a datacentre-hosted runner,
    // and indistinguishable from "no new posts" unless the line survives.
    await expect(run(["--version"])).rejects.toThrow(/not a bot/);
  });

  it("names the service when it cannot be reached at all", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const run = makeRemoteYtDlpRunner({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(run(["--version"])).rejects.toThrow(/could not be reached/);
  });

  it("rejects a 200 whose body has no stdout, rather than returning undefined", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const run = makeRemoteYtDlpRunner({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(run(["--version"])).rejects.toThrow(/no stdout/);
  });
});

/**
 * `NodeJS.ProcessEnv` requires NODE_ENV, and these cases are about the two
 * YTDLP_ variables only. Casting at one named helper keeps that cast out of
 * five assertions.
 */
const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("configuration is both-or-neither", () => {
  it("is null when neither is set, meaning spawn locally", () => {
    expect(remoteYtDlpFromEnv(env({}))).toBeNull();
  });

  it("is null with a URL but no token", () => {
    // Would otherwise post unauthenticated and fail 401 on every platform,
    // reporting a wrong reason for an empty list.
    expect(remoteYtDlpFromEnv(env({ YTDLP_SERVICE_URL: "https://ytdlp.example.com" }))).toBeNull();
  });

  it("is null with a token but no URL", () => {
    expect(remoteYtDlpFromEnv(env({ YTDLP_SERVICE_TOKEN: "a-token-at-least-16-chars" }))).toBeNull();
  });

  it("is null when either is only whitespace", () => {
    expect(remoteYtDlpFromEnv(env({ YTDLP_SERVICE_URL: "  ", YTDLP_SERVICE_TOKEN: "a-token-at-least-16-chars" }))).toBeNull();
  });

  it("reads both when both are set", () => {
    expect(
      remoteYtDlpFromEnv(env({ YTDLP_SERVICE_URL: "https://ytdlp.example.com", YTDLP_SERVICE_TOKEN: "a-token-at-least-16-chars" })),
    ).toEqual({ url: "https://ytdlp.example.com", token: "a-token-at-least-16-chars" });
  });
});
describe("the host's cookie jar, which the caller still cannot name", () => {
  it("adds nothing when the service has no cookie file configured", () => {
    expect(withHostArgs(planFor(MEDIA), { cookiesFile: null })).toEqual(MEDIA);
  });

  it("prepends the SERVICE's path to a fetching command", () => {
    // The path comes from the container's environment. It is applied AFTER
    // `planFor` has rebuilt the argv out of literals, so the command yt-dlp
    // runs is still one this file constructed.
    expect(withHostArgs(planFor(MEDIA), { cookiesFile: "/run/secrets/cookies.txt" })).toEqual([
      "--cookies",
      "/run/secrets/cookies.txt",
      ...MEDIA,
    ]);
  });

  it("adds it to a listing walk too, which is the call that blocks first", () => {
    expect(withHostArgs(planFor(PLAYLIST), { cookiesFile: "/run/secrets/cookies.txt" })).toEqual([
      "--cookies",
      "/run/secrets/cookies.txt",
      ...PLAYLIST,
    ]);
  });

  it("leaves --version bare, so the 'is yt-dlp here' probe cannot fail on a cookie file", () => {
    expect(withHostArgs(planFor(["--version"]), { cookiesFile: "/run/secrets/cookies.txt" })).toEqual(["--version"]);
  });

  it("does not resurrect a refused argv", () => {
    // `planFor` returning null is a refusal, and nothing downstream may turn a
    // refusal into a command.
    expect(withHostArgs(planFor([...MEDIA, "--exec", "id"]), { cookiesFile: "/run/secrets/cookies.txt" })).toBeNull();
  });

  it("still refuses --cookies when it comes from the CALLER", () => {
    // Belt and braces with the refusal table above, stated once more here
    // because this is the file that now also ADDS the flag: the two must not
    // be confused. The service names the path; the network never does.
    expect(planFor([...MEDIA, "--cookies", "/etc/shadow"])).toBeNull();
    expect(planFor(["--cookies", "/etc/shadow", ...MEDIA])).toBeNull();
  });
});

describe("the service's own proxy, which the caller also cannot name", () => {
  const PROXY = "http://user:s3cr3t-password@gateway.example.net:7000";

  it("dials through the proxy the CONTAINER was given", () => {
    expect(withHostArgs(planFor(MEDIA), { cookiesFile: null, proxy: PROXY })).toEqual([
      "--proxy",
      PROXY,
      ...MEDIA,
    ]);
  });

  it("carries both when the host has both", () => {
    expect(withHostArgs(planFor(MEDIA), { cookiesFile: "/jar.txt", proxy: PROXY })).toEqual([
      "--proxy",
      PROXY,
      "--cookies",
      "/jar.txt",
      ...MEDIA,
    ]);
  });

  it("leaves --version alone, so a dead proxy cannot read as a missing yt-dlp", () => {
    expect(withHostArgs(planFor(["--version"]), { proxy: PROXY })).toEqual(["--version"]);
  });

  it("still refuses --proxy from the network", () => {
    // Same rule as --cookies: the host names it, the token holder never does.
    expect(planFor([...MEDIA, "--proxy", "http://evil.example"])).toBeNull();
  });

  it("scrubs the proxy out of an error body before it leaves the service", () => {
    const said = "yt-dlp exited 1: unable to connect to proxy " + PROXY;
    const clean = scrubProxy(said, PROXY);
    expect(clean).not.toMatch(/s3cr3t/);
    expect(clean).toMatch(/REDACTED/);
  });
});
