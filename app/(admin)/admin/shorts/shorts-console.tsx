"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { measurementCaveat } from "@/lib/platform/caveat";

import { ShortCard } from "../_components/short-card";
import { PLATFORMS, platformLabel, type Platform, type ShortRecord } from "@/lib/platform/types";
import {
  meteringSummary,
  ran,
  totalDropped,
  type LatestShortsReport,
  type PlatformForecast,
  type PlatformOutcome,
  type PlatformSpend,
  type RanOutcome,
  type UnverifiedShort,
} from "@/lib/shorts/run";
import type { StoredRun } from "@/lib/shorts/report-store";
import { shortKey } from "@/lib/shorts/store";
import type { TopicRef } from "@/lib/shorts/topics";

import {
  MAX_ROWS_PER_PLATFORM,
  askedCount,
  askedPlatforms,
  belowThresholdTotal,
  describeAge,
  formatFigure,
  formatSavedAt,
  formatUsd,
  notAskedCount,
  readCount,
  safeHref,
  spentUsdMicros,
  stoppedEarlyCount,
  unprovenPhrase,
  unreadCount,
  unverifiedFor,
  unverifiedTotal,
  type DownloadOutcome,
  type EstimateOutcome,
  type RunOutcome,
  type RunRequest,
  type TopicChoices,
} from "./view";

/**
 * THE PRODUCT. One button, one list, grouped by platform, highest views first.
 *
 * Erik, 2026-09-02: *"I want to get 'get latest shorts' you scrape ALL
 * platforms, come back with shorts over 500k views categorized by platform, AXE
 * the rest."* This component is that sentence. Everything the previous version
 * of this repo put on a screen — an inventory of channels, a review queue,
 * approve and unlist, a subscriber-relative ranking — has been deleted, and
 * what replaces it is deliberately one screen with one control on it.
 *
 * ------------------------------------------------------------------------
 * THE FIVE STATES OF THIS PAGE, AND WHY NO TWO OF THEM MAY LOOK ALIKE
 * ------------------------------------------------------------------------
 *
 *   0. NOTHING HAS BEEN RUN. The first thing anybody sees, and it says so in as
 *      many words. An empty page after a fresh load is otherwise
 *      indistinguishable from a run that found nothing, and one of those is a
 *      statement about the internet while the other is a statement about
 *      whether a button has been pressed.
 *
 * The other five are `PlatformOutcome` in lib/shorts/run.ts, and this component
 * exists to make them look different:
 *
 *   ok          — the platform was read, to the end. It may have found nothing,
 *                 and nothing is a real result, printed with the numbers behind
 *                 it.
 *   partial     — the platform was read AND STOPPED SHORT, because a spend cap
 *                 or a rate limit ended it. The rows are real and the absences
 *                 are not: what is not on the list was never looked at. This
 *                 arrived with X, which is billed per post returned.
 *   unavailable — the adapter said before running what it is missing, and that
 *                 sentence is printed instead of a table. As of 2026-09-04 that
 *                 is where Instagram, X and Facebook are until keys are entered.
 *   failed      — the adapter ran and threw. Different from unavailable on
 *                 purpose: one is a gap somebody closes by choosing a data
 *                 provider, the other is something breaking right now, and an
 *                 operator does different things about them.
 *   no-adapter  — nothing was even configured to look. The run says it in its
 *                 own words and this page repeats them.
 *
 * That is this repo's honesty rule applied per platform, and it is the single
 * most important thing in this file. If a change ever makes "found nothing" and
 * "could not be read" render the same way, it has broken the product rather
 * than the layout.
 *
 * ------------------------------------------------------------------------
 * THE ROWS NOBODY COULD MEASURE, AND WHY THEY ARE IN A SECOND TABLE
 * ------------------------------------------------------------------------
 *
 * Two official APIs can hand back a row that has failed no filter and passed
 * less than all of them. X documents a view count on media and nobody has
 * confirmed it is populated for third-party posts; Instagram's Graph API has no
 * duration field at all, so the 120-second ceiling cannot be evaluated from it.
 *
 * Those rows get their own table, their own heading and their own chip, and
 * every one of them says which claim went unproven. They are NOT in the main
 * table, they are NOT in "Over the threshold", and they are not stored. A row
 * nobody measured sitting in the same table as a row that really cleared
 * 500,000 views, in the same column, in the same type — that is the failure
 * this whole product is built to avoid, and it would take one merge to cause.
 *
 * ------------------------------------------------------------------------
 * MONEY
 * ------------------------------------------------------------------------
 *
 * X charges per post returned. So the operator can price a run before making it
 * — a separate, cheap call — and the page reports what the run actually cost
 * afterwards. An adapter that reports no price is shown as "does not report a
 * price", never as "free" and never as "$0.00". Only an adapter that meters
 * itself may put a figure here, because a price is a fact about somebody else's
 * product.
 *
 * SCAR, 2026-09-04. This paragraph, and the tooltip on the "Spent" figure, both
 * said "four of the five adapters have no price to quote". It was five, and it
 * had been five since the X leg landed. Nobody had lied on purpose: the sentence
 * was a count of the code, written by hand, sitting next to a number about
 * money, and the code moved. Every figure of that kind on this screen now comes
 * from `meteringSummary(report)` — how many platforms ran, how many of those
 * said what they charged — so the sentence is a statement about the run in front
 * of the operator rather than about the repository on the day somebody typed it.
 *
 * ------------------------------------------------------------------------
 * WHY A FAILED PLATFORM DOES NOT SHOW ITS ERROR TEXT
 * ------------------------------------------------------------------------
 *
 * `PlatformOutcome` carries `error`, and this page does not print it. That is
 * not squeamishness and it is not a disagreement with the run: the report is
 * also what a CLI and a log consume, and there the message is exactly right.
 * Here it is a hazard specific to this screen. These adapters call metered APIs
 * with a key in the query string, and a thrown message routinely contains the
 * URL that failed — so the string that would land in this HTML can be the
 * operator's own API key, on a page around forty people at LookUp Media open
 * and screenshot. The same finding has been written twice in this repo already,
 * against /admin/credentials and against the decision actions. The message goes
 * to the server log tagged `[admin/shorts]`, where an operator can grep for it;
 * the page says which platform broke and where to look.
 *
 * ...EXCEPT WHEN THE ERROR ITSELF SAYS IT WAS WRITTEN FOR A PERSON.
 *
 * That rule is right for a leaked URL and it was wrong for the one result this
 * build exists to obtain. The X leg rests on a field nobody has confirmed is
 * populated, and the errors that report what the first real run discovered —
 * "X returned 40 video posts and not one carried a view count", "this billing
 * cycle has already been billed for 2,980,000 Post reads" — are composed,
 * deliberately, as sentences for an operator. Sending those to a log file means
 * the answer the client is paying to settle arrives only if somebody thinks to
 * grep for it.
 *
 * So an error class may mark itself `SAFE_TO_SHOW` (lib/shorts/run.ts), the run
 * puts that message on the outcome as `safeMessage`, and this page prints it.
 * THE DEFAULT DID NOT MOVE: `safeMessage` is null for everything that did not
 * declare itself, including every error out of a library, and those still get
 * the platform name and the log pointer and nothing else.
 *
 * ------------------------------------------------------------------------
 * WHY THE MEDIA LINK IS A BUTTON THAT RESOLVES, AND NOT AN href
 * ------------------------------------------------------------------------
 *
 * A direct media URL from any of these platforms is signed and expires in
 * minutes to hours. Rendering one at page load and letting it sit there while
 * somebody reads a long list produces a link that looks alive and is not. So
 * the row carries the canonical post URL, which does not expire, and the file
 * is resolved at the moment a person asks for it. The component says the link
 * is short-lived rather than leaving them to discover it.
 *
 * `PlatformAdapter.downloadUrl` may answer null, meaning "this adapter has no
 * way to get you the file". That is shown as a sentence, never as a dead button
 * that gives no reason.
 *
 * ------------------------------------------------------------------------
 * WHY THE ACTIONS ARRIVE AS PROPS
 * ------------------------------------------------------------------------
 *
 * `run` and `resolveDownload` are server actions handed down by page.tsx rather
 * than imported here. It keeps this file out of the "use server" module graph,
 * so a jsdom test can render the whole screen without cookies, Supabase or a
 * platform registry — and a screen that cannot be rendered in a test is how the
 * previous repo shipped its two most important buttons with no coverage at all.
 *
 * ------------------------------------------------------------------------
 * PRESENTATION — DESIGN.md, NOT INVENTED HERE
 * ------------------------------------------------------------------------
 *
 * Every class comes from app/globals.css, which gained exactly one rule for
 * this screen — `.filter-actions`, when the subject menu made the run row too
 * wide for one line; the measurement is in the sheet. Violet is
 * interface only, so the one violet thing on the page is the button that runs
 * the fetch. Figures are mono, tabular and never abbreviated. An unmeasured
 * figure is an em dash carrying a `title` that says which absence it is, never
 * a zero — "no views" and "the source did not report views" are different
 * facts, and the second is the common one.
 *
 * The one reuse worth naming: DESIGN.md's tier colours belonged to a curation
 * state that no longer exists. Green now means a platform was read, slate means
 * it could not be, and rose is kept for the case the sheet reserves it for —
 * something a person has to go and fix outside the app, which is what a failed
 * adapter and an unwritten run both are.
 */
export interface ShortsConsoleProps {
  /** The configured threshold, from lib/config.ts. The operator may move it. */
  readonly defaultMinViews: number;
  /**
   * Where the per-platform maximum starts, from ./view.ts. The operator may
   * move it, up to `MAX_ROWS_PER_PLATFORM`.
   */
  readonly defaultLimit: number;
  /**
   * Where the length floor starts, from ./view.ts. Zero, meaning no floor.
   *
   * A PROP RATHER THAN A LITERAL for the same reason the other two are: this
   * component is rendered by a test with numbers of its own, and a starting
   * value baked in here would be a second place the screen's defaults live.
   */
  readonly defaultMinDuration: number;
  /**
   * The Shorts ceiling, from lib/config.ts. TWO JOBS, AND THAT IS DELIBERATE.
   *
   * It is where the "longest" control starts AND the highest number that
   * control will accept, because those are the same number: a Short is anything
   * at or under it, so an operator may narrow the window and may not widen it.
   * Moving the ceiling itself is an environment variable — see ./view.ts on
   * `RunRequest.maxDurationSeconds`.
   */
  readonly maxDurationSeconds: number;
  /**
   * THE SUBJECTS THIS RUN MAY BE POINTED AT, from /admin/topics.
   *
   * Luka, 2026-09-05: *"we need the scraper to be able to search for those
   * specific clips, not any random shorts with 500k+ views."* The topic list
   * answered the first half of that in the run; this control answers the
   * second half on the screen — a run already searches for every active
   * subject, and an operator gathering clips for ONE channel wants one of them.
   *
   * NARROWING, NOT SWITCHING ON. Leaving it alone asks for every active
   * subject, which is the run this screen has made since topics shipped, so an
   * operator who never touches it sees no change.
   *
   * IT CARRIES THE SENTENCE FOR AN EMPTY LIST — see `TopicChoices`. An empty
   * menu has three meanings and only the console can be looking at it, so the
   * page says which one it is rather than leaving five words missing.
   */
  readonly topics: TopicChoices;
  /**
   * THE LAST RUN THIS DEPLOYMENT MADE, put back so a reload does not lose it.
   *
   * Erik, 2026-09-05: *"The run should not disappear after a while."* Nothing
   * was expiring it — the report lived in the state below and nowhere else, so
   * it went with the component on a refresh, a walk to another admin page and
   * back, or a restored tab, and the operator landed on "Nothing has been
   * fetched yet". That sentence means NO RUN HAS HAPPENED, and it was being
   * shown minutes after one had.
   *
   * IT SEEDS THE CONTROLS AS WELL AS THE LIST, and that pairing is the whole of
   * why it is one prop rather than two. The panel states the terms the list
   * below it was gathered on; a restored list under the deployment's default
   * threshold would be a caption for a run nobody made — the same failure the
   * estimate is cleared to avoid in `onRun`, one field over.
   *
   * IT IS SHARED, NOT PER-BROWSER (Erik, same day), so this can be a run
   * somebody else paid for. That is the point — a run costs API quota and, on X,
   * real money per Post — and it is also why the console may not render it as
   * though it just happened. `restoredAt` below is what enforces that.
   *
   * NULL MEANS NOTHING TO SHOW AND NOTHING ELSE. Nothing stored, no database, a
   * row that would not parse — page.tsx flattens all of them, because this
   * component does the same thing in every case and none of them is a statement
   * about any platform.
   */
  readonly restored?: StoredRun | null;
  /** Runs the fetch. A server action, handed down by page.tsx. */
  readonly run: (request: RunRequest) => Promise<RunOutcome>;
  /** Resolves one media URL on demand. A server action, handed down by page.tsx. */
  readonly resolveDownload: (short: ShortRecord) => Promise<DownloadOutcome>;
  /**
   * What one downloaded file costs, already worded by the server.
   *
   * COMPUTED THERE AND NOT HERE, because the rate is YTDLP_PROXY_USD_PER_GB and
   * this is a client component: reading it here would read `undefined` in the
   * browser and quietly render every download as free. A run's cost is server
   * knowledge and so is a file's.
   */
  readonly costPerDownload: string;
  /**
   * Prices a run without making it. OPTIONAL, and the option is the honest part.
   *
   * A deployment where nothing meters itself has nothing to forecast, and a
   * disabled "Estimate" button next to a run that costs nothing would invent a
   * worry. When it is absent the control is not rendered at all.
   */
  readonly estimate?: (request: RunRequest) => Promise<EstimateOutcome>;
}

/** Where one row's media control has got to. Keyed by (platform, video id). */
type DownloadState =
  | { readonly phase: "resolving" }
  | { readonly phase: "ready"; readonly url: string }
  | { readonly phase: "refused"; readonly message: string };

/**
 * One resolved media URL, checked, on its way into `downloads`.
 *
 * ------------------------------------------------------------------------
 * THE `safeHref` CHECK MOVED HERE, AND THE MOVE IS THE WHOLE POINT
 * ------------------------------------------------------------------------
 *
 * It used to live in `MediaCell`, on the line that writes the `href`, with a
 * comment saying that is where it belongs — "the check lives here rather than
 * only in the action because this is the line that puts a string into an
 * attribute". That was true while an anchor was the only way an adapter's
 * string could get out of this page.
 *
 * "Export all links" is a second way out, and it does not go through an anchor:
 * it goes into a text box, a clipboard and a `.txt` file, which is a string
 * somebody pipes to a downloader. A check on the anchor does nothing about
 * that, and a second copy of the check in the export would be two guards to
 * keep in step. So it happens ONCE, at the boundary where an adapter's answer
 * becomes state, and every consumer reads a value that has already passed.
 *
 * `resolveDownloadUrl` checks this on the server as well and that is not
 * duplication either — the server one keeps a bad URL out of the response, this
 * one keeps it out of the page, and neither is allowed to assume the other ran.
 * Found by tests/shorts-export.test.tsx, which put `javascript:alert(1)` in the
 * export box on the first run of it.
 */
function toDownloadState(outcome: DownloadOutcome): DownloadState {
  if (!outcome.ok) return { phase: "refused", message: outcome.message };
  const url = safeHref(outcome.url);
  if (url === null) {
    return {
      phase: "refused",
      message: "The adapter returned something that is not a web address.",
    };
  }
  return { phase: "ready", url };
}

/**
 * Where a press of "Export all links" has got to.
 *
 * `total` is what THAT press took on, not the size of the list: a row somebody
 * already opened by hand is not asked for a second time, and on a platform that
 * bills per lookup the difference is money. `done` counts rows that came back,
 * answered or refused — a refusal is a finished row, and a progress bar that
 * only advanced on success would stall on a list where half the adapters have
 * no file to give.
 */
type ExportState = {
  readonly phase: "running" | "stopped" | "done";
  readonly total: number;
  readonly done: number;
};

/**
 * How many media lookups the export has in the air at once.
 *
 * THREE, AND THE NUMBER IS A COMPROMISE WITH TWO REAL COSTS ON EITHER SIDE.
 * One at a time turns two hundred rows into a wait long enough that an operator
 * closes the tab, and every resolve already paid for is then thrown away. All
 * of them at once points two hundred simultaneous requests at somebody else's
 * service — for YouTube that is this deployment's own yt-dlp box, which answers
 * one subprocess per call, and for a metered platform it is two hundred
 * billable lookups fired before the first refusal can be read.
 *
 * `resolveDownloadUrl` is deliberately not behind the run's lock (see its
 * comment in ./actions.ts: an operator opening several rows in a row is a
 * handful of bounded lookups). A pool of three is that same handful, held to a
 * width somebody chose rather than one that happens to be the length of the
 * list.
 */
const EXPORT_CONCURRENCY = 3;

/**
 * The threshold, read off the input.
 *
 * Whole numbers of views, one or more. Zero is refused for the same reason
 * lib/config.ts refuses `MIN_VIEWS=0`: it is a request to turn off the one
 * thing this tool promises, and it is far likelier to be a slip than an
 * intention. Deleting the filter should look like a code change, not a typo.
 *
 * Separators and spaces are stripped before parsing, because the number on
 * screen is rendered with them — an operator who edits "500,000" to "600,000"
 * has typed the most natural thing in the world and should not be told off for
 * it.
 */
export function parseThreshold(
  raw: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const trimmed = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "A threshold is a whole number of views. Digits only." };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    return {
      ok: false,
      message:
        "A threshold of zero turns off the one thing this tool promises. Ask for at least one view.",
    };
  }
  return { ok: true, value };
}

/**
 * The per-platform maximum, read off its input.
 *
 * SAME SHAPE AS `parseThreshold` AND A DIFFERENT SENTENCE FOR EVERY REFUSAL,
 * because the two numbers sit next to each other and an operator who mistypes
 * one needs to be told which. It strips separators for the same reason that one
 * does: this figure is rendered plain, but a person who has just edited
 * "500,000" above will type "1,00" here often enough.
 *
 * THE CEILING IS CHECKED HERE AS WELL AS ON THE SERVER, and that is not
 * belt-and-braces — it is the difference between being told before the press
 * and being told after it. The server check is the one that binds; see
 * `MAX_ROWS_PER_PLATFORM` in ./view.ts for why it refuses rather than lowering.
 */
export function parseLimit(
  raw: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const trimmed = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "A maximum is a whole number of videos. Digits only." };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    return {
      ok: false,
      message: "Asking a platform for no videos is not a run. Ask for at least one.",
    };
  }
  if (value > MAX_ROWS_PER_PLATFORM) {
    return {
      ok: false,
      message:
        `One press asks a platform for at most ${formatFigure(MAX_ROWS_PER_PLATFORM)} videos. ` +
        "On a platform that bills per video returned, that ceiling is the difference between a " +
        "press and an invoice.",
    };
  }
  return { ok: true, value };
}

/**
 * A length in whole seconds, read off one of the two duration inputs.
 *
 * ONE PARSER FOR BOTH BOXES, and the differences between them are arguments
 * rather than a second copy. The two ends of a window are the same kind of
 * number and the day one of them starts accepting "1:30" they both must; two
 * near-identical parsers is how one of them would not.
 *
 * `floor` is the smallest acceptable value — zero for the minimum, because zero
 * IS the way to say "no minimum", and one for the maximum, because a window
 * ending at zero second contains nothing. `ceiling` is the deployment's Shorts
 * ceiling for both: a floor above it would be a window with nothing in it, and
 * a ceiling above it would be a request for videos that are not Shorts.
 */
export function parseSeconds(
  raw: string,
  bounds: { readonly floor: number; readonly ceiling: number; readonly label: string },
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const trimmed = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `A ${bounds.label} length is a whole number of seconds. Digits only.`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < bounds.floor) {
    return {
      ok: false,
      message:
        bounds.floor === 0
          ? "A minimum length cannot be negative. Zero is how you ask for no minimum."
          : "A maximum length of zero seconds would keep nothing. Ask for at least one second.",
    };
  }
  if (value > bounds.ceiling) {
    return {
      ok: false,
      message:
        `A Short is anything at or under ${bounds.ceiling} seconds, so a ${bounds.label} of ` +
        `${value} is outside what this tool looks for at all. That ceiling is what makes a video ` +
        "a Short, and it is configuration rather than a preference.",
    };
  }
  return { ok: true, value };
}

/**
 * Which control a refusal belongs to.
 *
 * The message goes next to the thing that caused it rather than into one
 * catch-all line under the bar. There are three controls now and two of them
 * take a number, so "A maximum is a whole number of videos" floating under both
 * of them would leave an operator checking the one they did not get wrong.
 */
type ControlError = {
  readonly field: "threshold" | "limit" | "minDuration" | "maxDuration" | "platforms";
  readonly message: string;
};

/**
 * THE "LOOK FOR" PICKER. A searchable dropdown, not a native <select>.
 *
 * A native menu of thirty-plus subjects is a scroll, not a search, so this is a
 * real combobox: a trigger that reads like the other controls, and a popover
 * carrying a search box over a filtered, scrollable list. The empty choice
 * ("Every active subject") is always first and always selectable — see the note
 * where this is used for why that is not "no subject".
 *
 * The value is the topic SLUG (or "" for every active subject); the words are
 * the topic name. The chosen option is always shown even while a search hides
 * the rest, so the trigger can never go blank.
 */
type TopicChoice = TopicRef & { readonly gone?: true };

function TopicCombobox({
  id,
  labelledBy,
  value,
  choices,
  onChange,
  describedBy,
}: {
  readonly id: string;
  readonly labelledBy: string;
  readonly value: string;
  readonly choices: readonly TopicChoice[];
  readonly onChange: (slug: string) => void;
  readonly describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const everySubject: TopicChoice = { slug: "", name: "Every active subject" };
  const all: readonly TopicChoice[] = [everySubject, ...choices];
  const q = query.trim().toLowerCase();
  const options = q === "" ? all : all.filter((o) => o.name.toLowerCase().includes(q));

  const current = all.find((o) => o.slug === value) ?? everySubject;
  const label = (o: TopicChoice) => (o.gone ? `${o.name} — no longer active` : o.name);

  // Close when a click lands outside the whole control.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // On open: clear the last search, highlight the top row, focus the box.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Never let the highlight point past the end of a shrinking list.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, options.length - 1)));
  }, [options.length]);

  function choose(slug: string) {
    onChange(slug);
    setOpen(false);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option.slug);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="combo" ref={rootRef}>
      <button
        type="button"
        id={id}
        className="combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelledBy} ${id}`}
        aria-describedby={describedBy}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="combo-value">{label(current)}</span>
        <span className="combo-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div className="combo-pop">
          <input
            ref={searchRef}
            type="search"
            className="combo-search"
            placeholder="Search subjects…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            aria-label="Search subjects"
            autoComplete="off"
          />
          <ul className="combo-list" role="listbox" aria-label="Subjects">
            {options.length === 0 ? (
              <li className="combo-empty">No subject matches “{query}”.</li>
            ) : (
              options.map((option, i) => (
                <li key={option.slug || "__every__"} role="option" aria-selected={option.slug === value}>
                  <button
                    type="button"
                    className={
                      "combo-option" +
                      (i === activeIndex ? " is-active" : "") +
                      (option.slug === value ? " is-selected" : "")
                    }
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => choose(option.slug)}
                  >
                    {label(option)}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ShortsConsole({
  defaultMinViews,
  defaultLimit,
  defaultMinDuration,
  maxDurationSeconds,
  topics,
  restored = null,
  run,
  resolveDownload,
  costPerDownload,
  estimate,
}: ShortsConsoleProps) {
  const thresholdId = useId();
  /**
   * A RESTORED RUN SETS THE CONTROLS, AND THE DEFAULTS ARE THE FALLBACK.
   *
   * Every `useState` below reads `restored?.report` first for one reason: the
   * panel is the caption for the list underneath it. A restored list of Shorts
   * gathered at 250,000 views, sitting under a box that says 500,000, is a
   * screen that answers a question nobody asked — the same failure `onRun`
   * clears the estimate to avoid, one field over and harder to notice, because
   * a stale threshold looks exactly like a fresh one.
   *
   * IT IS A SEED AND NOT A LOCK. These are ordinary controls the moment the page
   * is drawn; an operator who wants the deployment's defaults back types them,
   * and the run they then make is theirs. What is not allowed is the screen
   * quietly disagreeing with itself before anybody has touched it.
   *
   * `restored` IS READ ONLY AT MOUNT, which is what a `useState` initialiser
   * means and is correct here rather than a limitation: this prop changes on a
   * page load, and a page load is a mount. It is deliberately NOT synced in an
   * effect — an effect that wrote these would fight the operator's typing every
   * time the server re-rendered.
   */
  const [threshold, setThreshold] = useState(
    formatFigure(restored?.report.minViews ?? defaultMinViews),
  );
  const [limit, setLimit] = useState(String(restored?.report.limit ?? defaultLimit));
  /**
   * THE LENGTH WINDOW, AND IT STARTS AS THE WHOLE OF IT. Zero to the Shorts
   * ceiling excludes nothing, so an operator who never touches these two boxes
   * gets exactly the run this screen made before they existed.
   */
  const [minDuration, setMinDuration] = useState(
    String(restored?.report.minDurationSeconds ?? defaultMinDuration),
  );
  const [maxDuration, setMaxDuration] = useState(
    String(restored?.report.maxDurationSeconds ?? maxDurationSeconds),
  );
  /**
   * EVERY PLATFORM STARTS TICKED, and that is the same brief this screen was
   * built from — "you scrape ALL platforms". The checkboxes exist so an operator
   * can narrow a run, not so they have to assemble one before the button works.
   */
  const [selected, setSelected] = useState<readonly Platform[]>(
    // A RESTORED RUN'S TICKS ARE ITS OWN, derived from its outcomes rather than
    // stored beside them — see `askedPlatforms`. A run of two platforms restored
    // under five ticked boxes would report three of them as missing when what
    // happened is that nobody asked for them.
    restored === null ? PLATFORMS : askedPlatforms(restored.report),
  );
  /**
   * WHICH SUBJECT TO LOOK FOR. The empty string is "every active subject", and
   * it is the value an operator who never opens the menu keeps.
   *
   * A SLUG IN STATE RATHER THAN A `TopicRef`, because that is what the request
   * carries and what the server looks up — see `RunRequest.topicSlug`. Holding
   * the name here as well would be a second copy of a row that can be edited on
   * another page while this one is open.
   *
   * A RESTORED RUN SETS IT, from the subject the report says it was narrowed
   * to, for the reason every other control here is seeded: the panel is the
   * caption for the list underneath it, and a list of Shark Tank clips under a
   * menu reading "Every active subject" describes a run nobody made.
   */
  const [topicSlug, setTopicSlug] = useState(restored?.report.topic?.slug ?? "");
  const [inputError, setInputError] = useState<ControlError | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(
    restored === null ? null : { ok: true, report: restored.report },
  );
  /**
   * WHEN THE LIST ON SCREEN WAS FETCHED, or null once it is this session's.
   *
   * THE ONE THING THAT KEEPS A RESTORED RUN HONEST. Everything above puts the
   * old screen back exactly as it was, which is the feature and is also the
   * hazard: an operator who reloads and sees a full page of Shorts has no way to
   * tell it from a page they just fetched, and on a shared store it may be a run
   * somebody else made days ago. So while this is set, the report is captioned
   * with its age and its timestamp, in the same live region as the list.
   *
   * IT IS CLEARED BY `onRun` AND NEVER SET AGAIN. A press produces a report from
   * this session, and a "this is from earlier" banner over a run made four
   * seconds ago is the same sentence being wrong in the other direction.
   */
  const [restoredAt, setRestoredAt] = useState<string | null>(restored?.savedAt ?? null);
  const [forecast, setForecast] = useState<EstimateOutcome | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [downloads, setDownloads] = useState<Readonly<Record<string, DownloadState>>>({});
  const [exportRun, setExportRun] = useState<ExportState | null>(null);
  /**
   * The stop flag, in a ref rather than in state ON PURPOSE. The workers below
   * read it inside a loop that outlives the render that started them, and a
   * state value read there is the value it had when the closure was made —
   * which is `false`, for ever, which is a Stop button that does nothing.
   */
  const cancelExport = useRef(false);
  /**
   * Which run's list the resolved URLs belong to.
   *
   * Bumped by every press of "Get latest shorts". An export worker captures it
   * and refuses to write once it has moved, which is the difference between the
   * two ways an export ends: STOP keeps the answers already in the air, because
   * those rows were paid for and are still on screen; A NEW RUN discards them,
   * because `onRun` has just emptied `downloads` and the row that lookup
   * belonged to may not even be on the new list.
   */
  const runToken = useRef(0);
  const [pending, startTransition] = useTransition();

  /**
   * The three controls as one request, or the first thing wrong with them.
   *
   * ONE FUNCTION FOR BOTH BUTTONS. The estimate and the run have to be asked
   * the same question — a quote for five platforms beside a run of two is a
   * number about a press nobody made — and the way that drifts is two readers
   * of the same three pieces of state.
   */
  function readControls(): { readonly ok: true; readonly request: RunRequest } | { readonly ok: false } {
    const parsedThreshold = parseThreshold(threshold);
    if (!parsedThreshold.ok) {
      setInputError({ field: "threshold", message: parsedThreshold.message });
      return { ok: false };
    }
    const parsedLimit = parseLimit(limit);
    if (!parsedLimit.ok) {
      setInputError({ field: "limit", message: parsedLimit.message });
      return { ok: false };
    }
    // THE CEILING IS PARSED BEFORE THE FLOOR, so that "90 to 30" is reported
    // against the box the operator is most likely to have meant to change,
    // and so the cross-check below has two real numbers to compare.
    const parsedMax = parseSeconds(maxDuration, {
      floor: 1,
      ceiling: maxDurationSeconds,
      label: "maximum",
    });
    if (!parsedMax.ok) {
      setInputError({ field: "maxDuration", message: parsedMax.message });
      return { ok: false };
    }
    const parsedMin = parseSeconds(minDuration, {
      floor: 0,
      ceiling: maxDurationSeconds,
      label: "minimum",
    });
    if (!parsedMin.ok) {
      setInputError({ field: "minDuration", message: parsedMin.message });
      return { ok: false };
    }
    if (parsedMin.value > parsedMax.value) {
      // REFUSED, NOT SWAPPED — the same call ./actions.ts makes on the server.
      // Nothing here knows which of the two numbers was the typo, and running
      // the window it guessed would put a list on the screen that answers a
      // question nobody asked.
      setInputError({
        field: "minDuration",
        message:
          `A minimum of ${parsedMin.value}s and a maximum of ${parsedMax.value}s is a window with ` +
          "nothing in it. Nothing could clear both, so nothing was read.",
      });
      return { ok: false };
    }
    if (selected.length === 0) {
      setInputError({
        field: "platforms",
        message:
          "Nothing is selected, so there is nothing to read. Tick at least one platform — an " +
          "empty selection is not read as all of them.",
      });
      return { ok: false };
    }
    setInputError(null);
    return {
      ok: true,
      // Put back into the vocabulary's order rather than click order, so two
      // identical selections make two identical requests.
      request: {
        minViews: parsedThreshold.value,
        limit: parsedLimit.value,
        minDurationSeconds: parsedMin.value,
        maxDurationSeconds: parsedMax.value,
        platforms: PLATFORMS.filter((platform) => selected.includes(platform)),
        // The empty option is the ABSENCE of a narrowing, so it travels as null
        // rather than as "". An empty string would reach the server as a slug
        // that matches no topic, and the refusal it earned there would be a
        // sentence about a deleted subject shown to somebody who chose none.
        topicSlug: topicSlug === "" ? null : topicSlug,
      },
    };
  }

  /**
   * THE MENU, WITH THE RESTORED RUN'S SUBJECT IN IT EVEN WHEN IT IS GONE.
   *
   * A `<select>` whose value is not among its options renders as nothing
   * selected, which on this screen would be a blank box over a list that was
   * gathered for a subject — the control disagreeing with the caption beside
   * it. So a restored subject that is no longer active is kept in the list and
   * SAID TO BE GONE. Choosing it is refused by the server with the same fact in
   * a longer sentence; what is not allowed is the screen going quiet about it.
   */
  const restoredTopic = restored?.report.topic ?? null;
  const choices: readonly (TopicRef & { readonly gone?: true })[] =
    restoredTopic && !topics.list.some((entry) => entry.slug === restoredTopic.slug)
      ? [...topics.list, { ...restoredTopic, gone: true }]
      : topics.list;

  function togglePlatform(platform: Platform) {
    setSelected((current) =>
      current.includes(platform)
        ? current.filter((entry) => entry !== platform)
        : [...current, platform],
    );
    // A SELECTION CHANGE INVALIDATES THE PRICE, not the list. The estimate was
    // a quote for a set of platforms and this is a different set; leaving the
    // old figure beside the new tick boxes is the one way this panel could
    // mislead about money. The last run's results stay, because they are still
    // a true report of a run that really happened — the report says which
    // platforms it asked.
    setForecast(null);
  }

  /**
   * A SUBJECT CHANGE INVALIDATES THE PRICE, for the same reason a platform
   * change does and rather more sharply.
   *
   * The forecast prices ONE read per platform. A run makes one read PER TOPIC —
   * see `runTopics` in lib/shorts/run.ts — so an unnarrowed quote is a floor
   * over however many subjects are switched on, and a quote made while one
   * subject was chosen is a price for a press that is no longer the one this
   * panel describes. Neither figure is wrong about the press it was made for,
   * and leaving either one beside a changed menu is the one way this panel
   * could mislead about money.
   */
  function onChooseTopic(slug: string) {
    setTopicSlug(slug);
    setForecast(null);
  }

  function onRun() {
    const parsed = readControls();
    if (!parsed.ok) return;
    startTransition(async () => {
      // Every previous run's resolved media URLs go with the run that produced
      // them. They are short-lived and they belong to rows that may not even be
      // in the new list; carrying them over would leave a live-looking link
      // attached to a row nobody just fetched.
      setDownloads({});
      // Any export still walking the OLD list stops here, and its panel goes
      // with the links it was building. Left running, its workers would keep
      // writing resolved URLs into a `downloads` map the new run has just
      // emptied — live-looking links on rows from a list nobody is looking at.
      cancelExport.current = true;
      runToken.current += 1;
      setExportRun(null);
      // AND SO DOES THE ESTIMATE. It was a forecast for a threshold and a scan
      // depth, and the run that follows reports what actually happened. Leaving
      // a stale prediction on screen beside a real invoice is the one way this
      // panel could mislead about money.
      setForecast(null);
      // THE RESTORED CAPTION GOES BEFORE THE RUN RETURNS, not after. From this
      // line on, whatever is on screen is this session's press — and a banner
      // saying the list was fetched "3 hours ago" sitting over a run that is
      // being made right now is the same lie as the one it exists to prevent,
      // pointing the other way.
      setRestoredAt(null);
      setOutcome(await run(parsed.request));
    });
  }

  function onEstimate() {
    if (!estimate) return;
    const parsed = readControls();
    if (!parsed.ok) return;
    setEstimating(true);
    void estimate(parsed.request).then((result) => {
      setForecast(result);
      setEstimating(false);
    });
  }

  function onResolve(short: ShortRecord) {
    const key = shortKey(short);
    setDownloads((current) => ({ ...current, [key]: { phase: "resolving" } }));
    void resolveDownload(short).then((result) => {
      setDownloads((current) => ({ ...current, [key]: toDownloadState(result) }));
    });
  }

  /**
   * Resolve every row on the list, so the whole thing can leave as one file.
   *
   * ------------------------------------------------------------------------
   * IT IS THE SAME ACTION THE ROW BUTTON CALLS, N TIMES. NOT A BULK ENDPOINT.
   * ------------------------------------------------------------------------
   *
   * The tempting version is one server action that takes the report and hands
   * back every link, and it is the wrong one twice over. A "use server" export
   * is a public endpoint whether or not the page that mentions it rendered, and
   * that one would take an arbitrary list and spend once per element — on X
   * that is $0.005 a row with a caller-chosen length. And it would answer only
   * at the end, so a two-hundred-row export would be a spinner with nothing
   * behind it and no way to stop it having decided it was too slow.
   *
   * Doing it here means every lookup goes through the gate and the validation
   * `resolveDownloadUrl` already does, the rows fill in as they land, and Stop
   * genuinely stops — the presses that were already paid for are kept.
   *
   * ------------------------------------------------------------------------
   * A ROW THAT HAS ALREADY BEEN ASKED IS NOT ASKED AGAIN
   * ------------------------------------------------------------------------
   *
   * Anything already in `downloads` is skipped, INCLUDING A REFUSAL. An adapter
   * that has just said it cannot get this file will say it again, and on a
   * metered platform the second ask is charged like the first. So the export's
   * total is the rows it actually took on, and pressing it twice after a
   * finished export costs nothing rather than costing the whole list again.
   */
  function onExportAll(shorts: readonly ShortRecord[]) {
    const queue = shorts.filter((short) => downloads[shortKey(short)] === undefined);

    if (queue.length === 0) {
      // Everything on the list has already been asked. The panel below is
      // already showing the answer, so this press resolves nothing and charges
      // nothing rather than doing the list again.
      setExportRun({ phase: "done", total: 0, done: 0 });
      return;
    }

    cancelExport.current = false;
    const token = runToken.current;
    setExportRun({ phase: "running", total: queue.length, done: 0 });

    let next = 0;
    let finished = 0;

    async function worker(): Promise<void> {
      for (;;) {
        // Stop, or a new run that has replaced the list underneath us. Either
        // way this worker takes nothing further off the queue.
        if (cancelExport.current || runToken.current !== token) return;

        const index = next++;
        const short = queue[index];
        if (short === undefined) return;

        const key = shortKey(short);
        setDownloads((current) => ({ ...current, [key]: { phase: "resolving" } }));

        // A THROW IS A REFUSAL FOR THIS ROW, NOT THE END OF THE EXPORT. The
        // action catches its own adapter failures, so reaching here means the
        // round trip itself did not come back — and one dropped request must
        // not take the other hundred and ninety-nine with it.
        const result = await resolveDownload(short).catch(
          (): DownloadOutcome => ({
            ok: false,
            message:
              "The request for this file did not come back. Nothing is known about it either way — " +
              "the row's own button will ask again.",
          }),
        );

        // The answer landed into a list that is no longer on screen. It is
        // dropped rather than written: `onRun` emptied this map on purpose, and
        // putting a link back into it would attach a live-looking file to a row
        // from the previous run. A press of Stop does NOT come through here —
        // that row is still on screen and was still paid for.
        if (runToken.current !== token) return;

        setDownloads((current) => ({ ...current, [key]: toDownloadState(result) }));

        // Counted whatever the phase is, so a stopped export's figure keeps
        // climbing as the lookups already in the air come home. "Stopped at 41
        // of 148" has to mean forty-one rows really came back.
        finished += 1;
        setExportRun((current) => (current === null ? current : { ...current, done: finished }));
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(EXPORT_CONCURRENCY, queue.length) }, () => worker()),
    ).then(() => {
      if (runToken.current !== token) return;
      setExportRun((current) =>
        current === null || current.phase !== "running" ? current : { ...current, phase: "done" },
      );
    });
  }

  function onStopExport() {
    cancelExport.current = true;
    // The workers already in flight still land — their rows were paid for and
    // throwing the answers away would be the one genuinely wasteful thing this
    // button could do. What stops is taking anything new off the queue.
    setExportRun((current) =>
      current === null || current.phase !== "running" ? current : { ...current, phase: "stopped" },
    );
  }

  return (
    <>
      <section className="panel" aria-labelledby={`${thresholdId}-controls`}>
        <p className="panel-title" id={`${thresholdId}-controls`}>
          The run
        </p>

        <div className="filter-bar">
          {/* FIRST IN THE BAR, because it is the only control that says what
              the run is ABOUT. The four beside it are sizes — how many views,
              how many seconds, how many rows — and a screen that opens with
              them and buries the subject reads as the untargeted tool this one
              stopped being on 2026-09-05. */}
          <div className="field">
            <span id={`${thresholdId}-topic-label`}>Look for</span>
            {/* THE EMPTY CHOICE ("Every active subject") IS NOT "no subject" — a
                run has searched by subject since topics shipped, and it is every
                one that is switched on. `TopicCombobox` keeps it first and always
                selectable. Naming it "All" would read as "do not filter", which
                is a different and much more expensive run. */}
            <TopicCombobox
              id={`${thresholdId}-topic`}
              labelledBy={`${thresholdId}-topic-label`}
              value={topicSlug}
              choices={choices}
              onChange={onChooseTopic}
              describedBy={inputError === null ? `${thresholdId}-hint` : `${thresholdId}-error`}
            />
          </div>

          <label className="field" htmlFor={thresholdId}>
            <span>View threshold</span>
            <input
              id={thresholdId}
              className="input input-mono"
              inputMode="numeric"
              autoComplete="off"
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              aria-describedby={inputError === null ? `${thresholdId}-hint` : `${thresholdId}-error`}
              aria-invalid={inputError?.field === "threshold"}
            />
          </label>

          <label className="field" htmlFor={`${thresholdId}-limit`}>
            <span>Most videos per platform</span>
            <input
              id={`${thresholdId}-limit`}
              className="input input-mono input-narrow"
              inputMode="numeric"
              autoComplete="off"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              aria-describedby={inputError === null ? `${thresholdId}-hint` : `${thresholdId}-error`}
              aria-invalid={inputError?.field === "limit"}
            />
          </label>

          {/* THE LENGTH WINDOW, AND IT IS TWO BOXES RATHER THAN ONE RANGE
              CONTROL. A slider would be smaller and would make the exact
              number the hard thing to set, which is the wrong way round for a
              figure an operator states in seconds and then wants to state
              again next week. Narrow boxes, because the widest value either
              one can hold is three digits. */}
          <label className="field" htmlFor={`${thresholdId}-min-duration`}>
            <span>Minimum length</span>
            <input
              id={`${thresholdId}-min-duration`}
              className="input input-mono input-narrow"
              inputMode="numeric"
              autoComplete="off"
              value={minDuration}
              onChange={(event) => setMinDuration(event.target.value)}
              aria-describedby={
                inputError === null ? `${thresholdId}-hint` : `${thresholdId}-error`
              }
              aria-invalid={inputError?.field === "minDuration"}
            />
          </label>

          <label className="field" htmlFor={`${thresholdId}-max-duration`}>
            <span>Maximum length</span>
            <input
              id={`${thresholdId}-max-duration`}
              className="input input-mono input-narrow"
              inputMode="numeric"
              autoComplete="off"
              value={maxDuration}
              onChange={(event) => setMaxDuration(event.target.value)}
              aria-describedby={
                inputError === null ? `${thresholdId}-hint` : `${thresholdId}-error`
              }
              aria-invalid={inputError?.field === "maxDuration"}
            />
          </label>

          {/* THE TWO VERBS ARE ONE GROUP so they wrap together. With the
              subject menu in the row the controls no longer fit on one line at
              this page's width, and loose flex children put "What will this
              cost?" alone under the menu — an orphan beside the wrong control.
              app/globals.css carries the measurement. */}
          <div className="filter-actions">
            <button type="button" className="btn" onClick={onRun} disabled={pending}>
              {pending ? "Reading platforms…" : "Get latest shorts"}
            </button>

            {estimate ? (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={onEstimate}
                disabled={estimating || pending}
              >
                {estimating ? "Pricing the run…" : "What will this cost?"}
              </button>
            ) : null}
          </div>
        </div>

        {/* A `fieldset` rather than a row of loose checkboxes, so the group has
            a name a screen reader reads before the five boxes. Its own line
            under the bar rather than inside it: five controls wrapped into a
            flex row next to two inputs and two buttons reflow into an order
            nobody chose. */}
        {/* No `mt-*` here: `.checks` owns its own top margin, because the rule
            has to clear a fieldset's browser default and doing that with
            `margin: 0` cancels any utility class of the same specificity. */}
        <fieldset className="checks">
          <legend className="field-label">Platforms to read</legend>
          {PLATFORMS.map((platform) => (
            <label
              // `check-on` FROM REACT AND NOT FROM `:has(input:checked)` IN THE
              // SHEET. Chrome does not repaint a `:has()` rule when React sets
              // the `checked` property, so the sheet version left an unticked
              // platform's chip lit — a control saying it is in a run it is not
              // in. app/globals.css carries the scar in full.
              className={selected.includes(platform) ? "check check-on" : "check"}
              key={platform}
              htmlFor={`${thresholdId}-${platform}`}
            >
              <input
                id={`${thresholdId}-${platform}`}
                type="checkbox"
                checked={selected.includes(platform)}
                onChange={() => togglePlatform(platform)}
              />
              <span>{platformLabel(platform)}</span>
            </label>
          ))}
        </fieldset>

        {inputError === null ? (
          <details className="controls-help mt-3">
            <summary>What do these controls mean?</summary>
            <p className="hint" id={`${thresholdId}-hint`}>
            <strong>Look for</strong> narrows the run to one of the subjects on{" "}
            <strong>What to look for</strong>; the words behind that subject are what get sent to
            each platform. Left alone it searches for every subject that is switched on, which is
            what this button has always done — so it is a way of gathering clips for one channel,
            not a way of turning the subjects off.{" "}
            {topics.note === null ? null : <>{topics.note}{" "}</>}
            Shorts at or over the threshold are kept and the rest are dropped. It starts at{" "}
            <span className="mono">{formatFigure(defaultMinViews)}</span>, which is the
            client&rsquo;s own figure, and it applies to every selected platform — nobody has given
            a per-platform number and this tool will not invent five.{" "}
            <strong>Minimum</strong> and <strong>maximum length</strong> are in whole seconds and
            they bound how long a kept video may be. A minimum of{" "}
            <span className="mono">0</span> keeps everything, and both ends are inclusive, so 30 to
            60 keeps a short of exactly 30 seconds and one of exactly 60. The maximum stops at{" "}
            <span className="mono">{maxDurationSeconds}s</span> because that ceiling is what makes a
            video a Short at all — this tool will not go looking for something longer, and moving
            that line is configuration rather than a box on this screen.{" "}
            <strong>Most videos per platform</strong> is how many each ticked platform is asked
            for, so it is the most any one of them can show — fewer will appear when fewer clear
            the threshold. It is also what a run costs on a platform that bills per video returned,
            which is why it stops at{" "}
            <span className="mono">{formatFigure(MAX_ROWS_PER_PLATFORM)}</span>. An unticked
            platform is not asked and not charged, and it is reported as not asked rather than as
            empty.
            </p>
          </details>
        ) : (
          <p className="field-error mt-3" id={`${thresholdId}-error`} role="alert">
            {inputError.message}
          </p>
        )}

        {forecast === null ? null : <ForecastPanel outcome={forecast} />}
      </section>

      {/* The whole result is one live region, so a screen reader is told when a
          run finishes rather than being left on a button that stopped saying
          "Reading platforms". */}
      <div aria-live="polite" aria-busy={pending}>
        {pending ? (
          <section className="run-loading mt-6" role="status">
            <span className="run-spinner" aria-hidden="true" />
            <p className="run-loading-title">Reading platforms…</p>
            <p className="run-loading-sub">This usually takes 15–60 seconds.</p>
          </section>
        ) : outcome === null ? (
          <p className="note mt-6">
            Nothing has been fetched yet, and no earlier run could be put back. Press{" "}
            <strong>Get latest shorts</strong> to read every platform this deployment can reach.
            This is not the same as a run that found nothing — once a run has happened, every
            platform gets a section saying what it found or why it could not be read.
          </p>
        ) : outcome.ok ? (
          <>
            {restoredAt === null ? null : <RestoredNotice savedAt={restoredAt} />}
            <RunReport
              report={outcome.report}
              downloads={downloads}
              onResolve={onResolve}
              costPerDownload={costPerDownload}
              exportRun={exportRun}
              onExportAll={onExportAll}
              onStopExport={onStopExport}
            />
          </>
        ) : (
          <section className="notice mt-6" role="alert">
            <strong>The run did not happen</strong>
            <p>{outcome.message}</p>
            <p className="mt-2">
              No platform was read, so there is nothing below and nothing below is out of date.
              This is not a report that the platforms are empty.
            </p>
          </section>
        )}
      </div>
    </>
  );
}

/**
 * THE CAPTION THAT STOPS A RESTORED RUN LOOKING LIKE A FRESH ONE.
 *
 * The list below this is real and every figure in it is true — it is a report of
 * a run that genuinely happened. What it is not is a report of a run that
 * happened NOW, and on a shared store it may not even be a run this operator
 * made. Those are the two things a page of Shorts cannot say for itself, so this
 * says them, above the report and inside the same live region, where somebody
 * reading downwards meets it before the numbers.
 *
 * IT IS `note` AND NOT `notice`. Nothing has gone wrong. A restored run is the
 * feature working — the alternative was making somebody spend API quota again to
 * see what they already had — and dressing it as an alert would teach an
 * operator to dismiss the one banner on this screen that qualifies its numbers.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AGE ARRIVES AFTER THE FIRST PAINT AND THE TIMESTAMP DOES NOT
 * ---------------------------------------------------------------------------
 *
 * "3 hours ago" is a function of the clock, and this component is rendered on
 * the server before it is hydrated in a browser. Computing it in both places
 * computes it at two different instants, which is a hydration mismatch: React
 * logs an error, re-renders, and the visible form is a time that changes as the
 * page loads — next to a list somebody is deciding something about. So the
 * relative phrase is state written by an effect, which runs only in the browser,
 * and the first paint carries the absolute timestamp alone.
 *
 * THE TIMESTAMP IS THEREFORE THE LOAD-BEARING HALF, not the decoration, which is
 * why it is `formatSavedAt` — pinned to UTC so the two renders agree, and
 * labelled, so a foreign clock is never mistaken for the reader's own. The age
 * is the courtesy: it is what makes "days" jump out where a date does not.
 *
 * IT IS COMPUTED ONCE AND NOT ON A TIMER. A tab left open all afternoon will go
 * on saying "3 hours ago" — which is why the sentence is anchored to the load
 * ("when this page loaded") rather than left to imply it is live, and why the
 * timestamp beside it never moves.
 */
function RestoredNotice({ savedAt }: { readonly savedAt: string }) {
  const [age, setAge] = useState<string | null>(null);

  useEffect(() => {
    setAge(describeAge(savedAt, new Date()));
  }, [savedAt]);

  return (
    <p className="note mt-6">
      Showing your last run, fetched <span className="mono">{formatSavedAt(savedAt)}</span>
      {age === null ? "" : ` (${age})`}. Nothing has been read since, so these are that run&rsquo;s
      figures, not the platforms right now. Press <strong>Get latest shorts</strong> to run it
      again.
    </p>
  );
}

/**
 * What a run WOULD cost, before anybody presses the expensive button.
 *
 * "Money is the one number an operator must never be surprised by." So this is
 * a list of all five platforms and not a single total: a total would hide that
 * the sum only covers the platforms that quoted a price, and the ones that did
 * not are exactly the ones somebody should think about before pressing.
 *
 * A PLATFORM THAT DOES NOT REPORT A PRICE IS NEVER PRINTED AS FREE. It gets an
 * em dash carrying the sentence saying nothing has priced it — the same rule
 * every other unmeasured figure on this page follows, applied to money, where
 * it matters most.
 */
function ForecastPanel({ outcome }: { readonly outcome: EstimateOutcome }) {
  if (!outcome.ok) {
    return (
      <div className="notice mt-4" role="alert">
        <strong>The estimate could not be made</strong>
        <p>{outcome.message}</p>
        <p className="mt-2">
          Nothing was priced and nothing was spent. This is not a report that a run would be free.
        </p>
      </div>
    );
  }

  const { forecast } = outcome;
  // SCAR, found by running the CLI: with every platform unconfigured, `unpriced`
  // is zero and the sum is zero, and the "every platform that will run has
  // quoted a figure" line rendered as "$0.00" — a price for a run that would
  // read nothing at all. Vacuously true and read by a person as "free".
  const nothingRuns = forecast.platforms.every((entry) => entry.kind === "not-running");

  return (
    <div className="note mt-4">
      <p>
        <strong>Estimated cost of one run</strong> at{" "}
        <span className="mono">{formatFigure(forecast.minViews)}</span> views and{" "}
        <span className="mono">{formatFigure(forecast.limit)}</span> rows per platform. Nothing has
        been read or charged yet.
      </p>

      <dl className="kv mt-3">
        {forecast.platforms.map((entry) => (
          <ForecastRow key={entry.platform} entry={entry} />
        ))}
      </dl>

      <p className="mt-3">
        {nothingRuns ? (
          <>
            <strong>Nothing would run</strong>, so there is nothing to price — not a figure of
            zero. Each platform above says what it is waiting for.
          </>
        ) : forecast.unpriced === 0 ? (
          <>
            Every platform that will run has quoted a figure, and they come to{" "}
            <span className="mono">{formatUsd(forecast.knownUsdMicros)}</span>.
          </>
        ) : (
          <>
            <span className="mono">{formatUsd(forecast.knownUsdMicros)}</span> is a{" "}
            <strong>floor, not a total</strong>:{" "}
            <span className="mono">{forecast.unpriced}</span>{" "}
            {forecast.unpriced === 1 ? "platform will run and could not say what it" : "platforms will run and could not say what they"}{" "}
            would cost.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * HOW MUCH OF A REASON GOES ON THE LINE.
 *
 * SCAR, 2026-09-05: every row printed its whole `note`, and the adapters write
 * paragraphs — Facebook's runs eleven lines about Page tasks and the Meta
 * Content Library. Five of those stacked is an essay where somebody asked for
 * a price. The lead sentence is what they read; the rest stays ON THE PAGE,
 * one click away, still not a tooltip.
 */
const REASON_LEAD_MAX = 96;

export function splitReason(note: string): {
  readonly lead: string;
  readonly rest: string | null;
} {
  const trimmed = note.trim();

  // A whole sentence if one fits. Then the rest is genuinely the remainder,
  // and expanding does not re-read words already on screen.
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(trimmed)?.[1];
  if (sentence !== undefined && sentence.length <= REASON_LEAD_MAX) {
    const rest = trimmed.slice(sentence.length).trim();
    return { lead: sentence, rest: rest.length > 0 ? rest : null };
  }
  if (trimmed.length <= REASON_LEAD_MAX) return { lead: trimmed, rest: null };

  // No sentence fits, so the lead is a fragment and `rest` carries the FULL
  // note — a remainder starting mid-clause reads as a rendering fault.
  const clause = /^(.{24,96}?)[,:;—]\s/.exec(trimmed)?.[1];
  if (clause !== undefined) return { lead: `${clause}…`, rest: trimmed };
  const cut = trimmed.slice(0, REASON_LEAD_MAX);
  const space = cut.lastIndexOf(" ");
  return { lead: `${cut.slice(0, space > 40 ? space : REASON_LEAD_MAX)}…`, rest: trimmed };
}

/**
 * THE REASON IS ON THE PAGE, NOT IN A TOOLTIP.
 *
 * SCAR, 2026-09-05: this row carried its `note` in a `title` attribute while
 * the paragraph below promised that "each platform above says what it is
 * waiting for". It did not — on a touch screen there is no hover at all, and
 * the one sentence that turns a dead run into a five-minute fix was the one
 * thing a person could not read. A `<details>` keeps that promise without
 * spending the whole panel on it: the lead is always visible, and the summary
 * is the disclosure, so the long half is never more than a click away.
 */
function ForecastReason({ note }: { readonly note: string }) {
  const { lead, rest } = splitReason(note);
  if (rest === null) return <p className="forecast-why">{lead}</p>;
  return (
    <details className="forecast-why">
      <summary>
        {lead} <span className="forecast-more">Why</span>
      </summary>
      <p>{rest}</p>
    </details>
  );
}

/** One platform's line in the estimate. Three kinds, three different things said. */
function ForecastRow({ entry }: { readonly entry: PlatformForecast }) {
  const priced = entry.kind === "priced" && entry.usdMicros !== null;
  return (
    <>
      <dt>{platformLabel(entry.platform)}</dt>
      <dd>
        {priced ? (
          formatUsd(entry.usdMicros ?? 0)
        ) : (
          <>
            <span className="unknown">&#8212;</span>{" "}
            <span className="faint" style={{ fontFamily: "var(--font-body)" }}>
              {entry.kind === "unpriced" ? "will run, no price quoted" : "will not run"}
            </span>
          </>
        )}
        <ForecastReason note={entry.note} />
      </dd>
    </>
  );
}

/** The figures, the persistence answer, then one section per platform. */
function RunReport({
  report,
  downloads,
  onResolve,
  costPerDownload,
  exportRun,
  onExportAll,
  onStopExport,
}: {
  readonly report: LatestShortsReport;
  readonly downloads: Readonly<Record<string, DownloadState>>;
  readonly onResolve: (short: ShortRecord) => void;
  readonly costPerDownload: string;
  readonly exportRun: ExportState | null;
  readonly onExportAll: (shorts: readonly ShortRecord[]) => void;
  readonly onStopExport: () => void;
}) {
  const unread = unreadCount(report);
  const asked = askedCount(report);
  const notAsked = notAskedCount(report);
  const capped = stoppedEarlyCount(report);
  const unjudged = unverifiedTotal(report);
  const spent = spentUsdMicros(report);
  // DERIVED, NOT WRITTEN DOWN. See the scar in this file's header: the sentence
  // that used to sit here counted adapters by hand and was wrong by one.
  const metering = meteringSummary(report);

  // ALREADY IN THE LIBRARY. The run marks which kept shorts were in the library
  // before it ran (see `carriedOverKeys`), and this page hides them by default
  // so a repeated read of one topic surfaces only what is new. It is a display
  // choice, never a change to the figures above or to what Export All exports —
  // hiding is offered with the count and a way to show them, because a section
  // that quietly dropped rows would be this tool's one forbidden move.
  const hiddenKeys = useMemo(() => new Set(report.carriedOverKeys ?? []), [report.carriedOverKeys]);
  const carriedCount = useMemo(
    () => report.shorts.reduce((n, short) => (hiddenKeys.has(shortKey(short)) ? n + 1 : n), 0),
    [report.shorts, hiddenKeys],
  );
  const [showCarried, setShowCarried] = useState(false);

  return (
    <>
      <div className="figures mt-6">
        <div className="figure">
          {/* Green is the win colour, so it is withheld from a zero. A green 0
              at the top of the page reads as a result rather than as the
              absence of one. */}
          <span className={report.shorts.length > 0 ? "v tier-high" : "v"}>
            {formatFigure(report.shorts.length)}
          </span>
          <span className="k">Over the threshold</span>
        </div>
        <div className="figure">
          {/* Amber, not green and not red. These rows are neither a win nor a
              breakage — they are the measurement the source would not give us,
              and an operator seeing this climb is looking at a product hole. */}
          <span className={unjudged > 0 ? "v tier-mid" : "v"}>{formatFigure(unjudged)}</span>
          <span className="k">Could not be judged</span>
        </div>
        <div className="figure">
          <span className="v">{formatFigure(belowThresholdTotal(report))}</span>
          <span className="k">Dropped beneath it</span>
        </div>
        <div className="figure">
          {/* THE DENOMINATOR IS WHAT WAS ASKED FOR, not all five. An operator
              who ticked two platforms and got both must not read "2/5" and
              conclude three went missing. How many were left out is the figure
              beside this one, and it is only there when it is not zero. */}
          <span className="v">
            {readCount(report)}
            <span className="faint">/{asked}</span>
          </span>
          <span className="k">Platforms read</span>
        </div>
        <div className="figure">
          <span className={unread > 0 ? "v attention" : "v"}>{unread}</span>
          <span className="k">Not read</span>
        </div>
        {notAsked > 0 ? (
          <div className="figure">
            {/* Slate, never amber and never rose. DESIGN.md keeps those for a
                platform that answered with nothing and a platform somebody has
                to go and fix; an unticked box is neither, and colouring it like
                a problem would make the operator's own choice look like one. */}
            <span className="v faint">{notAsked}</span>
            <span className="k">Not asked</span>
          </div>
        ) : null}
        <div className="figure">
          {spent.platforms === 0 ? (
            <span
              className="v unknown"
              title={
                metering.ran.length === 0
                  ? "No platform was read, so nothing was charged and nothing was quoted. This is the absence of a run, not a price of zero."
                  : `No platform in this run reported what it cost. That is not the same as the run being free — ${metering.unmetered.length} of the ${metering.ran.length} platforms that were read have no price to quote, and nothing here has measured one.`
              }
            >
              &#8212;
            </span>
          ) : (
            <span className="v">{formatUsd(spent.total)}</span>
          )}
          <span className="k">Spent</span>
        </div>
      </div>

      {capped > 0 ? (
        <section className="notice mt-4" role="alert">
          <strong>
            {capped === 1 ? "One platform" : `${formatFigure(capped)} platforms`} stopped before the
            end
          </strong>
          <p>
            A spend cap or a rate limit ended the read. Everything listed below was really found;
            what is <em>not</em> listed was never looked at, so this list is not the whole of what
            is over <span className="mono">{formatFigure(report.minViews)}</span> views. The
            platform&rsquo;s own section says which limit it hit.
          </p>
        </section>
      ) : null}

      {/* A COMPACT FACT LINE, NOT A PARAGRAPH. Each fact is its own chip so the
          run's terms scan at a glance. The honesty rules still hold: the topic
          chip appears ONLY when the run was narrowed (a run with no subject has
          none to name); the floor chip appears only when a floor was set; cost
          is quoted, never rounded to a misleading zero; and the "not asked"
          platforms are named, never counted as empty. */}
      <div className="run-facts">
        {report.topic ? (
          <span className="run-fact run-fact-topic" title="This run was narrowed to one subject, so the list below is not the whole of what these platforms had.">
            Topic: <strong>{report.topic.name}</strong>
          </span>
        ) : null}
        <span className="run-fact" title="Only shorts at or over this view count were kept.">
          &ge; <span className="mono">{formatFigure(report.minViews)}</span> views
        </span>
        <span className="run-fact" title="Length window the shorts were kept within.">
          {report.minDurationSeconds > 0 ? (
            <>
              <span className="mono">{report.minDurationSeconds}s</span>&ndash;
              <span className="mono">{report.maxDurationSeconds}s</span>
            </>
          ) : (
            <>
              &le; <span className="mono">{report.maxDurationSeconds}s</span>
            </>
          )}
        </span>
        <span className="run-fact" title="Most videos asked for, per platform.">
          up to <span className="mono">{formatFigure(report.limit)}</span>/platform
        </span>
        {notAsked > 0 ? (
          <span className="run-fact run-fact-muted" title="Not selected for this run, so not read. Nothing below says anything about these.">
            <span className="mono">{formatFigure(notAsked)}</span>{" "}
            {notAsked === 1 ? "platform" : "platforms"} not read
          </span>
        ) : null}
        <span
          className="run-fact"
          title={
            metering.ran.length === 0
              ? "Nothing was read, so nothing was charged."
              : spent.platforms === 0
                ? "No platform reported a cost for this run — which is not the same as free."
                : metering.unmetered.length === 0
                  ? "Total charged across every platform read."
                  : `Charged by ${metering.metered.length} of ${metering.ran.length} platforms read; the rest quoted no price rather than zero.`
          }
        >
          {metering.ran.length === 0 ? (
            <>no charge</>
          ) : spent.platforms === 0 ? (
            <>no cost reported</>
          ) : (
            <>
              <span className="mono">{formatUsd(spent.total)}</span> spent
            </>
          )}
        </span>
      </div>

      {report.persistence.status === "failed" ? (
        <section className="notice mt-4" role="alert">
          <strong>Read, but not saved</strong>
          <p>
            The <span className="mono">{formatFigure(report.persistence.rows)}</span> shorts below
            were really read and really cleared the threshold — a store that refuses does not make
            them wrong. They were not written down, so the next run will meet them again as if for
            the first time.
          </p>
          <p className="mt-2">
            The store&rsquo;s own words are in this deployment&rsquo;s server log, tagged{" "}
            <code className="mono">[admin/shorts]</code>, rather than on this page: they quote
            schema, table and column names.
          </p>
        </section>
      ) : null}

      {/* THE FILE BESIDE THE LIST, NOT ON TOP OF IT.

          Erik, 2026-09-08: the export panel sat between the summary and the
          platform sections, so on a wide screen it pushed every row down by a
          whole panel's height while the right third of the page stayed empty.
          Same panel, moved into that empty column: at the page's own width it
          rides alongside the sections and stays put while they scroll.

          DOM ORDER IS UNCHANGED. The panel is still written before the
          sections and the grid places it in the second column, rather than
          `order` re-shuffling a later element into an earlier slot. Keyboard
          and screen-reader order therefore read exactly as they did yesterday,
          and below the breakpoint where the columns collapse, so does the
          page. */}
      <div
        className={
          // The second column is asked for only when there is a panel to put in
          // it. A run that cleared nothing has no export panel, and reserving
          // 380px for it anyway would narrow the sections for a box that is not
          // there. The class is set here rather than by `:has()`, for the
          // repaint scar app/globals.css records against that selector.
          report.shorts.length > 0 ? "report-body report-body-split mt-6" : "report-body mt-6"
        }
      >
        {report.shorts.length > 0 ? (
          <aside className="report-aside">
            <ExportPanel
              report={report}
              downloads={downloads}
              exportRun={exportRun}
              onExportAll={onExportAll}
              onStopExport={onStopExport}
            />
          </aside>
        ) : null}

        {/* A PLATFORM THE OPERATOR DID NOT TICK GETS NO SECTION. It is still
            counted apart in the figures above (the "Not asked" tile), which is
            where the honesty rule is satisfied — "not asked" is a choice made on
            this screen, not a finding about the platform, so a paragraph
            explaining each unticked platform is noise on a page that is meant to
            show results. Every platform that WAS asked still appears, whatever
            happened to it, because there the distinction between "read nothing"
            and "could not be read" is real. */}
        {/* ALREADY-SEEN CLIPS ARE HIDDEN, AND SAID TO BE. The count and the
            toggle are the honesty half: a page that dropped rows without a word
            would be indistinguishable from a platform that found fewer. */}
        {carriedCount > 0 ? (
          <div className="carried-note mt-6">
            <span>
              {showCarried ? (
                <>Showing {formatFigure(carriedCount)} already in your library.</>
              ) : (
                <>
                  {formatFigure(carriedCount)} {carriedCount === 1 ? "clip is" : "clips are"} already
                  in your library and hidden.
                </>
              )}
            </span>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setShowCarried((v) => !v)}
            >
              {showCarried ? "Hide them" : "Show them"}
            </button>
          </div>
        ) : null}

        <div className="stack">
          {report.platforms
            .filter((outcome) => outcome.status !== "not-asked")
            .map((outcome) => (
              <PlatformSection
                key={outcome.platform}
                outcome={outcome}
                unverified={unverifiedFor(report, outcome.platform)}
                spend={spendFor(report, outcome.platform)}
                downloads={downloads}
                onResolve={onResolve}
                costPerDownload={costPerDownload}
                hiddenKeys={hiddenKeys}
                showCarried={showCarried}
              />
            ))}
        </div>
      </div>
    </>
  );
}

/** Which of the two lists the export box is showing. */
type ExportKind = "file" | "post";

/** Where a press of Copy got to. A silent clipboard is a button that lied. */
type CopyState = "idle" | "copied" | "failed";

/**
 * EVERY LINK ON THE PAGE, IN ONE BOX, FOR ONE PRESS.
 *
 * Erik, 2026-09-05: *"give me an 'Export All' button that gives me ALL of the
 * links so these videos can be downloaded."* The row buttons were the whole of
 * "links to download them" until now, and one press per row is not a way to
 * take two hundred videos anywhere.
 *
 * ------------------------------------------------------------------------
 * TWO LISTS, AND THE DIFFERENCE BETWEEN THEM IS NOT A PREFERENCE
 * ------------------------------------------------------------------------
 *
 * VIDEO FILE LINKS are what the row buttons resolve: signed, direct, and dead
 * within hours. They are what a plain downloader wants — `aria2c -i`, `wget
 * -i`, a download manager — because nothing has to understand the platform to
 * fetch one. They cost a lookup each, and on a platform that bills per lookup
 * they cost money each. They also start expiring the moment they are made: on a
 * long list the first line of the file is minutes older than the last, and the
 * panel says so rather than letting somebody find out at row 12 of 148.
 *
 * POST LINKS are the canonical URLs already in the report. They resolve
 * nothing, cost nothing, are ready before the button is pressed, and DO NOT
 * EXPIRE — but something at the other end has to know how to download from a
 * post, which for this deployment means the same yt-dlp the YouTube adapter
 * already runs (`yt-dlp -a links.txt`). For anybody who is going to leave a
 * download running overnight, this is the better file, and offering only the
 * expensive perishable one would be hiding that.
 *
 * Neither is the "real" export. They are two different bargains and the panel
 * names both.
 *
 * ------------------------------------------------------------------------
 * WHY THE FILE IS BARE URLS, ONE PER LINE, AND NOTHING ELSE
 * ------------------------------------------------------------------------
 *
 * Titles and view counts in the file would make it nicer to read and useless to
 * pipe. `wget -i` in particular does NOT honour `#` comments in a plain URL
 * list — it treats the comment as a URL and fails on it — so a single
 * courteous header line breaks the most likely thing anybody does with this.
 * The context belongs on the page, where it is, and the file stays feedable.
 *
 * ------------------------------------------------------------------------
 * THE PANEL IS HONEST ABOUT WHAT IS NOT IN THE BOX
 * ------------------------------------------------------------------------
 *
 * A row whose adapter refused, and a row nobody has asked for yet, are both
 * missing from the file and they are missing for different reasons. Both are
 * counted under the box. A file of 96 links out of a list of 148, handed over
 * with nothing said, is this repo's one forbidden move in a new place.
 *
 * ------------------------------------------------------------------------
 * "ALL" IS THE RUN, NOT THE SCREEN
 * ------------------------------------------------------------------------
 *
 * It exports `report.shorts` — every row that cleared the threshold on every
 * platform — and it is deliberately not wired to whatever the tables below are
 * currently doing about their own length. Exporting the visible slice would
 * make "Export all" mean "export the bit you can already see", which is the one
 * thing it must not mean, and it would let a presentation decision change an
 * answer. The panel prints the figure out loud so a short table and a long file
 * never look like a contradiction.
 */
function ExportPanel({
  report,
  downloads,
  exportRun,
  onExportAll,
  onStopExport,
}: {
  readonly report: LatestShortsReport;
  readonly downloads: Readonly<Record<string, DownloadState>>;
  readonly exportRun: ExportState | null;
  readonly onExportAll: (shorts: readonly ShortRecord[]) => void;
  readonly onStopExport: () => void;
}) {
  const panelId = useId();
  const [kind, setKind] = useState<ExportKind>("file");
  const [copied, setCopied] = useState<CopyState>("idle");

  const rows = report.shorts;

  // One pass, four buckets, and every row lands in exactly one of them. The
  // arithmetic under the box is this and nothing else, so it cannot drift from
  // what is actually in it.
  const fileLinks: string[] = [];
  let refused = 0;
  let inFlight = 0;
  let unasked = 0;
  for (const short of rows) {
    const state = downloads[shortKey(short)];
    if (state === undefined) unasked += 1;
    else if (state.phase === "ready") fileLinks.push(state.url);
    else if (state.phase === "refused") refused += 1;
    else inFlight += 1;
  }

  // Already checked, because `safeHref` is what put them in an href above and a
  // file that leaves this page is not a safer place for a `javascript:` URL
  // than an anchor is. A row whose post URL was unusable is not silently
  // dropped — it is the gap the count under the box reports.
  const postLinks = rows
    .map((short) => safeHref(short.url))
    .filter((url): url is string => url !== null);

  const lines = kind === "file" ? fileLinks : postLinks;
  const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  const running = exportRun?.phase === "running";

  function choose(next: ExportKind) {
    setKind(next);
    // The message under Copy was about the other list. Clearing it is the
    // difference between "copied" meaning something and meaning nothing.
    setCopied("idle");
  }

  function onCopy() {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      // A browser with no clipboard API, or a page not in a secure context.
      // Saying so beats a button that appears to work.
      setCopied("failed");
      return;
    }
    void clipboard.writeText(text).then(
      () => setCopied("copied"),
      () => setCopied("failed"),
    );
  }

  function onSave() {
    if (typeof URL.createObjectURL !== "function") return;
    const href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    // Colons out of the ISO timestamp: a filename carrying them is refused
    // outright by Windows, which is where this is being used.
    anchor.download = `shorts-${kind}-links-${report.finishedAt.replace(/[:.]/g, "-")}.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }

  return (
    // No top margin of its own any more: the grid in RunReport places this and
    // owns the gap. An `mt-6` here would only drop it out of line with the
    // first platform section beside it.
    <section className="panel" aria-labelledby={`${panelId}-title`}>
      <p className="panel-title" id={`${panelId}-title`}>
        Every link, in one file
      </p>

      <p className="hint">
        <span className="mono">{formatFigure(rows.length)}</span>{" "}
        {rows.length === 1 ? "short" : "shorts"} cleared the threshold on this run, across every
        platform that was read. That is what &ldquo;all&rdquo; means here — the whole run, not
        whatever length the tables below happen to print.
      </p>

      <fieldset className="checks">
        <legend className="field-label">Which links</legend>
        {(
          [
            { value: "file", label: "Video file links", count: fileLinks.length },
            { value: "post", label: "Post links", count: postLinks.length },
          ] as const
        ).map((option) => (
          <label
            // `check-on` from React rather than from `:has(input:checked)`, for
            // the repaint scar app/globals.css records against the platform
            // boxes above. Same class, same reason.
            className={kind === option.value ? "check check-on" : "check"}
            key={option.value}
            htmlFor={`${panelId}-${option.value}`}
          >
            <input
              id={`${panelId}-${option.value}`}
              type="radio"
              name={`${panelId}-kind`}
              checked={kind === option.value}
              onChange={() => choose(option.value)}
            />
            <span>
              {option.label} <span className="mono">{formatFigure(option.count)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="filter-bar mt-4">
        {kind === "file" ? (
          <>
            <button
              type="button"
              // Quiet, not violet. DESIGN.md keeps the one violet control on
              // this page for the run itself; this is the second expensive verb
              // and it is still not the one the page is for.
              className="btn btn-quiet"
              onClick={() => onExportAll(rows)}
              disabled={running}
            >
              {running ? "Resolving files…" : "Export all links"}
            </button>
            {running ? (
              <button type="button" className="btn btn-quiet" onClick={onStopExport}>
                Stop
              </button>
            ) : null}
          </>
        ) : null}

        <button
          type="button"
          className="btn btn-quiet"
          onClick={onCopy}
          disabled={lines.length === 0}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={onSave}
          disabled={lines.length === 0}
        >
          Save as .txt
        </button>
      </div>

      {/* `aria-live="off"` INSIDE A LIVE REGION, ON PURPOSE. The whole report
          sits in an `aria-live="polite"` div so a finished run announces
          itself; without this, a two-hundred-row export would announce its
          counter two hundred times and bury everything else on the page. The
          phase sentence below it changes once and is left to announce. */}
      {exportRun === null ? null : (
        <p className="hint mt-3" aria-live="off">
          {exportRun.phase === "running" ? (
            <>
              Resolving <span className="mono">{formatFigure(exportRun.done)}</span> of{" "}
              <span className="mono">{formatFigure(exportRun.total)}</span>. Rows fill in as they
              land, so Stop keeps everything already asked for.
            </>
          ) : exportRun.phase === "stopped" ? (
            <>
              Stopped after <span className="mono">{formatFigure(exportRun.done)}</span> of{" "}
              <span className="mono">{formatFigure(exportRun.total)}</span>. What came back is in
              the box; pressing Export again takes only the rows that were never asked.
            </>
          ) : exportRun.total === 0 ? (
            <>
              Every row on this list had already been asked, so that press resolved nothing and
              charged nothing.
            </>
          ) : (
            <>
              Asked for <span className="mono">{formatFigure(exportRun.total)}</span>{" "}
              {exportRun.total === 1 ? "file" : "files"}. What came back is below.
            </>
          )}
        </p>
      )}

      <label className="field mt-4" htmlFor={`${panelId}-box`}>
        <span>
          {kind === "file" ? "Video file links" : "Post links"} —{" "}
          {formatFigure(lines.length)} of {formatFigure(rows.length)}
        </span>
        <textarea
          id={`${panelId}-box`}
          className="input input-mono"
          readOnly
          rows={lines.length === 0 ? 3 : Math.min(12, Math.max(4, lines.length))}
          spellCheck={false}
          value={
            text === ""
              ? kind === "file"
                ? "Nothing has been resolved yet. Press Export all links."
                : "No row on this list carried a usable post URL."
              : text
          }
        />
      </label>

      {copied === "idle" ? null : (
        <p className={copied === "copied" ? "field-ok mt-2" : "field-error mt-2"} role="status">
          {copied === "copied"
            ? `${formatFigure(lines.length)} ${lines.length === 1 ? "link" : "links"} copied.`
            : "This browser did not hand over the clipboard. The box above is selectable, and Save as .txt does not need it."}
        </p>
      )}

      <p className="hint mt-3">
        {kind === "file" ? (
          <>
            One direct media URL per line and nothing else, so the file can be fed straight to a
            downloader. <strong>These expire.</strong> They are signed by the platform and die
            within hours, and a long export makes them one at a time — the first line is already
            older than the last. Resolve them when you are ready to download, not the day before.
            Each one is a lookup: on a platform that bills per lookup, an export of{" "}
            <span className="mono">{formatFigure(rows.length)}</span> rows is{" "}
            <span className="mono">{formatFigure(rows.length)}</span> of them. A row you have
            already opened by hand is not asked again.
          </>
        ) : (
          <>
            One canonical post URL per line. Nothing was resolved to build this and nothing was
            charged — these are the addresses the run already found, and they do not expire.
            Something at the far end has to know how to download from a post; this deployment
            already runs the tool that does (<span className="mono">yt-dlp -a</span>). For a list
            you intend to download over hours rather than minutes, this is the file that will still
            work when you get to it.
          </>
        )}
      </p>

      {/* WHAT IS NOT IN THE BOX, COUNTED. A short file handed over in silence
          reads as a complete one. */}
      {kind === "file" && (refused > 0 || unasked > 0 || inFlight > 0) ? (
        <p className="hint mt-2">
          Missing from this file:{" "}
          {[
            unasked > 0 ? `${formatFigure(unasked)} never asked for` : null,
            inFlight > 0 ? `${formatFigure(inFlight)} still resolving` : null,
            refused > 0
              ? `${formatFigure(refused)} the adapter would not give a file for — each row says why`
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(", ")}
          .
        </p>
      ) : null}
      {kind === "post" && postLinks.length < rows.length ? (
        <p className="hint mt-2">
          <span className="mono">{formatFigure(rows.length - postLinks.length)}</span>{" "}
          {rows.length - postLinks.length === 1 ? "row" : "rows"} gave a post URL that is not an
          http or https address, so {rows.length - postLinks.length === 1 ? "it is" : "they are"}{" "}
          not in this file. Those rows show &ldquo;no usable link&rdquo; in the list below.
        </p>
      ) : null}
    </section>
  );
}

/**
 * What one platform charged for this run, or null.
 *
 * A lookup over a list rather than a field on the outcome, and it compares two
 * values rather than naming a platform — the rule lib/platform/registry.test.ts
 * enforces on every file outside lib/platform.
 */
function spendFor(report: LatestShortsReport, platform: Platform): PlatformSpend | null {
  return (report.spend ?? []).find((row) => row.platform === platform) ?? null;
}

/** One platform. Always rendered, whatever happened to it. */
function PlatformSection({
  outcome,
  unverified,
  spend,
  downloads,
  onResolve,
  costPerDownload,
  hiddenKeys,
  showCarried,
}: {
  readonly outcome: PlatformOutcome;
  readonly unverified: readonly UnverifiedShort[];
  readonly spend: PlatformSpend | null;
  readonly downloads: Readonly<Record<string, DownloadState>>;
  readonly onResolve: (short: ShortRecord) => void;
  readonly costPerDownload: string;
  /** Keys of kept shorts already in the library; hidden unless `showCarried`. */
  readonly hiddenKeys: ReadonlySet<string>;
  readonly showCarried: boolean;
}) {
  const label = platformLabel(outcome.platform);
  const headingId = `platform-${outcome.platform}`;

  // The kept shorts this section actually paints. `outcome.shorts` is left
  // untouched — it is what the figures and Export All count — and the hiding is
  // purely which cards are drawn. `carriedHere` is how many of this platform's
  // shorts were dropped, so the section can say so rather than look short.
  const keptShorts = ran(outcome) ? outcome.shorts : [];
  const carriedHere = keptShorts.filter((short) => hiddenKeys.has(shortKey(short))).length;
  const visibleShorts = showCarried
    ? keptShorts
    : keptShorts.filter((short) => !hiddenKeys.has(shortKey(short)));

  return (
    <section aria-labelledby={headingId}>
      <div className="list-head">
        <h2 className="section-title" id={headingId}>
          {label}
        </h2>
        <StatusChip outcome={outcome} />
      </div>

      {spend === null ? null : (
        <p className="hint">
          This read cost <span className="mono">{formatUsd(spend.usdMicros)}</span>. {spend.note}
        </p>
      )}

      {outcome.status === "partial" ? (
        <div className="notice" role="alert">
          <strong>{label} stopped before the end of the read</strong>
          {/* The adapter's own sentence, rendered as written — the same
              treatment `unavailableReason()` gets, and for the same reason.
              This string is composed by the adapter for a person to read; it is
              never an exception message, which on a metered API routinely
              quotes the URL it called with the key still in it. */}
          <p>{outcome.truncation.message}</p>
          <p className="mt-2">
            {outcome.truncation.cause === "spend-cap"
              ? "That is a ceiling this deployment set, so the run behaved correctly. Raise it, or accept a shorter list."
              : "That is the platform refusing more requests for now, not a setting here. The same read later will go further."}{" "}
            What is below was really found. What is <em>not</em> below was never looked at.
          </p>
        </div>
      ) : null}

      {outcome.status === "unavailable" ||
      outcome.status === "no-adapter" ||
      outcome.status === "not-asked" ? (
        // No table, no empty state, no zero. A platform that did not run has
        // nothing to be empty about, and the sentence is the adapter's own (or,
        // for no-adapter and not-asked, the run's).
        <div className="note">
          <p>{outcome.reason}</p>
        </div>
      ) : outcome.status === "failed" ? (
        <div className="notice" role="alert">
          <strong>{label} broke while it was being read</strong>
          <p>
            It was reached and it threw, which is not the same as finding nothing — nothing here is
            a statement about what is on {label} today.
          </p>
          {/* The adapter's own sentence, rendered as written, and ONLY when the
              error class marked itself fit to print — the same treatment
              `unavailableReason()` and a truncation message get, for the same
              reason. `safeMessage` is null for everything else, including every
              error out of a library, and those keep the log pointer below and
              nothing more. See this file's header for the leak the default is
              guarding and for why the exception exists at all. */}
          {outcome.safeMessage === null || outcome.safeMessage === undefined ? (
            <p className="mt-2">
              The thrown message is in this deployment&rsquo;s server log, tagged{" "}
              <code className="mono">[admin/shorts]</code>, and not on this page. These adapters
              call APIs with a key in the URL, and the failing URL is routinely part of the message.
            </p>
          ) : (
            <>
              <p className="mt-2">{outcome.safeMessage}</p>
              <p className="mt-2 faint">
                That sentence was composed by the {label} adapter for somebody to read, which is
                why it is here rather than only in the log. Everything else the exception carries
                is in this deployment&rsquo;s server log, tagged{" "}
                <code className="mono">[admin/shorts]</code>.
              </p>
            </>
          )}
        </div>
      ) : outcome.shorts.length === 0 ? (
        <div className="note">
          {outcome.status === "partial" ? (
            <p>
              {label} answered as far as it got, and nothing it managed to see was at or over the
              threshold. It did not see everything, so this is not an answer about {label} — it is
              an answer about the part of {label} that was read.
            </p>
          ) : (
            <p>
              {label} was read and nothing came back at or over the threshold. That is a result
              rather than a failure — the platform answered.
            </p>
          )}
          <p className="mt-2">
            <RowAccounting outcome={outcome} unverified={unverified.length} />
          </p>
        </div>
      ) : visibleShorts.length === 0 ? (
        // Everything this platform found is already in the library, and the
        // operator has chosen to hide those. Not an empty read — say which it
        // is, so it can never be mistaken for "found nothing".
        <div className="note">
          <p>
            {label} found{" "}
            <span className="mono">{formatFigure(carriedHere)}</span>{" "}
            {carriedHere === 1 ? "short" : "shorts"} over the threshold, all already in your library.
            Use <strong>Show them</strong> above to see {carriedHere === 1 ? "it" : "them"}.
          </p>
          <p className="mt-2">
            <RowAccounting outcome={outcome} unverified={unverified.length} />
          </p>
        </div>
      ) : (
        <>
          {/* Cards, highest views first. The platform is named by the heading
              above, and each card carries it too so a screenshot of one card
              still says which platform it is. */}
          <div className="short-grid">
            {visibleShorts.map((short) => (
              <ShortCard
                key={shortKey(short)}
                short={short}
                footer={
                  <MediaCell
                    short={short}
                    download={downloads[shortKey(short)]}
                    onResolve={onResolve}
                    costPerDownload={costPerDownload}
                  />
                }
              />
            ))}
          </div>
          {carriedHere > 0 && !showCarried ? (
            <p className="hint mt-3">
              <span className="mono">{formatFigure(carriedHere)}</span> more already in your library,
              hidden.
            </p>
          ) : null}
          <p className="hint mt-3">
            <RowAccounting outcome={outcome} unverified={unverified.length} />
          </p>
        </>
      )}

      {ran(outcome) && unverified.length > 0 ? (
        <UnverifiedTable label={label} entries={unverified} />
      ) : null}
    </section>
  );
}

/**
 * The rows this run could not judge, in a table of their own.
 *
 * A SEPARATE TABLE, NOT A FLAG ON A ROW. The temptation is a badge in the main
 * list, and it is the wrong call for a page people scan for links: a badge is
 * read after the view count, if at all, and by then the row has already been
 * taken as a short over 500,000 views. Different table, different columns,
 * different heading, and no view-count column pretending to be comparable with
 * the one above it.
 *
 * There is no "Link" button here on purpose. The file is the thing an
 * operator takes away, and offering it beside an unproven row is the whole
 * mistake in one button — these rows are a diagnosis of what the source did not
 * tell us, not a shortlist. The post link is present, so anybody who wants to
 * go and look can.
 */
function UnverifiedTable({
  label,
  entries,
}: {
  readonly label: string;
  readonly entries: readonly UnverifiedShort[];
}) {
  return (
    <>
      <div className="list-head mt-6">
        <h3 className="section-title">{label} — could not be judged</h3>
        <span className="state state-warn">
          <span className="state-mark" aria-hidden="true">
            ?
          </span>
          {formatFigure(entries.length)} unmeasured
        </span>
      </div>

      <p className="hint">
        These rows failed no filter and passed less than all of them, so they are not in the list
        above and they were not saved. They are here because the alternative is silence, and silence
        about a platform that returned rows reads as a platform with nothing on it.
      </p>

      {/* Same cards as the list above, so an unmeasured clip reads as the same
          kind of thing — but each carries, in place of an action, the sentence
          for WHY it could not be judged, since that is the whole point of
          showing it. A missing view count is an em dash and a missing length is
          simply no badge, exactly as on a measured card. */}
      <div className="short-grid">
        {entries.map((entry) => (
          <ShortCard
            key={shortKey(entry.short)}
            short={entry.short}
            footer={<p className="short-caveat">{unprovenPhrase(entry.unproven)}</p>}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Where every row a platform returned went.
 *
 * THE NUMBERS ADD UP, AND THAT IS THE POINT. `returned` equals kept plus
 * duplicates plus every field of the drop breakdown — run.ts guarantees it and
 * its test asserts it — so this sentence can account for every row rather than
 * announcing a total and leaving a reader to wonder about the difference. A
 * report whose parts do not sum to its total is a report nobody can use to work
 * out where the shorts went.
 *
 * The two "unknown" buckets are never folded into "under the threshold". A
 * short whose view count the source did not report has not been shown to be
 * under anything, and a large unknown count means a source has stopped
 * reporting a field — a bug to chase, not a quiet day on that platform.
 */
function RowAccounting({
  outcome,
  unverified,
}: {
  readonly outcome: RanOutcome;
  /** How many of the dropped rows are shown below as unjudged rather than gone. */
  readonly unverified: number;
}) {
  const { dropped } = outcome;
  const parts: string[] = [];
  if (dropped.belowThreshold > 0) {
    parts.push(`${formatFigure(dropped.belowThreshold)} under the threshold`);
  }
  if (dropped.tooLong > 0) {
    parts.push(`${formatFigure(dropped.tooLong)} longer than the Shorts ceiling`);
  }
  // NOT FOLDED INTO THE LINE ABOVE. "Longer than the Shorts ceiling" is a fact
  // about the video; "shorter than you asked for" is a fact about the request,
  // and an operator reading the first when the second happened would go looking
  // for a bug in the adapter.
  if (dropped.tooShort > 0) {
    parts.push(`${formatFigure(dropped.tooShort)} shorter than the minimum length`);
  }
  if (dropped.unknownViews > 0) {
    parts.push(`${formatFigure(dropped.unknownViews)} with no view count reported`);
  }
  if (dropped.unknownDuration > 0) {
    parts.push(`${formatFigure(dropped.unknownDuration)} with no duration reported`);
  }
  if (dropped.wrongPlatform > 0) {
    parts.push(`${formatFigure(dropped.wrongPlatform)} labelled with another platform`);
  }
  if (outcome.duplicates > 0) {
    parts.push(`${formatFigure(outcome.duplicates)} returned more than once in this run`);
  }

  return (
    <>
      <span className="mono">{formatFigure(outcome.kept)}</span> kept of{" "}
      <span className="mono">{formatFigure(outcome.returned)}</span>{" "}
      {outcome.returned === 1 ? "row" : "rows"} returned
      {parts.length === 0 ? "." : <> — {parts.join(", ")}.</>}
      {dropped.unknownViews > 0 || dropped.unknownDuration > 0 ? (
        <>
          {" "}
          A row the source gave no view count or no duration for was not judged against the
          threshold either way; an unknown number has not been shown to clear it or to miss it.
        </>
      ) : null}
      {unverified > 0 ? (
        <>
          {" "}
          <span className="mono">{formatFigure(unverified)}</span> of those are listed under{" "}
          <em>could not be judged</em> below rather than thrown away.
        </>
      ) : null}
      {outcome.status === "partial" ? (
        <>
          {" "}
          These counts are of what was read before the run stopped, and not of what is on the
          platform.
        </>
      ) : null}
      {totalDropped(dropped) === 0 && outcome.duplicates === 0 && outcome.returned > 0 ? (
        <> Everything this platform returned cleared the bar.</>
      ) : null}
    </>
  );
}

function StatusChip({ outcome }: { readonly outcome: PlatformOutcome }) {
  if (outcome.status === "ok") {
    return (
      <span className="state state-approved">
        <span className="state-mark" aria-hidden="true">
          &#10003;
        </span>
        {outcome.kept === 0 ? "Read — none over the threshold" : `Read — ${formatFigure(outcome.kept)} kept`}
      </span>
    );
  }
  if (outcome.status === "partial") {
    // Amber and not green: it answered, so it is not a failure, and it did not
    // finish, so it is not the win either. DESIGN.md keeps rose for something a
    // person has to go and fix outside the app, and a spend cap is a setting
    // working exactly as it was set.
    return (
      <span className="state state-warn">
        <span className="state-mark" aria-hidden="true">
          !
        </span>
        {outcome.kept === 0
          ? "Stopped early — none so far"
          : `Stopped early — ${formatFigure(outcome.kept)} so far`}
      </span>
    );
  }
  if (outcome.status === "failed") {
    return (
      <span className="state state-signal">
        <span className="state-mark" aria-hidden="true">
          !
        </span>
        Broke mid-run
      </span>
    );
  }
  // THREE WAYS NOT TO HAVE RUN, THREE WORDS. They share the quiet slate because
  // none of them is a result, and they must not share a label: "not asked" is
  // fixed by ticking a box on this screen, "nothing looked" by configuring a
  // key, and "could not run" by whatever the adapter's own sentence says. One
  // chip reading "Not read" over all three would send an operator to the wrong
  // one of those every time.
  return (
    <span className="state state-unlisted">
      <span className="state-mark" aria-hidden="true">
        &#8212;
      </span>
      {outcome.status === "not-asked"
        ? "Not asked"
        : outcome.status === "no-adapter"
          ? "Nothing looked"
          : "Could not run"}
    </span>
  );
}

/** The on-demand half of "links to download them". */
function MediaCell({
  short,
  download,
  onResolve,
  costPerDownload,
}: {
  readonly short: ShortRecord;
  readonly download: DownloadState | undefined;
  readonly onResolve: (short: ShortRecord) => void;
  readonly costPerDownload: string;
}) {
  if (download === undefined) {
    return (
      <button
        type="button"
        className="btn btn-quiet btn-small"
        onClick={() => onResolve(short)}
        aria-label={`Get the video file link for ${short.title ?? short.platform_video_id}`}
      >
        {/* One word on the face, the whole sentence in the label. The column
            heading above already says these are video files, and a button
            repeating its own column down two hundred rows is noise; the
            screen-reader name still carries which row it belongs to, which is
            the thing "Link" on its own genuinely does not say. */}
        Link
      </button>
    );
  }

  if (download.phase === "resolving") {
    return (
      <button type="button" className="btn btn-quiet btn-small" disabled>
        Resolving&#8230;
      </button>
    );
  }

  if (download.phase === "refused") {
    return <span className="faint">{download.message}</span>;
  }

  // NO `safeHref` HERE ANY MORE, and its absence is not a relaxation. It moved
  // one step earlier, to `toDownloadState`, because the export is a second way
  // an adapter's string leaves this page and an anchor-side check does nothing
  // about a `.txt` file. A `ready` state now means "checked", so a second call
  // here would be a guard that can never fire — and dead code shaped like a
  // security check is worse than none, because the next reader counts it.
  return (
    <>
      <a className="link" href={download.url} target="_blank" rel="noreferrer noopener">
        Download the video
      </a>
      <div className="hint mt-1">
        {/* THE COST, WHERE THE SPENDING HAPPENS. A resolve is metadata and
            effectively free; the FILE is what moves 19MB of somebody's
            per-gigabyte allowance, and it moves it when this link is followed
            rather than when the row was resolved. So the figure belongs on the
            link, not on the button that produced it. */}
        {costPerDownload} · short-lived, and nothing stores it — press again for a fresh one.
      </div>
    </>
  );
}
