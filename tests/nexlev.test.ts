import { describe, expect, it } from "vitest";

import { NexLevClient, NexLevError, parseSimilarChannels } from "@/lib/discovery/nexlev";

/**
 * THE NEXLEV HTTP SEAM, UNDER TEST — against the DOCUMENTED response shape
 * (`{ data: [ { about: { channelId, ... }, similarityScore } ] }`), never a
 * guessed one.
 */
describe("parseSimilarChannels", () => {
  it("keeps rows with a real channelId and score, strongest first, and drops the rest", () => {
    const rows = parseSimilarChannels({
      data: [
        { similarityScore: 62, about: { channelId: "UC_b", channelName: "B", subscriberCount: 10 } },
        { similarityScore: 88, about: { channelId: "UC_a", channelName: "A", subscriberCount: 20 } },
        { similarityScore: 50, about: { channelName: "no id" } }, // no channelId — dropped
        { about: { channelId: "UC_c" } }, // no score — dropped
        "not an object",
      ],
    });
    expect(rows.map((r) => r.channelId)).toEqual(["UC_a", "UC_b"]);
    expect(rows[0]).toMatchObject({ similarityScore: 88, channelName: "A", subscriberCount: 20 });
  });

  it("returns [] for a body without a data array", () => {
    expect(parseSimilarChannels({})).toEqual([]);
    expect(parseSimilarChannels(null)).toEqual([]);
  });
});

describe("NexLevClient.similarChannels", () => {
  it("POSTs to the documented endpoint with a bearer key and the documented body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ data: [{ similarityScore: 70, about: { channelId: "UC_a" } }] }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const client = new NexLevClient({ apiKey: "secret-key", fetchImpl });
    const rows = await client.similarChannels("UC_seed");

    expect(calls[0].url).toBe("https://prod.dashboard.nexlev.io/api/external/similar-channels/search");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      channelId: "UC_seed",
      channelType: "all",
      level: 1,
    });
    expect(rows.map((r) => r.channelId)).toEqual(["UC_a"]);
  });

  it("surfaces a 429 as a NexLevError carrying retryAfter", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ retryAfter: 30 }), { status: 429 })) as typeof globalThis.fetch;
    const client = new NexLevClient({ apiKey: "k".repeat(20), fetchImpl });

    await expect(client.similarChannels("UC_x")).rejects.toMatchObject({
      name: "NexLevError",
      retryAfterSeconds: 30,
    });
  });

  it("refuses to construct without a key", () => {
    expect(() => new NexLevClient({ apiKey: "  " })).toThrow(NexLevError);
  });
});
