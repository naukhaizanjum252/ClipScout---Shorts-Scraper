"use server";

import { shortMaxSeconds } from "@/lib/config";
import { resolveCredentialStore } from "@/lib/credentials/resolve";
import type { CredentialStore } from "@/lib/credentials/types";
import {
  adapterFor,
  buildAdapters,
  linkIsBoundToItsResolver,
  xConfigFor,
  type RegistryOptions,
} from "@/lib/platform/registry";
import { PlatformUnavailableError } from "@/lib/platform/unavailable";
import { remoteYtDlpFromEnv, signedDownloadUrl } from "@/lib/platform/ytdlp-remote";
import { PLATFORMS, isPlatform, platformLabel, type Platform, type ShortRecord } from "@/lib/platform/types";
import {
  forecastLatestShortsSpend,
  getLatestShorts as runLatestShorts,
  safeToShowMessage,
} from "@/lib/shorts/run";
import { resolveSeedStore } from "@/lib/shorts/seeds";
import { activeTopics, resolveTopicStore, TopicsNotInstalledError } from "@/lib/shorts/topic-store";
import { topicRef, type Topic, type TopicRef } from "@/lib/shorts/topics";
import { ShortsStoreError, type ShortsStore } from "@/lib/shorts/store";
import { SupabaseShortsStore } from "@/lib/shorts/supabase-store";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

import { keepRun } from "./last-run";
import {
  MAX_ROWS_PER_PLATFORM,
  safeHref,
  type DownloadOutcome,
  type EstimateOutcome,
  type RunOutcome,
  type RunRequest,
} from "./view";

/**
 * THE THREE ENDPOINTS BEHIND THE TWO BUTTONS.
 *
 * WHAT THIS FILE MAY EXPORT, AND WHY THE RULE IS STRICTER THAN IT LOOKS
 *
 * Async server actions, and nothing else. Next turns EVERY export of a
 * "use server" module into a callable public endpoint, so an export here is a
 * deployment decision rather than a code-organisation one. The scar is
 * lib/actions/decide.ts, where a pure helper was exported from an action module
 * to make a test easier and thereby published an endpoint nobody had decided to
 * publish. Everything shared with the client component lives in ./view.ts,
 * which has no directive and therefore cannot become an endpoint.
 *
 * The third one, `estimateLatestShortsSpend`, was added on 2026-09-04 when X
 * became a platform this tool pays per resource to read. It is a deliberate
 * publication and not a convenience: an operator has to be able to find out
 * what a run costs BEFORE making it, and the only alternative — pricing every
 * run automatically at the front of `getLatestShorts` — would make the cheap
 * call compulsory in order to make the expensive one.
 *
 * EVERYTHING THAT ARRIVES HERE IS UNTRUSTED, INCLUDING THE THINGS THE PAGE JUST
 * RENDERED
 *
 * A server action is reachable by anyone who can POST to the app with an action
 * id the client bundle already contains. The role check below is therefore the
 * guard and not a courtesy — the redirect on page.tsx only decides what a
 * browser is shown, and the proxy only checks that a cookie exists.
 *
 * `resolveDownloadUrl` takes a whole `ShortRecord`, which means a caller can
 * hand it any record it likes. The adapter it reaches will take that record's
 * `url` and go and fetch it, and for the yt-dlp-backed adapters that means
 * invoking a subprocess against an address chosen by the caller. So the record
 * is not passed through: it is REBUILT from validated fields, the platform must
 * be one of the five, and the URL must survive `safeHref`. A KNOWN LIMIT,
 * written down rather than left to be discovered: an authenticated operator can
 * still point this at any http(s) address. Closing that needs each adapter to
 * check the host against the platform it reads, which belongs behind the
 * per-platform seam (lib/platform/types.ts is explicit that a URL rule with
 * `youtube.com` in it may not live outside the YouTube adapter) and not in this
 * file.
 *
 * NO UPSTREAM SENTENCE CROSSES THIS BOUNDARY
 *
 * Every message these actions return is composed here out of literals. The
 * words a store, a provider or a subprocess used go to the server log under
 * `[admin/shorts]`, where an operator can grep for them. This is the third time
 * the rule has been written in this repo — the credentials page and the
 * decision actions are the other two — and on this page it protects something
 * specific: these adapters call metered APIs with the key in the query string,
 * so a failing URL quoted in an exception is an operator's own API key.
 *
 * ------------------------------------------------------------ THE SPEND GATE
 *
 * SCAR, 2026-09-04. ALL THREE endpoints here can spend real money — X bills
 * $0.005 for every Post it returns and $0.005 again to resolve one file, on the
 * client's card — and until this revision the only thing between an HTTP POST
 * and that bill was "a viewer exists". Three separate holes, all of them
 * reachable by anybody who could read an action id out of the client bundle:
 *
 *   NO ROLE CHECK.  Closed at the time by requiring an admin -- and then
 *                   REOPENED DELIBERATELY on 2026-09-04, when Erik chose to
 *                   remove sign-in altogether. There is no role to check now.
 *                   See `authoriseSpend` below for exactly what is left
 *                   guarding the budget; the other two holes stay closed.
 *   NO CEILING.     Whatever `X_MAX_POSTS_PER_RUN` said, this file passed
 *                   through. A typo of 10000 in an environment variable was a
 *                   $50 authorisation nobody reviewed.
 *   NO LOCK.        Two people pressing at once, or one person pressing twice,
 *                   made two runs and paid for both.
 *
 * The ceiling and the lock are closed below, and the lock has a LIMIT WRITTEN
 * DOWN RATHER THAN GLOSSED: it is a module-level flag, so it serialises presses
 * inside ONE server process and does not know about a second instance. That is
 * a real improvement over nothing and it is not a distributed lock. The
 * durable one belongs in the database beside the scheduler's, whose claim is a
 * conditional UPDATE on `platform_schedule` — that mechanism cannot be reused
 * here as it stands, because it refuses any platform whose schedule row is
 * `enabled = false`, which is every platform until a person turns it on, and a
 * button that stops working until you configure the scheduler is not a button.
 *
 * WHAT AN UNCONFIGURED DEPLOYMENT DOES. With no Supabase project there is no
 * stored credential, so a run reads whatever the environment holds. A keyless
 * laptop that has exported `X_API_KEY` is spending the key of whoever is
 * sitting at it, which is `lib/credentials/env-store.ts`'s whole documented
 * posture.
 *
 * THIS PARAGRAPH USED TO SAY "the gate then requires the preview flag", naming
 * a `lib/shorts/preview.ts` that no longer exists. That flag opened the auth
 * gate on a database-less machine; with the gate removed (Erik, 2026-09-04) it
 * guarded nothing, was consulted by nothing, and has been deleted along with
 * the `SHORTS_PREVIEW` variable it read. A configured and an unconfigured
 * deployment now differ in where credentials come from and nowhere else.
 */

/**
 * The most Post reads ONE PRESS of the button may authorise, whatever the
 * environment says.
 *
 * NOBODY HAS SET THIS NUMBER EITHER, and like `ROWS_PER_PLATFORM` above it is a
 * ceiling chosen in the safe direction rather than a measurement. At X's
 * published $0.005 per Post returned, 100 is fifty cents a press — an amount an
 * operator can discover by accident without it being a story.
 *
 * IT ONLY EVER LOWERS. A deployment that configured `X_MAX_POSTS_PER_RUN = 40`
 * keeps 40; one that configured 10,000 gets 100. And a deployment that
 * configured NOTHING still gets nothing — see `cappedPostsPerRun`, which
 * deliberately refuses to invent a cap for an operator who never set one,
 * because the X adapter's refusal to run without one is the honest state and
 * turning it into a default would start the meter on somebody's behalf.
 */
const MAX_BILLED_POSTS_PER_PRESS = 100;

/**
 * How long after a run before the button will make another, in seconds.
 *
 * The lock already stops two runs at once; this is only a guard against an
 * accidental double-fire right after one finishes. It was 60s, which throttled
 * an operator iterating on subjects — the normal loop here is run, glance,
 * adjust, run again, and a minute's wait made that painful. Five seconds still
 * absorbs a fat-fingered second click without standing between someone and
 * their next real run. The per-run spend is already bounded by
 * MAX_BILLED_POSTS_PER_PRESS and the vendor request cap, so this is a courtesy,
 * not the budget's defence.
 */
const MIN_SECONDS_BETWEEN_RUNS = 5;

/** The tag every line this file writes to the deployment's server log carries. */
const LOG_TAG = "[admin/shorts]";

// ---------------------------------------------------------------------------
// Who may spend
// ---------------------------------------------------------------------------

/** A refusal carries the sentence a person reads; nothing else crosses back. */
type Authorisation = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * May this caller cause a metered API call?
 *
 * YES. ALWAYS. Sign-in was removed on 2026-09-04 (Erik's call: the scraper is
 * fully open), so there is no account to check and no role to check it against.
 *
 * This function is kept as a single named seam rather than deleted, because
 * every metered endpoint already calls it before asking a platform, leasing a
 * key or writing a row. Restoring a gate is an edit HERE and in
 * lib/auth/role.ts, not a hunt through three call sites for the right place to
 * put the check back.
 *
 * WHAT IT USED TO DO, AND WHY IT IS NOT LEFT IN PLACE: it refused an
 * unauthenticated caller, and refused a signed-in non-admin. Both branches
 * became unreachable the moment `getViewer()` started returning a constant
 * `owner`. Unreachable refusal code in a path that spends the operator's money
 * is worse than no code at all -- it reads, in review and in a diff, as a
 * protection that is running.
 *
 * SO, PLAINLY, WHAT PROTECTS THE BUDGET NOW:
 *   - the secrecy of the deployment URL, and nothing else about identity;
 *   - MAX_BILLED_POSTS_PER_PRESS, which caps one press;
 *   - the in-process lock and MIN_SECONDS_BETWEEN_RUNS below, which cap how
 *     often presses can land in ONE server process. Vercel can run more than
 *     one, so that is a speed bump, not a spend limit.
 *
 * The keyless `ytdlp` path costs nothing, and is the default. A run only bills
 * anybody once a paid credential has been stored on the credentials page.
 */
async function authoriseSpend(): Promise<Authorisation> {
  return { ok: true };
}

// ---------------------------------------------------------------------------
// What was asked for
// ---------------------------------------------------------------------------

type ValidatedRequest =
  | { readonly ok: true; readonly request: Required<RunRequest> }
  | { readonly ok: false; readonly message: string };

/**
 * Turn whatever arrived into a request, or into a sentence.
 *
 * FIVE FIELDS, ALL OF THEM UNTRUSTED, AND ONE OF THEM SPENDS MONEY PER ITEM.
 * The threshold check is the one this file already had; `limit`, `platforms`
 * and the two duration bounds are checked here rather than in the browser
 * because the browser is not what posts to this endpoint — an action id out of
 * the client bundle is, and it can carry a limit of ten thousand, a platform
 * list of five copies of `"x"`, and a ceiling of an hour.
 *
 * THE CEILING IS CHECKED AGAINST CONFIG, NOT AGAINST A LITERAL. A request may
 * narrow the duration window as far as it likes and may not widen it past
 * `shortMaxSeconds()` — the number that defines a Short for this deployment.
 * Accepting a larger one would let a public endpoint change what the word
 * "Short" means here, which is a decision that belongs in an environment
 * variable with a person and a date behind it.
 *
 * IT IS ONE FUNCTION FOR BOTH ENDPOINTS ON PURPOSE. The run and the estimate
 * have to accept exactly the same requests, or the estimate prices something
 * the run then refuses — and an operator whose estimate said $0.40 and whose
 * run said "that is not a whole number of views" has been told two different
 * things about one press.
 *
 * NOTHING IS COERCED. A bad number is refused, never rounded; a platform that
 * is not one of the five is refused, never dropped. Silently reading four of
 * the five platforms somebody asked for is the failure this whole repo is
 * about, and it would arrive here as a `.filter()` that looked tidy.
 */
function validateRequest(request: RunRequest, verb: "read" | "priced"): ValidatedRequest {
  const nothingHappened =
    verb === "read"
      ? "Nothing was read, and the platforms were not asked."
      : "Nothing was priced, and no platform was asked.";

  const minViews = request?.minViews;
  if (!Number.isSafeInteger(minViews) || (minViews as number) < 1) {
    return {
      ok: false,
      message: `A view threshold has to be a whole number of views, one or more. ${nothingHappened}`,
    };
  }

  const limit = request?.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
    return {
      ok: false,
      message: `A per-platform maximum has to be a whole number of videos, one or more. ${nothingHappened}`,
    };
  }
  if ((limit as number) > MAX_ROWS_PER_PLATFORM) {
    // The number is named back, because the refusal is only useful if it says
    // what would have been accepted.
    return {
      ok: false,
      message:
        `This deployment asks a platform for at most ${MAX_ROWS_PER_PLATFORM} videos in one press, ` +
        `and ${limit} was asked for. On a platform that bills per video returned that ceiling is the ` +
        `difference between a press and an invoice. ${nothingHappened}`,
    };
  }

  const ceiling = shortMaxSeconds();

  const maxDurationSeconds = request?.maxDurationSeconds;
  if (!Number.isSafeInteger(maxDurationSeconds) || (maxDurationSeconds as number) < 1) {
    return {
      ok: false,
      message: `A maximum length has to be a whole number of seconds, one or more. ${nothingHappened}`,
    };
  }
  if ((maxDurationSeconds as number) > ceiling) {
    return {
      ok: false,
      message:
        `A Short is anything at or under ${ceiling} seconds in this deployment, and ` +
        `${maxDurationSeconds} was asked for. A longer video is not a Short, so this tool will ` +
        `not go looking for one. ${nothingHappened}`,
    };
  }

  const minDurationSeconds = request?.minDurationSeconds;
  if (!Number.isSafeInteger(minDurationSeconds) || (minDurationSeconds as number) < 0) {
    return {
      ok: false,
      message:
        "A minimum length has to be a whole number of seconds, zero or more. Zero is the way " +
        `to ask for no minimum at all. ${nothingHappened}`,
    };
  }
  if ((minDurationSeconds as number) > (maxDurationSeconds as number)) {
    // Refused rather than swapped. An operator who typed 90 and 30 meant one of
    // those two windows and this file cannot tell which; running the one it
    // guessed would put a list on the screen that answers a question nobody
    // asked, with nothing on the page saying so.
    return {
      ok: false,
      message:
        `A minimum of ${minDurationSeconds} seconds and a maximum of ${maxDurationSeconds} is a ` +
        `window with nothing in it. ${nothingHappened}`,
    };
  }

  const asked = request?.platforms;
  if (!Array.isArray(asked)) {
    return { ok: false, message: `No list of platforms was given. ${nothingHappened}` };
  }
  if (asked.length === 0) {
    return {
      ok: false,
      message:
        "No platform is selected, so there is nothing to read. Tick at least one — an empty " +
        "selection is not read as every platform, because those are opposite intentions and the " +
        "expensive one must not be the accident.",
    };
  }
  for (const platform of asked) {
    if (!isPlatform(platform)) {
      return {
        ok: false,
        message: `That is not a platform this tool reads. ${nothingHappened}`,
      };
    }
  }

  // Deduped and put back into the vocabulary's order. A duplicate would not
  // cause a second read — the run keys platforms by name — but it would make
  // the selection this file logs and passes on disagree with the report that
  // comes back, and an order that depends on click sequence makes two identical
  // runs produce two different-looking requests.
  const platforms = PLATFORMS.filter((platform) => (asked as readonly Platform[]).includes(platform));

  // THE SUBJECT IS CHECKED FOR SHAPE HERE AND FOR EXISTENCE LATER, and the
  // split is not laziness. Whether `"shark-tank"` is a slug at all is a fact
  // about the string and costs nothing; whether this deployment has a topic by
  // that name and whether it is switched on are facts about the database, and
  // reading it belongs after the free refusals — see the note on the order of
  // the checks in `getLatestShorts`. `topicsForRun` does the second half.
  const topicSlug = request?.topicSlug;
  if (topicSlug !== null && topicSlug !== undefined && !isSlug(topicSlug)) {
    return {
      ok: false,
      message:
        "That is not the address of a subject this tool knows. Choose one from the list, or " +
        `leave it on every active subject. ${nothingHappened}`,
    };
  }

  return {
    ok: true,
    request: {
      minViews: minViews as number,
      limit: limit as number,
      minDurationSeconds: minDurationSeconds as number,
      maxDurationSeconds: maxDurationSeconds as number,
      platforms,
      // Undefined becomes null rather than being carried through. A caller that
      // omitted the field asked for every active subject, which is what null
      // means, and leaving the two spellings apart would make one of them an
      // unhandled case in every reader downstream.
      topicSlug: topicSlug ?? null,
    },
  };
}

/**
 * Slug rules, as the browser will have produced them.
 *
 * THE SAME SHAPE `slugify` MAKES and the same one the database enforces as a
 * check constraint — lowercase, ASCII letters and digits, single hyphens
 * between them. It is a shape test and not a lookup: it rejects the strings
 * that could not name a topic under any circumstances, and says nothing about
 * whether this deployment has one.
 */
function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

// ---------------------------------------------------------------------------
// One run at a time
// ---------------------------------------------------------------------------

/**
 * MODULE STATE, ON PURPOSE, AND IT IS PER PROCESS.
 *
 * See the header: this serialises presses within one server process and knows
 * nothing about a second instance. It is the strongest lock available without a
 * table nobody has created, and pretending otherwise would be worse than the
 * flag itself.
 */
let meteredCallInFlight = false;
let lastRunFinishedAtMs: number | null = null;

type Claim = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly message: string };

/**
 * Take the one slot, or explain who has it.
 *
 * `cooldown` is applied to the RUN and not to the estimate. A run buys Posts; an
 * estimate buys one counts request at half a cent and exists so that somebody
 * can decide whether to make the run, so rate-limiting the cheap call would
 * push people towards the expensive one.
 */
function claimMeteredSlot(cooldown: boolean): Claim {
  if (meteredCallInFlight) {
    return {
      ok: false,
      message:
        "A run is already in progress on this server. Nothing was asked a second time and nothing " +
        "extra was charged — X bills per post returned, so two runs at once is two bills. Wait for " +
        "the one in flight to finish.",
    };
  }

  if (cooldown && lastRunFinishedAtMs !== null) {
    const secondsSince = (Date.now() - lastRunFinishedAtMs) / 1000;
    if (secondsSince < MIN_SECONDS_BETWEEN_RUNS) {
      const wait = Math.max(1, Math.ceil(MIN_SECONDS_BETWEEN_RUNS - secondsSince));
      return {
        ok: false,
        message:
          `The last run finished ${Math.floor(secondsSince)} second(s) ago, so this one was held to ` +
          `avoid an accidental double-fire — nothing was asked and nothing was charged. Try again in ` +
          `${wait} second(s). The list on screen is still the last run's answer.`,
      };
    }
  }

  meteredCallInFlight = true;
  let released = false;
  return {
    ok: true,
    release: () => {
      // Idempotent: a double release from a `finally` plus an early return
      // would otherwise reset the cooldown clock and hand out the slot twice.
      if (released) return;
      released = true;
      meteredCallInFlight = false;
      if (cooldown) lastRunFinishedAtMs = Date.now();
    },
  };
}

// ---------------------------------------------------------------------------
// What the registry needs in order to build a working adapter
// ---------------------------------------------------------------------------

type Configuration =
  | { readonly ok: true; readonly options: RegistryOptions }
  | { readonly ok: false; readonly message: string };

/**
 * Lower a configured per-run cap to this app's ceiling, and never raise one.
 *
 * NULL STAYS NULL. Unset means the operator has not said what a run may cost,
 * and lib/platform/x.ts reports that as unavailable in a sentence naming the
 * variable. Substituting `MAX_BILLED_POSTS_PER_PRESS` here would silently
 * authorise fifty cents a press on behalf of somebody who authorised nothing.
 *
 * NaN AND GARBAGE TRAVEL INTACT, for the reason the registry states where it
 * parses them: "nobody set a cap" and "somebody set a cap to `two hundred`" are
 * different problems with different sentences, and `Math.min` would collapse
 * the second into a number.
 */
function cappedPostsPerRun(configured: number | null): number | null {
  if (configured === null) return null;
  if (!Number.isSafeInteger(configured) || configured <= 0) return configured;
  return Math.min(configured, MAX_BILLED_POSTS_PER_PRESS);
}

/**
 * Everything the registry needs to build adapters that can actually run.
 *
 * SCAR, 2026-09-04. `buildAdapters()` used to be called here with NO ARGUMENTS
 * AT ALL. The X adapter's failure message explained where to paste a bearer
 * token, the credentials page stored one, the registry had a field to receive
 * one — and no caller ever filled it, so an operator with a valid, paid-for,
 * correctly-saved X token was told X was unavailable, forever, with a green
 * test suite underneath. The same omission left both Meta adapters holding
 * nothing but their legacy provider argument, and left seeds edited on
 * /admin/seeds unread by the button that is supposed to use them.
 *
 * THE REGISTRY NOW BUILDS THE CLIENTS AND THIS HANDS IT THE THREE THINGS IT
 * CANNOT DECIDE FOR ITSELF: which credential store this deployment uses, which
 * seed store, and the ceiling below. `buildAdapters` is async precisely so that
 * a caller which forgets fails the build instead of quietly producing a dead X
 * adapter — which is the shape of the bug it is fixing.
 *
 * A DEPLOYMENT THAT CANNOT DECRYPT ITS OWN KEYS IS REFUSED RATHER THAN
 * DOWNGRADED. `resolveCredentialStore()` throws when Supabase is configured and
 * the encryption key is missing, and the tempting catch — carry on with no
 * credential store — would report "no X credential is configured" to an
 * operator whose key is sitting in the database, correct and unreadable. That
 * is the exact lie this round exists to stop, so the run stops instead.
 */
async function meteredRunConfiguration(): Promise<Configuration> {
  let credentials: CredentialStore | null;
  try {
    credentials = (await resolveCredentialStore()).store;
  } catch (cause) {
    console.error(`${LOG_TAG} the credential store could not be opened:`, cause);
    return {
      ok: false,
      message:
        "This deployment stores operator keys but cannot open them, so no platform was asked and " +
        "nothing was charged. The reason is in the server log, tagged [admin/shorts] — it is a " +
        "deployment setting, not a problem with the keys themselves.",
    };
  }

  const { store: seedStore } = await resolveSeedStore();

  // The same refresh the scheduled run does, for the same reason: the seed list
  // is derived state now, and a button that read a week-old ranking would be
  // reading a different list from the one the scheduler reads. Idempotent, one
  // RPC, and a failure leaves the previous ranking in place rather than
  // stopping the run — see the note in lib/shorts/schedule.ts.
  try {
    await seedStore.refreshAutoSeeds();
  } catch (cause) {
    console.error(`${LOG_TAG} the automatic seed list could not be refreshed:`, cause);
  }

  const configured = xConfigFor();

  return {
    ok: true,
    options: {
      credentials,
      seedStore,
      x: { ...configured, maxPostsPerRun: cappedPostsPerRun(configured.maxPostsPerRun ?? null) },
    },
  };
}

/**
 * A store for a deployment that has no database.
 *
 * It REFUSES rather than pretending, and it refuses in a way the run already
 * knows how to report: `getLatestShorts` catches a failing store and returns
 * `persistence: { status: "failed" }` with the shorts intact, which the page
 * shows as "read, but not saved". A `MemoryShortsStore` here would have been
 * one line shorter and would have reported a successful write into an object
 * that is discarded when the request ends — a run that says it saved fifty
 * shorts and saved nothing is precisely the failure this repo keeps writing
 * tests against.
 */
class NoDatabaseStore implements ShortsStore {
  async upsertShorts(): Promise<void> {
    throw new ShortsStoreError(
      "No Supabase project is configured for this deployment, so there is nowhere to write. " +
        "The shorts were still read.",
    );
  }

  async readShorts(): Promise<never> {
    throw new ShortsStoreError("No Supabase project is configured for this deployment.");
  }

  async upsertUnverified(): Promise<void> {
    throw new ShortsStoreError(
      "No Supabase project is configured for this deployment, so there is nowhere to write. " +
        "The shorts were still read.",
    );
  }

  async readUnverified(): Promise<never> {
    throw new ShortsStoreError("No Supabase project is configured for this deployment.");
  }
}

/**
 * The subjects this run will search for, active ones only.
 *
 * AN EMPTY LIST IS A LEGITIMATE ANSWER and produces the untargeted run this
 * tool made before topics existed — every topic switched off is a decision
 * somebody made, and second-guessing it here would put the choice back in
 * code where nobody can see it. What is NOT legitimate is failing to read the
 * list and carrying on as though it were empty; that is why the caller treats
 * a throw as a refusal rather than as zero topics.
 */
async function activeTopicsForRun() {
  const { store } = await resolveTopicStore();
  return activeTopics(await store.listTopics());
}

/**
 * What one press will search for: every active subject, or the one that was
 * chosen.
 *
 * ------------------------------------------------------------------------
 * THE CHOICE IS A SLUG AND THE WORDS COME FROM THE STORE
 * ------------------------------------------------------------------------
 *
 * The browser sends `topicSlug` and nothing else about the subject. The terms
 * that actually get sent to YouTube, TikTok, Instagram and X are read here, out
 * of the row the store holds, so a stale tab cannot search for words that were
 * edited an hour ago and a hand-made request cannot search for words nobody put
 * on /admin/topics at all. That matters more than it looks: every row this run
 * writes is labelled with the topic, and a label is a claim.
 *
 * ------------------------------------------------------------------------
 * THE FOUR ANSWERS, AND WHY A MISSING SUBJECT IS A REFUSAL
 * ------------------------------------------------------------------------
 *
 *   NOTHING CHOSEN          every active topic, which is the run this screen
 *                           has made since topics shipped.
 *
 *   CHOSEN AND FOUND        that one topic, and `topic` set so the report can
 *                           say what it was looking for.
 *
 *   CHOSEN AND GONE         REFUSED. A subject that has been deleted or
 *                           switched off since the page was drawn is not a
 *                           reason to fall back to all of them: that is a run
 *                           the operator did not ask for, costing what thirty
 *                           subjects cost, under a control still showing the
 *                           one they picked.
 *
 *   THE LIST WOULD NOT READ  refused by the caller, except for a deployment
 *                           that has not run migration 14 — see
 *                           `TopicsNotInstalledError`. A choice cannot be
 *                           honoured there either, so choosing one is refused
 *                           and asking for all of them makes the untargeted
 *                           run this tool made before 2026-09-05.
 */
type TopicsForRun =
  | { readonly ok: true; readonly topics: readonly Topic[]; readonly topic: TopicRef | null }
  | { readonly ok: false; readonly message: string };

async function topicsForRun(topicSlug: string | null): Promise<TopicsForRun> {
  let all: readonly Topic[];
  try {
    all = await activeTopicsForRun();
  } catch (cause) {
    // A DEPLOYMENT THAT HAS NOT RUN MIGRATION 14 IS NOT A BROKEN ONE. It has
    // zero topics, which is a legitimate state and the state this tool was in
    // until 2026-09-05, so it makes the untargeted run rather than refusing.
    // Nothing it produces claims a subject: every row carries
    // `topic_slug: null`. See `TopicsNotInstalledError` for the full argument
    // and for why a read that genuinely FAILED still stops the run.
    if (cause instanceof TopicsNotInstalledError) {
      console.warn(`${LOG_TAG} ${cause.message}`);
      if (topicSlug === null) return { ok: true, topics: [], topic: null };
      return {
        ok: false,
        message:
          "This deployment has no topic list yet, so it cannot be pointed at one subject. " +
          "Nothing was read and nothing was charged. Running every platform for whatever is " +
          "biggest is a different question from the one that was asked, so it was not asked.",
      };
    }
    // A FAILURE TO READ IT IS NOT A FAILURE TO RUN, and that direction is
    // deliberate: falling back to an untargeted run returns the everything-
    // that-is-big list this whole change exists to replace, so the run is
    // refused instead. Silently reading the wrong thing is the failure mode
    // topics were added to fix.
    console.error(`${LOG_TAG} the topic list could not be read:`, cause);
    return {
      ok: false,
      message:
        "The list of topics to search for could not be read, so nothing was asked and " +
        "nothing was charged. Running without it would have returned whatever was biggest " +
        "on each platform rather than the kinds of clip this deployment is looking for. " +
        "The reason is in the server log, tagged [admin/shorts].",
    };
  }

  if (topicSlug === null) return { ok: true, topics: all, topic: null };

  const chosen = all.find((topic) => topic.slug === topicSlug);
  if (!chosen) {
    return {
      ok: false,
      // The slug is named back rather than described, because the operator is
      // looking at a menu and the useful next move is to look at the same name
      // on /admin/topics. It is the browser's own string, echoed after the
      // shape check in `validateRequest`, so there is nothing in it to escape.
      message:
        `No active subject called "${topicSlug}" is on this deployment's list. It has been ` +
        "deleted or switched off since this page was drawn. Nothing was read and nothing was " +
        "charged — every subject was NOT searched instead, because that is a different run and " +
        "a more expensive one. Reload the page to see the list as it is now.",
    };
  }

  return { ok: true, topics: [chosen], topic: topicRef(chosen) };
}

async function resolveStore(): Promise<ShortsStore> {
  if (!isSupabaseConfigured) return new NoDatabaseStore();
  return new SupabaseShortsStore(createSupabaseAdminClient());
}

/**
 * Read every platform this deployment can reach, keep the ones over the
 * threshold, and report what happened to each.
 *
 * The threshold is validated HERE and not only in the browser. The same rule as
 * lib/config.ts: whole number, one or more, and zero is refused because it is a
 * request to turn off the one thing this tool promises.
 *
 * The run itself is lib/shorts/run.ts. This action's whole job is
 * authorisation, the spend gate, the two numbers, the store, and turning a
 * thrown exception into a sentence — it deliberately contains no filtering, no
 * sorting and no grouping, because a second copy of those rules is a second
 * place for them to be subtly different from the one the tests cover.
 *
 * THE ORDER OF THE FOUR CHECKS IS LOAD-BEARING. Role, then the threshold, then
 * the slot, then the credential. Everything that can refuse for free refuses
 * before anything is read, built or leased — a non-admin must not cause a
 * credential to be decrypted, let alone an API call to be sent.
 */
export async function getLatestShorts(request: RunRequest): Promise<RunOutcome> {
  const authorised = await authoriseSpend();
  if (!authorised.ok) return { ok: false, message: authorised.message };

  const validated = validateRequest(request, "read");
  if (!validated.ok) return { ok: false, message: validated.message };
  const { minViews, limit, minDurationSeconds, maxDurationSeconds, platforms, topicSlug } =
    validated.request;

  const slot = claimMeteredSlot(true);
  if (!slot.ok) return { ok: false, message: slot.message };

  try {
    const configuration = await meteredRunConfiguration();
    if (!configuration.ok) return { ok: false, message: configuration.message };

    // ALL FIVE ARE BUILT AND ONLY THE SELECTED ONES ARE HANDED OVER. Building
    // the whole set is what keeps the Meta budget shared — `buildAdapters`
    // resolves one wiring for all of them, and two resolutions against one Meta
    // app can together spend twice the allowance without either one refusing.
    // Building is free; being read is what costs, and `platforms` below is what
    // decides that, inside the run rather than here.
    const built = await buildAdapters(configuration.options);
    const adapters = platforms
      .map((platform) => built.get(platform))
      .filter((adapter): adapter is NonNullable<typeof adapter> => adapter !== undefined);

    // WHAT KIND OF SHORT TO LOOK FOR. The WORDS are read here rather than
    // passed in from the browser: the topic list is a stored decision about
    // what this deployment is for, and a run driven by whatever a form posted
    // would let a stale tab search for terms somebody edited an hour ago and
    // have the rows labelled with the subject anyway.
    //
    // WHICH of those subjects to aim at is the operator's, and it arrives as a
    // slug. See `topicsForRun` for the four answers and for why a subject that
    // has since been switched off is a refusal rather than a fallback to all of
    // them.
    const subjects = await topicsForRun(topicSlug);
    if (!subjects.ok) return { ok: false, message: subjects.message };

    const report = await runLatestShorts({
      adapters,
      store: await resolveStore(),
      limit,
      minViews,
      minDurationSeconds,
      maxDurationSeconds,
      platforms,
      topics: subjects.topics,
      topic: subjects.topic,
    });

    // The words the page will not print. An operator debugging a broken adapter
    // needs the message the adapter actually threw; a screen roughly forty
    // people screenshot is not where it goes.
    for (const outcome of report.platforms) {
      if (outcome.status === "failed") {
        console.error(`${LOG_TAG} ${outcome.platform} threw while being read:`, outcome.error);
      }
    }
    if (report.persistence.status === "failed") {
      console.error(
        `${LOG_TAG} the run was read but not stored (${report.persistence.rows} rows):`,
        report.persistence.error,
      );
    }

    // KEPT AFTER THE RUN AND NEVER INSTEAD OF IT. `keepRun` cannot throw and
    // cannot change what is returned — see ./last-run.ts. The run has already
    // been paid for at this point, and a convenience copy that failed to write
    // is not a reason to withhold a list somebody's quota bought.
    //
    // IT IS AWAITED RATHER THAN LEFT IN THE AIR. A floating promise in a server
    // action is a promise the runtime is free to abandon when the response is
    // sent, which on a serverless deployment it routinely does — so the write
    // would land for a local `next dev` and silently not for the deployment,
    // which is the worst place for the difference to live.
    await keepRun(report);

    return { ok: true, report };
  } catch (cause) {
    // The run only throws for something structural — two adapters claiming one
    // platform, for instance. A per-platform failure is reported inside the
    // report and never reaches here.
    console.error(`${LOG_TAG} the run could not be made:`, cause);
    return {
      ok: false,
      message:
        "The run could not be made. This deployment's server log has the reason, tagged " +
        "[admin/shorts]. Nothing was read, so nothing below is a statement about any platform.",
    };
  } finally {
    // ALWAYS, including when the run threw. A slot released only on the happy
    // path is a button that stops working for the rest of the process's life
    // the first time an adapter blows up.
    slot.release();
  }
}

/**
 * What one run would cost, without making it.
 *
 * X prices its API per resource RETURNED, so the only way to know what a read
 * costs before paying for it is to ask a different, cheaper endpoint how many
 * things match. That is the X adapter's business; this action's job is
 * authorisation, the same threshold validation the run does, and the loop over
 * whatever adapters exist.
 *
 * IT NEVER READS ANY SHORTS AND NEVER WRITES ANYTHING. If it did, "find out
 * what this costs" would itself be a thing that costs — which is the one
 * behaviour that would make an operator stop asking.
 *
 * NOT EVERY PLATFORM CAN BE PRICED, and the report says which. A platform that
 * quotes no price is reported as unpriced, never as free: four of the five
 * adapters have no billing model to report, and turning that into a zero would
 * put a number this app invented next to a currency symbol.
 */
export async function estimateLatestShortsSpend(request: RunRequest): Promise<EstimateOutcome> {
  // THE SAME GATE AS THE RUN, AND NOT A WEAKER ONE. A counts request is half a
  // cent rather than fifty, which makes it cheap and does not make it free —
  // and an endpoint that anyone signed in may hit is an endpoint anyone signed
  // in may hit a thousand times.
  const authorised = await authoriseSpend();
  if (!authorised.ok) return { ok: false, message: authorised.message };

  // THE SAME VALIDATION THE RUN DOES, from the same function. See its comment:
  // an estimate that accepted a request the run refuses has quoted a press that
  // cannot happen.
  const validated = validateRequest(request, "priced");
  if (!validated.ok) return { ok: false, message: validated.message };
  const { minViews, limit, minDurationSeconds, maxDurationSeconds, platforms, topicSlug } =
    validated.request;

  const slot = claimMeteredSlot(false);
  if (!slot.ok) return { ok: false, message: slot.message };

  try {
    // THE SUBJECT IS RESOLVED HERE TOO, AND IT DOES NOT REACH THE FORECAST.
    // Both halves of that need saying.
    //
    // It is resolved because the invariant this whole function is built on is
    // that the two buttons accept exactly the same requests: an estimate that
    // priced a subject the run then refuses has quoted a press that cannot
    // happen, and an operator who was quoted $0.40 and then told their subject
    // is gone has been told two different things about one click.
    //
    // It does not reach `forecastLatestShortsSpend` because that function does
    // not model subjects at all — it prices ONE read per platform, and a run
    // makes one read PER TOPIC. So a quote for an unnarrowed press is a floor
    // rather than a price, and narrowing to one subject is the case where the
    // two agree. That gap predates this control and is not closed here; what is
    // not done is pretend, so nothing below multiplies a figure by a topic
    // count this file would have had to invent.
    const subjects = await topicsForRun(topicSlug);
    if (!subjects.ok) return { ok: false, message: subjects.message };
    // THE SAME CONFIGURATION THE RUN WOULD USE, including the ceiling. A price
    // quoted against an uncapped configuration would be a price for a run this
    // file would then refuse to make.
    const configuration = await meteredRunConfiguration();
    if (!configuration.ok) return { ok: false, message: configuration.message };

    const built = await buildAdapters(configuration.options);
    const forecast = await forecastLatestShortsSpend({
      // The same subset, the same limit and the same selection the run would
      // use. Every one of those three changes the figure, and a forecast made
      // against a different one of them is a quote for a different press.
      adapters: platforms
        .map((platform) => built.get(platform))
        .filter((adapter): adapter is NonNullable<typeof adapter> => adapter !== undefined),
      limit,
      minViews,
      minDurationSeconds,
      maxDurationSeconds,
      platforms,
    });
    return { ok: true, forecast };
  } catch (cause) {
    // Every per-platform failure is already folded into the forecast itself, so
    // reaching here means something structural. The words go to the log for the
    // same reason they do on the run: a metered API quotes its own URL, key
    // included, in the message it throws.
    console.error(`${LOG_TAG} the run could not be priced:`, cause);
    return {
      ok: false,
      message:
        "The run could not be priced. This deployment's server log has the reason, tagged " +
        "[admin/shorts]. Nothing was read and nothing was charged — this is not a report that a " +
        "run would be free.",
    };
  } finally {
    slot.release();
  }
}

/**
 * Resolve one short's media URL, at the moment somebody asks for it.
 *
 * NEVER STORED AND NEVER RESOLVED IN ADVANCE. A direct media URL from any of
 * these platforms is signed and expires in minutes to hours, so a table of them
 * — or even a page of them, rendered while somebody reads a long list — is a
 * set of links that look alive and are not. The canonical post URL is what
 * persists; this is the other half of Erik's "links to download them".
 *
 * IT IS BEHIND THE SAME GATE AS THE RUN, and that is not belt-and-braces. On X
 * a resolve is a Post lookup — $0.005, every press, and this endpoint takes a
 * whole record from the caller, so somebody who can POST to it can name a post
 * id this page never rendered. It is not behind the LOCK: an operator opens
 * several rows in a row and each one is a single bounded lookup, so serialising
 * them would break the page to prevent nothing.
 */
export async function resolveDownloadUrl(short: ShortRecord): Promise<DownloadOutcome> {
  const authorised = await authoriseSpend();
  if (!authorised.ok) return { ok: false, message: authorised.message };

  const platform = short?.platform;
  const url = safeHref(short?.url);
  const videoId = typeof short?.platform_video_id === "string" ? short.platform_video_id.trim() : "";

  if (!isPlatform(platform) || url === null || videoId === "") {
    // Not a refusal an operator can act on, because an operator cannot cause it
    // from the page: every row rendered there came out of a run. It is here
    // because this endpoint is reachable without the page.
    console.error(`${LOG_TAG} a download was asked for with a record that is not a short.`);
    return {
      ok: false,
      message: "That is not a short this tool produced, so no file was looked for.",
    };
  }

  // REBUILT, NOT FORWARDED. Only the four fields an adapter needs to find the
  // file survive, each one checked above. Passing the caller's object through
  // would hand a subprocess whatever else was in it.
  const record: ShortRecord = {
    ...short,
    platform,
    platform_video_id: videoId,
    url,
  };

  // ---------------------------------------------------------------------
  // A LINK THE BROWSER CAN ACTUALLY FOLLOW, WHEN THERE IS A SERVICE TO SERVE IT
  // ---------------------------------------------------------------------
  //
  // MEASURED 2026-09-08: a googlevideo URL carries a signed `ip=` and is
  // refused from any other address — 403 from here, 206 through the exit that
  // resolved it. Since the resolve runs through a proxy (YouTube gates the
  // player API by address), the URL it produces belongs to the proxy and not to
  // the operator. That is precisely what was on screen: "Open the video file"
  // leading to "Access to rr4---sn-vgqsrned.googlevideo.com was denied".
  //
  // So when a yt-dlp service is configured, this hands back a signed link to
  // ITS /file route, which fetches through the same proxy, streams the bytes,
  // and keeps nothing. No adapter is called and no proxy traffic is spent here:
  // the cost lands when, and only when, somebody actually follows the link.
  //
  // WHICH platforms is a table in lib/platform, not a fork here: see
  // LINK_IS_BOUND_TO_ITS_RESOLVER. Only YouTube is true, because only YouTube
  // has been measured. The others are false meaning "nobody has looked".
  const service = remoteYtDlpFromEnv();
  if (service && linkIsBoundToItsResolver(platform)) {
    return { ok: true, url: signedDownloadUrl(url, service) };
  }

  try {
    // The same configuration the run is built with. Asking the registry for a
    // bare adapter here was the other face of the same scar: the X row's
    // download button reached an adapter with no client and reported that X was
    // unavailable, on a row X had just returned.
    const configuration = await meteredRunConfiguration();
    if (!configuration.ok) return { ok: false, message: configuration.message };

    const adapter = await adapterFor(platform, configuration.options);
    const resolved = await adapter.downloadUrl(record);
    if (resolved === null) {
      // NULL IS NOW ONLY THIS ONE THING, and the sentence had to narrow with
      // it. Until 2026-09-08 the keyless adapters returned null for every
      // yt-dlp failure as well, so this line — "has no way to get the file" —
      // was shown to an operator whose actual problem was a per-IP bot check
      // that yt-dlp had described, in words, in a sentence naming its own fix.
      // A failure now throws and is answered below; null means the adapter ran
      // and this post had no media URL in the answer.
      return {
        ok: false,
        message:
          `The ${platformLabel(platform)} adapter has no file for this post. It was asked and it ` +
          "answered — nothing failed and nothing was refused, there is simply no media URL for " +
          "this one. The post link above still works.",
      };
    }

    const safe = safeHref(resolved);
    if (safe === null) {
      console.error(`${LOG_TAG} ${platform} resolved a media URL that is not an http address.`);
      return {
        ok: false,
        message: `The ${platformLabel(platform)} adapter answered with something that is not a web address.`,
      };
    }

    return { ok: true, url: safe };
  } catch (cause) {
    // The log line is kept whatever happens: it carries the stack and the
    // cause chain, and the sentence below is at most one line of that.
    console.error(`${LOG_TAG} ${platform} threw while resolving a media URL:`, cause);

    // THE ADAPTER'S OWN WORDS, WHEN THE ADAPTER SAID THEY WERE FIT TO PRINT.
    //
    // The run path has done this since `markSafeToShow` existed and this path
    // did not, so the same failure was a sentence on screen when it happened
    // during a run and "look in the log" when it happened on a download. That
    // asymmetry is what produced the report this comment exists for: yt-dlp
    // said "Sign in to confirm you're not a bot. Use --cookies-from-browser or
    // --cookies for the authentication", and the operator was shown a claim
    // that YouTube files were not something this tool could get at all.
    //
    // Unmarked errors still go nowhere near the page. These adapters call
    // metered APIs and an exception from one routinely quotes the URL it was
    // called with; that rule has not moved. `PlatformUnavailableError` is
    // added by hand rather than marked at its definition because
    // lib/platform/unavailable.ts sits inside lib/shorts/run.ts's own import
    // graph, and a module-evaluation-time mark there would close the ring —
    // its `reason` is composed for a person to read and is the same sentence
    // the platform card shows.
    const said =
      safeToShowMessage(cause) ?? (cause instanceof PlatformUnavailableError ? cause.reason : null);

    return {
      ok: false,
      message: said
        ? `The ${platformLabel(platform)} adapter could not get the file for this post. It said: ` +
          `${said} The post link above still works.`
        : `The ${platformLabel(platform)} adapter failed while looking for the file. The reason is ` +
          "in this deployment's server log, tagged [admin/shorts]. The post link above still works.",
    };
  }
}
