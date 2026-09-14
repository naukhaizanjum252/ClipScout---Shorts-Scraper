/**
 * WHAT THE SCREEN NEEDS THAT THE RUN DOES NOT ALREADY GIVE IT.
 *
 * Deliberately thin. `lib/shorts/run.ts` already returns the shape this page
 * draws — `LatestShortsReport`, one outcome per platform in `PLATFORMS` order,
 * every kept short sorted highest-views-first — and the temptation was to
 * define a second "view model" and map between the two. That would have been a
 * mistake with a specific cost: the report's honesty is enforced by its TYPE
 * (a `no-adapter` outcome has no row count to print, so printing one does not
 * compile), and every translation into a looser local shape is an opportunity
 * to flatten that back into a status string and an optional number. So the page
 * renders the report itself, and this module holds only the things a report has
 * no business knowing: how to make a string safe for an `href`, how a figure is
 * spelled, and the two result wrappers a server action needs.
 *
 * The counting helpers here are sums over the report rather than new facts. Each
 * one steps over the outcomes it may not count — a platform that could not be
 * read has no rows to add, and adding a zero for it would be the honesty rule
 * broken in an accumulator.
 *
 * TWO OF THEM COUNT THINGS THAT DID NOT EXIST BEFORE 2026-09-04 and both are
 * absences rather than results. `unverifiedTotal` counts rows no filter could
 * be applied to — X may not populate a view count on third-party media, and
 * Instagram's official API publishes no duration at all. `spentUsdMicros` sums
 * only the platforms that report a price, and returns the count alongside the
 * sum so the caller cannot print a floor as a total. Neither may ever be
 * rendered as a plain zero.
 */
import type { Platform } from "@/lib/platform/types";
import type { TopicRef } from "@/lib/shorts/topics";
import { BYTES_PER_DOWNLOAD_ESTIMATE } from "@/lib/config";
import {
  ran,
  stoppedEarly,
  type LatestShortsReport,
  type SpendForecastReport,
  type UnverifiedShort,
  type UsdMicros,
} from "@/lib/shorts/run";

/**
 * How many videos a run asks each platform for WHEN NOBODY HAS SAID.
 *
 * It used to live in ./actions.ts as the only answer — a constant the file
 * passed to every run — and the comment on it said, in as many words, "when
 * somebody says what a run is for, it moves". Erik said (2026-09-05: *"a
 * maximum amount of videos to display"*), so it moved: the number is a control
 * on the screen now, and this is where that control starts.
 *
 * IT IS HERE RATHER THAN IN ./actions.ts BECAUSE OF THE DIRECTIVE. Next turns
 * every export of a "use server" module into a public endpoint, so that file
 * may export nothing but async actions — and page.tsx has to be able to read
 * this to seed the input. It is not in lib/config.ts for the reason it never
 * was: everything there cites a person and a date, and fifty cannot. It is a
 * cost ceiling chosen to keep one press to one bounded call per platform.
 */
export const DEFAULT_ROWS_PER_PLATFORM = 50;

/**
 * The most videos ONE PRESS may ask a single platform for, whatever was typed.
 *
 * A NUMBER THE OPERATOR TYPES IS A NUMBER THE OPERATOR CAN MISTYPE, and this
 * one multiplies the invoice: on X every returned Post is $0.005, so an extra
 * zero on a per-platform maximum is an extra zero on the bill. Two hundred is
 * chosen in the safe direction and is well above anything a person scans by eye.
 *
 * IT IS ENFORCED BY REFUSING RATHER THAN BY LOWERING, which is the opposite of
 * what actions.ts does to `X_MAX_POSTS_PER_RUN` — and the difference is who is
 * in the room. An environment variable was set once by somebody who is not
 * here, so quietly lowering it is the only way to keep a deployment working;
 * this number was typed seconds ago by somebody looking at the screen, and
 * silently running a different number from the one they typed would make every
 * figure in the report an answer to a question they did not ask.
 *
 * X's own ceiling still applies underneath: a maximum of 200 does not authorise
 * 200 billed Posts, because actions.ts caps that at 100 per press.
 */
export const MAX_ROWS_PER_PLATFORM = 200;

/**
 * Where the length floor starts: NOWHERE, which is the only honest default.
 *
 * Erik asked for "a minimum and maximum length" on 2026-09-05, and asking for
 * the control is not the same as naming the number. Nobody has said a
 * four-second clip is uninteresting, so this tool does not decide it — the
 * floor starts at zero, excludes nothing, and the inventory an operator sees on
 * a fresh page is the same one they saw before this control existed.
 *
 * THE CEILING HAS NO CONSTANT BESIDE THIS ONE ON PURPOSE. It starts at
 * `shortMaxSeconds()` from lib/config.ts, because that number is the client's
 * own sentence ("2 minutes max is length") and it is the definition of a Short
 * rather than a preference about them. A zero has no such provenance, which is
 * exactly why it can live here and the ceiling cannot.
 */
export const DEFAULT_MIN_DURATION_SECONDS = 0;

/**
 * How many of a platform's rows FIT IN THE BOX before it starts scrolling.
 *
 * Erik, 2026-09-05: *"we just don't want the screen to go on forever, the 10
 * gets shown immediately and then you have a scroll bar on the side to show the
 * rest so we will have 5 blocks of 10 instead of 200 records on one screen."*
 *
 * IT CUTS THE HEIGHT OF A BOX, NOT THE LENGTH OF A LIST, and the distinction is
 * the whole reason this constant is worth a comment. Every row a platform
 * returned is rendered, in order, inside that box: Ctrl+F finds them, a screen
 * reader reads them, the accounting sentence underneath counts them, and
 * scrolling reaches them. What is bounded is the window onto the list, so five
 * platforms are five blocks a page tall instead of one column of two hundred.
 *
 * An earlier turn of this got it wrong in the expensive direction — it sliced
 * the array to ten and printed a sentence about the rest. That is a different
 * product: it makes the operator run again with different settings to see row
 * eleven. Trimming a list and trimming a viewport look identical in a
 * screenshot and are opposites in use.
 *
 * THE NUMBER LIVES HERE, IN TYPESCRIPT, AND THE STYLESHEET MULTIPLIES IT. The
 * console sets it as the `--rows-before-scroll` custom property on the box and
 * app/globals.css turns it into a `max-height`, so the count sits beside the
 * other display figures rather than being buried in a pixel value somebody has
 * to divide to understand.
 */
export const ROWS_BEFORE_SCROLL = 10;

/**
 * WHAT ONE PRESS ASKS FOR.
 *
 * An object rather than three positional arguments, and it is shared by the run
 * and the estimate BECAUSE THEY MUST BE ASKED THE SAME QUESTION. A forecast
 * priced against five platforms and a run made against two is a quote for a run
 * nobody made, and the way that bug arrives is two call sites drifting apart —
 * so there is one shape and both actions take it.
 *
 * EVERY FIELD IS REVALIDATED IN ./actions.ts. A server action is a public
 * endpoint, so nothing that arrives in one of these is believed because the
 * page produced it; this type says what the page sends, not what the server
 * accepts.
 */
export interface RunRequest {
  /** Shorts at or over this many views are kept. A whole number, one or more. */
  readonly minViews: number;
  /**
   * The most rows to ask EACH selected platform for.
   *
   * A ceiling on what comes back and therefore on what is shown — and, on a
   * platform that bills per row returned, a ceiling on the invoice. It is the
   * `limit` the report already prints, now set on screen instead of hard-coded.
   */
  readonly limit: number;
  /**
   * The shortest a video may be, in seconds. Zero is the ordinary value and
   * means no floor at all.
   *
   * A PREFERENCE, NOT A DEFINITION — see `maxDurationSeconds` below for the
   * other half of that sentence.
   */
  readonly minDurationSeconds: number;
  /**
   * The longest a video may be, in seconds.
   *
   * IT IS BOUNDED BY THE DEPLOYMENT'S SHORTS CEILING AND THE SERVER ENFORCES
   * THAT. An operator may narrow the window — 15 to 45 seconds, say — but may
   * not widen it past `shortMaxSeconds()`, because above that line a video is
   * not a Short and this tool would be answering a different question from the
   * one its name asks. Raising the ceiling itself is an environment variable
   * with a person and a date behind it, not a box on a screen.
   */
  readonly maxDurationSeconds: number;
  /**
   * The platforms to read. Never empty — an empty selection is refused with a
   * sentence rather than run as "all", because the two are opposite intentions
   * and the expensive one must not be the accident.
   */
  readonly platforms: readonly Platform[];
  /**
   * WHICH SUBJECT TO LOOK FOR, or null for every subject that is switched on.
   *
   * NULL IS THE ORDINARY VALUE AND IT IS NOT "no topic". A run has searched by
   * subject since 2026-09-05 — it reads /admin/topics and searches for every
   * active row — and this control does not turn that off, it narrows it. The
   * two meanings would look the same in a null and are opposite in a bill and
   * in a list, so the sentence is worth having here: null asks for the run this
   * screen already made, and a slug asks for one of the subjects inside it.
   *
   * IT IS A SLUG AND NOT A TOPIC. The browser may say which of the deployment's
   * subjects to aim at; it may not say what the words behind that subject are.
   * A form that posted terms would let a stale tab — or a hand-made request to
   * an action id out of the client bundle — search for anything at all and have
   * the result labelled with a topic somebody trusts. The server looks the slug
   * up in the store and uses the row it finds, or refuses.
   */
  readonly topicSlug: string | null;
}

/**
 * THE SUBJECTS THIS SCREEN MAY BE AIMED AT, and what to say when there are
 * none.
 *
 * ONE SHAPE RATHER THAN TWO PROPS, because the empty list has three different
 * meanings and the console cannot tell them apart on its own: no topic is
 * switched on, no database is configured, or the list could not be read at all.
 * The first is a decision somebody made, the second is a deployment that has
 * not been finished, and the third is a fault — and only the fault means the
 * run is about to refuse. A bare `[]` would render the same silent menu for all
 * three, so the sentence travels with the list.
 *
 * `note` IS NULL WHEN THERE IS NOTHING TO EXPLAIN. A screen with subjects to
 * choose from does not need a paragraph about it.
 */
export interface TopicChoices {
  /** Active topics, by name. Empty is a real answer — see `note`. */
  readonly list: readonly TopicRef[];
  /** Why the list is empty, or null when it is not. */
  readonly note: string | null;
}

/**
 * What a server action hands back.
 *
 * A refusal carries a sentence this app composed, never an upstream one — the
 * scar is in lib/actions/decide.ts and on /admin/credentials, and it is worth
 * restating because it was written twice in this repo before it stuck: an error
 * message from somebody else's system quotes their internals, and on this page
 * the systems in question are metered APIs whose failures quote the URL they
 * were called with, key and all. Those go to the server log; a person gets a
 * classification.
 */
export type RunOutcome =
  | { readonly ok: true; readonly report: LatestShortsReport }
  | { readonly ok: false; readonly message: string };

/** Resolving one media URL, on demand. A null from an adapter becomes an `ok: false`. */
export type DownloadOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

/**
 * What the cost estimate hands back.
 *
 * Same shape and the same refusal rule as `RunOutcome`. A forecast is a cheap
 * call against a metered API, so it fails in the same ways for the same reasons
 * and the message a person reads is composed here rather than quoted.
 */
export type EstimateOutcome =
  | { readonly ok: true; readonly forecast: SpendForecastReport; readonly scope?: EstimateScope }
  | { readonly ok: false; readonly message: string };

/**
 * WHY THE QUOTED FIGURE IS A FLOOR, IN NUMBERS THE PANEL CAN NAME.
 *
 * `forecastLatestShortsSpend` prices ONE read per platform, but a run makes one
 * read per SUBJECT per platform and ALSO reads each subject's channels. So the
 * figure is exact only for a run narrowed to one subject with no channels, and a
 * floor otherwise. This carries the two counts that make it a floor, so the
 * estimate can say so instead of presenting the floor as a total. Omitted on the
 * callers that do not compute it (the CLI, older tests), where the panel falls
 * back to its prior wording.
 */
export interface EstimateScope {
  /** Subjects this run will search. 0 is an untargeted run. */
  readonly topics: number;
  /** Topic channels (across the searched subjects, on the selected platforms) also read. */
  readonly channels: number;
}

/**
 * A URL that is safe to put in an `href`, or null.
 *
 * TWO SEPARATE REASONS THIS EXISTS, AND NEITHER IS PARANOIA.
 *
 * The first: `ShortRecord.url`, `creator_url`, `thumbnail_url` and everything
 * `downloadUrl()` returns are strings that came from outside — a scraper's
 * output, a third-party provider's JSON. React escapes text, but it does not
 * stop `href="javascript:..."` from running when somebody clicks it. Every one
 * of those values reaches an attribute on this page, so every one comes through
 * here first.
 *
 * The second, and the reason it returns `parsed.href` rather than the string it
 * was handed: browsers strip tabs and newlines out of a URL before acting on
 * it, and so does the URL parser. `"java\nscript:alert(1)"` parses as the
 * `javascript:` scheme — which this rejects — but handing the ORIGINAL string
 * back would put the version with the newline into the attribute, where the
 * browser strips it again and runs exactly what was just rejected. Returning
 * the normalised form means the string that was checked is the string that
 * ships.
 *
 * Anything that is not http or https is refused, `data:` and `blob:` included.
 * A platform that genuinely needs one of those can make its case; quietly
 * allowing every scheme is not the way to find that out.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.href;
}

/**
 * Rows dropped for being under the threshold, across every platform that ran.
 *
 * A filtered-out count is information rather than noise: it is the difference
 * between "this platform had nothing worth your time today" and "your threshold
 * is set higher than this platform's day". It counts ONLY rows whose view count
 * was known and genuinely lower. The rows whose view count the source never
 * reported are `dropped.unknownViews` and they are shown separately, because an
 * unknown number has not been shown to be under anything.
 */
export function belowThresholdTotal(report: LatestShortsReport): number {
  return report.platforms.reduce((n, outcome) => (ran(outcome) ? n + outcome.dropped.belowThreshold : n), 0);
}

/**
 * How many platforms were read.
 *
 * A platform that stopped early COUNTS AS READ, and this is the one place that
 * decision is easy to get wrong in the quiet direction. It was asked, it
 * answered, and the rows it gave are real; calling it unread would say nothing
 * looked at X when something did and then ran out of budget. What is missing is
 * said separately, by `stoppedEarlyCount` and by the platform's own section —
 * never by shrinking this figure.
 */
export function readCount(report: LatestShortsReport): number {
  return report.platforms.filter(ran).length;
}

/**
 * THE DENOMINATOR. How many platforms this run was asked for.
 *
 * It used to be `PLATFORMS.length`, printed as "/5", and the platform
 * checkboxes made that a lie the moment anybody unticked one: an operator who
 * asked for two platforms and got both would read "2/5 platforms read" and
 * conclude three had gone missing. The denominator is what was asked for, and
 * how many were left out is said separately by `notAskedCount`.
 *
 * DERIVED FROM THE OUTCOMES rather than from a selection field on the report,
 * because the report already carries one outcome per platform and a second
 * record of the same fact is a second thing to keep in step.
 */
export function askedCount(report: LatestShortsReport): number {
  return report.platforms.filter((outcome) => outcome.status !== "not-asked").length;
}

/**
 * How many platforms were left out of this run on purpose.
 *
 * Its own figure, and never folded into `unreadCount`. "Could not be read" is a
 * thing to go and fix; "was not asked for" is a box on this screen. A page that
 * counted them together would put a deployment problem and a click in the same
 * number, and the click is far commoner.
 */
export function notAskedCount(report: LatestShortsReport): number {
  return report.platforms.filter((outcome) => outcome.status === "not-asked").length;
}

/**
 * How many platforms answered and then stopped short.
 *
 * Its own figure because it is the difference between "we looked everywhere and
 * this is what is over 500,000" and "we looked until the money ran out". The
 * second is a perfectly good answer; it is just not the first one, and a page
 * that showed only `readCount` would let a reader take it for the first one.
 */
export function stoppedEarlyCount(report: LatestShortsReport): number {
  return report.platforms.filter(stoppedEarly).length;
}

/**
 * How many platforms this run ASKED FOR and could not read, for any of the
 * three reasons.
 *
 * Unavailable, failed and no-adapter are counted together HERE and only here,
 * because the figure answers one question — how much of what we asked for did
 * this run not see — and the sections below it keep the three apart. A page that
 * only ever showed the total would be hiding the difference; a page that never
 * totalled them would make an operator count five panels by eye.
 *
 * A PLATFORM NOBODY ASKED FOR IS NOT IN HERE. It was not read, and it was not
 * "not read" in the sense this figure means — the figure sits under the word
 * "Not read" in a row of things that need attention, and an unticked checkbox
 * does not need attention. `notAskedCount` is the other figure.
 */
export function unreadCount(report: LatestShortsReport): number {
  return report.platforms.filter((outcome) => !ran(outcome) && outcome.status !== "not-asked").length;
}

/**
 * Every row the run could not judge, across every platform.
 *
 * `report.unverified` is optional on the type and never absent from a real run
 * — see the field's own comment. The `?? []` here is the price of that, and it
 * is deliberately a coalesce and not a `!`: a report from somewhere else with
 * no unverified list has told us nothing about unverified rows, and zero is the
 * only figure this page may print for "nothing was told to us".
 */
export function unverifiedTotal(report: LatestShortsReport): number {
  return (report.unverified ?? []).length;
}

/**
 * The unjudgeable rows of one platform, in the order the run put them in.
 *
 * Filtered from the flat list rather than read off the outcome, because the
 * outcome would have needed a new required field and the flat list already
 * carries the platform on every row. `entry.short.platform === platform`
 * compares two values; it does not name a platform, which is the rule
 * lib/platform/registry.test.ts enforces on every file outside lib/platform.
 */
export function unverifiedFor(
  report: LatestShortsReport,
  platform: Platform,
): readonly UnverifiedShort[] {
  return (report.unverified ?? []).filter((entry) => entry.short.platform === platform);
}

/**
 * What the run actually cost, summed over the platforms that said.
 *
 * A FLOOR, NEVER A TOTAL. Four of the five adapters do not report a price, and
 * this figure adds up only the ones that do — so every surface printing it has
 * to say which platforms are behind it. Returning null when nothing metered
 * would be tidier and would lose the distinction between "no platform charged
 * us" and "no platform told us", so it returns the sum and the count, and the
 * caller renders an em dash when the count is zero.
 */
export function spentUsdMicros(report: LatestShortsReport): { readonly total: UsdMicros; readonly platforms: number } {
  const rows = report.spend ?? [];
  return { total: rows.reduce((sum, row) => sum + row.usdMicros, 0), platforms: rows.length };
}

/**
 * Figures are never abbreviated — DESIGN.md — because they get compared down a
 * column: 1,284,000 rather than 1.28M.
 *
 * The locale is pinned rather than left to the browser. Grouping separators
 * differ between locales, this string is produced on the client after a run
 * while the same helper runs on Node in the tests, and an unpinned locale makes
 * a rendered figure depend on whose machine drew it.
 */
export function formatFigure(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A duration as m:ss.
 *
 * Colon form rather than "94s", because the ceiling was set in minutes by the
 * person who set it — "2 minutes max is length" — and because a column of m:ss
 * under tabular figures tells you at a glance which side of two minutes a row
 * is on, where a column of raw seconds does not.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Money, from the integer millionths of a dollar the run carries.
 *
 * FOUR DECIMAL PLACES, because X's published rate is $0.005 per Post read and a
 * two-decimal renderer would print half a cent as "$0.00". A currency formatter
 * that rounds a real charge to nothing is the same class of mistake as a null
 * view count rendered as a zero, and it is the one an operator is least likely
 * to catch — nobody double-checks a zero next to the word "spent".
 *
 * A charge too small even for four places is spelled out rather than rounded,
 * for the same reason. It is a real amount of money and this will not say it
 * was not.
 */
/**
 * What a number of downloads costs, said in bandwidth and, when this deployment
 * has told us its rate, in money.
 *
 * BANDWIDTH ALWAYS, MONEY ONLY WHEN PRICED. The megabytes are measured — two
 * files fetched through the live service on 2026-09-08 — so they can be stated
 * flatly. The dollars depend on YTDLP_PROXY_USD_PER_GB, which has no default
 * because every published per-gigabyte figure is a price on somebody else's
 * invoice. Unpriced, this says so and names the variable, which is a thing an
 * operator can act on; inventing a rate is not.
 *
 * "about", every time. The application never sees the real size: the browser
 * fetches from the service directly, which is the whole point of the signed
 * link, so there is no after-the-fact correction and no pretending otherwise.
 */
export function formatDownloadCost(count: number, usdMicros: number | null): string {
  const megabytes = (count * BYTES_PER_DOWNLOAD_ESTIMATE) / 1_000_000;
  const size = megabytes >= 1000 ? `${(megabytes / 1000).toFixed(2)} GB` : `${Math.round(megabytes)} MB`;
  if (usdMicros === null) return `about ${size} of proxy traffic`;
  return `about ${size} of proxy traffic, ${formatUsd(usdMicros)}`;
}

export function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (micros > 0 && dollars < 0.0001) return "under $0.0001";
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/**
 * Which filter went unproven, as a phrase for a person.
 *
 * The wording says WHAT WAS NOT SHOWN rather than what is missing, because the
 * absent field is the source's problem and the unproven claim is ours. "No
 * duration" invites a reader to assume the short is short; "not shown to be
 * under the ceiling" does not.
 */
export function unprovenPhrase(unproven: readonly ("views" | "duration")[]): string {
  const views = unproven.includes("views");
  const duration = unproven.includes("duration");
  if (views && duration) {
    return "neither the view count nor the length was reported, so this row has not been shown to clear the threshold or to be a Short";
  }
  if (views) {
    return "no view count was reported, so this row has not been shown to clear the threshold";
  }
  return "no length was reported, so this row has not been shown to be under the Shorts ceiling";
}

/**
 * How old a restored run is, as a phrase.
 *
 * COARSE ON PURPOSE. The sentence beside a restored list has one job — stop it
 * being read as something that just happened — and "3 hours ago" does that as
 * well as a count of minutes while staying right for longer. The absolute
 * timestamp is printed beside it, so this is never the only answer.
 *
 * `now` IS AN ARGUMENT, INCLUDING FOR THE CALLER THAT ALWAYS PASSES THE CLOCK.
 * A default of `new Date()` would make this a function whose output depends on
 * when it runs, which is untestable and — the reason that matters here — is
 * rendered by a client component the server renders first. See `formatSavedAt`
 * for the other half of that problem.
 */
export function describeAge(savedAt: string, now: Date): string {
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return "at an unknown time";

  const seconds = Math.max(0, Math.round((now.getTime() - saved.getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * When a restored run was saved, spelled out.
 *
 * PINNED TO UTC, AND THE PIN IS WHY THIS IS A FUNCTION RATHER THAN A
 * `toLocaleString` AT THE CALL SITE. The console is a client component that the
 * server renders first, so a timestamp formatted in the machine's local zone is
 * formatted twice in two different zones — React hydrates one over the other and
 * the visible form is a time that changes as the page loads, next to a list an
 * operator is deciding something about. Pinning the zone makes both renders
 * agree. It is the same call `formatFigure` makes about the locale, for the same
 * reason.
 *
 * THE ZONE IS NAMED IN THE OUTPUT rather than left implied. A bare "14:32" that
 * is neither the reader's clock nor labelled is worse than a foreign one that
 * says so.
 */
export function formatSavedAt(savedAt: string): string {
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return "an unknown time";
  return `${saved.toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })} UTC`;
}

/**
 * The platforms a run actually asked for.
 *
 * Used to put the checkboxes back where a restored run left them, so the panel
 * describes the list underneath it. DERIVED FROM THE OUTCOMES rather than stored
 * beside them — the same call `askedCount` makes above, for the same reason: the
 * report already carries one outcome per platform, and a second record of which
 * were asked is a second thing to keep in step.
 */
export function askedPlatforms(report: LatestShortsReport): readonly Platform[] {
  return report.platforms
    .filter((outcome) => outcome.status !== "not-asked")
    .map((outcome) => outcome.platform);
}
