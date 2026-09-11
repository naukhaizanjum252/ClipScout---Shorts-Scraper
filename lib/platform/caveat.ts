/**
 * A NUMBER ON THE SCREEN THAT IS NOT A MEASUREMENT, AND THE ONE WORD THAT SAYS WHY.
 *
 * WHY THIS IS ITS OWN MODULE. It began inside lib/platform/scrapecreators.ts,
 * beside the one vendor that needed it, which was right while the only reader
 * was the parser that wrote it. It stopped being right the moment the admin
 * console had to render the caveat: that console is a client component, and
 * reaching into a two-thousand-line vendor module — one that carries endpoint
 * tables, credit accounting and every error class for a paid API — to borrow a
 * four-line duck-typed getter drags all of it toward the browser bundle.
 *
 * THE ALTERNATIVE WAS WORSE. The obvious dodge is a second copy of the getter
 * in the view layer, duck-typed against the same property name. That is two
 * definitions of one contract sitting in two files that nobody edits on the
 * same day, which is how the property gets renamed in one place and silently
 * stops being read in the other. One definition, imported by both.
 *
 * NOTHING HERE KNOWS ABOUT ANY PLATFORM. No vendor, no endpoint, no note text —
 * those stay with the parser that writes them, because the standing rule in
 * ./types.ts is that per-platform facts live behind the per-platform seam. What
 * lives here is only the shape of "this figure is not what it looks like" and
 * the reader that asks.
 */
import type { ShortRecord } from "./types";

/** Which field a caveat is about. One value today; a union because a second is likely. */
export type CaveatedField = "view_count";

/**
 * WHY A CAVEAT NEEDS A BASIS, AND WHY THE TWO ARE OPPOSITES.
 *
 * There are now two reasons a number on this screen is not a measurement, and
 * they point in opposite directions:
 *
 *   "reported" — the SOURCE gave a figure and this tool refuses to compare it.
 *                Facebook. `view_count` is null, the vendor's number is parked
 *                in `reportedValue`, and the row cannot pass the threshold.
 *
 *   "derived"  — the source gave NOTHING and this tool computed a figure
 *                anyway. Instagram keyword search. `view_count` is populated,
 *                it IS compared against the threshold, and the row can pass,
 *                be kept, and be written to the database.
 *
 * One discriminant rather than two caveat types, because every reader of this
 * — the console cell, a future export, whatever comes next — has to branch on
 * exactly this question and nothing else. Without it a caller sees "there is a
 * caveat" and cannot tell whether the number beside it is untrusted-and-unused
 * or invented-and-load-bearing, which is the more dangerous of the two and the
 * one that must never render as a plain figure.
 */
export type CaveatBasis = "reported" | "derived";

/**
 * A number this tool refuses to present as a plain measurement.
 *
 * `reportedValue` is the vendor's figure UNMODIFIED, including null when the
 * vendor sent nothing — because "the vendor said 900" and "the vendor said
 * nothing" are different things to show a person, and collapsing them would
 * reintroduce exactly the zero-versus-unknown confusion this repo is built
 * around. On a "derived" caveat it is null by construction: the whole reason
 * to derive is that the source reported nothing.
 */
export interface MeasurementCaveat {
  readonly field: CaveatedField;
  readonly basis: CaveatBasis;
  /** What the source actually returned. Never used in a comparison. */
  readonly reportedValue: number | null;
  /** One sentence, written for a person, safe to print. */
  readonly note: string;
}

/**
 * A `ShortRecord` that is also carrying a health warning.
 *
 * Structurally a `ShortRecord`, so it flows through every seam unchanged and
 * needs no cooperation from run.ts, the store or the adapters. Only this file
 * writes the extra property; anything that wants it asks `measurementCaveat()`.
 */
export interface CaveatedShortRecord extends ShortRecord {
  readonly measurement_caveat: MeasurementCaveat;
}

/**
 * The caveat on a row, or null when there is none.
 *
 * A function rather than a field access so that a caller holding a plain
 * `ShortRecord` — which is what every seam in this repo declares — can ask
 * without a cast and without knowing this type exists.
 */
export function measurementCaveat(short: ShortRecord): MeasurementCaveat | null {
  const candidate = (short as Partial<CaveatedShortRecord>).measurement_caveat;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof candidate.note === "string" && candidate.note.trim() ? candidate : null;
}
