/**
 * "GET LATEST SHORTS." The one action, and the report it owes a person.
 *
 * Erik, 2026-09-02: *"I want to get 'get latest shorts' you scrape ALL
 * platforms, come back with shorts over 500k views categorized by platform, AXE
 * the rest."* This file is that sentence. It runs every adapter it was given,
 * applies the view threshold and the length window — the Shorts ceiling, plus
 * whatever floor the caller asked for, which is usually none — dedupes on
 * (platform, platform_video_id), persists, and returns one list grouped by
 * platform with the highest views first.
 *
 * THE HONESTY RULE, WHICH IS MOST OF WHY THIS FILE IS LONGER THAN THE LOOP
 *
 * A platform that COULD NOT BE READ and a platform that HAD NOTHING over the
 * threshold must never look the same. As of 2026-09-04 three of the five have
 * no way to enumerate a timeline without a paid key — yt-dlp calls
 * `instagram:user` CURRENTLY BROKEN, and there is no profile enumerator for
 * Facebook or X — so "we could not read this platform" is not an edge case
 * here, it is the normal state of the majority of them. If those came back as
 * empty lists, the tool would be quietly reporting that Instagram has no viral
 * content.
 *
 * So a platform gets one of FIVE outcomes and they are different values, not
 * different row counts:
 *
 *   ok            it ran, to the end of what it was asked for. `kept` may be 0,
 *                 and 0 means zero shorts cleared the threshold, which is a
 *                 real answer about that platform.
 *   partial       IT RAN AND STOPPED SHORT. A spend cap or a rate limit ended
 *                 the read before the adapter had seen everything it was asked
 *                 for. The rows are real; the ABSENCE of a row is not evidence.
 *   unavailable   `unavailableReason()` returned a sentence. Print the sentence.
 *   failed        it threw. Print the error.
 *   no-adapter    nothing was configured to read this platform at all.
 *
 * `partial` was added on 2026-09-04, when X became a platform this tool pays
 * per resource to read. X's own pricing is per Post returned, so a run has to
 * be allowed to stop when a budget or a 429 says stop — and a list that hid
 * that would have LookUp Media believe they had seen everything over 500,000
 * views when they had seen the first page of it. It is a separate STATUS rather
 * than a flag on `ok` for the same reason the other four are separate: a status
 * a caller can forget to check is a status the screen will render as success.
 *
 * `no-adapter` exists because a caller that passes two adapters would otherwise
 * produce a report with three platforms simply missing, and a missing platform
 * is the most invisible failure of the lot — nobody scrolls looking for a
 * heading that is not there. Every one of the five appears in every report.
 *
 * PARTIAL SUCCESS ACROSS PLATFORMS IS ALSO THE NORMAL CASE. One adapter
 * throwing must not lose the others' results, so each is run inside its own
 * catch and the report says exactly which part was which.
 *
 * ROWS THAT COULD NOT BE JUDGED — THE OTHER THING 2026-09-04 CHANGED
 *
 * Until now every row this file kept had been measured against both filters.
 * Two official APIs broke that:
 *
 *   - X documents `media.public_metrics.view_count` as publicly readable, and
 *     NOBODY HAS CONFIRMED it is populated for arbitrary third-party posts. A
 *     null there is "X did not say", not "nobody watched it".
 *   - Instagram's Graph API HAS NO DURATION FIELD ON MEDIA AT ALL. Not a null
 *     one — none. The 120-second ceiling cannot be evaluated from official
 *     Instagram data, and that is a hole in the product, not in this code.
 *
 * A row like that has failed nothing. It has also not passed. Dropping it
 * silently would report Instagram as empty; keeping it in `shorts` would put a
 * row nobody measured into the one list this product exists to produce, where
 * it would sit indistinguishable from a row that really did clear 500,000.
 *
 * So there is a third destination. `report.shorts` still means EVERY FILTER WAS
 * CHECKED AND EVERY FILTER PASSED — its meaning has not moved, and it is still
 * the only thing persisted. `report.unverified` holds the rows that failed no
 * filter they could be judged against and could not be judged against at least
 * one, each carrying WHICH filter went unproven. The drop tally counts them
 * exactly as before, so the arithmetic below is unchanged.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It never resolves a download URL and never stores one. `downloadUrl` is on
 * the adapter and is called at the moment a person wants the file, because a
 * direct media URL is signed and expires in minutes to hours — stored, it is a
 * dead link that looks alive. It also does not search, curate, approve or
 * unlist: the channel review queue that used to be this repo is deleted.
 */
import type { LatestShortsQuery, PlatformAdapter } from "../platform/adapter";
import { measurementCaveat } from "../platform/caveat";
import { PLATFORMS, platformLabel, type Platform, type ShortRecord } from "../platform/types";
import { asTopical, noTopicalReaderReason } from "../platform/topical";
import { cleanTerms, type Topic, type TopicRef } from "./topics";
import { shortKey, type ShortsStore } from "./store";

/** Thrown for a run that was configured wrong, before anything is read. */
export class LatestShortsRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatestShortsRunError";
  }
}

// ---------------------------------------------------------------------------
// Stopping short, and what it costs
// ---------------------------------------------------------------------------

/**
 * Why a read ended before it had seen what it was asked for.
 *
 * TWO CAUSES AND NO MORE, because these are the two an adapter can actually
 * distinguish. A spend cap is OURS — an operator's ceiling, hit deliberately,
 * and the run is behaving correctly. A rate limit is THEIRS — a 429, hit
 * involuntarily, and the same query later would go further. An operator does
 * different things about them: raise a budget, or wait. A single "truncated"
 * flag would make them choose blind.
 *
 * `message` is the adapter's own sentence and is rendered as written, exactly
 * like `unavailableReason()`. It is NOT an exception message: an exception
 * from a metered API routinely quotes the URL it was called with, key and all,
 * and nothing that has been anywhere near a thrown message may go on a page
 * around forty people screenshot. An adapter composes this string knowing it
 * will be read by a person.
 */
export interface Truncation {
  readonly cause: "spend-cap" | "rate-limit";
  /** One sentence, fit to print, composed by the adapter. Never an exception's text. */
  readonly message: string;
}

/**
 * Money, as an integer count of MILLIONTHS OF A US DOLLAR.
 *
 * Integers, because these are summed. X charges $0.005 per Post read — half a
 * cent — so cents cannot hold one unit and floating-point dollars accumulate
 * error across a few thousand rows in exactly the digit an operator would
 * notice. A micro-dollar holds every price anybody has quoted us with four
 * digits to spare, and addition of integers is exact.
 *
 * This file NEVER computes a price. It carries the number the adapter reports
 * and sums the ones that are reported. A price is a business fact about
 * somebody else's product; a module that multiplied a row count by a rate it
 * had memorised would be inventing an invoice.
 */
export type UsdMicros = number;

/** What one adapter says a run WILL cost, asked before the run is made. */
export interface SpendForecast {
  /** Null when the adapter cannot price this run in advance. `note` then says why. */
  readonly usdMicros: UsdMicros | null;
  /** How the figure was arrived at, or why there is not one. The adapter's own words. */
  readonly note: string;
}

/** What one adapter says a run DID cost, asked after it ran. */
export interface SpendActual {
  readonly usdMicros: UsdMicros;
  /** What was billed and at what rate, in the adapter's own words. */
  readonly note: string;
}

/**
 * What the `latestShorts()` call that just returned actually did.
 *
 * Both halves are nullable and they are independent. A run can stop early
 * without costing anything (a rate limit on a free source) and can cost money
 * without stopping early (the ordinary case).
 */
export interface RunAccount {
  readonly spend: SpendActual | null;
  readonly truncation: Truncation | null;
}

/**
 * THE OPTIONAL HALF OF THE ADAPTER SEAM, AND WHY IT IS OPTIONAL.
 *
 * `PlatformAdapter` (lib/platform/adapter.ts) has four methods and the comment
 * on it says, in as many words, "four methods, no more". That rule is right:
 * every method added there is a method five adapters have to implement, four of
 * which have nothing to say. Four of the five platforms here cost no money and
 * have no budget to run out of, and making them all carry an accounting method
 * would be four empty implementations kept in step forever.
 *
 * So metering is a CAPABILITY an adapter may have, and an adapter that does not
 * have it is reported as UNMETERED rather than as free. THAT DISTINCTION IS THE
 * POINT: "this adapter does not report a price" and "this adapter costs
 * nothing" are different claims, and only one of them is ours to make.
 *
 * ---------------------------------------------------------------------------
 * SCAR, 2026-09-04. THE CAPABILITY USED TO BE DETECTED BY DUCK TYPING AND THAT
 * IS THE BUG THIS BLOCK EXISTS TO CLOSE.
 * ---------------------------------------------------------------------------
 *
 * WHAT WAS WRONG. `asAccounting()` was `typeof candidate.accountForLastRun ===
 * "function"`, and nothing anywhere implemented that method. A review found
 * `accountForLastRun` and `forecastSpend` appearing in exactly two files — this
 * one and its own test — with no adapter on the other side of the seam.
 *
 * WHAT IT WOULD HAVE DONE. `report.spend` was structurally always empty, so the
 * screen's "Spent" figure was structurally always an em dash, on the one
 * platform in this product that bills real money per row it returns. A run
 * costing several dollars and a run costing nothing rendered identically, and
 * every test stayed green, because "the adapter has no such method" and "the
 * adapter reported no spend" were the same value: null.
 *
 * WHAT STOPS IT NOW. Two things, and they are different failures:
 *
 *   1. THE BRAND. A metering adapter must carry `[METERS_ITS_OWN_SPEND]: true`.
 *      A symbol property cannot be produced by accident and cannot be produced
 *      by a method that merely shares a name, so the capability is DECLARED
 *      rather than guessed at. It is `Symbol.for`, not `Symbol()`, because this
 *      module is loaded twice in a Next build — once for the server and once
 *      for the client bundle — and two private symbols would not compare equal.
 *
 *   2. THE DISAGREEMENT IS LOUD. An adapter carrying the methods without the
 *      brand, or the brand without any of the methods, throws
 *      `SpendContractError` before a single platform is read. Half a money
 *      contract is a bug, and the whole failure above was a bug that produced
 *      no value distinguishable from a free run. It now produces an exception
 *      naming the adapter's platform.
 *
 * The compiler holds the rest: `AccountingAdapter` requires the brand AND the
 * method, so `implements AccountingAdapter` cannot compile with one of them
 * missing. What the compiler cannot do is force an adapter to opt in, which is
 * what the runtime check above is for.
 */
export const METERS_ITS_OWN_SPEND: unique symbol = Symbol.for("shorts-scraper.meters-its-own-spend");

/**
 * A thing that reports what it charged. Not necessarily an adapter.
 *
 * Split out from `AccountingAdapter` because the object that KNOWS what a run
 * cost is often not the object that read the platform — for X it is the HTTP
 * client, which counts billable resources as they come back and is handed to
 * the adapter. Keeping the money half nameable on its own lets that client
 * implement the contract in the file that owns the price table, instead of the
 * price table being re-derived somewhere it can drift.
 */
export interface SpendAccountant {
  readonly [METERS_ITS_OWN_SPEND]: true;
  /**
   * What the last `latestShorts()` call cost and whether it finished.
   *
   * Called ONCE, immediately after `latestShorts()` returns. Null means the
   * adapter has nothing to report about that call — which is not "it was free".
   */
  accountForLastRun(): RunAccount | null;
}

export interface AccountingAdapter extends PlatformAdapter, SpendAccountant {}

/** An adapter that can price a run BEFORE it is made. See `AccountingAdapter`. */
export interface ForecastingAdapter extends PlatformAdapter {
  readonly [METERS_ITS_OWN_SPEND]: true;
  /**
   * What this query would cost. Must not itself perform the expensive read.
   *
   * For X this is `/2/tweets/counts/recent`, which reports how many posts match
   * a query without returning them — the cheap way to find out what the
   * expensive way would cost.
   */
  forecastSpend(query: LatestShortsQuery): Promise<SpendForecast>;
}

/**
 * An adapter whose money contract is half-built.
 *
 * Its own type, and thrown rather than logged, because the alternative is the
 * failure in the scar above: a money contract that is not held reports zero,
 * and zero is a number an operator believes.
 */
export class SpendContractError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "SpendContractError";
  }
}

/** What one adapter declared about money, after the declaration was checked. */
export interface SpendCapabilities {
  /** True when the adapter carries the brand at all. */
  readonly declared: boolean;
  readonly accounting: AccountingAdapter | null;
  readonly forecasting: ForecastingAdapter | null;
}

/**
 * What this adapter says about money, and a throw when it says two things.
 *
 * Called once per adapter BEFORE anything is read, so a half-built contract
 * stops a run rather than silently costing one.
 */
export function spendCapabilities(adapter: PlatformAdapter): SpendCapabilities {
  const candidate = adapter as Partial<AccountingAdapter & ForecastingAdapter>;
  const declared = candidate[METERS_ITS_OWN_SPEND] === true;
  const accounts = typeof candidate.accountForLastRun === "function";
  const forecasts = typeof candidate.forecastSpend === "function";

  if (!declared && (accounts || forecasts)) {
    throw new SpendContractError(
      adapter.platform,
      `The adapter for ${platformLabel(adapter.platform)} has ` +
        `${accounts && forecasts ? "accountForLastRun() and forecastSpend()" : accounts ? "an accountForLastRun() method" : "a forecastSpend() method"}` +
        " but does not declare METERS_ITS_OWN_SPEND, so this run would have ignored it and " +
        "reported the platform as having quoted no price. That is exactly how a metered " +
        "platform came to report nothing at all. Add the brand, or remove the method.",
    );
  }
  if (declared && !accounts && !forecasts) {
    throw new SpendContractError(
      adapter.platform,
      `The adapter for ${platformLabel(adapter.platform)} declares METERS_ITS_OWN_SPEND and ` +
        "implements neither accountForLastRun() nor forecastSpend(), so it has claimed to " +
        "report money and reports none. An adapter that cannot say what it charged must not " +
        "say that it can.",
    );
  }

  return {
    declared,
    accounting: declared && accounts ? (adapter as AccountingAdapter) : null,
    forecasting: declared && forecasts ? (adapter as ForecastingAdapter) : null,
  };
}

/** The adapter as an `AccountingAdapter`, or null when it does not meter itself. */
export function asAccounting(adapter: PlatformAdapter): AccountingAdapter | null {
  return spendCapabilities(adapter).accounting;
}

/** The adapter as a `ForecastingAdapter`, or null when it cannot price a run. */
export function asForecasting(adapter: PlatformAdapter): ForecastingAdapter | null {
  return spendCapabilities(adapter).forecasting;
}

// ---------------------------------------------------------------------------
// Errors an adapter says are fit to print
// ---------------------------------------------------------------------------

/**
 * THE MARK THAT SAYS "THIS EXCEPTION WAS WRITTEN FOR A PERSON TO READ".
 *
 * The standing rule on /admin/shorts is that a thrown message never reaches the
 * page: these adapters call metered APIs, an exception from one routinely
 * quotes the URL it was called with, and this page is open on around forty
 * screens at LookUp Media. That rule is right and it is not moving.
 *
 * IT IS ALSO WRONG FOR THE ONE RESULT THIS BUILD EXISTS TO OBTAIN. X's leg
 * rests on a field nobody has confirmed is populated, and the errors that
 * report what the first real run discovered — "X returned 40 video posts and
 * not one carried a view count" — are composed, deliberately, as sentences for
 * an operator. Sending those to a log file means the answer to the question the
 * client is paying to settle arrives only if somebody thinks to grep for it.
 *
 * So an error may DECLARE ITSELF fit to print, and only the file that composed
 * the message may declare it. The mark is a symbol for the same reason the
 * metering brand is: it cannot be produced by accident, and it cannot be
 * produced by an upstream library's error object that happens to have a
 * `safe` field. Everything unmarked goes to the log exactly as before — the
 * default did not move, and an error that says nothing about itself is still
 * treated as hostile.
 */
export const SAFE_TO_SHOW: unique symbol = Symbol.for("shorts-scraper.safe-to-show");

/**
 * Brand an error class as fit to print. Called by the module that DEFINES it.
 *
 * On the prototype rather than on each instance, so subclasses inherit it and
 * so a `throw` site cannot forget. It is non-enumerable, so a marked error still
 * serialises and compares like any other error.
 */
export function markSafeToShow<T extends { prototype: object }>(errorClass: T): T {
  Object.defineProperty(errorClass.prototype, SAFE_TO_SHOW, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return errorClass;
}

/**
 * The message of an error that says it is fit to print, or null.
 *
 * Null for everything else — including a marked error with an empty message,
 * because a blank sentence on the page is worse than the honest "look in the
 * log" it would replace.
 */
export function safeToShowMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if ((error as unknown as Record<symbol, unknown>)[SAFE_TO_SHOW] !== true) return null;
  const message = error.message.trim();
  return message === "" ? null : message;
}

/** What one platform actually cost in one run. Present only for platforms that meter. */
export interface PlatformSpend extends SpendActual {
  readonly platform: Platform;
}

// ---------------------------------------------------------------------------
// Rows that were dropped, and rows that could not be judged
// ---------------------------------------------------------------------------

/**
 * Why a row an adapter returned was not kept.
 *
 * ONE REASON PER ROW, the first that applies, in the order the fields are
 * declared below. That makes the numbers add up — `returned` equals `kept` plus
 * `duplicates` plus every field of this breakdown — which is the property worth
 * having, because a report whose parts do not sum to its total is a report
 * nobody can use to work out where the shorts went. run.test.ts asserts the sum.
 *
 * SCAR, 2026-09-04. The order used to put the two "the source did not say"
 * reasons FIRST, so a row with no duration and eleven views was filed under
 * `unknownDuration`. That was wrong once `unverified` existed: it made a row
 * that genuinely missed the threshold by half a million views look like a row
 * nobody could measure, and rows nobody could measure are now shown on the
 * page. The evaluable failures are therefore checked first, and a row only
 * reaches an "unknown" bucket once it has passed every filter that COULD be
 * applied to it. The declaration order below is the evaluation order; keep them
 * together.
 */
export interface DroppedBreakdown {
  /**
   * The adapter returned a row labelled with a platform it does not read.
   *
   * Dropped rather than re-labelled and rather than trusted. A mislabelled row
   * looks exactly like a real one and is only ever caught by somebody noticing
   * a TikTok filed under YouTube — see the refusal to guess in
   * `parsePlatform` (lib/platform/types.ts), which this enforces at the other
   * end of the same seam.
   */
  readonly wrongPlatform: number;
  /** Longer than the Shorts ceiling. A real answer: it is not a Short. */
  readonly tooLong: number;
  /**
   * Shorter than the length the operator asked for. Zero unless they asked.
   *
   * THE ONE DROP REASON THAT IS NOBODY'S FAULT AND NOTHING'S FAILURE. `tooLong`
   * says a video is not a Short; this says a Short is not what somebody wanted
   * to watch today. It is counted separately for exactly that reason — folding
   * a length preference into "longer than the Shorts ceiling" would tell an
   * operator that the platform returned videos that are not Shorts when what
   * happened is that they typed a floor.
   */
  readonly tooShort: number;
  /** Under the threshold. The ordinary reason, and the point of the threshold. */
  readonly belowThreshold: number;
  /**
   * `duration_seconds` was null, and nothing else had ruled the row out.
   *
   * Duration is the only thing that defines a Short, so a source that did not
   * say has not told us this is one. On yt-dlp sources it is usually a live or
   * upcoming broadcast. On Instagram's official API it is EVERY ROW, because
   * that API has no duration field — which is why these rows are now surfaced
   * as `unverified` rather than vanishing.
   */
  readonly unknownDuration: number;
  /**
   * `view_count` was null, and nothing else had ruled the row out.
   *
   * Null is not zero and it is not "probably fine". An unknown view count has
   * not been shown to clear 500,000, so it does not clear it and the row is not
   * in `shorts`. A large count here means a source has stopped reporting view
   * counts — a bug to chase, not a quiet day on that platform. On X it is the
   * open question the whole leg rests on.
   */
  readonly unknownViews: number;
}

/**
 * A counting copy of `DroppedBreakdown`.
 *
 * The published type is readonly so a report cannot be edited after the fact;
 * the tally has to be writable while it is being built. Mapped rather than
 * re-listed, so a new drop reason cannot be added to one and forgotten in the
 * other.
 */
type DropTally = { -readonly [K in keyof DroppedBreakdown]: number };

/** Every field of `DroppedBreakdown`, at zero. */
function noDrops(): DropTally {
  return {
    wrongPlatform: 0,
    tooLong: 0,
    tooShort: 0,
    belowThreshold: 0,
    unknownDuration: 0,
    unknownViews: 0,
  };
}

/** Total rows accounted for by a breakdown. Used by the report and by tests. */
export function totalDropped(dropped: DroppedBreakdown): number {
  return (
    dropped.wrongPlatform +
    dropped.tooLong +
    dropped.tooShort +
    dropped.belowThreshold +
    dropped.unknownDuration +
    dropped.unknownViews
  );
}

/** Which of the two filters a source left unmeasurable. */
export type UnprovenFilter = "views" | "duration";

/**
 * A row that failed nothing and passed less than everything.
 *
 * It is NOT in `report.shorts` and it is NOT persisted, because `shorts` means
 * "measured against both filters and over the bar" and that promise is the
 * product. It is in the report because the alternative — silence — reports
 * Instagram as empty when the truth is that Instagram's official API does not
 * publish a duration for anybody.
 *
 * `unproven` is never empty. A row with nothing unproven is a kept row.
 */
export interface UnverifiedShort {
  readonly short: ShortRecord;
  /** Which filters could not be evaluated for this row. Never empty. */
  readonly unproven: readonly UnprovenFilter[];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * What happened to one platform in one run.
 *
 * A discriminated union rather than a status string beside optional fields, so
 * a caller that renders `outcome.reason` has been forced by the compiler to
 * check which kind of outcome it is holding. The UI's job is to make these six
 * look different; the type is what stops it accidentally making them look the
 * same.
 *
 * `ok` and `partial` are spelled out in full rather than sharing a base through
 * an intersection. `Extract<PlatformOutcome, { status: "ok" }>` is the type
 * three call sites narrow with and fixtures build with `Partial<>`, and an
 * intersection makes both of those harder to read than the eight lines it
 * saves. `RanOutcome` below is the alias for "either of the two that ran".
 */
/**
 * WHICH SUBJECTS A PLATFORM WAS ACTUALLY SEARCHED FOR, and which it refused.
 *
 * Present on the two outcomes that read the platform, and only when the run was
 * given topics at all. It exists because "YouTube: 4 kept" answers a different
 * question depending on whether four topics were searched or twenty-nine were
 * refused and one worked — and the refusals are per topic, not per platform, so
 * a single `reason` string on the outcome could not carry them.
 *
 * A PLATFORM THAT REFUSED EVERY TOPIC IS `unavailable`, NOT an empty `ok`. That
 * is the honesty rule on the new axis: nothing was searched, so nothing can be
 * said about what is there. This shape is for the mixed case.
 */
export interface TopicAccount {
  /** Slugs that were searched for. Their rows are in `shorts`. */
  readonly searched: readonly string[];
  /** Slugs that could not be, each with the adapter's own sentence. */
  readonly refused: readonly { readonly slug: string; readonly reason: string }[];
}

export type PlatformOutcome =
  | {
      readonly platform: Platform;
      readonly status: "ok";
      /** `adapter.describe()`, so the UI can say what read this even when kept is 0. */
      readonly description: string;
      /** Rows the adapter handed back, before any filtering. */
      readonly returned: number;
      /** Rows that cleared every filter and were not already held. */
      readonly kept: number;
      /** Rows that cleared every filter and were already held, this run. */
      readonly duplicates: number;
      readonly dropped: DroppedBreakdown;
      /** The kept rows, highest views first. Same objects as in `report.shorts`. */
      readonly shorts: readonly ShortRecord[];
      /** Absent when the run asked for no topics. See `TopicAccount`. */
      readonly topics?: TopicAccount;
    }
  | {
      readonly platform: Platform;
      readonly status: "partial";
      readonly description: string;
      readonly returned: number;
      readonly kept: number;
      readonly duplicates: number;
      readonly dropped: DroppedBreakdown;
      readonly shorts: readonly ShortRecord[];
      /**
       * What stopped it. Never null on this branch — that IS the branch.
       *
       * Everything above is true of the rows that arrived. What is missing from
       * them is unknown, so no absence in this outcome is evidence of anything.
       */
      readonly truncation: Truncation;
      /** Absent when the run asked for no topics. See `TopicAccount`. */
      readonly topics?: TopicAccount;
    }
  | {
      readonly platform: Platform;
      readonly status: "unavailable";
      readonly description: string;
      /** The adapter's own sentence. Rendered as written; never summarised to "0". */
      readonly reason: string;
    }
  | {
      readonly platform: Platform;
      readonly status: "failed";
      readonly description: string;
      /** The thrown message. A failure is not an empty list. */
      readonly error: string;
      /**
       * The same message WHEN THE ADAPTER MARKED IT FIT TO PRINT, else null.
       *
       * `error` is for a log; this is for a screen, and the two are separate
       * fields rather than one flag because the surfaces have opposite defaults.
       * A CLI prints `error` always. The admin page prints `safeMessage` when
       * there is one and otherwise says where the log is — see `SAFE_TO_SHOW`
       * above for which errors qualify and why the default stays hostile.
       *
       * OPTIONAL ON THE TYPE, ALWAYS SET BY `getLatestShorts`, exactly like
       * `unverified` and `spend` below: a report built by hand — a fixture, a
       * stored report from before this field existed — is still a report, and
       * absent is read as "nothing was said", which is the safe direction.
       */
      readonly safeMessage?: string | null;
    }
  | {
      readonly platform: Platform;
      readonly status: "no-adapter";
      readonly reason: string;
    }
  | {
      /**
       * THE OPERATOR DID NOT ASK FOR THIS PLATFORM.
       *
       * Its own status and not a `no-adapter` with a different sentence, which
       * is what the first draft of the platform checkboxes did. The two are
       * indistinguishable on a screen and an operator fixes them in opposite
       * places: an unticked box is a box you tick, and a missing adapter is a
       * key you go and configure. Folding one into the other would have told
       * somebody who deselected YouTube that nothing is configured to read
       * YouTube — a sentence about the deployment, produced by a click.
       *
       * It is also the reason the SELECTION IS ENFORCED INSIDE THE RUN rather
       * than by the caller filtering its adapter list. An adapter handed to a
       * run for a platform the run was not asked for is not read, whatever the
       * caller intended, because on X being read is being billed.
       */
      readonly platform: Platform;
      readonly status: "not-asked";
      readonly reason: string;
    };

/**
 * The two outcomes that actually read the platform.
 *
 * Every count in a report is over these and only these. A helper exists because
 * `status === "ok"` was the test for "it ran" in four places before `partial`
 * existed, and every one of those places would have silently stopped counting a
 * capped X run — dropping its rows off the page while the figures went on
 * looking tidy. Narrow with this, not with a literal.
 */
export type RanOutcome = Extract<PlatformOutcome, { status: "ok" | "partial" }>;

/** True when the platform was actually read, completely or not. */
export function ran(outcome: PlatformOutcome): outcome is RanOutcome {
  return outcome.status === "ok" || outcome.status === "partial";
}

/** True when the platform was read but stopped short of what it was asked for. */
export function stoppedEarly(
  outcome: PlatformOutcome,
): outcome is Extract<PlatformOutcome, { status: "partial" }> {
  return outcome.status === "partial";
}

/**
 * Whether the run's results reached storage.
 *
 * SEPARATE FROM THE PER-PLATFORM OUTCOMES ON PURPOSE. A store that refuses does
 * not make the shorts wrong — they were read, they are in the report, and a
 * person can act on them. Throwing the whole run away because the database is
 * down would turn a recoverable problem into a total loss. But a run that
 * silently did not persist is a run that will read the same shorts again
 * tomorrow and call them new, so it is reported, loudly, as its own field.
 */
export type PersistenceOutcome =
  | { readonly status: "written"; readonly rows: number }
  | { readonly status: "failed"; readonly rows: number; readonly error: string };

export interface LatestShortsReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** The thresholds this run actually used. Recorded so a stale list cannot be misread. */
  readonly minViews: number;
  /**
   * The length floor this run applied. Zero when there was none.
   *
   * RECORDED FOR THE SAME REASON THE OTHER THREE ARE, and it is the one most
   * worth recording: a run with a floor of 60 produces a shorter list than the
   * same run without one, and NOTHING ELSE ON THE PAGE WOULD SAY WHY. A stale
   * list read as the whole inventory is the failure this field exists to stop.
   */
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly limit: number;
  /**
   * The subject this run was narrowed to, or absent when it was not.
   *
   * RECORDED FOR THE SAME REASON THE FOUR NUMBERS ABOVE ARE. A list gathered
   * for one subject and a list gathered for every active subject look identical
   * on screen — same columns, same figures — and reading the first as the
   * second is reading "the best Shark Tank clips today" as "the best clips
   * today". Nothing else in this report says which it is: the per-platform
   * `TopicAccount` names the slugs that were searched, and one searched slug is
   * equally what a narrowed run and a deployment with one active topic produce.
   *
   * OPTIONAL, so a report stored before this field existed is still a report —
   * and absent and null mean the same thing here, which is that nobody narrowed
   * anything. That is the untargeted-or-everything run, and it is the only
   * reading of a missing field that does not invent a subject.
   */
  readonly topic?: TopicRef | null;
  /** One per platform in `PLATFORMS`, always all five, always in that order. */
  readonly platforms: readonly PlatformOutcome[];
  /**
   * THE ONE LIST. Every kept short, grouped by platform in `PLATFORMS` order,
   * highest views first within each group.
   *
   * EVERY ROW HERE WAS MEASURED AGAINST BOTH FILTERS AND CLEARED BOTH. That has
   * been true since this file was written and it did not change when
   * `unverified` arrived — rows nobody could measure are in that list, not this
   * one, and only this one is persisted.
   */
  readonly shorts: readonly ShortRecord[];
  /**
   * Rows that failed no filter and passed less than all of them.
   *
   * `getLatestShorts` ALWAYS sets this, to `[]` when there were none. It is
   * optional on the type only so that a report built by hand — a fixture, a
   * stored report from before this field existed — is still a report. Absent
   * and empty mean different things and no producer in this repo emits absent.
   *
   * Grouped by platform in `PLATFORMS` order, then highest known views first.
   */
  readonly unverified?: readonly UnverifiedShort[];
  /**
   * Keys (`shortKey`) of kept shorts that were ALREADY in the library — the
   * `shorts` table — BEFORE this run wrote to it. The search page hides these by
   * default so a repeated read of the same topic surfaces only what is new; the
   * Library still shows everything, used or not, old or new.
   *
   * MEASURED BEFORE THE UPSERT, because that upsert puts THIS run's shorts into
   * the library too — read after, and every row would look already-known. A
   * library that could not be read leaves this empty rather than guessing, so
   * the failure hides nothing (a clip shown twice) rather than hiding something
   * new (a clip never shown). Always set by a real run, to `[]` when nothing
   * carried over; optional on the type only so a hand-built report is still a
   * report.
   */
  readonly carriedOverKeys?: readonly string[];
  /**
   * What this run cost, per platform, for the platforms that meter themselves.
   *
   * A platform missing from this list did not report a price. THAT IS NOT THE
   * SAME AS FREE and no surface may print it as zero. Always set by
   * `getLatestShorts`, to `[]` when nothing metered.
   */
  readonly spend?: readonly PlatformSpend[];
  readonly persistence: PersistenceOutcome;
}

/**
 * Who charged, who did not say, and how many platforms each of those is.
 *
 * DERIVED FROM THE REPORT, ON PURPOSE, and it exists because the alternative
 * was on the screen: /admin/shorts carried the sentence "four of the five
 * adapters have no price to quote", written by hand, against five platforms of
 * which one meters itself — so the sentence was wrong the day X arrived and
 * would have gone on being wrong every time the set changed. A count a person
 * has to keep in step with the code is a count that is eventually a lie, and
 * this one sits next to the word "Spent".
 *
 * `unmetered` counts only platforms that RAN. A platform that could not be read
 * spent nothing and quoted nothing, and folding it in here would answer a
 * question nobody asked with a number that looks like an answer to the one they
 * did.
 */
export interface MeteringSummary {
  /** Platforms that were read, completely or not. */
  readonly ran: readonly Platform[];
  /** Of those, the ones that reported what they charged. */
  readonly metered: readonly Platform[];
  /**
   * Of those, the ones that reported NO price.
   *
   * NOT the ones that were free. Nothing in this repo may turn this list into a
   * zero — see `report.spend`.
   */
  readonly unmetered: readonly Platform[];
}

/** `MeteringSummary` for one report. A sum over what is already there. */
export function meteringSummary(report: LatestShortsReport): MeteringSummary {
  const priced = new Set((report.spend ?? []).map((row) => row.platform));
  const ranPlatforms = report.platforms.filter(ran).map((outcome) => outcome.platform);
  return {
    ran: ranPlatforms,
    metered: ranPlatforms.filter((platform) => priced.has(platform)),
    unmetered: ranPlatforms.filter((platform) => !priced.has(platform)),
  };
}

export interface LatestShortsRunOptions {
  /** At most one adapter per platform. Missing platforms report `no-adapter`. */
  readonly adapters: readonly PlatformAdapter[];
  readonly store: ShortsStore;
  /** Passed straight to every adapter. A ceiling on cost, not a target. */
  readonly limit: number;
  readonly minViews: number;
  readonly maxDurationSeconds: number;
  /**
   * The shortest a video may be. OMITTED MEANS NO FLOOR, and that is the same
   * run every caller made before this existed.
   *
   * Optional where `maxDurationSeconds` is required, and the asymmetry is the
   * point: the ceiling is what makes a video a Short, so a run that did not
   * state one would be a run with no definition of its subject. A floor is a
   * preference, and the scheduler, the CLI and the cron route have never been
   * given one — so they say nothing and nothing is excluded, rather than
   * inheriting a number somebody typed on a screen they cannot see.
   */
  readonly minDurationSeconds?: number;
  /**
   * WHICH PLATFORMS THIS RUN WAS ASKED FOR. Omitted means all of them.
   *
   * Undefined and "all five" are the same run, and that is deliberate: every
   * caller that existed before the checkboxes did — the scheduler, the CLI, the
   * cron route — asks for everything it has an adapter for, and none of them
   * had to change.
   *
   * AN EMPTY ARRAY IS NOT THE SAME AS OMITTED. It is a run of nothing, and it
   * produces a report of five `not-asked` outcomes rather than quietly meaning
   * "all". A caller that computed an empty selection by mistake gets a report
   * saying nothing was asked, which is true, instead of a bill for five
   * platforms it did not want.
   *
   * The set is applied HERE, to the adapters, before any of them is read. See
   * the `not-asked` outcome for why the run does not trust a caller to have
   * filtered its own list.
   */
  readonly platforms?: readonly Platform[];
  /**
   * WHAT KIND OF SHORT THIS RUN IS LOOKING FOR. Omitted or empty means none,
   * which is the untargeted run every caller made before topics existed.
   *
   * AND THE TWO ARE GENUINELY THE SAME RUN HERE, unlike `platforms`, where an
   * empty array deliberately means "nothing". The reason they differ is what
   * an empty list would otherwise assert: an empty platform selection is a
   * person having ticked no boxes, which is a decision worth honouring, while
   * an empty topic list is the state this product was in until 2026-09-05 and
   * refusing to run in it would break the scheduler, the CLI and the cron route
   * on the day this shipped.
   *
   * A PLATFORM THAT CANNOT BE SEARCHED IS REPORTED AS UNAVAILABLE, never as
   * having found nothing, and never by falling back to its untargeted read.
   * See `runTopics`.
   */
  readonly topics?: readonly Topic[];
  /**
   * THE ONE SUBJECT THIS RUN WAS NARROWED TO, when a person narrowed it.
   *
   * Omitted or null means nobody did: the run searched for whatever `topics`
   * it was handed, which for the scheduler, the CLI and the cron route is every
   * active topic and always has been. Those callers never set this and never
   * need to.
   *
   * IT IS A SECOND STATEMENT ABOUT THE SAME RUN AND IT IS CHECKED AGAINST THE
   * FIRST. `topics` says what will be searched; this says the run was aimed at
   * one subject on purpose, which is a fact about a decision rather than about
   * a search and cannot be derived — one active topic and one CHOSEN topic
   * produce identical `topics`, and only the second may be captioned "looking
   * for Shark Tank" or restored into a control that narrows the next run. A
   * caller that sets this to something `topics` does not match is refused
   * before anything is read; see `runLatestShorts`.
   */
  readonly topic?: TopicRef | null;
  /** Injected in tests so a report is comparable. Defaults to the wall clock. */
  readonly now?: () => string;
}

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------

/**
 * What one row is: kept, dropped for a stated reason, or unjudgeable.
 *
 * Three destinations rather than two, and the third one is the whole of the
 * 2026-09-04 change. `unverified` carries a drop `reason` as well, because the
 * row is still not in `shorts` and the tally still has to account for it — the
 * arithmetic did not move, only what happens to the row afterwards.
 */
type Verdict =
  | { readonly kind: "keep" }
  | { readonly kind: "drop"; readonly reason: keyof DroppedBreakdown }
  | {
      readonly kind: "unverified";
      readonly reason: keyof DroppedBreakdown;
      readonly unproven: readonly UnprovenFilter[];
    };

const KEEP: Verdict = { kind: "keep" };

/**
 * Does this short clear the bar, miss it, or fail to say?
 *
 * `>= minViews`, not `> minViews`. Erik said "shorts over 500k views" and the
 * contract calls the number `minViews`; a minimum is inclusive, so a short with
 * exactly 500,000 views is kept. The distinction affects one view count in half
 * a million and it is still written down here rather than left to whoever reads
 * the code next, because "did the boundary do what he meant" is not a question
 * anyone should have to answer twice.
 *
 * THE ORDER IS THE POINT. Every filter that CAN be evaluated is evaluated
 * first, and a row only becomes `unverified` once it has survived all of them.
 * A row with no duration and eleven views is under the threshold — that is a
 * measurement, and calling it "we could not tell" would put a genuinely small
 * short on the page beside the ones nobody could measure.
 */
function judge(short: ShortRecord, platform: Platform, query: LatestShortsQuery): Verdict {
  if (short.platform !== platform) return { kind: "drop", reason: "wrongPlatform" };

  const duration = short.duration_seconds;
  const views = short.view_count;

  if (duration !== null && duration > query.maxDurationSeconds) {
    return { kind: "drop", reason: "tooLong" };
  }
  // `< minDurationSeconds`, so a floor of 30 keeps a short of exactly 30 —
  // the same inclusive reading `minViews` gets four lines down, and for the
  // same reason: two minimums on one screen that disagree about their own
  // boundary is a difference nobody would ever think to look for.
  //
  // A FLOOR OF ZERO IS NOT A FILTER. It cannot drop anything (no duration is
  // negative), so the ordinary run — where nobody asked for one — never reaches
  // this branch and never counts a `tooShort`.
  if (duration !== null && duration < query.minDurationSeconds) {
    return { kind: "drop", reason: "tooShort" };
  }
  if (views !== null && views < query.minViews) {
    return { kind: "drop", reason: "belowThreshold" };
  }

  const unproven: UnprovenFilter[] = [];
  // Views first, because the threshold is the promise and "we could not tell
  // whether this cleared 500,000" is the more alarming of the two absences.
  if (views === null) unproven.push("views");
  if (duration === null) unproven.push("duration");
  if (unproven.length === 0) return KEEP;

  // ONE REASON PER ROW for the tally, in the declaration order of
  // `DroppedBreakdown`, so the numbers still sum. `unproven` carries the whole
  // truth for the row itself.
  return {
    kind: "unverified",
    reason: duration === null ? "unknownDuration" : "unknownViews",
    unproven,
  };
}

/**
 * Highest views first, stable.
 *
 * Every row here has a non-null `view_count` — a null one never got past
 * `judge` — so this never has to invent an ordering for an unknown number.
 * The sort is stable in every JavaScript engine since ES2019, so ties keep the
 * order the adapter returned them in, which is newest-first from the source.
 * That is a better tie-break than anything this file could compute, and it
 * costs nothing.
 */
function viewsDescending(shorts: readonly ShortRecord[]): ShortRecord[] {
  return [...shorts].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));
}

/**
 * The unverified rows of one platform, best-known-first.
 *
 * A row with no view count sorts LAST rather than as a zero. It is not the
 * smallest thing in the list, it is the thing the list cannot rank, and putting
 * it at the bottom is the only ordering that does not assert something about
 * it. Ties keep the source's order, same as the kept list.
 */
function unverifiedOrder(entries: readonly UnverifiedShort[]): UnverifiedShort[] {
  return [...entries].sort((a, b) => {
    const av = a.short.view_count;
    const bv = b.short.view_count;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}

// ---------------------------------------------------------------------------
// Running one adapter
// ---------------------------------------------------------------------------

/** What one adapter produced, before dedupe. Internal. */
interface AdapterResult {
  readonly platform: Platform;
  readonly description: string;
  readonly kind: "rows" | "unavailable" | "failed";
  readonly rows: readonly ShortRecord[];
  readonly message: string;
  /**
   * The same message when the thrown error declared itself fit to print.
   *
   * Computed here, at the only place holding the exception object, rather than
   * carried onward as an `unknown` for a surface to inspect. A page that had to
   * unwrap an error to decide what to render would sooner or later render the
   * wrong branch of that decision.
   */
  readonly safeMessage: string | null;
  /** Null unless the adapter meters itself AND had something to say. */
  readonly account: RunAccount | null;
  /** Null unless the run was given topics. See `TopicAccount`. */
  readonly topics: TopicAccount | null;
}

/**
 * Ask the adapter what the call it just made did.
 *
 * WRAPPED IN ITS OWN CATCH. An accounting method that throws must not turn a
 * successful read into a failure — the rows are already in hand and they are
 * real. The cost of losing this is that a capped run reads as complete, which
 * is why it is worth saying here that the failure mode is silent: there is
 * nowhere honest to put "the adapter would not tell us whether it stopped
 * early" without inventing a sixth outcome for a case nobody has seen.
 */
function accountFor(adapter: PlatformAdapter): RunAccount | null {
  const accounting = asAccounting(adapter);
  if (!accounting) return null;
  try {
    return accounting.accountForLastRun();
  } catch {
    return null;
  }
}

/**
 * One platform, read once per topic, merged.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE REASON THIS IS NOT A LOOP INLINE:
 *
 *   NO TOPICAL READER AT ALL -> `unavailable`, with the sentence naming what
 *   is missing. Facebook lands here permanently; TikTok and Instagram land
 *   here until a vendor key exists.
 *
 *   EVERY TOPIC REFUSED -> `unavailable`, with the first refusal quoted and
 *   the rest counted. Nothing was searched, so an empty `ok` would be the
 *   platform reporting that none of thirty subjects had anything — a claim it
 *   never tested. This is the honesty rule applied to the new axis.
 *
 *   SOME SEARCHED -> `rows`, with a `TopicAccount` saying which. A refusal in
 *   this case is per topic and is carried alongside the rows rather than
 *   replacing them: one broken subject must not cost the other twenty-nine, in
 *   exactly the way one bad seed must not cost a platform.
 *
 * A THROW FROM ONE TOPIC FAILS THE PLATFORM and is not caught here. That is
 * deliberate and it is the opposite of the refusal handling above: a refusal is
 * the adapter saying in advance that it cannot, which is information; a throw is
 * the reader breaking mid-read, and continuing past it would produce a report
 * whose numbers came from a source that had already failed once.
 */
async function runTopics(
  adapter: PlatformAdapter,
  query: LatestShortsQuery,
  topics: readonly Topic[],
  description: string,
): Promise<AdapterResult> {
  const platform = adapter.platform;
  const topical = asTopical(adapter);

  if (!topical) {
    return {
      platform,
      description,
      kind: "unavailable",
      rows: [],
      message: noTopicalReaderReason(platform),
      safeMessage: null,
      account: null,
      topics: { searched: [], refused: [] },
    };
  }

  const searched: string[] = [];
  const refused: { slug: string; reason: string }[] = [];
  const rows: ShortRecord[] = [];

  for (const topic of topics) {
    // ASKED BEFORE THE READ, per topic, for the same reason
    // `unavailableReason` is asked before `latestShorts`: it is the method that
    // keeps "could not be searched for" from arriving as "found nothing".
    const reason = await topical.topicUnavailableReason(topic);
    if (reason !== null) {
      refused.push({ slug: topic.slug, reason });
      continue;
    }
    rows.push(...(await topical.latestShortsForTopic(topic, query)));
    searched.push(topic.slug);
  }

  const account: TopicAccount = { searched, refused };

  if (searched.length === 0) {
    return {
      platform,
      description,
      kind: "unavailable",
      rows: [],
      message:
        `None of the ${refused.length} topic${refused.length === 1 ? "" : "s"} asked for ` +
        `could be searched for on ${platformLabel(platform)}, so nothing was read and this ` +
        `is NOT a report that ${platformLabel(platform)} had nothing about them. ` +
        (refused[0] ? `The first: ${refused[0].reason}` : ""),
      safeMessage: null,
      account: null,
      topics: account,
    };
  }

  return {
    platform,
    description,
    kind: "rows",
    rows,
    message: "",
    safeMessage: null,
    account: accountFor(adapter),
    topics: account,
  };
}

async function runAdapter(
  adapter: PlatformAdapter,
  query: LatestShortsQuery,
  topics: readonly Topic[],
): Promise<AdapterResult> {
  const platform = adapter.platform;
  let description = "";
  try {
    description = adapter.describe();

    // A RUN WITH TOPICS IS A DIFFERENT RUN, and it does not fall through to
    // the untargeted read on the way past. That fall-through is the bug this
    // whole change exists to prevent: it would return the same everything-that-
    // is-big list, now wearing a subject's name.
    if (topics.length > 0) return await runTopics(adapter, query, topics, description);

    // ASKED BEFORE `latestShorts`, ALWAYS. This is the method that keeps "could
    // not be read" from collapsing into "no results", and it only does that if
    // somebody actually calls it. A throw from here is a failure, not an
    // availability: an adapter that cannot even say whether it can run has not
    // told us it is unavailable, it has told us it is broken.
    const reason = await adapter.unavailableReason();
    if (reason !== null) {
      return {
        platform,
        description,
        kind: "unavailable",
        rows: [],
        message: reason,
        safeMessage: null,
        account: null,
        topics: null,
      };
    }

    const rows = await adapter.latestShorts(query);
    return {
      platform,
      description,
      kind: "rows",
      rows,
      message: "",
      safeMessage: null,
      account: accountFor(adapter),
      topics: null,
    };
  } catch (cause) {
    return {
      platform,
      description,
      kind: "failed",
      rows: [],
      message: cause instanceof Error ? cause.message : String(cause),
      safeMessage: safeToShowMessage(cause),
      // A read that threw may still have spent money before it threw. Ask.
      account: accountFor(adapter),
      topics: null,
    };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run every available adapter, filter, dedupe, persist, report.
 *
 * ADAPTERS RUN CONCURRENTLY because they read five unrelated services and a
 * serial run would take the sum of five network round trips for no reason. The
 * RESULTS are then processed in `PLATFORMS` order, so the report — and in
 * particular which of two identical shorts is called the duplicate — does not
 * depend on which service answered first. A report that changes shape between
 * two identical runs is a report nobody can diff.
 */
export async function getLatestShorts(options: LatestShortsRunOptions): Promise<LatestShortsReport> {
  const { adapters, store, limit, minViews, maxDurationSeconds } = options;
  const minDurationSeconds = options.minDurationSeconds ?? 0;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();

  const byPlatform = new Map<Platform, PlatformAdapter>();
  for (const adapter of adapters) {
    if (byPlatform.has(adapter.platform)) {
      // Refused rather than merged. Two sources for one platform is a
      // reasonable thing to want (yt-dlp and the Data API both read YouTube),
      // but it makes every per-platform number in the report ambiguous — whose
      // `returned` is 40? — and it makes a duplicate between the two look like
      // a duplicate within one. Compose them into one adapter instead.
      throw new LatestShortsRunError(
        `Two adapters claim the platform ${JSON.stringify(adapter.platform)}. ` +
          "A run reports one outcome per platform, so it takes at most one adapter per platform. " +
          "If two sources genuinely read the same platform, compose them behind a single adapter.",
      );
    }
    byPlatform.set(adapter.platform, adapter);
    // BEFORE ANYTHING IS READ, AND BEFORE ANYTHING IS SPENT. A half-declared
    // money contract throws here rather than being discovered as a report that
    // quietly says a metered platform quoted no price. See the scar on
    // `METERS_ITS_OWN_SPEND`.
    spendCapabilities(adapter);
  }

  // THE SELECTION IS APPLIED BEFORE ANYTHING IS READ, and it is applied to the
  // adapters rather than to the report afterwards. Filtering the report would
  // mean the platform was asked, answered and was billed for, and then had its
  // rows thrown away — which on X is fifty cents for a list nobody sees.
  const asked = new Set<Platform>(options.platforms ?? PLATFORMS);

  const query: LatestShortsQuery = { limit, minViews, minDurationSeconds, maxDurationSeconds };
  const ordered = PLATFORMS.filter((platform) => byPlatform.has(platform) && asked.has(platform));
  // Topics with no words are dropped here rather than inside the loop: a topic
  // that cannot be searched for would otherwise be counted as a refusal against
  // every platform, five times over, for one bad row.
  const topics = (options.topics ?? []).filter((t) => cleanTerms(t.terms).length > 0);
  // THE NARROWING IS CHECKED AGAINST WHAT WILL ACTUALLY BE SEARCHED, and it is
  // checked here — before a single adapter is read and before anybody is
  // charged. A report that says "looking for Shark Tank" over rows gathered for
  // thirty subjects is the exact failure topics were added to fix, pointing the
  // other way, and it would arrive as two call sites drifting rather than as
  // anything visible on the screen. Refused rather than corrected: this file
  // cannot tell which of the two statements the caller meant.
  const narrowedTo = options.topic ?? null;
  if (narrowedTo && (topics.length !== 1 || topics[0].slug !== narrowedTo.slug)) {
    throw new LatestShortsRunError(
      `This run says it was narrowed to ${JSON.stringify(narrowedTo.slug)}, and the topics it was ` +
        `given are ${JSON.stringify(topics.map((t) => t.slug))}. A run reports one subject only ` +
        "when it searched for exactly that one, so nothing was read and nothing was charged.",
    );
  }
  const results = await Promise.all(
    ordered.map((platform) => runAdapter(byPlatform.get(platform)!, query, topics)),
  );
  const resultFor = new Map(results.map((result) => [result.platform, result]));

  // Dedupe across the whole run, not per platform: identity is
  // (platform, platform_video_id), so a collision can only happen within one
  // platform anyway — but the map is global so that stays true by construction
  // rather than by argument, and so a future adapter that somehow returns
  // another platform's row cannot slip a duplicate past a per-platform set.
  const seen = new Set<string>();
  // The unverified list gets its OWN set. A short is in one list or the other,
  // never both, so the two cannot collide — and keeping them apart means a
  // repeated unverified row does not get counted as a duplicate of a kept one,
  // which would make `duplicates` mean two different things in one number.
  const seenUnverified = new Set<string>();
  const outcomes: PlatformOutcome[] = [];
  const all: ShortRecord[] = [];
  const unverified: UnverifiedShort[] = [];
  const spend: PlatformSpend[] = [];

  for (const platform of PLATFORMS) {
    // ASKED FIRST, AND BEFORE THE ADAPTER LOOKUP. A platform that was not
    // selected is not asked whether it has an adapter, because "you did not ask
    // for this" is the whole truth about it and "nothing is configured to read
    // it" would be a second claim this run never tested.
    if (!asked.has(platform)) {
      outcomes.push({
        platform,
        status: "not-asked",
        reason:
          `${platformLabel(platform)} was not selected for this run, so it was not read and it ` +
          "was not charged. That is a choice made on this screen, not a statement about " +
          `${platformLabel(platform)} or about what this deployment can reach.`,
      });
      continue;
    }

    const result = resultFor.get(platform);

    if (!result) {
      outcomes.push({
        platform,
        status: "no-adapter",
        reason:
          `No adapter is configured to read ${platformLabel(platform)}. That is not a statement ` +
          `about ${platformLabel(platform)}: nothing looked, so nothing can be said about what ` +
          "is there.",
      });
      continue;
    }

    // Money is recorded for every platform that reported it, whatever the read
    // then did. A read that failed after paying for two pages still cost that.
    if (result.account?.spend) spend.push({ platform, ...result.account.spend });

    if (result.kind === "unavailable") {
      outcomes.push({
        platform,
        status: "unavailable",
        description: result.description,
        reason: result.message,
      });
      continue;
    }

    if (result.kind === "failed") {
      outcomes.push({
        platform,
        status: "failed",
        description: result.description,
        error: result.message,
        safeMessage: result.safeMessage,
      });
      continue;
    }

    const dropped = noDrops();
    const kept: ShortRecord[] = [];
    const unjudged: UnverifiedShort[] = [];
    let duplicates = 0;

    for (const short of result.rows) {
      const verdict = judge(short, platform, query);

      if (verdict.kind === "drop") {
        dropped[verdict.reason] += 1;
        continue;
      }

      if (verdict.kind === "unverified") {
        // Counted in the tally per RETURNED ROW, so the arithmetic still sums;
        // listed once per DISTINCT SHORT, so the page cannot show the same row
        // twice under two identical keys.
        dropped[verdict.reason] += 1;
        const key = shortKey(short);
        if (!seenUnverified.has(key)) {
          seenUnverified.add(key);
          unjudged.push({ short, unproven: verdict.unproven });
        }
        continue;
      }

      const key = shortKey(short);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      kept.push(short);
    }

    const sorted = viewsDescending(kept);
    all.push(...sorted);
    unverified.push(...unverifiedOrder(unjudged));

    // The two ran-outcomes differ by one field, so they are built from one
    // object. `ran()` above is the exported narrowing helper; this is the data.
    const wasRead = {
      platform,
      description: result.description,
      returned: result.rows.length,
      kept: sorted.length,
      duplicates,
      dropped,
      shorts: sorted,
      // SPREAD, so the key is absent rather than present-and-undefined when the
      // run asked for no topics. `topics: undefined` and no `topics` at all are
      // the same to a reader of the type and different to `JSON.stringify`, and
      // this object is stored as JSON by lib/shorts/report-store.ts.
      ...(result.topics ? { topics: result.topics } : {}),
    } as const;

    const truncation = result.account?.truncation ?? null;
    outcomes.push(
      truncation ? { ...wasRead, status: "partial", truncation } : { ...wasRead, status: "ok" },
    );
  }

  // Persistence last, and its failure is reported rather than thrown: the
  // shorts above were really read and are really over the threshold whether or
  // not a database accepted them.
  //
  // ONLY `all` IS WRITTEN. The unverified rows are deliberately not persisted:
  // the table is the tool's answer to "shorts over 500,000 views", and a row
  // nobody could measure is not an answer to that question. Storing them would
  // also make every later read of the table have to re-derive which rows had
  // been judged, from fields that no longer say.
  // WHAT THE OPERATOR HAS ALREADY SEEN, measured before the write below. See
  // `carriedOverKeys` on the report type for why this is here and not on the
  // page: the upsert on the next line adds this run's shorts to the library, so
  // "already in the library" has to be answered against the library as it stood
  // a moment ago. A read that fails carries nothing over, which shows a clip
  // twice at worst and never hides a genuinely new one.
  let carriedOverKeys: string[] = [];
  try {
    const existing = await store.readShorts();
    const known = new Set(
      (existing.complete ? existing.shorts : existing.partial).map(shortKey),
    );
    carriedOverKeys = all.filter((short) => known.has(shortKey(short))).map(shortKey);
  } catch (cause) {
    console.error(
      "[run] the library could not be read to mark already-seen shorts; none hidden:",
      cause,
    );
  }

  let persistence: PersistenceOutcome;
  try {
    await store.upsertShorts(all);
    persistence = { status: "written", rows: all.length };
  } catch (cause) {
    persistence = {
      status: "failed",
      rows: all.length,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // THE UNVERIFIED ROWS ARE NOW SAVED TOO, into their own table, so the Library
  // can show them (Asad, 2026-09-10 — every Instagram keyword reel is here
  // because that endpoint gives no duration). This is BEST-EFFORT and secondary
  // to the verified write above: a failure here is logged and does not change
  // `persistence`, which is the promise about `shorts`. The caveat rides on each
  // row structurally (lib/platform/caveat.ts) and is carried into the store so
  // an estimated view count can be shown as one, never as a measurement.
  try {
    const unverifiedRows = unverified.map((u) => ({
      ...u.short,
      unproven: u.unproven,
      measurement_caveat: measurementCaveat(u.short),
    }));
    await store.upsertUnverified(unverifiedRows);
  } catch (cause) {
    console.error("[run] the unverified rows could not be saved for the Library:", cause);
  }

  return {
    startedAt,
    finishedAt: now(),
    minViews,
    minDurationSeconds,
    maxDurationSeconds,
    limit,
    // SPREAD, so the key is absent rather than present-and-undefined on a run
    // nobody narrowed — the same call the per-platform `topics` account makes
    // above, and for the same reason: this object is stored as JSON.
    ...(narrowedTo ? { topic: narrowedTo } : {}),
    platforms: outcomes,
    shorts: all,
    unverified,
    carriedOverKeys,
    spend,
    persistence,
  };
}

// ---------------------------------------------------------------------------
// What a run will cost, before it is made
// ---------------------------------------------------------------------------

/**
 * Why a platform has no price on it.
 *
 * `unpriced` and `not-running` are kept apart because they mean opposite things
 * to somebody about to press a button that spends money. `unpriced` is "this
 * WILL run and nobody can tell you what it will cost" — the case to worry
 * about. `not-running` is "nothing will happen here, so nothing will be spent"
 * — the case to ignore. Collapsing them into "no estimate" would put the
 * frightening one and the harmless one behind the same dash.
 */
export type ForecastKind = "priced" | "unpriced" | "not-running";

export interface PlatformForecast {
  readonly platform: Platform;
  readonly kind: ForecastKind;
  /** Present exactly when `kind` is "priced". */
  readonly usdMicros: UsdMicros | null;
  /** One sentence for a person. The adapter's own words when it had any. */
  readonly note: string;
}

export interface SpendForecastReport {
  readonly forecastAt: string;
  /** The query that was priced. A forecast for 500k is not a forecast for 200k. */
  readonly minViews: number;
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly limit: number;
  /** One per platform in `PLATFORMS`, always all five, always in that order. */
  readonly platforms: readonly PlatformForecast[];
  /**
   * The sum of the platforms that gave a figure, and NOTHING ELSE.
   *
   * It is a FLOOR, not a total, whenever `unpriced` is above zero — which the
   * caller can see, and which every surface printing this number has to say.
   */
  readonly knownUsdMicros: UsdMicros;
  /** Platforms that will run and could not be priced. The number that matters. */
  readonly unpriced: number;
}

export interface SpendForecastOptions {
  readonly adapters: readonly PlatformAdapter[];
  readonly limit: number;
  readonly minViews: number;
  readonly maxDurationSeconds: number;
  /** Same meaning and same default as the run's: omitted is no floor. */
  readonly minDurationSeconds?: number;
  /**
   * The same selection the run takes, with the same meaning: omitted is all
   * five, and an empty array is a run of nothing.
   *
   * IT IS PASSED FOR A REASON THAT COSTS MONEY IF IT IS NOT. An estimate that
   * priced every platform would quote a run this deployment would then refuse
   * to make, and it would quote it high — which is the direction that makes an
   * operator not press the button.
   */
  readonly platforms?: readonly Platform[];
  readonly now?: () => string;
}

/**
 * Price a run before making it.
 *
 * "Money is the one number an operator must never be surprised by" — so this
 * exists as a separate call the page makes on its own button, rather than as
 * something bolted to the front of `getLatestShorts`. Forcing an estimate
 * before every run would make the cheap call mandatory in order to make the
 * expensive one, and an operator who already knows what a run costs would pay
 * for the privilege of being told again.
 *
 * IT ASKS `unavailableReason()` FIRST, exactly as the run does. A platform that
 * cannot run cannot cost anything, and pricing it would produce a figure for
 * work that will not happen.
 *
 * NO PRICE IS COMPUTED HERE. Every figure comes from the adapter that will do
 * the spending. This function loops, sums and reports.
 */
export async function forecastLatestShortsSpend(
  options: SpendForecastOptions,
): Promise<SpendForecastReport> {
  const { adapters, limit, minViews, maxDurationSeconds } = options;
  const minDurationSeconds = options.minDurationSeconds ?? 0;
  const now = options.now ?? (() => new Date().toISOString());
  const query: LatestShortsQuery = { limit, minViews, minDurationSeconds, maxDurationSeconds };

  const byPlatform = new Map<Platform, PlatformAdapter>();
  for (const adapter of adapters) {
    // Same check as the run, for the same reason: an estimate that silently
    // skipped a half-declared metering adapter would under-quote a run and be
    // believed, which is the more expensive way round to be wrong.
    spendCapabilities(adapter);
    byPlatform.set(adapter.platform, adapter);
  }

  const asked = new Set<Platform>(options.platforms ?? PLATFORMS);
  const platforms = await Promise.all(
    // An unasked platform is handed NO ADAPTER, so `forecastOne` never reaches
    // `unavailableReason()` or `forecastSpend()` for it. Both of those talk to
    // the platform, and one of them is a metered call — pricing something
    // nobody asked for is the estimate doing the thing it exists to prevent.
    PLATFORMS.map((platform) =>
      forecastOne(platform, asked.has(platform) ? byPlatform.get(platform) : undefined, query, {
        asked: asked.has(platform),
      }),
    ),
  );

  return {
    forecastAt: now(),
    minViews,
    minDurationSeconds,
    maxDurationSeconds,
    limit,
    platforms,
    knownUsdMicros: platforms.reduce((sum, p) => sum + (p.usdMicros ?? 0), 0),
    unpriced: platforms.filter((p) => p.kind === "unpriced").length,
  };
}

async function forecastOne(
  platform: Platform,
  adapter: PlatformAdapter | undefined,
  query: LatestShortsQuery,
  selection: { readonly asked: boolean } = { asked: true },
): Promise<PlatformForecast> {
  const label = platformLabel(platform);

  // TWO REASONS A PLATFORM WILL NOT RUN, AND THE NOTE KEEPS THEM APART. The
  // `kind` is the same because the money answer is the same — nothing — but the
  // sentence beside it is the only thing telling an operator whether to tick a
  // box or go and configure a key.
  if (!selection.asked) {
    return {
      platform,
      kind: "not-running",
      usdMicros: null,
      note: `${label} is not selected, so this run will not read it and will not be charged for it.`,
    };
  }

  if (!adapter) {
    return {
      platform,
      kind: "not-running",
      usdMicros: null,
      note: `Nothing is configured to read ${label}, so a run spends nothing here and finds nothing here.`,
    };
  }

  let reason: string | null;
  try {
    reason = await adapter.unavailableReason();
  } catch {
    // The message is deliberately not carried. It is an exception from an
    // adapter that talks to a metered API, and a thrown message from one of
    // those routinely quotes the URL it called, key included. The run itself
    // will report this platform as `failed` and log the words.
    return {
      platform,
      kind: "not-running",
      usdMicros: null,
      note: `${label} could not say whether it can run, so it has not been priced. A run will report why.`,
    };
  }

  if (reason !== null) {
    return { platform, kind: "not-running", usdMicros: null, note: reason };
  }

  const forecasting = asForecasting(adapter);
  if (!forecasting) {
    return {
      platform,
      kind: "unpriced",
      usdMicros: null,
      note:
        `${label} does not report what a run costs. That is not the same as free — it means this ` +
        "adapter has no price to quote, and nothing here has measured one.",
    };
  }

  try {
    const forecast = await forecasting.forecastSpend(query);
    if (forecast.usdMicros === null) {
      return { platform, kind: "unpriced", usdMicros: null, note: forecast.note };
    }
    return { platform, kind: "priced", usdMicros: forecast.usdMicros, note: forecast.note };
  } catch {
    return {
      platform,
      kind: "unpriced",
      usdMicros: null,
      note: `${label} could not be priced: the estimate itself failed. A run will still cost whatever it costs.`,
    };
  }
}

// ---------------------------------------------------------------------------
// The one-line summary
// ---------------------------------------------------------------------------

/**
 * The one-line summary a run log or a CLI prints.
 *
 * Here rather than in the CLI because the sentence has to keep the outcomes
 * apart, and that is a property of the report rather than of any one surface
 * that shows it. A summary that said "3 platforms, 0 shorts" would be the
 * honesty rule broken in a single string.
 *
 * "Read" counts the platforms that ran, complete or capped, and the capped ones
 * are then named separately in the same breath. A capped platform WAS read —
 * hiding it from the read count would be its own small lie — but a reader who
 * stops after the first number must not walk away thinking the list is whole.
 */
export function summariseRun(report: LatestShortsReport): string {
  // A RECORD OVER THE UNION AND NOT AN OBJECT LITERAL. The literal it replaced
  // named five statuses, and `counts[outcome.status] += 1` on a sixth is
  // `undefined + 1` — NaN, printed into the summary line, with nothing red
  // anywhere. Typing it this way means the next status added to the union
  // fails the typecheck here instead.
  const counts: Record<PlatformOutcome["status"], number> = {
    ok: 0,
    partial: 0,
    unavailable: 0,
    failed: 0,
    "no-adapter": 0,
    "not-asked": 0,
  };
  for (const outcome of report.platforms) counts[outcome.status] += 1;

  const parts = [
    `${report.shorts.length} shorts at or over ${report.minViews.toLocaleString("en")} views`,
    `${counts.ok + counts.partial} platform(s) read`,
    `${counts.partial} stopped early`,
    `${counts.unavailable} unavailable`,
    `${counts.failed} failed`,
    `${counts["no-adapter"]} with no adapter`,
    `${counts["not-asked"]} not asked for`,
    `${report.unverified?.length ?? 0} could not be judged`,
  ];
  if (report.persistence.status === "failed") parts.push("NOT STORED");
  return parts.join(", ");
}
