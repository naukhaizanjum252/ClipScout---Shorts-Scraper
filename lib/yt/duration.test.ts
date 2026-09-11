import { describe, expect, it } from "vitest";

import { DurationParseError, isShort, parseDurationSeconds } from "./duration";

describe("parseDurationSeconds", () => {
  it("parses the shapes YouTube actually returns", () => {
    expect(parseDurationSeconds("PT59S")).toBe(59);
    expect(parseDurationSeconds("PT1M")).toBe(60);
    expect(parseDurationSeconds("PT2M")).toBe(120);
    expect(parseDurationSeconds("PT1M2S")).toBe(62);
    expect(parseDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(parseDurationSeconds("P1DT2H")).toBe(93_600);
    expect(parseDurationSeconds("PT0S")).toBe(0);
  });

  it("parses P0D, which is what a live broadcast with no end returns", () => {
    expect(parseDurationSeconds("P0D")).toBe(0);
  });

  it("floors fractional seconds rather than carrying a float into an integer column", () => {
    expect(parseDurationSeconds("PT1.9S")).toBe(1);
  });

  it("refuses anything it does not fully understand instead of guessing", () => {
    for (const bad of ["", "P", "PT", "2 minutes", "PT1X", "1M30S", "PT1M2"]) {
      expect(() => parseDurationSeconds(bad)).toThrow(DurationParseError);
    }
  });

  it("refuses years and months, which have no fixed length", () => {
    expect(() => parseDurationSeconds("P1Y")).toThrow(DurationParseError);
    expect(() => parseDurationSeconds("P1M")).toThrow(DurationParseError);
  });
});

describe("isShort", () => {
  it("is inclusive of the ceiling — the client said 2 minutes MAX", () => {
    expect(isShort(120, 120)).toBe(true);
    expect(isShort(121, 120)).toBe(false);
    expect(isShort(1, 120)).toBe(true);
  });

  it("never calls a zero-length item a Short", () => {
    // P0D is a live stream. A 0-second row would sort to the top of anything
    // ordered by duration and read as the cheapest possible Short.
    expect(isShort(0, 120)).toBe(false);
  });

  it("moves with the ceiling, because the ceiling is config", () => {
    expect(isShort(150, 180)).toBe(true);
    expect(isShort(150, 120)).toBe(false);
  });
});
