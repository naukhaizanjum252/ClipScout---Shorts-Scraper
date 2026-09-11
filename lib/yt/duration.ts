/**
 * `contentDetails.duration` -> seconds.
 *
 * This is the ONLY filter that separates a Short from a video, because the API
 * has no `isShort` flag — Shorts are not a distinct resource type. Get this
 * wrong and the entire inventory is wrong, so it is parsed strictly and refuses
 * anything it does not fully understand rather than returning a plausible
 * number.
 *
 * YouTube returns ISO 8601 durations: `PT59S`, `PT1M2S`, `PT2M`, `P1DT2H3M4S`.
 * Live streams with no known end return `P0D`, which parses to 0 — the caller
 * must treat a live/upcoming item on its own terms rather than filing it as a
 * 0-second Short. `isShort()` below therefore refuses 0.
 */

const ISO8601 =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Thrown rather than guessing when a duration string is not understood. */
export class DurationParseError extends Error {
  constructor(readonly raw: string) {
    super(`Unparseable ISO 8601 duration: ${JSON.stringify(raw)}`);
    this.name = "DurationParseError";
  }
}

/**
 * Seconds in the duration, rounded down to a whole second.
 *
 * Years and months are refused, not approximated: they have no fixed length,
 * and no video has ever been one. Their presence means the string is not what
 * we think it is.
 */
export function parseDurationSeconds(raw: string): number {
  const m = ISO8601.exec(raw.trim());
  if (!m) throw new DurationParseError(raw);

  const [, years, months, weeks, days, hours, minutes, seconds] = m;

  // `P` alone, or `PT` alone, matches the regex but carries no information.
  if (!years && !months && !weeks && !days && !hours && !minutes && !seconds) {
    throw new DurationParseError(raw);
  }
  if (years || months) throw new DurationParseError(raw);

  const n = (v: string | undefined) => (v === undefined ? 0 : Number(v));

  return Math.floor(
    n(weeks) * 604800 + n(days) * 86400 + n(hours) * 3600 + n(minutes) * 60 + n(seconds),
  );
}

/**
 * Is this a Short, at the configured ceiling?
 *
 * Zero is NOT a Short. A live broadcast with no duration yet comes back as
 * `P0D`, and a 0-second row in the inventory is a live stream mis-filed as the
 * cheapest possible Short — exactly the sort of thing that makes a curated list
 * untrustworthy the first time somebody clicks a row.
 */
export function isShort(durationSeconds: number, maxSeconds: number): boolean {
  return durationSeconds > 0 && durationSeconds <= maxSeconds;
}
