import { describe, expect, it } from "vitest";

import {
  ChannelRefParseError,
  channelIdFromUploadsPlaylist,
  isChannelId,
  parseChannelRef,
  uploadsPlaylistId,
} from "./channel-ref";

/**
 * Real-shaped channel ids. Five is what the plan's acceptance asks for; these
 * are seven, and they are the shapes that actually occur — including ids that
 * contain `-` and `_`, which are the characters a lazier regex gets wrong.
 *
 * One of them (`UCX6OQ3DkcsbYNE6H8uQQuVA`) is the channel the recorded fixture
 * in lib/source/fixtures/ was pulled from, so the derivation asserted here is
 * the same one that produced a real 137-video listing.
 */
const REAL_SHAPED_IDS = [
  "UCX6OQ3DkcsbYNE6H8uQQuVA",
  "UCBR8-60-B28hp2BmDPdntcQ",
  "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  "UCuAXFkgsw1L7xaCfnd5JJOw",
  "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
  "UCq-Fj5jknLsUf-MWSy4_brA",
  "UCEgdi0XIXXZ-qJOFPf4JSKw",
] as const;

describe("uploadsPlaylistId", () => {
  it("swaps the UC prefix for UU and changes nothing else", () => {
    for (const id of REAL_SHAPED_IDS) {
      const playlist = uploadsPlaylistId(id);
      expect(playlist).toBe(`UU${id.slice(2)}`);
      expect(playlist).toHaveLength(id.length);
      expect(playlist.slice(2)).toBe(id.slice(2));
    }
  });

  it("round-trips back to the channel id", () => {
    for (const id of REAL_SHAPED_IDS) {
      expect(channelIdFromUploadsPlaylist(uploadsPlaylistId(id))).toBe(id);
    }
  });

  it("refuses anything that is not a channel id, rather than producing a playlist that 404s later", () => {
    for (const bad of ["", "UU_x5XG1OV2P6uZZ5FSM9Ttw", "UCtooshort", "@handle", "UCX6OQ3DkcsbYNE6H8uQQuV!"]) {
      expect(() => uploadsPlaylistId(bad)).toThrow(ChannelRefParseError);
    }
  });
});

describe("isChannelId", () => {
  it("accepts every real-shaped id and rejects near-misses", () => {
    for (const id of REAL_SHAPED_IDS) expect(isChannelId(id)).toBe(true);
    expect(isChannelId("UCX6OQ3DkcsbYNE6H8uQQuVAA")).toBe(false); // one too long
    expect(isChannelId("ucX6OQ3DkcsbYNE6H8uQQuVA")).toBe(false); // lowercase prefix
  });
});

describe("parseChannelRef", () => {
  it("reads an id out of every URL shape the team actually pastes", () => {
    const id = "UCX6OQ3DkcsbYNE6H8uQQuVA";
    for (const input of [
      id,
      `https://www.youtube.com/channel/${id}`,
      `https://youtube.com/channel/${id}?si=abc`,
      `youtube.com/channel/${id}`,
      `https://m.youtube.com/channel/${id}/shorts`,
    ]) {
      expect(parseChannelRef(input)).toEqual({ kind: "id", channelId: id });
    }
  });

  it("reads a handle out of links, @forms and bare words", () => {
    for (const input of [
      "@MrBeast",
      "MrBeast",
      "https://www.youtube.com/@MrBeast",
      "https://www.youtube.com/@MrBeast/shorts",
      "www.youtube.com/@MrBeast",
    ]) {
      expect(parseChannelRef(input)).toEqual({ kind: "handle", handle: "MrBeast" });
    }
  });

  it("keeps the legacy /user/ form separate from a handle, because they resolve differently", () => {
    expect(parseChannelRef("https://www.youtube.com/user/SomeOldName")).toEqual({
      kind: "username",
      username: "SomeOldName",
    });
  });

  it("refuses /c/ rather than silently burning one of the day's 100 search calls", () => {
    expect(() => parseChannelRef("https://www.youtube.com/c/SomeName")).toThrow(/cannot be resolved/);
  });

  it("refuses non-YouTube URLs and empty input", () => {
    expect(() => parseChannelRef("https://vimeo.com/@someone")).toThrow(ChannelRefParseError);
    expect(() => parseChannelRef("   ")).toThrow(ChannelRefParseError);
  });

  it("refuses a /channel/ URL carrying something that is not a channel id", () => {
    expect(() => parseChannelRef("https://www.youtube.com/channel/not-an-id")).toThrow(/not a valid channel id/);
  });
});
