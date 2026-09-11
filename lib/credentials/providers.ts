/**
 * WHAT EACH PROVIDER'S CREDENTIAL ACTUALLY IS, WHAT IT BUYS, WHAT IT CANNOT
 * BUY, AND WHETHER ANYTHING IN THIS BUILD SPENDS IT.
 *
 * The credential store is provider-agnostic on purpose — it seals bytes and
 * hands them back, and it must not grow a `switch` on YouTube. But the page an
 * operator pastes a key into cannot be agnostic: "paste a key" with no answer to
 * "a key from where, and what will it do" is how somebody ends up creating a
 * Google Cloud project for a platform this tool cannot read at all. So the
 * per-provider prose lives here, in one table, next to the vocabulary rather
 * than inside a component.
 *
 * THE `limits` FIELD IS THE POINT OF THE 2026-09-04 REWRITE.
 *
 * Erik asked for Instagram and Facebook to be scaffolded so a key can be entered
 * and TESTED, because he wants to find out whether they work before paying
 * anyone. The answer, read out of Meta's own reference, is largely NO — and a
 * settings page that takes a Meta key without saying so would cost an operator
 * Business Verification plus App Review, which is weeks, to discover a hole that
 * is documented today. Each entry below carries the constraints that decide
 * whether the platform can serve this product at all, with the reference they
 * came from. They are printed on the page, above the Save button.
 *
 * The three that matter most, stated here so they are not buried:
 *
 *   INSTAGRAM MEDIA HAS NO DURATION FIELD. Not "we did not request it" — there
 *   is no field. The 120-second Shorts ceiling, which is the only thing that
 *   defines a Short in this product, cannot be evaluated from official
 *   Instagram data at all.
 *
 *   INSTAGRAM HASHTAG SEARCH, the only cross-account discovery Meta offers,
 *   returns no view count and no duration. It cannot answer a 500,000-view
 *   filter on its own.
 *
 *   FACEBOOK'S GRAPH REFERENCE DOCUMENTS NO READ ON A PAGE'S VIDEOS. Both
 *   /{page-id}/videos and /{page-id}/video_reels say, verbatim, under Reading:
 *   "You can't perform this operation on this endpoint." Verified against
 *   developers.facebook.com on 2026-09-04. That is stronger than the working
 *   assumption this round started with, which was that the edges work for Pages
 *   the operator administers, and the disagreement is written down rather than
 *   resolved by guessing.
 *
 * WHAT HAS AND HAS NOT BEEN OBSERVED. There are no API keys on the build
 * machine. Every claim below was read out of a vendor reference on the date
 * given and NONE of it has been seen come back from a live call. That is why the
 * check plans say what a pass proves and, more usefully, what it does not.
 *
 * `usedBy` IS THE HONEST FIELD AND IT IS THE REASON THIS FILE EXISTS.
 *
 * It answers, for each provider: does anything on the "Get latest shorts" path
 * spend this key, and what exactly happens to it.
 *
 * SCAR, 2026-09-04 review. It used to be `string | null`, it was null for x,
 * instagram and facebook, and IT WAS RENDERED ON NO SCREEN AT ALL. So the one
 * field this file calls its reason for existing was invisible to the only
 * person it was written for. The page invited an operator to paste a bearer
 * token that bills their card by the Post, and to start Meta Business
 * Verification and App Review — weeks — with nothing anywhere saying what this
 * build would do with the result. Meanwhile `youtube` carried the confident
 * string "the YouTube Data API v3 client (lib/yt/)" while nothing on the run
 * path had ever leased a YouTube credential, so the one non-null value was the
 * one false one.
 *
 * It is now a required pair — a boolean the tests can check and a paragraph the
 * operator reads — and the panel prints the paragraph in every slot, empty
 * slots included. "Nothing yet" is a legitimate and useful answer; being unable
 * to find the answer is not.
 *
 * IT MUST BE UPDATED BY WHOEVER CHANGES THE WIRING, and this is no longer left
 * to good intentions: tests/credential-honesty.test.tsx reads the run path's
 * own source and fails if a provider claims `onARun` while nothing there leases
 * it, or denies it while something does. A stale `true` tells an operator their
 * key is being spent when it is not; a stale `false` tells them a key is idle
 * while it bills their account. Neither is survivable on this page.
 *
 * `usedBy` is deliberately NOT what decides whether the Test button appears;
 * `check` decides that, because being able to prove a key is valid is useful
 * long before anything is ready to spend it.
 */
import { credentialFields, primaryField, type CredentialField } from "./fields";
import { platformLabel, type Platform } from "../platform/types";
import {
  CREDENTIAL_PROVIDERS,
  credentialProviderKind,
  platformsServedBy,
  type CredentialProvider,
  type CredentialProviderKind,
  type VendorCredentialProvider,
} from "./types";

/**
 * THE GRAPH API VERSION THIS BUILD CALLS. ONE DECLARATION, FOR THE WHOLE BUILD.
 *
 * PINNED, NOT UNVERSIONED. An unversioned Graph call is served by whatever
 * version Meta considers current for the app, so a response shape can change
 * under a deployment nobody touched.
 *
 * WHICH VERSION, re-read on developers.facebook.com on 2026-09-04:
 * versioning names v26.0 as the latest, and the changelog gives its release as
 * 29 July 2026 with its expiry still "TBD" — v25.0, the version before it, is
 * listed as expiring 29 July 2028. Meta's guarantee is at least two years from
 * release, so v26.0 has until 2028-07-29 at the very least. Nothing here has
 * been observed coming back from a live call; there is no Meta token on this
 * machine.
 *
 * SCAR, 2026-09-04 review: THERE WERE TWO OF THESE IN ONE BUILD. This file
 * pinned v26.0 and lib/platform/meta-client.ts pinned v25.0, so the URL printed
 * on the credentials page above the Test button, the URL that button actually
 * requested, and the URL the Instagram and Facebook adapters requested on a run
 * were not all the same. Two pins is not twice as safe — it is a build where
 * "which version are we on" has no answer, and where a version sunset would
 * take out half the calls and leave the other half working, which is the
 * hardest possible way to notice.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH and lib/platform/meta-client.ts is to
 * import it, not restate it. The direction was chosen because lib/platform
 * already depends on lib/credentials (meta-client imports `scrub` from
 * ../credentials/mask), while nothing in lib/credentials imports meta-client —
 * so the pin can move here without a cycle, and the sentence printed on the
 * page cannot drift from the URL requested.
 */
export const GRAPH_VERSION = "v26.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Threads is a different host on a different version line, and both halves
 * matter: graph.facebook.com does not serve keyword_search, and v1.0 is what
 * Meta's Threads reference uses while the Graph API is many majors past it.
 */
export const THREADS_BASE = "https://graph.threads.net/v1.0";

/**
 * `api.x.com`, not `api.twitter.com`. The endpoint reference at
 * docs.x.com/x-api/posts/recent-search-counts gives the full URL as
 * https://api.x.com/2/tweets/counts/recent (fetched 2026-09-04).
 */
export const X_COUNTS_URL = "https://api.x.com/2/tweets/counts/recent";

/**
 * The probe query. ARBITRARY ON PURPOSE — the check reads the HTTP status and
 * nothing else, so the only requirement is that it be a valid v2 search query
 * (the reference says `query` is a required string of 1 to 4096 characters).
 * A single common keyword satisfies that with no operator syntax to get wrong.
 */
export const X_PROBE_QUERY = "shorts";

/**
 * ============================================================================
 * SCRAPECREATORS — THE VENDOR ERIK CHOSE ON 2026-09-04
 * ============================================================================
 *
 * THE FIRST CREDENTIAL IN THIS BUILD THAT IS NOT NAMED AFTER A PLATFORM. One
 * key serves three of them, which is the case lib/credentials/types.ts and
 * supabase/migrations/20260901_02_credentials.sql both wrote down in advance:
 * "If a third-party data provider is ever chosen for one of these, it gets its
 * own enum value and may well serve several platforms at once."
 *
 * THE SLOT EXISTS AS OF THIS CHANGE. It did not on 2026-09-04, and the
 * paragraph that stood here listed the three files that had to widen before an
 * operator could save a key: `CREDENTIAL_PROVIDERS` in lib/credentials/types.ts,
 * the field specs in lib/credentials/fields.ts, and the `credential_provider`
 * enum in Postgres. All three have. The consequence of their NOT having is the
 * scar the vocabulary rewrite carries: a complete vendor client sat in
 * lib/platform/scrapecreators.ts with no production call site, because there
 * was no credential for the registry to lease it from, and the whole suite
 * stayed green while the file was moved out of the tree.
 *
 * What is here is what has always been here: the endpoints, the prices, the two
 * risks and a working Test call — all read out of the vendor's own pages on the
 * date given below, and NONE of it observed against a live API, because there
 * is no ScrapeCreators key on this machine.
 *
 * WHAT WAS FETCHED, AND WHEN. Every figure in this section came off one of
 * these on 2026-09-04. Re-fetch before asserting any of it again; a stale price
 * in this repo has already had to be corrected once.
 *
 *   scrapecreators.com                          pricing, credit expiry
 *   docs.scrapecreators.com/introduction        auth header, status codes,
 *                                               the rate-limit statement
 *   docs.scrapecreators.com                     the endpoint index
 *   docs.scrapecreators.com/v1/account/credit-balance
 *   docs.scrapecreators.com/v1/instagram/user/reels
 *   docs.scrapecreators.com/v1/tiktok/profile
 */

/**
 * The API host. Every documented endpoint hangs off it, and the docs give the
 * full URL rather than a base plus a path — `/v1/tiktok/profile`'s reference
 * prints "https://api.scrapecreators.com/v1/tiktok/profile" (fetched
 * 2026-09-04). It is declared once here so no second file has to spell it.
 */
export const SCRAPECREATORS_API_BASE = "https://api.scrapecreators.com";

/**
 * `x-api-key`, NOT `Authorization: Bearer`.
 *
 * docs.scrapecreators.com/introduction, fetched 2026-09-04, verbatim: "All API
 * requests require authentication using an API key. You'll need to include your
 * API key in the `x-api-key` header with every request." Getting this wrong
 * produces a 401 that reads exactly like a bad key, which is the worst way for
 * a first paid call to fail, so the header name is a declared constant rather
 * than a string typed twice.
 */
export const SCRAPECREATORS_AUTH_HEADER = "x-api-key";

/**
 * THE TEST CALL. `GET /v1/account/credit-balance`
 * (docs.scrapecreators.com/v1/account/credit-balance, fetched 2026-09-04:
 * method GET, full URL as below, `x-api-key` required, no query parameters,
 * "1 credit per request", response fields `success`, `credits_remaining`,
 * `credits_charged`, `creditCount`).
 *
 * CHOSEN OVER A PLATFORM ENDPOINT ON PURPOSE. Every scraping route costs the
 * same one credit, so nothing is saved by probing TikTok instead — but a
 * platform probe answers a question about one platform, returns somebody
 * else's content, and fails for reasons that have nothing to do with the key
 * (a handle that no longer exists, an upstream migration). The account endpoint
 * answers exactly the question the button asks — is this key real — and it
 * answers with the balance, which is the other thing an operator wants to know
 * before a run spends it.
 */
export const SCRAPECREATORS_CREDIT_BALANCE_URL = `${SCRAPECREATORS_API_BASE}/v1/account/credit-balance`;

/**
 * The vendor's id, spelled once.
 *
 * It is annotated as `VendorCredentialProvider` rather than left as a bare
 * string literal, so that a typo here fails at this line instead of quietly
 * producing a provider id the store has never heard of.
 */
export const SCRAPECREATORS_PROVIDER = "scrapecreators" satisfies VendorCredentialProvider;
export type ScrapeCreatorsProvider = typeof SCRAPECREATORS_PROVIDER;

/**
 * A provider the Test button can be pressed for.
 *
 * SCAR, and a deliberate tombstone rather than a deletion. This union used to
 * be WIDER than `CredentialProvider` — `CredentialProvider | "scrapecreators"`
 * — because the vendor's check had to exist and be tested before the vocabulary
 * had any word for the vendor at all. That was the honest shape while the alias
 * in lib/credentials/types.ts stood.
 *
 * The alias is gone and the two unions are now the same type. The name stays
 * because lib/credentials/checks.ts is built on it and renaming a type across a
 * file this change does not own would be churn; what it must not do is grow a
 * second meaning. If a future provider is checkable but not saveable, that is a
 * new fact and needs its own declaration, not this one quietly widening again.
 */
export type CheckableProvider = CredentialProvider;

/**
 * What the page prints beside the Test button, BEFORE it is pressed.
 *
 * Four sentences, because "makes a test call" is not something an operator can
 * consent to on a page about billable APIs. They are entitled to know which
 * request they are authorising, where it is documented, what it costs and what
 * a green result would actually mean.
 */
export interface CredentialCheckPlan {
  /** The request, as the vendor writes it. */
  readonly call: string;
  /** The reference this was read from, so nobody takes this file's word. */
  readonly source: string;
  /** What one press costs, in that API's own units. */
  readonly cost: string;
  /** What a pass proves — and, deliberately, what it does not. */
  readonly proves: string;
}

/**
 * WHAT THIS BUILD DOES WITH A KEY, IN A FORM AN OPERATOR CAN READ BEFORE THEY
 * SPEND ANYTHING.
 *
 * Two fields because there are two audiences and they need different things.
 * `onARun` is for the tests: a boolean can be checked against the run path's
 * own source, and tests/credential-honesty.test.tsx does exactly that, so the
 * claim cannot quietly go stale when the wiring changes. `detail` is for the
 * person about to paste a billable token or start Meta App Review, and it is
 * printed verbatim in that provider's slot.
 *
 * `detail` is required and may never be empty, including — especially —
 * when the answer is that nothing spends this key. "Nothing yet, and here is
 * what would have to change" is information. A blank is what a settings page
 * offers when nobody has done the work of finding out.
 */
export interface CredentialSpend {
  /**
   * True only when something on the "Get latest shorts" path leases this
   * provider's credential. The Test button does not count: it is one press an
   * operator chose, not a run.
   */
  readonly onARun: boolean;
  /** What spends it, what does not, and what would have to change. Rendered. */
  readonly detail: string;
}

/**
 * ONE NUMBERED ERRAND ON THE WAY TO A KEY.
 *
 * Erik, 2026-09-05: *"I just want a link someone with an account can hit so that
 * we can buy the needed API key and then a second link to actually reach the API
 * key"*, then *"I need those links displayed as steps on the X platform keys
 * box"*. `where.signup` is ONE link, and X is TWO errands in a fixed order:
 * money first, token second. Doing them the other way round gets you a token
 * that is refused, and an operator reading a single "get a key" link has no way
 * to know that from the page.
 *
 * OPTIONAL, AND THAT IS THE HONEST SETTING. A provider with no `steps` renders
 * the flat signup and docs links it always did. Requiring the field would mean
 * typing a click-path for five consoles nobody on this machine has walked
 * through, and an invented click-path is worse than the front door: it sends
 * somebody hunting for a button that may not be there.
 *
 * THE RENDERED TEXT STAYS SHORT ON PURPOSE. Erik, 2026-09-05, when the limits
 * came off this screen: it is a page for entering credentials, not for reading
 * about APIs. The receipts — which doc, read on which day — live in the comments
 * beside each step, not in `detail`.
 */
export interface CredentialStep {
  /** The errand, in the imperative. "Buy API credits", not "Credits". */
  readonly label: string;
  /** Where it is done. Absolute https; rendered as the step's own link. */
  readonly href: string;
  /** One line: what to do when the page opens, or what not to grab by mistake. */
  readonly detail: string;
}

export interface CredentialProviderInfo {
  readonly id: CredentialProvider;
  /**
   * Whether this slot is a platform's own API or a reseller serving several.
   *
   * DERIVED IN `credentialProviderInfo()` AND NOT WRITTEN IN THE TABLE BELOW.
   * A hand-typed `kind` is a second declaration of something
   * lib/credentials/types.ts already decides, and the two would eventually
   * disagree — with the page grouping a vendor key under the platform heading
   * and nothing going red.
   */
  readonly kind: CredentialProviderKind;
  /**
   * WHICH PLATFORMS THIS KEY BUYS. One for a platform provider — itself — and
   * three for ScrapeCreators.
   *
   * Also derived, from `platformsServedBy`, for the same reason and with more
   * at stake: this is the list an operator reads to decide whether one purchase
   * covers the platforms they care about.
   */
  readonly serves: readonly Platform[];
  /** "YouTube", "TikTok" — from `platformLabel`, so one file spells them. */
  readonly label: string;
  /** What the operator is being asked to paste, in the words the issuer uses. */
  readonly keyLabel: string;
  /**
   * The development-only environment variable for the PRIMARY secret. Read by
   * `EnvCredentialStore` on a laptop and by nothing in production. The other
   * fields declare their own; see lib/credentials/fields.ts.
   */
  readonly envVar: string;
  /** Every field this provider's credential is made of, in form order. */
  readonly fields: readonly CredentialField[];
  /**
   * What this build does with a key for this provider. Always answered, always
   * rendered, and checked against the run path's source by
   * tests/credential-honesty.test.tsx.
   *
   * The prose has to NAME THE MODULE, so an operator or a reviewer can check
   * the claim by opening it rather than by trusting this file.
   */
  readonly usedBy: CredentialSpend;
  /** One sentence for the operator: what a key here buys, or why it sits idle. */
  readonly note: string;
  /**
   * The constraints that decide whether this platform can serve the product,
   * each ending in the reference it was read from. Printed on the page.
   *
   * These are not caveats. For Instagram and Facebook they are the answer to the
   * question Erik asked, and an operator who reads them before starting App
   * Review has been saved the two weeks that reading them afterwards costs.
   */
  readonly limits: readonly string[];
  /** The one cheap documented call the Test button makes, or null. */
  /**
   * WHERE THE OPERATOR GOES TO GET THIS KEY.
   *
   * Erik, 2026-09-04: "make is so that the scrapecreators link is in the
   * credentials section so that we can link it directly". The generalisation is
   * the right one — every provider here sends somebody to a different console
   * with a different sign-up flow, and a page that says "paste your key" while
   * making the operator hunt for where to get it is doing half a job.
   *
   * `signup` is where you obtain it; `docs` is where its shape is documented.
   * Both are rendered as real links. A provider nobody can find the console for
   * is a provider nobody can onboard, so this is required rather than optional
   * and a test asserts every provider fills it in.
   */
  readonly where: { readonly signup: string; readonly docs: string };

  /**
   * THE SAME QUESTION, ANSWERED IN ORDER, WHERE ONE LINK CANNOT DO IT.
   *
   * Rendered as a numbered list in that provider's slot, in place of the single
   * "Get a … key" link. `where.signup` stays populated and must agree with the
   * first step — a slot cannot send an operator to two different front doors.
   * See `CredentialStep` for why this is optional.
   */
  readonly steps?: readonly CredentialStep[];

  readonly check: CredentialCheckPlan | null;
}

const INFO: Record<CredentialProvider, Omit<CredentialProviderInfo, "envVar" | "fields" | "kind" | "serves">> = {
  youtube: {
    id: "youtube",
    where: { signup: "https://console.cloud.google.com/apis/library/youtube.googleapis.com", docs: "https://developers.google.com/youtube/v3/getting-started" },
    label: platformLabel("youtube"),
    keyLabel: "YouTube Data API v3 key",
    /**
     * SCAR, 2026-09-04 review. This said "the YouTube Data API v3 client
     * (lib/yt/)" and it was the only non-null value in the table, which made it
     * read as the one platform whose key was definitely being used. It was not.
     * `YouTubeAdapter` hydrates with `videos.list` only when it is handed a
     * `YouTubeClient`, and lib/platform/registry.ts leases `x`, `instagram` and
     * `facebook` — never `youtube` — so the client it would pass is always
     * null. The claim was checkable and nobody checked it; the test now does.
     */
    usedBy: {
      onARun: false,
      detail:
        "NOTHING SPENDS THIS KEY ON A RUN YET. YouTube is read WITHOUT a key, by walking the uploads " +
        "playlist with yt-dlp (lib/platform/youtube.ts). That adapter hydrates the rows that survive " +
        "the filter with `videos.list` — publish dates, likes, comments — but only when it is handed a " +
        "YouTubeClient, and lib/platform/registry.ts leases X, Instagram and Facebook credentials on a " +
        "run and never a YouTube one. So those three fields stay null on every run whether or not you " +
        "save a key here. What a saved key does spend today is one unit per press of Test this key, " +
        "and one per `pnpm verify:quota`. Saving one costs nothing and buys nothing on a run until the " +
        "registry leases this provider the way it already leases X.",
    },
    note:
      "From your own Google Cloud project: enable YouTube Data API v3, create an API key. " +
      "YouTube can also be read without one, so this key is an upgrade rather than a requirement — " +
      "what it adds is publish dates, which the keyless walk carried for none of the 137 uploads in " +
      "lib/platform/fixtures/ytdlp-uploads-137.json.",
    limits: [
      "Quota is per Google Cloud project, and it is yours. The daily allowance is read off your own " +
        "console and recorded against this credential; this tool holds no default figure for it, " +
        "because a quota number that is not a measurement is a number that will be wrong.",
      "The unit costs and the separate per-endpoint call ration this build models are in " +
        "lib/yt/cost.ts, taken from Google's quota-cost table.",
    ],
    check: {
      call: "GET youtube/v3/channels?part=id&id=UCBR8-60-B28hp2BmDPdntcQ",
      source: "developers.google.com/youtube/v3/docs/channels/list",
      cost: "1 unit of your project's daily allowance.",
      proves:
        "The key is accepted AND YouTube Data API v3 is enabled on the Cloud project behind it — " +
        "a key with the API switched off fails here with its own distinct reason, which is the most " +
        "common setup mistake there is.",
    },
  },

  /**
   * TIKTOK. THE SLOT IS REAL AND THERE IS NOTHING TO PUT IN IT.
   *
   * The honest sentence, and it is a finding rather than a shortfall: a
   * scheduler can REFRESH a list of TikTok creators somebody supplied, and it
   * cannot GROW one. yt-dlp 2026.07.04 has a working `tiktok:user`; its
   * `tiktok:tag`, `tiktok:sound` and `tiktok:effect` extractors are all marked
   * CURRENTLY BROKEN upstream and there is no trending extractor at all. All
   * three official TikTok APIs — Research, Display, Commercial Content — are
   * closed to this use. Anything that claims keyless auto-discovery of new
   * TikTok creators is inventing a capability.
   */
  tiktok: {
    id: "tiktok",
    where: { signup: "https://scrapecreators.com", docs: "https://docs.scrapecreators.com" },
    label: platformLabel("tiktok"),
    keyLabel: "TikTok data provider key",
    usedBy: {
      onARun: false,
      detail:
        "NOTHING SPENDS A TIKTOK KEY ON A RUN, and this slot is not where the TikTok vendor key " +
        "goes. TikTok is read keylessly through yt-dlp's `tiktok:user` (lib/platform/tiktok.ts), " +
        "which refreshes creators you named and cannot discover new ones. The discovery that fills " +
        "that gap was bought on 2026-09-04 from ScrapeCreators, and ONE ScrapeCreators key covers " +
        "TikTok, Instagram and Facebook together — so it belongs in its own slot rather than three " +
        "platform-shaped ones. That slot does not exist yet; see the limits below for exactly what " +
        "has to change. A key pasted into this box today is sealed, stored, and idle.",
    },
    note:
      "TikTok is read WITHOUT a key: yt-dlp's `tiktok:user` extractor works, so a scheduled run can " +
      "refresh a list of creators you supply. What no key in THIS box buys is DISCOVERY of creators " +
      "nobody named — TikTok's Research, Display and Commercial Content APIs are all closed to this " +
      "use. Discovery now has a chosen vendor, ScrapeCreators, whose single key also serves " +
      "Instagram and Facebook and therefore needs a slot of its own. Until that slot exists a key " +
      "saved here is stored, encrypted, and unused.",
    limits: [
      "There is no test call for this slot, because there is no TikTok-key endpoint this build " +
        "could call without inventing one. ScrapeCreators does have one, and it is documented in " +
        "SCRAPECREATORS_INFO in this file — it needs the `scrapecreators` provider to exist in " +
        "lib/credentials/types.ts, in lib/credentials/fields.ts and in the `credential_provider` " +
        "enum in Postgres before an operator can save a key against it.",
      "yt-dlp 2026.07.04, on this machine: `tiktok:user` works; `tiktok:tag`, `tiktok:sound` and " +
        "`tiktok:effect` are marked CURRENTLY BROKEN upstream; there is no trending extractor. " +
        "ScrapeCreators lists a trending feed and keyword and hashtag search " +
        "(docs.scrapecreators.com, read 2026-09-04), which is the one leg where the vendor buys " +
        "discovery this repo could not otherwise get at all.",
    ],
    check: null,
  },

  /**
   * X. THE ONE LEG WITH A REAL OFFICIAL API, AND ONE LOAD-BEARING UNKNOWN.
   *
   * Verified against docs.x.com on 2026-09-04: X API v2 is priced per resource
   * RETURNED at $0.005 per Post read with no subscription tier, capped at 3
   * million reads per cycle, and a separate "Media Metadata" line item is priced
   * at $0.005 per REQUEST rather than per resource.
   * `media.public_metrics.view_count` is documented as publicly readable
   * alongside `duration_ms` and `variants`, which means X can in principle
   * return the discovery, the view count, the duration and a video URL in one
   * response — no second hop needed.
   *
   * WHAT IS NOT VERIFIED, AND THE WHOLE LEG RESTS ON IT: whether `view_count` is
   * actually POPULATED for arbitrary third-party videos. A field documented as
   * readable is not the same as a field that comes back non-null on real posts.
   * A null there must be shown as an unknown and never as zero views.
   */
  x: {
    id: "x",
    /**
     * THE FRONT DOOR MOVED, AND THE OLD ONE STILL ANSWERS — WHICH IS THE TRAP.
     *
     * This used to point at https://developer.x.com/en/portal/dashboard. That
     * URL is not dead (it 307s to a login, checked 2026-09-05), which is
     * precisely why it had to be re-checked rather than left alone: a link that
     * resolves is not a link that is current. X's own documentation now sends
     * every new developer to the Developer Console at console.x.com — "Visit
     * console.x.com and sign in with your X account", Step 1 of
     * docs.x.com/x-api/getting-started/getting-access, read 2026-09-05 — and
     * that is also where credits are bought, so both errands below are on that
     * host and the old portal is named nowhere on screen.
     */
    where: { signup: "https://console.x.com", docs: "https://docs.x.com/x-api/introduction" },
    /**
     * TWO ERRANDS, AND THE ORDER IS LOAD-BEARING.
     *
     * Erik, 2026-09-05: *"I need those links displayed as steps on the X
     * platform keys box"*. He is right that it is two links and not one, and
     * the reason is the pricing model rather than the console's layout.
     *
     * WHAT WAS VERIFIED, AND WHEN. docs.x.com/x-api/getting-started/pricing,
     * read 2026-09-05 (the page itself carries dateModified 2026-08-13): "The X
     * API uses pay-per-usage pricing. No subscriptions — pay only for what you
     * use." Credits are purchased UP FRONT in the Developer Console and drawn
     * down per request; Posts: Read is $0.005 per resource returned and Counts:
     * Recent — the call this page's Test button makes — is $0.005 per request.
     * "It is possible for an account credit balance to go slightly negative. In
     * this case, API requests will be blocked until you add credits."
     *
     * THAT LAST SENTENCE IS WHY BUYING COMES FIRST. A perfectly valid bearer
     * token with no balance behind it is refused, and the refusal arrives at
     * this repo as an API error on a key the operator just pasted and tested —
     * indistinguishable, on screen, from a bad key. Ordering the steps is the
     * cheapest possible fix for that, and it costs one numeral.
     *
     * THERE IS NO PLAN TO PICK, and the step says so. Anyone who last looked at
     * this API in its Free/Basic/Pro years will go hunting for a tier page that
     * no longer exists.
     *
     * STEP TWO NAMES THE WRONG CREDENTIALS ON PURPOSE. The console hands out
     * four things (docs.x.com/x-api/getting-started/getting-access, read
     * 2026-09-05): API Key & Secret, Bearer Token, Access Token & Secret, and
     * Client ID & Secret. This box wants the second. Three of the four are
     * sitting next to it on the same screen, all plausible, and the same page
     * warns that each is displayed once and a lost one is REGENERATED — which
     * invalidates the old one — rather than recovered.
     */
    steps: [
      {
        label: "Buy X API credits",
        href: "https://console.x.com",
        detail:
          "Pay-per-use, so there is no plan to choose. Do this first: a valid token with no credit " +
          "behind it is refused, and that reads on this page as a bad key.",
      },
      {
        label: "Copy the bearer token",
        href: "https://console.x.com/apps",
        detail:
          "Your app, then Bearer Token — not the API Key & Secret beside it. X shows it once, so " +
          "paste it here before you close the tab.",
      },
    ],
    label: platformLabel("x"),
    keyLabel: "X API v2 bearer token (app-only)",
    usedBy: {
      onARun: true,
      detail:
        "YES — AND THIS IS THE ONE THAT COSTS REAL MONEY. When you press “Get latest shorts”, " +
        "lib/platform/registry.ts leases the active X credential, builds an XClient from it " +
        "(lib/platform/x-client.ts) and hands it to the X adapter, which searches recent Posts with " +
        "your query. X charges $0.005 for every Post RETURNED, so the size of the bill is decided by " +
        "how much your query matches rather than by how many requests are sent: a query that starts " +
        "matching ten times as much costs ten times as much with nothing in this repo changing. The " +
        "cap is yours to set in X_MAX_POSTS_PER_RUN, and the manual button applies a ceiling of its " +
        "own on top. Test this key spends $0.005 per press and returns no Posts. Only that button " +
        "can reach this key today: lib/shorts/schedule.ts and scripts/latest.ts build their adapters " +
        "without a credential store, so an unattended run spends nothing — and reads nothing from X.",
    },
    note:
      "X is the one platform on this list with a first-party API that can do the whole job: its v2 " +
      "media fields document a view count, a duration and video variants in the same response as the " +
      "posts themselves. It is metered and it is yours to pay for. Paste the bearer token from your " +
      "project's app and press Test before you spend anything.",
    limits: [
      "Priced per resource RETURNED, $0.005 per Post read, no subscription tiers, capped at 3 million " +
        "reads per cycle. Media Metadata is a separate line item priced per REQUEST, also $0.005 " +
        "(docs.x.com, 2026-09-04).",
      "`media.public_metrics.view_count` is documented as publicly readable, alongside `duration_ms` " +
        "and `variants` (docs.x.com, 2026-09-04). WHETHER IT COMES BACK POPULATED FOR ARBITRARY " +
        "THIRD-PARTY VIDEOS HAS NOT BEEN OBSERVED — there is no key on the build machine to observe it " +
        "with. If it arrives null this tool shows an unknown, never a zero.",
      "The recent-counts endpoint returns counts rather than Posts, which is why it is the cheap way " +
        "to size a query before paying to read it: $0.005 per REQUEST, however many Posts the query " +
        "matches, against $0.005 for every single Post a search would return. It is cheap and it is " +
        "not free (docs.x.com price table, 2026-09-04). This page uses it as the Test call.",
    ],
    check: {
      call: `GET ${X_COUNTS_URL}?query=${X_PROBE_QUERY}&granularity=day`,
      source: "docs.x.com/x-api/posts/recent-search-counts",
      /**
       * SCAR, 2026-09-04 review. This used to say "whether the counts endpoint
       * carries a separate charge on your plan is not something this build has
       * verified", while lib/platform/x-client.ts charged
       * USD_PER_COUNTS_RECENT_REQUEST = 0.005 for the same call and cited the
       * same page on the same date. Two files disagreeing about whether a
       * button costs money is worse than either answer, because an operator who
       * reads the cautious one presses freely.
       *
       * Resolved by RE-READING docs.x.com/x-api/getting-started/pricing on
       * 2026-09-04. The per-request table lists "Counts: Recent — $0.005 per
       * request" (and "Counts: All — $0.010 per request") alongside the
       * per-resource read prices. It is charged, it is cheap, and both files
       * now say so. Still not observed on a real bill: there is no X key on
       * this machine.
       */
      cost:
        "$0.005, charged per REQUEST — one press, one charge. No Posts are returned, so the per-Post " +
        "read charge ($0.005 for every Post returned) has nothing to apply to, which is what makes " +
        "this the cheap way to prove a token. Read off the price table at " +
        "docs.x.com/x-api/getting-started/pricing on 2026-09-04, where Counts: Recent is listed at " +
        "$0.005 per request; no bill of yours has been seen to confirm it.",
      proves:
        "The bearer token is accepted for an app-only read. It does NOT prove that view counts come " +
        "back populated on real videos, which is the open question the whole X leg rests on.",
    },
  },

  /**
   * INSTAGRAM. THE SCAFFOLD IS REAL AND THE PRODUCT HOLE IS REAL TOO.
   *
   * Business Discovery, verified against developers.facebook.com on 2026-09-04:
   * `GET /<IG_USER_ID>?fields=business_discovery.username(<USERNAME>)`, read
   * from the operator's OWN Instagram business account, returns the target
   * professional account's media with `view_count`, `like_count`,
   * `comments_count`, `permalink` and `timestamp`. It is per-account lookup by
   * username, NOT cross-account search.
   *
   * There is no duration field on Instagram media. That is not an omission in
   * the request — the field does not exist — and it means the 120-second ceiling
   * that defines a Short cannot be evaluated from official Instagram data.
   */
  instagram: {
    id: "instagram",
    where: { signup: "https://developers.facebook.com/apps", docs: "https://developers.facebook.com/docs/instagram-platform" },
    label: platformLabel("instagram"),
    keyLabel: "Meta long-lived access token",
    usedBy: {
      onARun: true,
      detail:
        "Yes. When you press “Get latest shorts”, lib/platform/registry.ts leases this credential " +
        "and hands the token, your " +
        "own Instagram business account id and a Meta call budget SHARED with the Facebook adapter to " +
        "lib/platform/instagram.ts, which calls Business Discovery once for each @username on your " +
        "seed list. Meta charges nothing per call; what a run consumes is your app's Platform rate " +
        "limit, and the shared budget exists so the two Meta adapters cannot spend it twice over. " +
        "READ THE LIMITS BELOW BEFORE YOU CONCLUDE THAT MEANS INSTAGRAM SHORTS: the calls happen, and " +
        "the media that comes back carries no duration field, so nothing from Instagram can be shown " +
        "to be inside the 120-second ceiling.",
    },
    note:
      "Instagram's official route is Business Discovery: you name a professional account by @username " +
      "and get its media back with view counts. Read this slot's limits before you start Business " +
      "Verification and App Review — one of them decides whether this platform can serve this product " +
      "at all, and it is cheaper to learn now.",
    limits: [
      "THERE IS NO DURATION FIELD ON INSTAGRAM MEDIA. The 120-second Shorts ceiling — the only thing " +
        "that defines a Short in this tool — cannot be evaluated from official Instagram data at all. " +
        "This is verified, and it is a genuine product hole rather than a configuration problem.",
      "Business Discovery is per-account lookup by username, not cross-account search. It answers " +
        "\"what has this creator posted\", never \"who posted something big this week\" " +
        "(developers.facebook.com, IG User business_discovery, 2026-09-04).",
      "Hashtag Search is the only real cross-account discovery Meta offers, and it returns NO view " +
        "count and NO duration — caption, children, comments_count, id, like_count, media_type, " +
        "media_url, permalink and timestamp only. It cannot answer a 500,000-view filter on its own, " +
        "and it is capped at 30 unique hashtags per rolling 7 days.",
      "Both need Meta Business Verification and App Review. Hashtag Search additionally needs the " +
        "restricted Instagram Public Content Access feature.",
      "Business Discovery is documented to require instagram_basic, instagram_manage_insights and " +
        "pages_read_engagement, plus ads_management or ads_read when the token's Page role was granted " +
        "through Business Manager (developers.facebook.com, 2026-09-04). The Test button below reports " +
        "which of the first three your token already carries.",
      "Rate limiting follows the Platform formula: 200 calls per hour multiplied by the app's daily " +
        "active users. An app with no users has almost no allowance, which is a real constraint on a " +
        "back-office tool nobody signs in to.",
      "THE DURATION HOLE IS WHY A VENDOR WAS BOUGHT, and the vendor closes it. ScrapeCreators' " +
        "reels route returns `play_count` AND `video_duration` on the same record, with a " +
        "`paging_info.max_id` cursor, for one credit per request " +
        "(docs.scrapecreators.com/v1/instagram/user/reels, read 2026-09-04). That is the field " +
        "official Instagram data does not have at all. It costs money and it is the vendor's most " +
        "frequently broken leg — both are recorded in SCRAPECREATORS_INFO in this file — and it " +
        "needs a `scrapecreators` credential slot that does not exist yet.",
    ],
    check: {
      call: `GET ${GRAPH_BASE}/debug_token?input_token=<your token>&access_token=<app id>|<app secret>`,
      source: "developers.facebook.com/docs/graph-api/reference/debug_token",
      cost: "Nothing documented. It inspects a token rather than reading any content.",
      proves:
        "The token is valid, belongs to the app id you entered, and carries (or is missing) the three " +
        "permissions Business Discovery needs. It does NOT prove Business Discovery will answer — that " +
        "needs Business Verification and App Review, and this check is how you find out what is " +
        "missing before you start them.",
    },
  },

  /**
   * FACEBOOK. THE SCAFFOLD EXISTS SO THE ANSWER CAN BE SHOWN, AND THE ANSWER IS
   * MOSTLY NO.
   *
   * Read on developers.facebook.com, 2026-09-04, on the reference pages for both
   * /{page-id}/videos and /{page-id}/video_reels: under Reading, each says
   * verbatim "You can't perform this operation on this endpoint." Not restricted,
   * not permissioned — documented as unsupported.
   *
   * THIS DISAGREES WITH THE ASSUMPTION THIS ROUND STARTED FROM, which was that
   * those edges work for Pages the operator administers and refuse others. The
   * disagreement is recorded rather than resolved, because resolving it without a
   * key would be guessing, and because whichever way it falls the conclusion for
   * this product is the same: there is no cross-account Facebook discovery on the
   * official route.
   *
   * Meta Content Library — the CrowdTangle replacement — is academic and
   * non-profit only. Lucky35 is for-profit and explicitly ineligible. Nothing is
   * built toward it, and routing an application through an eligible third party
   * would breach the eligibility representation, so it is not suggested either.
   */
  facebook: {
    id: "facebook",
    where: { signup: "https://developers.facebook.com/apps", docs: "https://developers.facebook.com/docs/graph-api" },
    label: platformLabel("facebook"),
    keyLabel: "Meta long-lived Page access token",
    usedBy: {
      onARun: true,
      detail:
        "Yes, and it may buy nothing. When you press “Get latest shorts”, lib/platform/registry.ts " +
        "leases this credential and hands it, with the shared Meta call budget, to " +
        "lib/platform/facebook.ts, which reads " +
        "`/{page-id}/posts` for each Page on your seed list and looks for video attachments. The two " +
        "video edges are not called at all, because the reference documents no read on them — see the " +
        "limits below. Meta charges nothing per call; the cost is your app's rate limit and your " +
        "time. A run that comes back empty here is reported as Facebook having been read and having " +
        "returned nothing usable, never as “no shorts found”.",
    },
    note:
      "Facebook's official API has no public-content search, and this build could not find a " +
      "documented read for a Page's videos either. The slot exists so a token can be entered and " +
      "checked, and so the reason this platform cannot serve the product is written down where " +
      "somebody will read it before spending money on it.",
    limits: [
      "There is no public-content search on the Graph API. Whatever a Facebook credential buys, it is " +
        "about Pages the operator administers and nothing else.",
      "The Graph API reference documents NO READ on either video edge. Both /{page-id}/videos and " +
        "/{page-id}/video_reels say, under Reading: \"You can't perform this operation on this " +
        "endpoint.\" (developers.facebook.com, 2026-09-04). Other edges may carry video attachments; " +
        "this build has not verified any of them and does not claim one works.",
      "Meta Content Library, the CrowdTangle replacement, is restricted to academic and non-profit " +
        "researchers. A for-profit operator is explicitly ineligible, so nothing here is built toward " +
        "it and no third-party route around the eligibility rule is suggested.",
      "The Test button below inspects the token itself. That is the most this build can honestly " +
        "offer for Facebook: it proves the token is real and says what it can do, and it does not " +
        "imply a Page's videos can be listed.",
      "THE VENDOR ROUTE IS PAGE-SEEDED TOO, AND ITS VIEW COUNTS ARE NOT TRUSTWORTHY. " +
        "ScrapeCreators, chosen 2026-09-04, does list a Page's reels and posts where the official " +
        "API documents no read — and it sells no Facebook discovery either, so this platform can " +
        "only ever refresh Pages you name. Its Facebook view counts are documented as possibly " +
        "null or lower than the public badge; a local probe on this machine returned 408 views for " +
        "a reel whose badge read 9.8K. See SCRAPECREATORS_INFO in this file. Any Facebook view " +
        "count from that route has to be shown as unreliable rather than compared silently against " +
        "the 500,000 threshold.",
    ],
    check: {
      call: `GET ${GRAPH_BASE}/debug_token?input_token=<your token>&access_token=<app id>|<app secret>`,
      source: "developers.facebook.com/docs/graph-api/reference/debug_token",
      cost: "Nothing documented. It inspects a token rather than reading any content.",
      proves:
        "The token is valid and belongs to the app id you entered, and it reports the permissions the " +
        "token carries. It does NOT prove any Page's videos can be listed — see this slot's limits.",
    },
  },

  /**
   * THREADS. THE ONLY META SURFACE THAT ANSWERS A QUESTION ABOUT SOMEBODY ELSE.
   *
   * Added 2026-09-08 on Erik's "we need to add threads". It is the mirror image
   * of the Instagram and Facebook slots above: those two can read only accounts
   * the operator administers and cannot be searched at all; this one cannot read
   * the operator's seeds and CAN be searched for a subject across everybody's
   * public posts. For a tool whose whole job since migration 14 is "find clips
   * about Shark Tank", that trade is the right way round.
   *
   * AND IT CANNOT MEASURE ANYTHING, WHICH IS THE SENTENCE TO READ TWICE.
   * Nothing it returns carries a view count or a duration, ever, so nothing
   * from Threads can be shown to clear 500,000 views or to be under the
   * two-minute ceiling. Its rows are reported as unverified. An operator
   * deciding whether this key is worth the App Review paperwork should decide
   * on that basis: it buys DISCOVERY, not evidence.
   *
   * Nothing here has been seen come back from a live call — there is no Threads
   * token on this machine. Every figure was read off developers.facebook.com's
   * Threads documentation on 2026-09-08.
   */
  threads: {
    id: "threads",
    where: {
      signup: "https://developers.facebook.com/apps",
      docs: "https://developers.facebook.com/docs/threads/keyword-search",
    },
    label: platformLabel("threads"),
    keyLabel: "Threads access token (threads.net OAuth)",
    usedBy: {
      onARun: true,
      detail:
        "Only on a run that names a SUBJECT. lib/platform/registry.ts leases this credential and " +
        "hands it to lib/platform/threads.ts, which calls Meta's keyword search once per term on " +
        "the topic, with media_type=VIDEO. A run with no topic does not call Threads at all — it " +
        "refuses, because there is no trending edge and no way to enumerate a stranger's posts " +
        "without a keyword, and an empty list would be a claim about Threads that nobody checked. " +
        "Meta charges nothing per call; the cost is the app's rate limit, metered separately from " +
        "the Instagram and Facebook budget because it is a separate host.",
    },
    note:
      "The only Meta slot that buys discovery rather than access to your own accounts. It finds " +
      "other people's public video posts by keyword, and it can never tell you how many views any " +
      "of them got.",
    limits: [
      "NO VIEW COUNT, EVER, FOR ANYBODY ELSE'S POST. The views metric lives on " +
        "/{threads-media-id}/insights, which Meta documents as reading \"the insights from users' " +
        "own Threads\". There is no price and no scope that changes this.",
      "NO DURATION FIELD ANYWHERE IN THE API. Not on a search result, not on the media node, not " +
        "on insights. Duration is the only thing that defines a Short, so this platform cannot " +
        "prove that anything it returns is one. Every Threads row is therefore reported as " +
        "unverified rather than counted against the threshold.",
      "THE SEARCH SCOPE NEEDS APP REVIEW AND FAILS SILENTLY WITHOUT IT. A token with " +
        "threads_basic alone is accepted by keyword search and returns only the holder's own " +
        "posts — so a topic run comes back empty and looks like a quiet day rather than a " +
        "misconfiguration. threads_keyword_search is the scope that matters. The Test button " +
        "below performs a real search precisely so this is caught here instead of in a week.",
      "IT IS NOT A FACEBOOK TOKEN. Threads authenticates through threads.net's own OAuth against " +
        "graph.threads.net. A Page access token pasted here will be rejected, and a Threads token " +
        "pasted into the Facebook or Instagram slot will be rejected there.",
      "No data vendor this build can buy resells Threads — ScrapeCreators included — so this " +
        "credential is the only route to the platform. There is no fallback if the scope is " +
        "refused.",
    ],
    check: {
      call: `GET ${THREADS_BASE}/keyword_search?q=video&media_type=VIDEO&search_type=TOP&limit=1&access_token=<your token>`,
      source: "developers.facebook.com/docs/threads/keyword-search",
      cost: "Nothing documented. One search returning at most one post, against the app's rate limit.",
      proves:
        "The token authenticates AND carries threads_keyword_search, which is the scope that makes " +
        "this platform useful. Deliberately not a /me call: that would pass for a threads_basic " +
        "token, the exact credential whose topic runs come back silently empty. It does NOT prove " +
        "anything can be measured — no Threads result ever carries views or duration.",
    },
  },

  /**
   * ==========================================================================
   * SCRAPECREATORS — THE ONE VENDOR SLOT
   * ==========================================================================
   *
   * It sat OUTSIDE this table until the vocabulary rewrite, as a lone
   * `SCRAPECREATORS_INFO` constant, because `INFO` is keyed by
   * `CredentialProvider` and there was no such provider. The comment that
   * justified it said the page "renders exactly what the store can save, and a
   * slot the store would reject is a slot that invites an operator to paste a
   * key and then refuses it" — correct, and the fix was never to keep the
   * record outside the table, it was to make the store able to save it.
   *
   * It is in the table now, so it renders, so it can be saved, so it can be
   * leased. `SCRAPECREATORS_INFO` below is derived from this entry rather than
   * being a second copy of it.
   *
   * Every figure here was read off scrapecreators.com or
   * docs.scrapecreators.com on 2026-09-04 and NONE of it has been seen come
   * back from a live call: there is no ScrapeCreators key on this machine.
   */
  scrapecreators: {
    id: "scrapecreators",
    where: { signup: "https://scrapecreators.com", docs: "https://docs.scrapecreators.com" },
    label: "ScrapeCreators",
    keyLabel: "ScrapeCreators API key",

    /**
     * `onARun` IS TRUE, AND IT WENT TRUE IN THE SAME ROUND THE SLOT WAS BORN.
     *
     * It read `false` for exactly as long as this record sat outside the
     * vocabulary: nothing could lease a credential that did not exist, so
     * lib/platform/scrapecreators.ts held a complete vendor client with no
     * production call site. The slot below is what unblocked
     * lib/platform/registry.ts, and the registry now leases this credential on
     * every run.
     *
     * THIS BOOLEAN IS CHECKED AGAINST THE CODE, IN BOTH DIRECTIONS, by the
     * detector in lib/credentials/credentials.test.ts — which reads the run
     * path's own source and follows a lease taken through a constant, not only
     * a lease spelled with a string literal. A stale `false` here hides a bill
     * from the person paying it; a stale `true` tells an operator their credits
     * are draining while nothing fetches anything.
     */
    usedBy: {
      onARun: true,
      detail:
        "YES, AND ONE KEY PAYS FOR THREE PLATFORMS AT ONCE. When you press “Get latest shorts”, " +
        "lib/platform/registry.ts leases this one credential, builds ONE client from it and hands " +
        "that same instance to the TikTok, Instagram and Facebook adapters " +
        "(lib/platform/tiktok.ts, lib/platform/instagram.ts, lib/platform/facebook.ts) — one client " +
        "for three platforms, because a client each would be three credit meters nobody can see the " +
        "total of. Billing is per REQUEST at one credit, so the size of a run is decided by how many " +
        "sources it walks rather than by how many shorts it finds, and the per-run request cap is " +
        "what stands between a bad source list and your balance. It will NOT be handed to X: " +
        "lib/platform/x.ts reads X's own official API, which returns the view count, the duration " +
        "and the video URL in one response, and duration is the only thing that defines a Short " +
        "here. YouTube is read keylessly and needs no vendor either. Test this key spends one more " +
        "credit per press.",
    },

    note:
      "One key, three platforms — TikTok, Instagram and Facebook. ScrapeCreators is a synchronous " +
      "REST API billed per REQUEST rather than per record, so one call returns a whole page of " +
      "results for one credit. It gives TikTok real discovery — a trending feed by region, plus " +
      "keyword and hashtag search — and it reads Instagram reels and Facebook pages from creators " +
      "you name. It does not serve X, and it does not replace the keyless YouTube walk. Read the " +
      "two risks below before you rely on it.",

    limits: [
      "$47 for 25,000 credits, roughly $1.88 per 1,000 requests; the next tier is $497 for 500,000 " +
        "credits at about $0.99 per 1,000. Pay-as-you-go, no subscription, and the site states " +
        '"Credits never expire" and "1 credit === 1 request (for most endpoints)" ' +
        "(scrapecreators.com, read 2026-09-04). No invoice of yours has been seen to confirm it.",
      "IT BILLS PER REQUEST, NOT PER RECORD, and that is the whole shape of the cost. One call to " +
        "the Instagram reels endpoint returns a page of reels with a pagination cursor for one " +
        "credit (docs.scrapecreators.com/v1/instagram/user/reels, read 2026-09-04). A run that " +
        "finds nothing over the threshold costs the same as one that finds fifty.",
      "RISK ONE, DURABILITY: Instagram is the leg this build expects to break. The vendor's own " +
        "incident history records an Instagram reels endpoint being migrated to a new data source " +
        "on 25-26 August 2026. That is carried here from this repo's 2026-09-04 brief and is NOT " +
        "re-cited to a URL: status.scrapecreators.com did not resolve when it was re-checked on " +
        "2026-09-04. When that endpoint breaks, this tool must say Instagram could not be read — " +
        "never that there were no Instagram reels over the threshold.",
      "RISK TWO, FACEBOOK VIEW COUNTS ARE UNRELIABLE AND MUST BE LABELLED AS SUCH. The vendor's " +
        "Facebook video documentation is reported to warn that view_count can be null or LOWER than " +
        "the public Reels badge, and to point at /v1/facebook/profile/reels matched by post_id for " +
        "the badge figure. REPORTED, NOT REPRODUCED: a direct fetch of " +
        "docs.scrapecreators.com/v1/facebook/profile/videos on 2026-09-04 did not return that page's " +
        "field notes. What HAS been observed on this machine is a yt-dlp probe returning 408 views " +
        "for a reel whose public badge read 9.8K — a roughly 24x undercount. A number that may be " +
        "an order of magnitude low may not be compared silently against a 500,000 threshold.",
      "Facebook is PAGE-SEEDED ONLY, permanently. The endpoint index lists /v1/facebook/profile, " +
        "/v1/facebook/profile/reels and /v1/facebook/profile/posts and no discovery route " +
        "(docs.scrapecreators.com, read 2026-09-04). Nobody sells Facebook Reels discovery, this " +
        "vendor included, so a Facebook run can only ever refresh Pages somebody named.",
      'No enforced rate limit: "Scrape Creators does not enforce API rate limits. For now, we ' +
        'recommend keeping usage below 500 concurrent requests to ensure the best performance and ' +
        'reliability" (docs.scrapecreators.com/introduction, read 2026-09-04). The brake on a run is ' +
        "therefore your credit balance and nothing else, which is a different failure mode from " +
        "Meta's hourly allowance and needs its own ceiling before an unattended run is trusted.",
      "IT DOES NOT SERVE X OR YOUTUBE, and both exclusions are findings. X stays on its own metered " +
        "API because that API returns the duration this vendor does not sell for X, and duration is " +
        "the only thing that defines a Short here. YouTube is read keylessly through yt-dlp and has " +
        "nothing to gain from a paid credit. The three platforms this key does serve are listed " +
        "above the Save button, computed from lib/credentials/types.ts rather than typed here.",
    ],

    check: {
      call: `GET ${SCRAPECREATORS_CREDIT_BALANCE_URL} with header ${SCRAPECREATORS_AUTH_HEADER}: <your key>`,
      source: "docs.scrapecreators.com/v1/account/credit-balance",
      cost:
        "ONE CREDIT — about $0.0019 at the $47 tier. The account endpoint is documented at " +
        '"1 credit per request" like every scraping route, so this button is not free: pressing it ' +
        "ten times costs ten credits. Read off docs.scrapecreators.com/v1/account/credit-balance on " +
        "2026-09-04.",
      proves:
        "The key is accepted, and the reply carries credits_remaining so you learn the balance in " +
        "the same press. It does NOT prove any platform endpoint answers — Instagram in particular " +
        "has a documented history of breaking on this vendor, and a valid key gets a clean 200 here " +
        "on the same day an Instagram route is down.",
    },
  },
};

/**
 * The full record, with the field spec and the primary environment variable
 * folded in from lib/credentials/fields.ts.
 *
 * They are DERIVED rather than restated, so a field added there cannot fail to
 * appear on the form, and `envVar` cannot come to mean a different variable from
 * the one `EnvCredentialStore` reads. That drift is exactly what a second
 * declaration would allow, and nothing would go red when it happened.
 */
export function credentialProviderInfo(provider: CredentialProvider): CredentialProviderInfo {
  return {
    ...INFO[provider],
    kind: credentialProviderKind(provider),
    serves: platformsServedBy(provider),
    envVar: primaryField(provider).envVar,
    fields: credentialFields(provider),
  };
}

/**
 * Every provider, platforms first and then vendors — the order
 * `CREDENTIAL_PROVIDERS` declares, and the order the UI groups by.
 */
export function allCredentialProviders(): readonly CredentialProviderInfo[] {
  return CREDENTIAL_PROVIDERS.map((p) => credentialProviderInfo(p));
}

/**
 * THE TWO SLOTS THIS DEPLOYMENT ACTUALLY ASKS FOR.
 *
 * Erik, 2026-09-04: "it should have 2 simple layers, X signin, scraperCreator
 * key. That should handle everything else."
 *
 * That is a statement about coverage, and it is true. Between them these two
 * keys reach all five platforms:
 *
 *   x               X's own API. Nothing else sells X data.
 *   scrapecreators  one vendor key for tiktok, instagram and facebook.
 *   youtube         needs NO key at all — the keyless `ytdlp` adapter reads it,
 *                   which is why YouTube is not in this list despite being the
 *                   platform the client cares most about.
 *
 * The other four slots still EXIST and still work; they are not deleted,
 * because a deployment that already holds a YouTube Data API key or has
 * somehow obtained Meta's review should be able to use them. They are moved
 * out of the way rather than out of the vocabulary — see the credentials page,
 * which renders these two first and folds the rest away behind a disclosure.
 *
 * WHY A SEPARATE LIST RATHER THAN REORDERING `CREDENTIAL_PROVIDERS`: that
 * constant is the vocabulary, and the database enum, and the order the panel
 * groups by. This is a product decision about one screen. Conflating them
 * would mean a future change to what the page emphasises silently reordering a
 * Postgres enum.
 */
export const PRIMARY_CREDENTIAL_PROVIDERS = ["x", "scrapecreators"] as const;

/** The two slots above, as full descriptors, in that order. */
export function primaryCredentialProviders(): readonly CredentialProviderInfo[] {
  return PRIMARY_CREDENTIAL_PROVIDERS.map((p) => credentialProviderInfo(p));
}

/**
 * Everything else, in the vocabulary's own order.
 *
 * Derived by SUBTRACTION rather than listed, so a provider added to
 * `CREDENTIAL_PROVIDERS` later appears on the page automatically instead of
 * being silently invisible — the same rule the panel's `groupsFor` follows for
 * an unknown kind.
 */
export function secondaryCredentialProviders(): readonly CredentialProviderInfo[] {
  const primary = new Set<string>(PRIMARY_CREDENTIAL_PROVIDERS);
  return allCredentialProviders().filter((info) => !primary.has(info.id));
}

/**
 * The providers of one kind, for a page that groups them.
 *
 * A FUNCTION RATHER THAN TWO CONSTANTS, so the credentials page can render the
 * groups by looping over the kinds instead of naming them — the same rule that
 * keeps the platform list out of every other screen. A third kind, if one ever
 * exists, then appears on the page instead of being silently omitted from it.
 */
export function credentialProvidersOfKind(kind: CredentialProviderKind): readonly CredentialProviderInfo[] {
  return allCredentialProviders().filter((info) => info.kind === kind);
}

/**
 * The environment variable a provider's development PRIMARY secret is read
 * from.
 *
 * The names are declared in lib/credentials/fields.ts rather than derived from
 * the provider id. A rule like `${ID.toUpperCase()}_API_KEY` would produce every
 * one of these correctly and would also mean nobody can grep for
 * `INSTAGRAM_API_KEY` and find where it is read. On this codebase the greppable
 * version wins; `YOUTUBE_API_KEY` in particular is already named in
 * .env.example, in verify/quota.ts's error text and in the plan.
 *
 * `X_API_KEY` is generic enough to collide with something else on a shared
 * machine, and it holds a BEARER TOKEN rather than an api key, which is a second
 * small wrongness. It is still the name, because renaming it would break
 * .env.example and every note that already refers to it, and because the
 * alternative is one special case in a table of five and a developer guessing
 * which platform got the exception.
 */
export function providerEnvVar(provider: CredentialProvider): string {
  return primaryField(provider).envVar;
}

/**
 * ============================================================================
 * THE SCRAPECREATORS RECORD, AS OTHER MODULES STILL SPELL IT
 * ============================================================================
 *
 * SCAR. This block used to hold the whole vendor record as a standalone
 * constant, sitting outside `INFO` and outside `allCredentialProviders()`,
 * because the credential vocabulary had no word for a vendor. Its own comment
 * described folding it into `INFO` "on the day `CREDENTIAL_PROVIDERS` widens"
 * as "a one-line change and not a transcription job". That day is this change,
 * and what is left here is the two names other files already import.
 *
 * BOTH ARE DERIVED, NOT DECLARED. A second copy of the field spec is how a form
 * comes to render a box the store then refuses; a second copy of the record is
 * how the page comes to advertise a call the check does not make. They read
 * from lib/credentials/fields.ts and from `INFO` respectively, so there is
 * exactly one of each in the build.
 */

/** The vendor's field spec. Declared once, in lib/credentials/fields.ts. */
export const SCRAPECREATORS_FIELDS: readonly CredentialField[] = credentialFields(SCRAPECREATORS_PROVIDER);

/** The vendor's full record. Declared in `INFO` above, like every other slot. */
export const SCRAPECREATORS_INFO: CredentialProviderInfo = credentialProviderInfo(SCRAPECREATORS_PROVIDER);

/** The check plan for a provider, or null when there is no call to make. */
export function credentialCheckPlan(provider: CheckableProvider): CredentialCheckPlan | null {
  return INFO[provider].check;
}

/**
 * The fields a check has to find values for.
 *
 * SCAR, AND A THIN WRAPPER ON PURPOSE. It existed because `credentialFields()`
 * was keyed by `CredentialProvider` and ScrapeCreators was not one, so the
 * missing-field guard in lib/credentials/checks.ts — the one that stops an empty
 * box being reported as a rejected key — would have skipped the vendor
 * entirely. The vendor is in the vocabulary now, so this delegates.
 *
 * KEPT RATHER THAN DELETED because lib/credentials/checks.ts calls it and that
 * file is not this change's to edit. What it must never do is grow a branch
 * again: if a checkable provider and a saveable provider ever genuinely differ,
 * that is a new fact and needs its own declaration, not this one widening back.
 */
export function checkableFields(provider: CheckableProvider): readonly CredentialField[] {
  return credentialFields(provider);
}

/** The primary secret's field. The same wrapper, for the same reason. */
export function checkablePrimaryField(provider: CheckableProvider): CredentialField {
  return primaryField(provider);
}
