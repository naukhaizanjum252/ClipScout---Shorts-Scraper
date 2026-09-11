/**
 * Shapes the Library page and its action both need.
 *
 * NO `"use server"` DIRECTIVE HERE, DELIBERATELY — Next publishes every export
 * of a `"use server"` module as a callable endpoint, so the shared shapes live
 * in this plain module the way the topics and credentials pages do it.
 */
import type { ShortRecord } from "@/lib/platform/types";

/** A saved short, plus whether it has been marked used. */
export interface LibraryRow {
  readonly short: ShortRecord;
  readonly used: boolean;
  /**
   * Which filters could not be evaluated for this row, or null when it is a
   * fully measured short. Non-null means it came from the unverified table —
   * an Instagram keyword reel with no duration, say — and the Library marks it
   * so an estimate is never mistaken for a measured figure.
   */
  readonly unproven: readonly string[] | null;
}

/** Which rows the list is narrowed to. */
export type LibraryFilter = "all" | "unused" | "used";

/** What the page hands the client panel. */
export interface LibraryView {
  readonly rows: readonly LibraryRow[];
  /** Null when the whole table was read; a sentence when the read stopped short. */
  readonly truncation: string | null;
  /** Null when there is a database and it could be read; a sentence when not. */
  readonly unavailable: string | null;
}

/** What the mark-used action is asked for. Everything here is untrusted. */
export interface MarkUsedRequest {
  readonly platform: string;
  readonly platformVideoId: string;
  readonly used: boolean;
}

/** What the mark-used action answers with. */
export type MarkResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
