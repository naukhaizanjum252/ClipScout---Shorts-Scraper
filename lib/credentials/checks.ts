/**
 * "TEST THIS KEY", PER PROVIDER.
 *
 * WHAT ERIK ASKED FOR, IN HIS WORDS: he wants to enter a key and find out
 * whether it works — before paying anyone, and before spending two weeks in
 * Meta App Review. That is what this file is. One cheap, documented call per
 * provider, and a sentence back saying pass or fail in the API's OWN terms.
 *
 * THE RULES THIS FILE OBEYS AND THE REASON FOR EACH
 *
 * 1. ONE CALL. Not a discovery run, not a warm-up sequence. A test that spends
 *    real money at an unknown rate is a test nobody presses twice.
 *
 * 2. THE CALL IS NAMED IN THE UI BEFORE IT IS MADE. `credentialCheckPlan()`
 *    in lib/credentials/providers.ts is what the page prints next to the button:
 *    the endpoint, where it is documented, what it costs and what a pass
 *    actually proves. An operator pressing a button on a page about billable
 *    APIs is entitled to know which request they are authorising.
 *
 * 3. A FAILURE IS CLASSIFIED, NOT ECHOED. 401 and 403 mean different things and
 *    only one of them is "your key is wrong". Telling an operator their X
 *    bearer token is bad when what actually happened is that recent-counts is
 *    not in their access tier would send them to regenerate a token that was
 *    fine. Every branch below says which of the two it is.
 *
 * 4. NOTHING RETURNED FROM HERE CONTAINS A SECRET. Every message is passed
 *    through `scrub()` with every secret this check was handed, because a Meta
 *    error body echoes the request and the Graph API takes its tokens on the
 *    QUERY STRING. That is also why `scrub` strips `input_token=` and
 *    `access_token=` wholesale, for the case where an error carries a URL built
 *    somewhere this call site cannot see.
 *
 * 5. NOTHING HERE HAS EVER BEEN RUN AGAINST A LIVE API. There are no API keys
 *    on the build machine. Every endpoint, parameter and response field below
 *    was read out of the vendor's own reference on 2026-09-04 and is cited on
 *    the spot; not one of them has been observed. Where documentation and
 *    reality can differ — and on `view_count` for X they very well may — the
 *    code handles the absent value rather than assuming the documented one.
 */
import { scrub } from "./mask";
import {
  GRAPH_BASE,
  SCRAPECREATORS_AUTH_HEADER,
  SCRAPECREATORS_CREDIT_BALANCE_URL,
  X_COUNTS_URL,
  X_PROBE_QUERY,
  checkableFields,
  checkablePrimaryField,
  credentialCheckPlan,
  type CheckableProvider,
  type CredentialCheckPlan,
} from "./providers";
import { CredentialError, type CredentialValues } from "./types";
import { YouTubeClient } from "../yt/client";

/**
 * THE PLAN AND THE CALL LIVE IN DIFFERENT FILES ON PURPOSE.
 *
 * `CredentialCheckPlan` — the sentence the page prints before the button is
 * pressed — is data, and it lives in lib/credentials/providers.ts beside every
 * other per-provider sentence. So do the endpoint constants. This file imports
 * them rather than restating them, because a page that advertises one URL and a
 * client that requests another is precisely the failure a settings page about
 * billable APIs cannot have.
 */
export type { CredentialCheckPlan };

export interface CredentialCheckResult {
  readonly ok: boolean;
  /** Already scrubbed. Safe to store in `last_check_error` and to render. */
  readonly message: string;
  /** The HTTP status, when there was one. Null when the call never went out. */
  readonly status: number | null;
}

export interface CredentialCheckOptions {
  /** Injectable so the tests never touch the network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable clock, so "expires in N days" is deterministic under test. */
  readonly now?: () => Date;
}

/**
 * The permissions Instagram Business Discovery is documented to require.
 *
 * Source: developers.facebook.com, Instagram Platform, IG User business_discovery
 * reference, fetched 2026-09-04 — instagram_basic, instagram_manage_insights and
 * pages_read_engagement, plus ads_management OR ads_read when the token's Page
 * role was granted through Business Manager. The optional pair is NOT required
 * here, because requiring it would fail operators for whom it genuinely does not
 * apply; it is named in the provider notes instead.
 */
const INSTAGRAM_REQUIRED_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"] as const;

/**
 * Make the call.
 *
 * `values` comes from a lease: the sealed secrets opened in-process, plus the
 * readable identifiers. This function is the only place in the credentials
 * directory that touches the network.
 */
export async function runCredentialCheck(
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions = {},
): Promise<CredentialCheckResult> {
  const plan = credentialCheckPlan(provider);
  if (!plan) {
    throw new CredentialError(
      `There is no test call for ${provider}. Nothing in this build knows an endpoint to spend that key against.`,
    );
  }

  // Every secret this check was handed, for the scrubber. Collected once, so a
  // provider that grows a field cannot grow a message that leaks it.
  const allSecrets = Object.values(values.secrets);
  const safe = (message: string) => scrub(message, ...allSecrets).slice(0, 500);

  // A required field that is empty is a setup problem, not an API failure, and
  // reporting it as one would send somebody to regenerate a working token.
  const missing = checkableFields(provider)
    .filter((f) => f.required)
    .filter((f) => !(f.kind === "secret" ? values.secrets[f.id] : values.identifiers[f.id]))
    .map((f) => f.label);
  if (missing.length > 0) {
    return {
      ok: false,
      status: null,
      message: `Cannot test: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not stored on this credential. No call was made.`,
    };
  }

  const run = RUNNERS[provider];
  if (!run) {
    // Unreachable while a null plan and a null runner agree, which
    // `credentials.test.ts` asserts. Kept because the two tables are separate
    // declarations and a future provider could be given one and not the other.
    throw new CredentialError(`There is no test call for ${provider}.`);
  }

  try {
    return await run(provider, values, opts, safe);
  } catch (cause) {
    if (cause instanceof CredentialError) throw cause;
    // A DNS failure, a socket reset, an abort. Not a verdict on the key, and it
    // must not be recorded as one.
    return {
      ok: false,
      status: null,
      message: `The call could not be completed: ${safe(cause instanceof Error ? cause.message : String(cause))}. That is a network or configuration failure here, not a verdict on the key.`,
    };
  }
}

const INSTAGRAM_CLOSING =
  " Business Discovery still needs Business Verification and App Review before it will answer.";

/**
 * FACEBOOK IS HELD TO NO SCOPE LIST, and the empty array it is passed with in
 * the table below is the finding.
 * The Graph reference documents no read on /{page-id}/videos or
 * /{page-id}/video_reels for anyone, so there is no verified edge whose
 * permissions could be required. Requiring some anyway would be inventing a
 * rule, and failing operators over it would be inventing a rule with
 * consequences.
 */
const FACEBOOK_CLOSING =
  " This does not mean any Page's videos can be listed — see the Facebook note on this page.";

/**
 * WHICH FUNCTION MAKES WHICH CALL — A TABLE, NOT A SWITCH, AND THAT IS A RULE
 * RATHER THAN A PREFERENCE.
 *
 * lib/platform/registry.test.ts fails the build if any module outside
 * lib/platform compares against a platform name: no `=== "tiktok"`, no
 * `case "youtube":`. The reason is that a fork is something some other platform
 * silently does not take, and five of them scattered across a codebase is a tool
 * nobody can describe. This file had exactly that switch and the guard caught
 * it, which is the guard working.
 *
 * A `Record<CredentialProvider, ...>` is the endorsed shape because it is
 * STRONGER than the rule it satisfies: the compiler checks the keys, so a sixth
 * provider added to `PLATFORMS` stops this file compiling instead of silently
 * having no check and no explanation.
 *
 * `null` is TikTok. The two tables have to agree, and only ONE direction of
 * disagreement is observable: a provider with a plan and no runner prints a
 * call, offers a button and throws when it is pressed, which
 * `credentials.test.ts` catches. The reverse — a runner with no plan — is
 * unreachable, because the plan guard in `runCredentialCheck` returns before
 * this table is consulted. It is stated here rather than tested, because a test
 * that reached into a private table to assert dead code stays dead would be
 * testing the shape of the file instead of the behaviour of the product.
 */
type CheckRunner = (
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (message: string) => string,
) => Promise<CredentialCheckResult>;

const RUNNERS: Readonly<Record<CheckableProvider, CheckRunner | null>> = {
  youtube: checkYouTube,
  x: checkX,
  /**
   * ScrapeCreators sits in this table beside the five platform providers even
   * though `CREDENTIAL_PROVIDERS` does not carry it yet, because the table is a
   * `Record` over the union and the compiler is what keeps the two tables in
   * step. Adding the provider to the vocabulary later must not be the moment
   * its check is written for the first time and pressed for the first time on
   * the same afternoon.
   */
  scrapecreators: checkScrapeCreators,
  /**
   * Instagram and Facebook share one runner because they share one credential
   * shape and one token endpoint. What differs is data — which permissions are
   * checked for, and which sentence closes the result — so it is passed in
   * rather than branched on.
   */
  instagram: metaRunner(INSTAGRAM_REQUIRED_SCOPES, INSTAGRAM_CLOSING),
  facebook: metaRunner([], FACEBOOK_CLOSING),
  /**
   * THREADS DOES NOT SHARE THE META RUNNER, and could not.
   *
   * `metaRunner` inspects a token with `debug_token` on graph.facebook.com. A
   * Threads token is issued by a different authorisation server for a different
   * host and that endpoint does not know it, so pointing the shared runner at
   * one would report a working credential as invalid.
   */
  threads: checkThreads,
  tiktok: null,
};

// --------------------------------------------------------------------- YouTube

/**
 * Unchanged in substance from the check this page has always had — one
 * `channels.list` by id, budgeted to a single declared unit so the client stops
 * before a second call could ever go out. It is moved here rather than
 * rewritten, so the one provider whose check was real keeps the exact behaviour
 * that made it real.
 */
async function checkYouTube(
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (m: string) => string,
): Promise<CredentialCheckResult> {
  const apiKey = values.secrets[checkablePrimaryField(provider).id];
  const client = new YouTubeClient({
    apiKey,
    budgetUnits: 1,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  try {
    await client.call("channels.list", { part: "id", id: "UCBR8-60-B28hp2BmDPdntcQ", maxResults: 1 });
    return { ok: true, status: 200, message: "Key works. One unit spent." };
  } catch (cause) {
    const status = typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : null;
    return { ok: false, status, message: safe(cause instanceof Error ? cause.message : String(cause)) };
  }
}

// --------------------------------------------------------------------------- X

async function checkX(
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (m: string) => string,
): Promise<CredentialCheckResult> {
  const token = values.secrets[checkablePrimaryField(provider).id];
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = `${X_COUNTS_URL}?query=${encodeURIComponent(X_PROBE_QUERY)}&granularity=day`;

  const response = await doFetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const body = await readJson(response);

  if (response.status === 200) {
    // `meta.total_post_count` is documented as optional, so its absence is
    // reported as an absence rather than as zero — the same rule the rest of
    // this repo runs on.
    const total = numberAt(body, ["meta", "total_post_count"]);
    return {
      ok: true,
      status: 200,
      message:
        "X accepted the bearer token." +
        (total === null
          ? " The response carried no total post count, which is documented as optional."
          : ` The probe query matched ${total.toLocaleString("en-US")} posts in the last 7 days.`) +
        " This proves the token authenticates; it does not prove view counts come back populated.",
    };
  }

  const detail = safe(stringAt(body, ["title"]) ?? stringAt(body, ["detail"]) ?? "");
  const suffix = detail ? ` X said: ${detail}` : "";

  switch (response.status) {
    case 401:
      return {
        ok: false,
        status: 401,
        message: `X rejected the bearer token (401 Unauthorized). The token is wrong, revoked, or belongs to a different project.${suffix}`,
      };
    case 403:
      return {
        ok: false,
        status: 403,
        message:
          "X accepted the token but refused this endpoint (403 Forbidden). That usually means recent " +
          `counts is not included in your project's access level. It is NOT evidence that the token is wrong.${suffix}`,
      };
    case 429:
      return {
        ok: false,
        status: 429,
        message: `X rate-limited this check (429). Nothing was learned about the key either way — try again later.${suffix}`,
      };
    case 400:
      return {
        ok: false,
        status: 400,
        message:
          "X rejected the request itself (400 Bad Request). The probe query this build sends is fixed, " +
          `so this points at a change on X's side rather than at your token.${suffix}`,
      };
    default:
      return {
        ok: false,
        status: response.status,
        message: `X returned ${response.status}.${suffix}`,
      };
  }
}

// ---------------------------------------------------------------- ScrapeCreators

/**
 * ONE CALL TO THE ACCOUNT ENDPOINT, AND IT COSTS A CREDIT.
 *
 * `GET /v1/account/credit-balance` with the key in `x-api-key`
 * (docs.scrapecreators.com/v1/account/credit-balance, read 2026-09-04: GET, no
 * query parameters, "1 credit per request", replies with `success`,
 * `credits_remaining`, `credits_charged` and `creditCount`). The page says so
 * above the button — see `SCRAPECREATORS_INFO.check.cost` — because a Test
 * button that quietly spends money is the surprise this whole file exists to
 * avoid.
 *
 * THE BRANCH THAT MATTERS IS 402. ScrapeCreators documents Payment Required
 * among its status codes (docs.scrapecreators.com/introduction, 2026-09-04),
 * and an operator whose credits have simply run out must not be told their key
 * is wrong — they would regenerate a perfectly good key and still have no
 * credits. Same rule as the 401/403 split on X.
 *
 * NOTHING HERE HAS BEEN RUN AGAINST THE LIVE API. There is no ScrapeCreators
 * key on this machine. What is asserted in the tests is the classification, not
 * the vendor's behaviour.
 */
async function checkScrapeCreators(
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (m: string) => string,
): Promise<CredentialCheckResult> {
  const key = values.secrets[checkablePrimaryField(provider).id];
  const doFetch = opts.fetch ?? globalThis.fetch;

  const response = await doFetch(SCRAPECREATORS_CREDIT_BALANCE_URL, {
    headers: { [SCRAPECREATORS_AUTH_HEADER]: key, accept: "application/json" },
  });
  const body = await readJson(response);

  if (response.status === 200) {
    // `credits_remaining` is reported as absent rather than as zero when it does
    // not come back. Zero credits and an unanswered question are different
    // facts, and only one of them means a run will fail.
    //
    // `creditCount` IS A FALLBACK FOR IT, SINCE 2026-09-09. The live endpoint
    // dropped `credits_remaining` and returned `creditCount` as the balance —
    // confirmed by its own message, "You have 25100 credits remaining." So both
    // are read, `credits_remaining` first: when the vendor sends both, the
    // documented field wins and the old example (creditCount 333 beside a
    // `credits_remaining` of 1,000,000) still reads as 1,000,000. The sibling
    // reader behind the Check balance button — `ScrapeCreatorsClient
    // .creditBalance` — reads the same pair in the same order, so the two
    // controls on one page still agree about which field is the money.
    const remaining = numberAt(body, ["credits_remaining"]) ?? numberAt(body, ["creditCount"]);
    return {
      ok: true,
      status: 200,
      message:
        "ScrapeCreators accepted the key." +
        (remaining === null
          ? " The reply carried no credit balance, so how many credits you have left is unknown."
          : ` ${remaining.toLocaleString("en-US")} credits remaining, after the one this press spent.`) +
        " It does not prove any platform endpoint answers today — Instagram is this vendor's most " +
        "frequently broken leg, and a valid key gets a clean 200 here while a reels route is down.",
    };
  }

  const detail = safe(stringAt(body, ["error"]) ?? stringAt(body, ["message"]) ?? "");
  const suffix = detail ? ` ScrapeCreators said: ${detail}` : "";

  switch (response.status) {
    case 401:
    case 403:
      return {
        ok: false,
        status: response.status,
        message:
          `ScrapeCreators rejected the key (${response.status}). Check it was pasted whole and that ` +
          `it is sent as the ${SCRAPECREATORS_AUTH_HEADER} header rather than a bearer token — this ` +
          `API does not use Authorization: Bearer.${suffix}`,
      };
    case 402:
      return {
        ok: false,
        status: 402,
        message:
          "ScrapeCreators returned 402 Payment Required. THE KEY IS PROBABLY FINE and the account " +
          "is out of credits. Credits are bought in packs and never expire; a run will fail the " +
          `same way until the balance is topped up.${suffix}`,
      };
    case 404:
      return {
        ok: false,
        status: 404,
        message:
          `ScrapeCreators returned 404 for ${SCRAPECREATORS_CREDIT_BALANCE_URL}. That is this build ` +
          "asking for an endpoint the vendor no longer serves, not a verdict on your key. The path " +
          "was read off docs.scrapecreators.com/v1/account/credit-balance on 2026-09-04 and needs " +
          `re-checking there.${suffix}`,
      };
    default:
      return {
        ok: false,
        status: response.status,
        message: `ScrapeCreators returned ${response.status}. Nothing was proved about the key either way.${suffix}`,
      };
  }
}

// ------------------------------------------------------------------------ Meta

/**
 * Instagram and Facebook share one check because they share one credential
 * shape and one token endpoint. What differs is which permissions are checked
 * for, and that difference is data rather than a second code path.
 *
 * WHY `debug_token` AND NOT A REAL READ. A real read — Business Discovery for
 * Instagram, a Page's videos for Facebook — cannot succeed before Business
 * Verification and App Review, so a Test button wired to one would tell every
 * operator their key was broken for the two weeks in which it was fine. The
 * token endpoint answers the question that is actually answerable today:
 * is this token valid, whose app is it, when does it expire, and which of the
 * permissions you will need does it already carry.
 */
function metaRunner(requiredScopes: readonly string[], closing: string): CheckRunner {
  return (_provider, values, opts, safe) => checkMeta(requiredScopes, closing, values, opts, safe);
}

async function checkMeta(
  requiredScopes: readonly string[],
  closing: string,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (m: string) => string,
): Promise<CredentialCheckResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  const token = values.secrets.access_token;
  const appId = values.identifiers.app_id;
  const appSecret = values.secrets.app_secret;

  // The documented shortcut for an app access token: pass `{app-id}|{app-secret}`
  // as `access_token` rather than minting one first
  // (developers.facebook.com/docs/facebook-login/guides/access-tokens).
  const appToken = `${appId}|${appSecret}`;
  const url =
    `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(token)}` +
    `&access_token=${encodeURIComponent(appToken)}`;

  const response = await doFetch(url, { headers: { accept: "application/json" } });
  const body = await readJson(response);

  // Graph's transport-level failure: { error: { message, type, code } }.
  const topError = stringAt(body, ["error", "message"]);
  if (topError !== null) {
    const code = numberAt(body, ["error", "code"]);
    return {
      ok: false,
      status: response.status,
      message:
        `Meta refused the request (${response.status}${code === null ? "" : `, code ${code}`}). ` +
        `Meta said: ${safe(topError)} ` +
        "A code 190 here is the token; anything about the application is the app id or app secret.",
    };
  }

  const isValid = body !== null && typeof body === "object" && valueAt(body, ["data", "is_valid"]) === true;
  if (!isValid) {
    const reason = stringAt(body, ["data", "error", "message"]);
    return {
      ok: false,
      status: response.status,
      message:
        "Meta says this token is not valid." +
        (reason === null ? "" : ` Meta said: ${safe(reason)}`) +
        " Long-lived tokens are documented as lasting about 60 days, so an expired one is the usual cause.",
    };
  }

  const notes: string[] = [];

  // A token from a DIFFERENT app is the mistake that looks like everything
  // working: it is valid, so nothing errors, and every later call fails for a
  // reason nobody connects back to here.
  const reportedAppId = stringAt(body, ["data", "app_id"]);
  if (reportedAppId !== null && reportedAppId !== appId) {
    return {
      ok: false,
      status: response.status,
      message:
        `The token is valid but belongs to app ${reportedAppId}, not the app id you entered (${appId}). ` +
        "One of the two is from a different Meta app.",
    };
  }

  const expiresAt = numberAt(body, ["data", "expires_at"]);
  if (expiresAt === 0) {
    notes.push("It does not expire.");
  } else if (expiresAt !== null) {
    const days = Math.floor((expiresAt * 1000 - now().getTime()) / 86_400_000);
    notes.push(days < 0 ? "Meta reports it as already expired." : `It expires in about ${days} days.`);
  }

  const scopes = stringsAt(body, ["data", "scopes"]);
  const absent = requiredScopes.filter((s) => !scopes.includes(s));

  if (absent.length > 0) {
    return {
      ok: false,
      status: response.status,
      message:
        `The token is valid, but it is missing ${absent.join(", ")} — the permissions Business Discovery ` +
        "is documented to require. Those come from Meta App Review, not from regenerating the token. " +
        (notes.length > 0 ? notes.join(" ") : ""),
    };
  }

  return {
    ok: true,
    status: response.status,
    message:
      `Token accepted for app ${appId}. ${notes.join(" ")} ` +
      (scopes.length === 0
        ? "Meta reported no permissions on it."
        : `Permissions: ${scopes.slice(0, 12).join(", ")}${scopes.length > 12 ? ", and more" : ""}.`) +
      closing,
  };
}

// --------------------------------------------------------------------- Threads

/**
 * The endpoint this check spends, and WHY IT IS THE SEARCH AND NOT `/me`.
 *
 * `GET /v1.0/me` would prove the token is a token. It would pass for a
 * `threads_basic`-only credential, which is the exact credential that makes
 * this platform useless: keyword search accepts it, returns only the holder's
 * own posts, and a topic run over somebody else's videos comes back EMPTY.
 * Empty is indistinguishable from a quiet search, so the failure would be
 * discovered as "Threads never finds anything" weeks later rather than on the
 * page where the key was pasted.
 *
 * So the check performs the call the product actually depends on. A 200 here
 * means the token authenticates AND carries `threads_keyword_search`; anything
 * else is reported with Meta's own words.
 */
const THREADS_SEARCH_URL = "https://graph.threads.net/v1.0/keyword_search";

/**
 * A term chosen to match a lot and mean nothing.
 *
 * It is sent with `limit=1`, so the reply is one post at most. The point is the
 * STATUS CODE, not the content — a term with no results would return the same
 * 200 and prove the same thing, but a term that matches keeps an empty reply
 * meaningful as a signal that something is wrong with the scope rather than
 * with the word.
 */
const THREADS_PROBE_TERM = "video";

async function checkThreads(
  provider: CheckableProvider,
  values: CredentialValues,
  opts: CredentialCheckOptions,
  safe: (m: string) => string,
): Promise<CredentialCheckResult> {
  const token = values.secrets[checkablePrimaryField(provider).id];
  const doFetch = opts.fetch ?? globalThis.fetch;

  const url = new URL(THREADS_SEARCH_URL);
  url.searchParams.set("q", THREADS_PROBE_TERM);
  url.searchParams.set("media_type", "VIDEO");
  url.searchParams.set("search_type", "TOP");
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", "1");
  // IN THE QUERY STRING, matching `metaGet`. Meta accepts a bearer header on
  // some hosts and not on others; the query parameter is what every Threads
  // example uses. The scrubber above holds this secret, so nothing built from
  // this URL can print it.
  url.searchParams.set("access_token", token);

  const response = await doFetch(url.toString(), { headers: { accept: "application/json" } });
  const body = await readJson(response);

  if (response.status === 200) {
    /**
     * A 200 IS NOT THE ANSWER, AND READING IT AS ONE WAS THIS CHECK'S OWN BUG.
     *
     * The comment above says the probe term was chosen so "an empty reply
     * [stays] meaningful as a signal that something is wrong with the scope" —
     * and then the code returned `ok: true` on the status alone and never
     * looked at the rows. Meta documents the failure this misses in one
     * sentence: if the app has not been approved for `threads_keyword_search`,
     * "the search will be performed only on posts owned by the authenticated
     * user". That is a 200. The credential this slot's notes call useless —
     * standard access, searching nobody but its holder — passed the button
     * built to catch it, which is the false green in the exact place this repo
     * keeps arguing green must be earned.
     *
     * So the ROWS decide. `video` with `search_type=TOP` across all of Threads
     * returns something; the same search across one person's own video posts
     * almost certainly returns nothing. Empty is therefore evidence of
     * narrowing, not evidence of a quiet API.
     *
     * A FALSE NEGATIVE HERE IS CHEAP AND A FALSE POSITIVE IS NOT. Reporting an
     * advanced-access token as unproven costs one more press of a button that
     * bills nothing. Reporting a standard-access token as proven costs weeks of
     * topic runs that look like quiet days.
     */
    const rows = valueAt(body, ["data"]);

    if (Array.isArray(rows) && rows.length > 0) {
      return {
        ok: true,
        status: 200,
        message:
          "Threads answered a keyword search WITH RESULTS, which a token limited to its own " +
          "posts would almost certainly not have done for a term this broad — so it carries " +
          "threads_keyword_search and can see other people's public posts, the one thing this " +
          "platform is for. It does not mean any result can be MEASURED: Meta publishes view " +
          "counts for your own posts only and publishes no duration at all, so Threads rows are " +
          "always reported as unverified rather than counted against the 500,000 threshold.",
      };
    }

    if (Array.isArray(rows)) {
      return {
        ok: false,
        status: 200,
        message:
          `Threads accepted the token and returned NO posts for ${JSON.stringify(THREADS_PROBE_TERM)}, ` +
          "which is the documented shape of a token that has not been approved for " +
          "threads_keyword_search: Meta then performs the search over the holder's own posts " +
          "only, and answers 200 while doing it. A term this broad matches across all of " +
          "Threads, so an empty page points at the SCOPE rather than at the word. Advanced " +
          "access for threads_keyword_search comes from App Review; standard access is enough " +
          "to call the endpoint and not enough to make it useful. Reported as unproven rather " +
          "than as working, because a topic run on this token would come back empty and read " +
          "as a quiet day.",
      };
    }

    return {
      ok: false,
      status: 200,
      message:
        "Threads answered 200 with no `data` array at all, so nothing here can be checked " +
        "against the one thing the call was made to establish. That is an unreadable answer " +
        "rather than an empty one, and it is not a working key until it can be read.",
    };
  }

  // Meta nests its complaint at error.message and repeats the machine-readable
  // half at error.type. The message is the one worth showing: it names the
  // missing permission by its actual scope string.
  const detail = safe(stringAt(body, ["error", "message"]) ?? stringAt(body, ["error", "type"]) ?? "");
  const suffix = detail ? ` Meta said: ${detail}` : "";

  switch (response.status) {
    case 400:
    case 401:
    case 403:
      return {
        ok: false,
        status: response.status,
        message:
          `Threads rejected the call (${response.status}). The usual cause is the SCOPE rather ` +
          "than the token: keyword search over other people's posts needs " +
          "threads_keyword_search alongside threads_basic, and that one needs App Review. The " +
          "other usual cause is a Facebook Page token pasted here — Threads has its own OAuth on " +
          `threads.net and does not accept Meta's.${suffix}`,
      };
    case 429:
      return {
        ok: false,
        status: 429,
        message:
          "Threads rate-limited this call, which means the token is real — an unauthenticated " +
          `request would have been refused before it counted. Wait and press it again.${suffix}`,
      };
    default:
      return {
        ok: false,
        status: response.status,
        message:
          `Threads answered ${response.status}, which is neither an acceptance nor a documented ` +
          `refusal. Treating it as a failure: a key that cannot be shown to work has not been ` +
          `shown to work.${suffix}`,
      };
  }
}

// ------------------------------------------------------------------- plumbing

/**
 * A response body, or null.
 *
 * NEVER THROWS ON A BODY. An HTML error page from a proxy is a perfectly normal
 * thing to receive, and a JSON parse failure in the middle of a credential check
 * would surface as "the call could not be completed" — which is a different and
 * wrong diagnosis from "the API returned 502".
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringAt(source: unknown, path: readonly string[]): string | null {
  const value = valueAt(source, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberAt(source: unknown, path: readonly string[]): number | null {
  const value = valueAt(source, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringsAt(source: unknown, path: readonly string[]): string[] {
  const value = valueAt(source, path);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
