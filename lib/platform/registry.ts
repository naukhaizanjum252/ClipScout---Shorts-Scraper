/**
 * THE ONE PLACE THAT KNOWS WHICH PLATFORM IS WHICH — and, since 2026-09-04, the
 * one place that BUILDS EACH ADAPTER WITH THE CONFIGURATION IT NEEDS TO RUN.
 *
 * Everything else in this repo loops. The action asks the registry for five
 * adapters and calls the same four methods on each; the page asks the registry
 * for five statuses and renders the same card five times. Nothing outside this
 * file branches on platform identity, and lib/platform/registry.test.ts fails
 * the build if something starts to — the same invariant the old
 * lib/source/select.test.ts enforced for the two source adapters, which is the
 * one part of that seam worth keeping.
 *
 * ============================================================================
 * THE SCAR THIS FILE CARRIES, AND IT IS THE WHOLE REASON FOR THE 2026-09-04
 * REWRITE
 * ============================================================================
 *
 * Until this rewrite the registry built adapters and handed them NOTHING.
 *
 *   `new XClient` appeared NOWHERE in the tree. Not once. So `o.xClient` was
 *   always undefined, `XAdapter` was always constructed with `client: null`,
 *   and X reported "no X credential is configured" — FOREVER, no matter what an
 *   operator pasted on /admin/credentials. A valid, paid-for bearer token in the
 *   database could not reach the adapter, because nothing built the object that
 *   carries it.
 *
 *   The Meta adapters were constructed as `new InstagramAdapter(o.providers?.
 *   instagram ?? null)` — first argument only. Their second argument, the one
 *   carrying the token, the seeds, the operator's own Instagram id and the
 *   shared call budget, was never passed. Both adapters therefore ran with
 *   `token: null` and `seeds: []` and reported themselves unavailable forever,
 *   for the same reason and with the same permanence.
 *
 * AND 746 TESTS WERE GREEN THE WHOLE TIME. Every adapter had a thorough unit
 * test that constructed it by hand with a fixture client and proved it works.
 * Not one test asked the question that matters: does the APPLICATION ever build
 * one of these with real configuration? A test that reaches past the wiring
 * proves the part and says nothing whatever about the product.
 *
 * That is why the tests at the top of registry.test.ts now go through
 * `buildAdapters()` with a fake credential store and assert AVAILABILITY. They
 * are the only tests in this repo that would have caught the above, and they
 * are deliberately written against the same entry point the action, the script
 * and the scheduler call.
 *
 * ============================================================================
 * WHY THIS FILE IS ASYNC NOW, AND WHAT IT COST
 * ============================================================================
 *
 * A credential lives encrypted in Postgres and comes back through
 * `lease_api_credential()`, a SECURITY DEFINER function. Reading one is async
 * and server-only. There is no synchronous way to learn whether an X token
 * exists, and therefore no synchronous way to decide whether to construct an
 * `XClient` — and `XAdapter` decides its availability on whether it HOLDS a
 * client, which is correct: an adapter must not report itself ready on the
 * strength of a token nobody has fetched.
 *
 * So `adapterFor()` and `buildAdapters()` return promises. That is a breaking
 * change to four call sites and it was taken deliberately, because the
 * alternatives are both worse:
 *
 *   A LAZY CLIENT that leases on first use would make X report AVAILABLE with
 *   no credential saved at all, which is the honesty rule inverted — the tool
 *   would promise a platform it cannot read.
 *
 *   A SEPARATE `resolveOptions()` STEP callers must remember to call is exactly
 *   the shape of the bug being fixed here: a wiring step that compiles fine
 *   when omitted. Making the registry itself async means a caller that forgets
 *   FAILS THE BUILD instead of silently getting a dead X adapter.
 *
 * ============================================================================
 * WHERE EACH PIECE COMES FROM
 * ============================================================================
 *
 * CREDENTIALS — `options.credentials`, a store this file never constructs. The
 * registry is not entitled to decide whether a deployment reads keys from the
 * database or from a laptop's environment; `lib/credentials/resolve.ts` decides
 * that and the caller hands the answer in. What the registry does own is what
 * each provider's key BECOMES: an `XClient` for X, a token and an account id
 * for Meta, and ONE `ScrapeCreatorsClient` shared by the three platforms that
 * vendor serves.
 *
 * A CREDENTIAL READ THAT THROWS IS ALLOWED OUT OF HERE. It is not caught and
 * turned into "no credential is configured", because those are different facts
 * and the second one is a lie that sends an operator to a settings page where
 * their key is sitting saved and correct. The caller renders the failure; this
 * file refuses to dress it up as a result. Same rule as `SeedStore.listSeeds`,
 * which refuses a partial read for the same reason.
 *
 * SEEDS — the DATABASE WINS, and the environment is the fallback for a machine
 * that has no database. That precedence is `lib/shorts/seeds.ts`'s decision and
 * this file implements it rather than re-arguing it: a seed switched off on
 * /admin/seeds has to stop being fetched, and a union of the two lists would
 * keep fetching it while the page showed it as off. Zero seeds from the store
 * means zero, never "fall back to the environment", for the same reason —
 * somebody reached zero by turning the last one off.
 *
 *   options.seeds[platform]   an explicit list from the caller. Wins outright.
 *   options.seedStore         the rows. The environment is then IGNORED.
 *   otherwise                 PLATFORM_SEEDS_* — see `seedsFor`.
 *
 * ONE META BUDGET FOR BOTH META ADAPTERS. Instagram and Facebook are two
 * platforms behind ONE Meta app under ONE Platform rate limit — "Calls within
 * one hour = 200 * Number of Users". Each adapter builds its own budget when
 * none is handed in, so before this rewrite an Instagram run and a Facebook run
 * could together issue 400 calls an hour against a 200-call allowance and
 * neither brake would ever fire. `resolveWiring()` constructs exactly one and
 * gives it to both. meta-client.ts's header names this fix as the caller's job;
 * this is the caller.
 *
 * ============================================================================
 * WHAT AVAILABILITY MEANS HERE
 * ============================================================================
 *
 * `platformStatuses()` returns a row for ALL FIVE platforms, always, including
 * the ones nothing can read. That is deliberate and it is the honesty rule
 * in its structural form: a platform missing from the list is a platform the UI
 * cannot even say it failed to read, and "could not be read" would collapse
 * into "no results". Every unavailable row carries a sentence naming what is
 * missing, and the caller is expected to render that sentence.
 *
 * A ROW SAYING "AVAILABLE" STILL PROVES NOTHING ABOUT THE VENDOR. Availability
 * is answered locally and makes no network call, on purpose — see the note on
 * `XAdapter.unavailableReason`, which explains that the cheapest thing X sells
 * is a $0.005 counts request and a status page must not drip money. So
 * "available" means "everything this deployment is responsible for is in
 * place", not "the token works". Nothing in this repo has been run against X or
 * Meta; the first real key is the experiment.
 *
 * ============================================================================
 * SEEDS, AND WHY THE ENVIRONMENT KEY IS DERIVED
 * ============================================================================
 *
 * Two adapters need a seed list — see their files for why neither platform has
 * a browse-everything feed. The environment key is DERIVED from the platform
 * name (`PLATFORM_SEEDS_YOUTUBE`, `PLATFORM_SEEDS_TIKTOK`, ...) rather than
 * looked up in a table: a table is five branches waiting to disagree, and this
 * way a sixth platform gets its seed variable for free.
 *
 * This env reading is the one piece of config that did not go in lib/config.ts,
 * because the seed list arrived with the adapters rather than with the tunables.
 * Moving it is a one-line change and should happen; it is recorded here rather
 * than left as a surprise.
 *
 * X DOES NOT TAKE A SEED LIST, AND THAT IS WHY IT READS ITS OWN VARIABLES.
 *
 * `seedsFor` splits its value on commas AND whitespace, which is exactly right
 * for a list of channel ids and exactly wrong for `min_likes:20000
 * has:video_link -is:retweet` — it would arrive as four unrelated seeds. X is
 * searched, not enumerated, so it takes a QUERY (`X_SEARCH_QUERY`), a spend cap
 * (`X_MAX_POSTS_PER_RUN`) and an optional window (`X_WINDOW_HOURS`) instead.
 * They are read here, alongside the seeds, and they belong in lib/config.ts for
 * the same reason and by the same one-line change.
 *
 * `X_MAX_POSTS_PER_RUN` IS PARSED HERE AND VALIDATED IN THE ADAPTER. A bad value
 * comes through as NaN rather than being silently dropped to null, because
 * "nobody set a cap" and "somebody set a cap to `two hundred`" are different
 * problems and the adapter has a different sentence for each. Swallowing the
 * second into the first is how an operator spends an afternoon looking at the
 * wrong variable.
 *
 * `providers.x` IS NO LONGER CONSULTED. X used to be a `ProviderBackedAdapter`
 * waiting for somebody to name a third-party data vendor. As of 2026-09-04 it
 * reads X's own official API and takes an `XClient` built here from the saved
 * bearer token. Instagram and Facebook still take providers; X does not, and as
 * of the narrowing below it can no longer be passed one at all.
 *
 * ============================================================================
 * SCRAPECREATORS IS WIRED HERE. SCAR, 2026-09-04, AND IT IS THE THIRD OF ITS
 * KIND.
 * ============================================================================
 *
 * WHAT WAS MISSING. `ScrapeCreatorsClient` had ONE definition and ZERO
 * production call sites. A reviewer moved lib/platform/scrapecreators.ts OUT OF
 * THE TREE ENTIRELY and the suite stayed 100% green with `tsc` exiting 0 — the
 * same shape as `new XClient` appearing nowhere in the tree, and as the Meta
 * adapters being constructed without the options object carrying their token.
 * Three rounds, three well-built and well-tested units, and nothing anywhere
 * that asked whether the application builds one of them with real
 * configuration. The falsifiable statement this round had to make true is the
 * one at the bottom of registry.test.ts: DELETE lib/platform/scrapecreators.ts
 * AND THE SUITE GOES RED.
 *
 * WHAT THE PREVIOUS VERSION OF THIS COMMENT REFUSED TO DO, AND IT WAS RIGHT.
 * It named three blockers and declined to lease a credential until they were
 * gone. A lease added before them would not have enabled a dead platform, it
 * would have BROKEN A WORKING PAGE: /admin/credentials and /admin/shorts both
 * render every platform, both go through this file, and a lease of a provider
 * name the deployment's credential vocabulary does not contain does not come
 * back null — the environment store dies looking up a field spec that does not
 * exist, and Postgres rejects an unknown enum value inside the RPC. Every
 * platform's row disappears to enable one that was never going to answer.
 *
 * WHAT CLOSED EACH OF THE THREE:
 *
 *   1. A CREDENTIAL PROVIDER IS NO LONGER FORCED TO BE A PLATFORM. It used to
 *      be — `CREDENTIAL_PROVIDERS = PLATFORMS` in lib/credentials/types.ts,
 *      an alias that made "the vendor" unsayable, and that file said in advance
 *      that the alias was what would give way. It gave way. A provider is now
 *      either a PLATFORM whose own API we call or a VENDOR serving several
 *      platforms at once, and `scrapecreators` is the first vendor. This file
 *      does not import that vocabulary — see `CredentialSource` for why the
 *      port stays structural — it widens its own to `CredentialProviderName`.
 *   2. `TikTokAdapter` NOW TAKES A `ProviderClient`, so the one platform this
 *      vendor gives genuine discovery to can receive it. `ProviderBackedPlatform`
 *      grew to three.
 *   3. WHAT TO ASK THE VENDOR FOR IS CONFIGURATION, NOT A GUESS. See
 *      `VENDOR_SOURCES` below. Instagram and Facebook take their seeds,
 *      because a seed there already IS a creator handle and a page. TikTok does
 *      NOT: a TikTok seed is a sec_uid for yt-dlp and the vendor's TikTok
 *      sources are regions and keywords, which are different things entirely.
 *      So TikTok's vendor sources come from their own variables, and an unset
 *      TikTok source is answered with "tell me a region or a keyword" rather
 *      than with a guessed region or with an empty result.
 *
 * ONE CLIENT FOR THREE PLATFORMS, the way `metaBudget` is one budget for two
 * and for the same reason: ScrapeCreators bills per REQUEST against ONE credit
 * balance, so a per-platform client is a per-platform credit meter nobody can
 * see the total of. X does not get it — X reads its own official API, which
 * returns the duration the 120-second filter needs and which this vendor does
 * not sell. YouTube does not get it either; it is keyless through yt-dlp and
 * paying for it would be buying something we already have.
 *
 * A VENDOR KEY THAT IS ABSENT, MALFORMED OR REJECTED MUST NOT TAKE THE PAGE
 * DOWN, and this is the one place where the "let a credential read throw" rule
 * above is deliberately inverted. The reasoning is not symmetry, it is blast
 * radius: an unreadable X key is X's problem and X alone renders wrong, but the
 * vendor key is read on behalf of three platforms, two of which have a working
 * keyless or official path without it, and one deployment upgrading its schema
 * later than its code is a real and expected state. So `leaseVendor` catches,
 * every platform falls back to the path it had before the vendor existed, and
 * the failure is REPORTED rather than swallowed — see `PlatformStatus.notes`,
 * which carries the sentence into the same row the operator is already reading.
 * Never a stack trace, and never an empty result.
 */
import type { YouTubeClient } from "../yt/client";
import type { PlatformAdapter } from "./adapter";
import { FacebookAdapter } from "./facebook";
import { InstagramAdapter } from "./instagram";
import { MetaCallBudget } from "./meta-client";
import {
  ScrapeCreatorsClient,
  ScrapeCreatorsProvider,
  type PlatformSource,
} from "./scrapecreators";
import { ThreadsAdapter } from "./threads";
import { TikTokAdapter } from "./tiktok";
import { PLATFORMS, platformLabel, type Platform } from "./types";
import type { ProviderClient } from "./unavailable";
import { XAdapter, type XAdapterOptions } from "./x";
import { meterWithX, XClient, type XPostFieldsParam } from "./x-client";
import type { YtDlpRunner } from "./ytdlp";
import { makeRemoteYtDlpRunner, remoteYtDlpFromEnv } from "./ytdlp-remote";
import { discoverYouTubeChannels } from "./youtube-discover";
import { YouTubeAdapter } from "./youtube";

export type Env = Record<string, string | undefined>;

/**
 * A plaintext key, as this file needs to see one.
 *
 * DELIBERATELY A STRUCTURAL PORT AND NOT AN IMPORT FROM lib/credentials. A real
 * `PlaintextLease` satisfies it, so `CredentialStore` can be passed straight in,
 * but lib/platform does not take a dependency on the credential module to say
 * so. That keeps this directory importable by a plain CLI — lib/credentials
 * reaches for `next/headers` down one of its branches — and it keeps the
 * platform seam free of the store's vocabulary, which is a different subject.
 */
export interface CredentialLease {
  /** The provider's PRIMARY secret: the bearer token, the access token. */
  readonly secret: string;
  /** The non-secret fields, by field id. An app id, a Page id, an account id. */
  readonly identifiers: Readonly<Record<string, string>>;
}

/**
 * THE DATA VENDOR'S CREDENTIAL NAME. NOT A PLATFORM, AND THAT IS THE POINT.
 *
 * One key, three platforms. It was unsayable until 2026-09-04 because
 * lib/credentials/types.ts aliased the credential vocabulary to the platform
 * list, so the only way to name a vendor was to pretend it was a sixth
 * platform — which would then have needed a seed list, an adapter, a status row
 * and a card on /admin/shorts for a thing that scrapes rather than publishes.
 */
export const VENDOR_PROVIDER = "scrapecreators";
export type VendorProvider = typeof VENDOR_PROVIDER;

/**
 * Everything this file will ask a credential store for: the four platforms
 * whose own API we call, plus the vendor.
 *
 * A LOCAL UNION AND NOT AN IMPORT, for the same reason `CredentialLease` is a
 * local shape — see below. `CredentialProvider` from lib/credentials is the
 * authority and a real store's `lease` satisfies this port structurally.
 */
export type CredentialProviderName = Platform | VendorProvider;

/** Where saved keys come from. `CredentialStore` from lib/credentials satisfies it. */
export interface CredentialSource {
  /**
   * The active key for one provider, or null when there is none.
   *
   * NULL IS A NORMAL STATE and means "no key saved for this provider". A THROWN
   * error is not: it means the store could not answer, and this file lets it
   * out rather than converting it into a null — see the header. THE ONE
   * EXCEPTION IS THE VENDOR, and the header says why that asymmetry is
   * deliberate rather than an oversight.
   */
  lease(provider: CredentialProviderName): Promise<CredentialLease | null>;
}

/** One seed row, as this file needs to see one. `Seed` from lib/shorts satisfies it. */
export interface SeedRow {
  readonly platform: Platform;
  readonly seed: string;
  readonly active: boolean;
}

/** Where seeds come from when a database holds them. `SeedStore` satisfies it. */
export interface SeedSource {
  listSeeds(): Promise<readonly SeedRow[]>;
}

/**
 * The identifier field carrying the operator's OWN Instagram professional
 * account id — the node Business Discovery is asked from, not the creator being
 * looked up.
 *
 * The literal has to agree with the field spec in lib/credentials/fields.ts,
 * and a rename there would silently produce `igUserId: null` here — Instagram
 * would report "not configured" while a complete credential sat in the
 * database, which is this round's bug in miniature. registry.test.ts asserts
 * the two agree.
 */
const IG_USER_ID_FIELD = "ig_business_account_id";

/**
 * The two spellings X's own documentation disagrees about. See x-client.ts's
 * header: the OpenAPI spec says `post.fields`, every worked example says
 * `tweet.fields`, and the client defaults to the second.
 */
const POST_FIELDS_PARAMS = ["tweet.fields", "post.fields"] as const;

/**
 * THE PLATFORMS WHOSE ADAPTER ACTUALLY TAKES A `ProviderClient` — and the type
 * is narrow so that handing one to a platform that would drop it is a COMPILE
 * ERROR rather than a silence.
 *
 * SCAR, 2026-09-04. `providers` was `Partial<Record<Platform, ProviderClient>>`,
 * which advertised that a data client could be supplied for any of the five.
 * Only two of them read it: `InstagramAdapter` and `FacebookAdapter` extend
 * `ProviderBackedAdapter` and take one positionally. `TikTokAdapter`,
 * `YouTubeAdapter` and `XAdapter` have no such parameter, so
 * `providers: { tiktok: client }` compiled, type-checked, and was thrown away
 * without a word. That is the same defect as the registry that built adapters
 * and handed them nothing: a wiring step that is legal to omit and silent when
 * omitted.
 *
 * TIKTOK JOINED ON 2026-09-04, and the mechanism worked exactly as the previous
 * version of this comment predicted it would: the union could not grow until
 * `TikTokAdapter` grew a `ProviderClient` slot, and the line below that passes
 * the client would not have compiled a day earlier. TikTok is the platform this
 * vendor was actually bought for — yt-dlp has no trending extractor at all and
 * its tag, sound and effect extractors are marked broken upstream — so a
 * "provider-backed" list that excluded it was describing a product nobody
 * wanted.
 *
 * X AND YOUTUBE ARE STILL EXCLUDED AND MUST STAY EXCLUDED. `providers: { x: c }`
 * does not compile, which is a stronger statement than any test: X reads its own
 * official API for the duration this vendor does not sell, and YouTube is
 * keyless.
 */
export type ProviderBackedPlatform = "tiktok" | "instagram" | "facebook";

/**
 * The same three, as values, so the vendor wiring can loop instead of branching.
 *
 * `satisfies` keeps the list and the union in step — widen one and the other
 * stops compiling, which is the guarantee the seam test in registry.test.ts
 * cannot give on its own.
 */
export const PROVIDER_BACKED_PLATFORMS = ["tiktok", "instagram", "facebook"] as const satisfies
  readonly ProviderBackedPlatform[];

export interface RegistryOptions {
  readonly env?: Env;
  /** Seeds per platform, overriding both the seed store and the environment. */
  readonly seeds?: Partial<Record<Platform, readonly string[]>>;
  /**
   * The seed rows. When present the environment is IGNORED for every platform —
   * see the header for why zero rows means zero rather than a fallback.
   */
  readonly seedStore?: SeedSource | null;
  /**
   * The operator's saved keys. This is what turns a pasted X bearer token into
   * a live `XClient`, a pasted Meta token into a configured pair of Meta
   * adapters, and a pasted ScrapeCreators key into one vendor client answering
   * for three platforms. Absent means no key for any provider, which every
   * adapter reports for itself in a sentence.
   *
   * FOUR PROVIDERS ARE ASKED FOR AND THERE ARE FIVE PLATFORMS. YouTube has no
   * key to lease here, and the fourth name is not a platform at all — see
   * `VENDOR_PROVIDER`.
   */
  readonly credentials?: CredentialSource | null;
  /**
   * A third-party data client for a platform yt-dlp cannot enumerate. See
   * lib/platform/unavailable.ts for the two-method seam it satisfies.
   *
   * NORMALLY OMITTED NOW. When `credentials` holds a ScrapeCreators key this
   * file builds these itself, one per platform off one shared client. An
   * explicit entry WINS over the one it would have built, which is what a test
   * with a fake provider needs and what a caller holding a different vendor's
   * client needs; it is not a merge, because two clients answering for one
   * platform is two credit meters and one invoice.
   */
  readonly providers?: Partial<Record<ProviderBackedPlatform, ProviderClient>>;
  /**
   * WHAT TO ASK THE VENDOR FOR, per platform, overriding what this file derives
   * from the seeds and the environment.
   *
   * THIS IS THE THIRD BLOCKER FROM THE HEADER, AND IT IS CONFIGURATION BECAUSE
   * THE ALTERNATIVE WAS A GUESS. `ScrapeCreatorsProvider` needs sources — a
   * TikTok region or keyword, an Instagram handle, a Facebook page URL — and
   * refuses an empty list rather than reporting an empty result, which is
   * right. Nobody in this repo knows whose trending feed an operator wants, and
   * defaulting to "US" would spend their credits answering a question about
   * somebody else's country. See `VENDOR_SOURCES` for what is derived and what
   * is refused.
   *
   * It is also the only way to configure a TikTok hashtag source, which needs
   * the vendor's undocumented parameter NAME alongside the hashtag and is
   * therefore a pair rather than a value — see `TikTokHashtagSource` in
   * lib/platform/scrapecreators.ts.
   */
  readonly vendorSources?: Partial<Record<ProviderBackedPlatform, readonly PlatformSource[]>>;
  /** Injected in tests so no adapter spawns a process. */
  readonly run?: YtDlpRunner;
  /**
   * An operator's YouTube Data API client, when one exists. Optional everywhere.
   *
   * STILL CALLER-SUPPLIED, AND NOTHING SUPPLIES IT. Unlike X and Meta this is
   * not built from the saved credential here, because `YouTubeClient` needs a
   * unit budget as well as a key and nobody with the authority to set one has —
   * lib/config.ts's `dailyQuotaUnits()` has no default on purpose. YouTube is
   * readable without a key, so this is an upgrade that is missing rather than a
   * platform that is dead; it is recorded here so it is not mistaken for done.
   */
  readonly youtubeClient?: YouTubeClient | null;
  /**
   * An X API v2 client, overriding the one this file would build.
   *
   * NORMALLY OMITTED. When `credentials` holds an X bearer token the registry
   * constructs the client itself; this field is for a test that wants a fake
   * transport, and for a caller that has already built one. An explicit `null`
   * means "no X client", which reports X unavailable even with a key saved.
   */
  readonly xClient?: XClient | null;
  /** X search configuration, overriding the environment. */
  readonly x?: Pick<XAdapterOptions, "query" | "maxPostsPerRun" | "windowHours">;
  /**
   * The shared Meta hourly call budget. Constructed here when omitted, which is
   * the normal path — the point is that ONE of them is given to BOTH
   * graph.facebook.com adapters. Supply one to widen or narrow the ceiling, or
   * to share it with something outside this registry.
   *
   * IT DOES NOT COVER THREADS. See `threadsBudget`.
   */
  readonly metaBudget?: MetaCallBudget;
  /**
   * Threads' own hourly call budget, separate from `metaBudget` because
   * graph.threads.net is a separate host with a separate quota. Sharing them
   * would let one platform's spending report the other as exhausted.
   */
  readonly threadsBudget?: MetaCallBudget;
  /** Injected so a test can drive a whole run without touching the network. */
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

/** One platform, as a page renders it — available or not. */
export interface PlatformStatus {
  readonly platform: Platform;
  /** "YouTube", "TikTok", "X" — spelled the way the platform spells itself. */
  readonly label: string;
  /** What this adapter is and what it needs. Always present. */
  readonly description: string;
  readonly available: boolean;
  /** Why not, in a sentence for a person. Null exactly when `available`. */
  readonly reason: string | null;
  /**
   * THINGS THAT ARE TRUE OF THIS ROW BUT ARE NOT THE ADAPTER'S OWN ANSWER.
   *
   * Exactly one thing lives here today: a ScrapeCreators key is saved and this
   * platform is NOT using it, with the sentence saying why — no region was
   * named for TikTok, no seeds for Instagram, the key could not be read at all.
   * That fact belongs to the registry, not to the adapter: `TikTokAdapter` does
   * not know a vendor key exists, so left to itself it would report "seed some
   * sec_uids" to an operator who has already paid for the thing that makes
   * seeds unnecessary.
   *
   * NOTES DO NOT DECIDE AVAILABILITY. A platform can be perfectly available and
   * still carry one — that is the normal case for a seeded TikTok with no
   * vendor region. When the row is UNAVAILABLE the notes are also appended to
   * `reason`, because `reason` is what /admin/shorts and /admin/seeds render
   * today and a refusal nobody can read is not a refusal.
   */
  readonly notes: readonly string[];
}

/**
 * Where a platform's seeds live in the environment.
 *
 * Derived from the platform name so there is no table to keep in step. The
 * value is a comma-, whitespace- or newline-separated list.
 */
export function seedEnvKey(platform: Platform): string {
  return `PLATFORM_SEEDS_${platform.toUpperCase()}`;
}

/**
 * Seeds for one platform from the CALLER OR THE ENVIRONMENT. Synchronous, and
 * deliberately unaware of the seed store — `resolveSeeds` below layers the
 * database on top, because reading it is async and this function is called from
 * lib/shorts/seeds.ts to answer "what does the environment still name that the
 * database does not hold".
 */
export function seedsFor(platform: Platform, options: RegistryOptions = {}): readonly string[] {
  const explicit = options.seeds?.[platform];
  if (explicit) return explicit.map((s) => s.trim()).filter(Boolean);
  const raw = (options.env ?? process.env)[seedEnvKey(platform)];
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A whole number from the environment, or null when unset, or NaN when set to
 * something that is not one.
 *
 * THE THREE OUTCOMES ARE THE POINT. `Number.parseInt("two hundred")` is NaN and
 * `?? null` would not catch it, so an unvalidated read turns a typo into "no cap
 * configured" — the same message an operator gets for a variable they never set.
 * NaN travels to the adapter intact so it can say which of the two happened.
 */
function readWholeNumber(env: Env, key: string): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
}

/**
 * X's search configuration: explicit options win, otherwise the environment.
 *
 * Nothing here has a default, and that is the whole design. An unconfigured X is
 * unavailable and says which variable is missing — see lib/platform/x.ts for why
 * a search query and a spend cap are the two things this repo refuses to guess
 * on somebody's behalf when the meter runs per Post returned.
 */
export function xConfigFor(options: RegistryOptions = {}): Pick<
  XAdapterOptions,
  "query" | "maxPostsPerRun" | "windowHours"
> {
  const env = options.env ?? process.env;
  return {
    query: options.x?.query ?? env.X_SEARCH_QUERY ?? null,
    maxPostsPerRun: options.x?.maxPostsPerRun ?? readWholeNumber(env, "X_MAX_POSTS_PER_RUN"),
    windowHours: options.x?.windowHours ?? readWholeNumber(env, "X_WINDOW_HOURS"),
  };
}

/**
 * Which spelling of X's Post fields parameter to send, from the environment.
 *
 * THIS EXISTS BECAUSE x-client.ts TELLS AN OPERATOR TO SET IT. When X accepts
 * the parameter and ignores it, the client throws with "Set X_POST_FIELDS_PARAM
 * to `post.fields` and run again" — and until this rewrite NOTHING IN THE TREE
 * READ THAT VARIABLE. An error message naming a lever that does not exist is
 * the same failure as an adapter nothing constructs, one sentence smaller.
 *
 * An unrecognised value is ignored rather than thrown on, and warned about
 * instead: this is read while a status page is rendering all five platforms,
 * and a typo in an optional escape hatch may not take that page down.
 */
function postFieldsParamFrom(env: Env): XPostFieldsParam | undefined {
  const raw = env.X_POST_FIELDS_PARAM?.trim();
  if (!raw) return undefined;
  const known = POST_FIELDS_PARAMS.find((name) => name === raw);
  if (known) return known;
  console.warn(
    `[platform/registry] X_POST_FIELDS_PARAM is set to ${JSON.stringify(raw)}, which is not one ` +
      `of ${POST_FIELDS_PARAMS.join(" or ")}. Ignoring it; X will send its default. See ` +
      "lib/platform/x-client.ts for why that parameter has two spellings.",
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// The data vendor
// ---------------------------------------------------------------------------

/**
 * WHERE AN OPERATOR SAYS WHAT TO ASK THE VENDOR FOR ON TIKTOK, and the request
 * ceiling for all three platforms.
 *
 * INSTAGRAM AND FACEBOOK ARE ABSENT FROM THIS TABLE ON PURPOSE. Their sources
 * come from the seeds, because there the seed IS the source: an Instagram seed
 * is the handle `/v1/instagram/user/reels` takes, and a Facebook seed is the
 * page URL `/v1/facebook/profile/reels` takes. TikTok is the one that is not
 * like that — a TikTok seed is a sec_uid, yt-dlp's internal creator key, while
 * this vendor's TikTok sources are a region or a keyword. There is no function
 * from one to the other, and writing one would be inventing a mapping and
 * calling it configuration.
 *
 * HASHTAG SOURCES ARE DELIBERATELY NOT READABLE FROM HERE. A hashtag source
 * needs the NAME of the query parameter that carries the hashtag as well as the
 * hashtag itself, and the vendor does not document that name — so it is a pair,
 * not a value, and it travels through `RegistryOptions.vendorSources` where the
 * two halves stay together.
 *
 * These belong in lib/config.ts with the other tunables, by the same one-line
 * change the seed variables above are waiting for.
 */
export const VENDOR_ENV = {
  /** Regions whose trending feed to read. The vendor's own example is "US". */
  tiktokRegions: "SCRAPECREATORS_TIKTOK_REGIONS",
  /** Keyword searches. Comma- or newline-separated; a keyword may contain spaces. */
  tiktokKeywords: "SCRAPECREATORS_TIKTOK_KEYWORDS",
  /** Requests ONE run may issue across all three platforms. Each one is a credit. */
  maxRequests: "SCRAPECREATORS_MAX_REQUESTS",
} as const;

/**
 * A Facebook seed this vendor can actually use: a public page URL.
 *
 * A PAGE ID IS NOT A PAGE URL AND THIS FILE WILL NOT BUILD ONE FROM THE OTHER.
 * Facebook's official Graph route takes a numeric Page id the operator
 * administers; the vendor's reels endpoint takes a public page URL. Both are
 * legitimate Facebook seeds, they are different values, and so the seed list is
 * FILTERED rather than converted — `https://www.facebook.com/<id>` is a URL
 * scheme this repo would be inventing, which resolves for some pages, 404s for
 * others, and costs a credit either way to find out which.
 */
const PAGE_URL = /^https?:\/\//i;

/** The vendor client, the providers built off it, and what could not be wired. */
interface VendorWiring {
  /** The ONE client. Null when no key is saved, or it could not be read or built. */
  readonly client: ScrapeCreatorsClient | null;
  /** What each adapter is given. An explicit `options.providers` entry wins. */
  readonly providers: Partial<Record<ProviderBackedPlatform, ProviderClient>>;
  /** One sentence per platform a saved key is NOT reaching, and why. */
  readonly notes: Partial<Record<ProviderBackedPlatform, string>>;
}

/** What to ask the vendor for on one platform, and what is missing if nothing. */
interface SourcePlan {
  readonly sources: readonly PlatformSource[];
  /**
   * Null when there is nothing to say. NOT null merely because `sources` is
   * non-empty: a Facebook seed list that is half page URLs and half Page ids
   * produces both sources AND a note, because the operator needs to know which
   * of the seeds they are looking at is not being read.
   */
  readonly note: string | null;
}

/**
 * A comma- or newline-separated list out of one variable.
 *
 * NOT `seedsFor`'S SPLIT, and the difference is load-bearing: that one splits on
 * whitespace as well, which is right for a channel id and wrong for a keyword.
 * "morning routine" is ONE search and two words; split, it buys two searches
 * nobody asked for at a credit each and reports them as results.
 */
function commaList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An error's message, for a note a person reads. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * WHAT TO ASK THE VENDOR FOR, PER PLATFORM. A table rather than a branch, so a
 * fourth vendor-backed platform is a compile error here rather than a silence.
 *
 * Each entry answers the third blocker the header names, and each one REFUSES
 * rather than guesses when it has nothing to go on. An unset source is "tell me
 * what to ask for" — never a default region, and never an empty result.
 */
const VENDOR_SOURCES = {
  tiktok: (options: RegistryOptions): SourcePlan => {
    const env = options.env ?? process.env;
    const regions = commaList(env[VENDOR_ENV.tiktokRegions]);
    const keywords = commaList(env[VENDOR_ENV.tiktokKeywords]);

    const sources: PlatformSource[] = [];
    // The trending feed is what this vendor was actually bought for: one
    // request, one credit, no seeds, and nothing keyless can do it at all.
    for (const region of regions) sources.push({ kind: "trending", region });
    for (const keyword of keywords) {
      // The region is attached when one is named and left unset otherwise. An
      // unset region is the vendor's own default; ours would be a second,
      // invisible one nobody could see they were being served.
      sources.push({ kind: "keyword", keyword, region: regions[0] });
    }
    if (sources.length > 0) return { sources, note: null };

    return {
      sources,
      note:
        "A ScrapeCreators key is saved, but nothing says WHAT to ask it about TikTok, so the " +
        "vendor is not being called and TikTok is still being read the keyless way — one named " +
        "creator at a time, by sec_uid, through yt-dlp. Your TikTok seeds are NOT used for this " +
        "and are not converted into it: a seed here is a sec_uid, TikTok's internal key for one " +
        "creator, while the vendor's TikTok sources are a REGION (whose trending feed to read) " +
        `or a KEYWORD to search for. Set ${VENDOR_ENV.tiktokRegions} to a region code (the ` +
        `vendor's own example is "US"), or ${VENDOR_ENV.tiktokKeywords} to a comma-separated ` +
        "list of searches, or both. No region is assumed here on purpose — a default would " +
        "quietly decide what you are looking for and charge you a credit for it.",
    };
  },

  instagram: (_options: RegistryOptions, seeds: readonly string[]): SourcePlan => {
    // The seed IS the source here. The leading @ is stripped for the same
    // reason `InstagramAdapter` strips it.
    const handles = seeds.map((seed) => seed.trim().replace(/^@/, "")).filter(Boolean);
    if (handles.length > 0) {
      return { sources: handles.map((handle) => ({ kind: "creator", handle })), note: null };
    }
    return {
      sources: [],
      note:
        "A ScrapeCreators key is saved and no Instagram accounts are seeded, so there is nothing " +
        "to ask it for and Instagram has fallen back to Meta's official Business Discovery " +
        "route — which needs a Meta token, an app review and the operator's own professional " +
        "account id, all of which this key was bought to make unnecessary. " +
        "/v1/instagram/user/reels is seeded by handle and it is the only Instagram endpoint " +
        "here that carries a view count at all. Seed the handles on /admin/seeds, or in " +
        `${seedEnvKey("instagram")}.`,
    };
  },

  facebook: (_options: RegistryOptions, seeds: readonly string[]): SourcePlan => {
    const trimmed = seeds.map((seed) => seed.trim()).filter(Boolean);
    const urls = trimmed.filter((seed) => PAGE_URL.test(seed));
    const rest = trimmed.filter((seed) => !PAGE_URL.test(seed));
    const sources: PlatformSource[] = urls.map((url) => ({ kind: "page", url }));

    // TWO DIFFERENT FACTS, NOT TWO WORDINGS OF ONE. "Nothing is seeded" and
    // "what you seeded is the wrong kind of value" are fixed by different
    // actions, and an operator sent to the wrong one loses an afternoon.
    const skipped =
      rest.length === 0
        ? null
        : `These Facebook seeds were not sent to ScrapeCreators because they are not page URLs: ` +
          `${rest.map((seed) => JSON.stringify(seed)).join(", ")}. The vendor's reels endpoint ` +
          "takes a PUBLIC PAGE URL (`https://www.facebook.com/someone`); these look like the " +
          "numeric Page ids the official Graph route takes, which is a different value for a " +
          "different route. This tool will not turn one into the other — a constructed URL " +
          "resolves for some pages and 404s for others, and costs a credit either way to find " +
          "out which. Add the page URL as a seed alongside the id.";

    if (sources.length > 0) return { sources, note: skipped };

    const nothing =
      "A ScrapeCreators key is saved and no Facebook page URL is seeded, so the vendor is not " +
      "being called. Facebook is page-seeded only — nobody sells Facebook Reels discovery, this " +
      "vendor included, so there is no trending or keyword alternative to fall back on. Seed " +
      `the public page URLs on /admin/seeds, or in ${seedEnvKey("facebook")}.`;
    return { sources, note: skipped ? `${nothing} ${skipped}` : nothing };
  },
} satisfies Record<
  ProviderBackedPlatform,
  (options: RegistryOptions, seeds: readonly string[]) => SourcePlan
>;

/**
 * The vendor credential, read WITHOUT the right to take the page down.
 *
 * THE ONE PLACE THIS FILE CATCHES A CREDENTIAL READ, and the header argues the
 * asymmetry: an unreadable X key breaks X, whereas this key is read on behalf
 * of three platforms that each still have the route they had before it existed,
 * and a deployment whose Postgres enum or environment store does not know the
 * `scrapecreators` provider yet is a real and expected state — it is exactly
 * what this tree looked like the day before the credential vocabulary widened.
 * The failure is carried out as a sentence rather than swallowed.
 */
async function leaseVendor(
  credentials: CredentialSource | null,
): Promise<{ lease: CredentialLease | null; failure: string | null }> {
  if (!credentials) return { lease: null, failure: null };
  try {
    /*
     * THE PROVIDER NAME IS SPELLED OUT HERE RATHER THAN PASSED AS
     * `VENDOR_PROVIDER`, AND THAT IS NOT AN OVERSIGHT.
     *
     * tests/credential-honesty.test.tsx greps the run path for
     * `lease("<provider>")` to decide whether the sentence on /admin/credentials
     * — "this key is spent on every run" — is TRUE. A constant here is invisible
     * to it, and the page would go back to making a claim nothing can check:
     * exactly the class of lie this repo keeps finding in itself. The literal
     * and the constant are pinned to each other in registry.test.ts, so they
     * cannot drift in silence either.
     */
    return { lease: await credentials.lease("scrapecreators"), failure: null };
  } catch (cause) {
    console.warn("[platform/registry] the ScrapeCreators credential could not be read:", cause);
    return {
      lease: null,
      failure:
        "The saved ScrapeCreators key could not be READ, which is not the same as no key being " +
        `saved: ${messageOf(cause)}. TikTok, Instagram and Facebook have fallen back to the ` +
        "routes they had before this vendor existed rather than this page failing outright. Fix " +
        "the credential store — a deployment whose credential vocabulary does not carry " +
        `"${VENDOR_PROVIDER}" yet fails here first — and note that nothing about the key itself ` +
        "has been called into question.",
    };
  }
}

/**
 * ONE CLIENT, THREE PROVIDERS, AND A SENTENCE FOR EVERY PLATFORM IT DOES NOT
 * REACH.
 *
 * THE LINE THIS WHOLE ROUND EXISTS FOR IS `new ScrapeCreatorsClient(...)`
 * BELOW. Before it, `ScrapeCreatorsClient` had one definition and not one
 * production call site, and lib/platform/scrapecreators.ts could be moved out
 * of the tree with the suite still 100% green and `tsc` still exiting 0.
 *
 * ONE CLIENT AND NOT THREE, the way `metaBudget` is one budget and not two.
 * There is ONE ScrapeCreators credit balance and three legs drawing on it, so a
 * client per platform would be a request ceiling per platform: a run capped at
 * 40 requests could issue 120 and no brake would ever fire.
 * lib/platform/meta-client.ts records that exact mistake being made once
 * already, which is why it is not being made a second time here.
 *
 * NOTHING IN THIS FUNCTION MAY THROW. Every failure becomes a note and a
 * fallback, because it runs while /admin/credentials and /admin/shorts render
 * all five platforms — and taking those pages down to enable one platform is a
 * strictly worse outcome than that platform staying on the route it had.
 */
function buildVendor(
  options: RegistryOptions,
  seeds: Record<Platform, readonly string[]>,
  key: CredentialLease | null,
  leaseFailure: string | null,
): VendorWiring {
  const explicit = options.providers ?? {};
  const providers: Partial<Record<ProviderBackedPlatform, ProviderClient>> = {};
  const notes: Partial<Record<ProviderBackedPlatform, string>> = {};
  const done = (client: ScrapeCreatorsClient | null): VendorWiring => {
    /*
     * A CLIENT THE CALLER HANDED IN WINS, AND ITS PLATFORM CARRIES NO NOTE.
     * Two clients answering for one platform is two credit meters against one
     * invoice, so `options.providers` is honoured outright rather than merged.
     * And since that platform IS being read by a provider, the vendor's "there
     * was nothing to ask it" sentence would be a false statement about a row
     * that is working — so it is dropped rather than printed beside it.
     */
    for (const platform of PROVIDER_BACKED_PLATFORMS) {
      const supplied = explicit[platform];
      if (!supplied) continue;
      providers[platform] = supplied;
      delete notes[platform];
    }
    return { client, providers, notes };
  };
  const everywhere = (note: string): VendorWiring => {
    for (const platform of PROVIDER_BACKED_PLATFORMS) notes[platform] = note;
    return done(null);
  };

  if (leaseFailure) return everywhere(leaseFailure);

  const secret = key?.secret?.trim();
  // NO KEY SAVED IS THE ORDINARY STATE AND GETS NO SENTENCE. Every adapter
  // already says what it needs, and adding "you have not bought a vendor" to
  // three more rows is noise on a page whose whole job is one button.
  if (!secret) return done(null);

  /*
   * A GARBAGE REQUEST CAP IS REFUSED RATHER THAN DEFAULTED, for the reason
   * `readWholeNumber` gives: "nobody set a cap" and "somebody set a cap to
   * `forty`" are different problems. Falling back to the client's own default
   * would spend on behalf of an operator who was visibly trying to limit it,
   * and this vendor bills per REQUEST — the cap IS what a run may cost.
   */
  const cap = readWholeNumber(options.env ?? process.env, VENDOR_ENV.maxRequests);
  if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1)) {
    return everywhere(
      `${VENDOR_ENV.maxRequests} is set to something that is not a whole number of requests, so ` +
        "no ScrapeCreators client was built, nothing was sent and nothing was charged. It caps " +
        "REQUESTS and not rows — the vendor bills 1 credit per request — so that number is what " +
        "a run may cost. Set it to a positive whole number, or unset it and take the vendor " +
        "client's own default.",
    );
  }

  let client: ScrapeCreatorsClient;
  try {
    client = new ScrapeCreatorsClient({
      // THE LEASED STRING, NOT A CLOSURE THAT RE-LEASES. `resolveWiring` runs
      // once per `buildAdapters` and every request in that run belongs to it; a
      // closure would put a SECURITY DEFINER round trip in front of each of the
      // requests a run may make. A rotated key is picked up on the next build,
      // which is the same guarantee the X client gives.
      apiKey: secret,
      fetch: options.fetchImpl,
      maxRequests: cap ?? undefined,
      now: options.now,
    });
  } catch (cause) {
    return everywhere(
      `The saved ScrapeCreators key could not be turned into a client: ${messageOf(cause)} ` +
        "Nothing was sent and nothing was charged; the three platforms it serves fell back to " +
        "the routes they had before the vendor existed.",
    );
  }

  for (const platform of PROVIDER_BACKED_PLATFORMS) {
    const override = options.vendorSources?.[platform];
    const plan = override?.length
      ? ({ sources: override, note: null } satisfies SourcePlan)
      : VENDOR_SOURCES[platform](options, seeds[platform]);
    if (plan.note) notes[platform] = plan.note;

    /*
     * A PLATFORM WITH NO SOURCES GETS NO PROVIDER, AND THE SENTENCE INSTEAD.
     * `ScrapeCreatorsProvider` does refuse an empty source list — correctly —
     * but it refuses inside `latestShorts`, which is the middle of a run, after
     * the platform card has already told the operator this platform was
     * available. Deciding it here puts the refusal on the card, before anybody
     * presses anything and before a credit is at risk.
     */
    if (plan.sources.length === 0) continue;

    try {
      providers[platform] = new ScrapeCreatorsProvider({ client, platform, sources: plan.sources });
    } catch (cause) {
      // The provider validates every source as it is constructed — a hashtag
      // with no parameter name, a trending source with no region — and refuses
      // before anything is sent. That refusal names its own fix and costs
      // nothing; letting it out of here would cost the page.
      notes[platform] =
        `ScrapeCreators refused the sources configured for ${platform}: ${messageOf(cause)} ` +
        "Nothing was sent and nothing was charged for it.";
    }
  }

  return done(client);
}

/** The vendor note for one platform, as a status row carries it. */
function vendorNotesFor(platform: Platform, vendor: VendorWiring): readonly string[] {
  const note = (vendor.notes as Partial<Record<string, string>>)[platform];
  return note ? [note] : [];
}

/**
 * Everything the builders need, with every asynchronous read already done.
 *
 * It exists so that `buildAdapters()` resolves ONCE for all five platforms. The
 * shared Meta budget is the reason it has to: two adapters built from two
 * separate resolutions would hold two budgets, which is the bug B2 names. The
 * shared ScrapeCreators client is the second reason, and a more expensive one:
 * three clients would be three request ceilings drawn against one credit
 * balance, so a run capped at 40 requests could issue 120.
 */
interface Wiring {
  readonly options: RegistryOptions;
  readonly seeds: Record<Platform, readonly string[]>;
  readonly xClient: XClient | null;
  readonly instagramToken: string | null;
  readonly facebookToken: string | null;
  readonly threadsToken: string | null;
  readonly igUserId: string | null;
  readonly metaBudget: MetaCallBudget;
  /**
   * THREADS METERS SEPARATELY, and that is not tidiness.
   *
   * `metaBudget` is ONE allowance shared by whoever holds the instance —
   * `take(platform)` names who to blame, it does not divide anything. Instagram
   * and Facebook share it because they share graph.facebook.com and its quota.
   * Threads is a different host with a different quota, so putting it in the
   * same bucket would make an Instagram run fail because a Threads run had
   * already spent the hour: a false statement about Instagram, produced by this
   * file, of exactly the kind its header is about.
   */
  readonly threadsBudget: MetaCallBudget;
  readonly vendor: VendorWiring;
}

/** The seed list per platform. Explicit beats the store, the store beats the environment. */
async function resolveSeeds(options: RegistryOptions): Promise<Record<Platform, readonly string[]>> {
  const rows = options.seedStore ? await options.seedStore.listSeeds() : null;

  const stored = {} as Record<Platform, string[]>;
  for (const platform of PLATFORMS) stored[platform] = [];
  for (const row of rows ?? []) {
    if (!row.active) continue;
    const value = row.seed.trim();
    // Optional-chained because the rows come from a database and nothing about
    // this file's types stops a sixth platform's row arriving from a newer
    // deployment sharing the schema.
    if (value) stored[row.platform]?.push(value);
  }

  const resolved = {} as Record<Platform, readonly string[]>;
  for (const platform of PLATFORMS) {
    const explicit = options.seeds?.[platform];
    if (explicit) resolved[platform] = explicit.map((s) => s.trim()).filter(Boolean);
    else if (rows) resolved[platform] = stored[platform];
    else resolved[platform] = seedsFor(platform, options);
  }

  // BREAK THE BOOTSTRAP DEADLOCK.
  //
  // Migration 11's `refresh_auto_seeds` ranks creators out of the `shorts`
  // table, so it can maintain a seed list but can never produce the first one:
  // no seeds -> no run -> no shorts -> nothing to rank -> no seeds. Confirmed
  // against the live database on 2026-09-05, where all three tables were empty
  // and every platform on /admin/shorts read "will not run".
  //
  // So when YouTube has no seeds, go and find some. `discoverYouTubeChannels`
  // walks public hashtag feeds with the same yt-dlp this deployment already
  // has, needs no key, and needs nobody to write a list.
  //
  // ONLY WHEN EMPTY. Once seeds exist — discovered, or ranked by the weekly
  // top 200 — this does nothing, so it costs one extra read on a cold
  // deployment and nothing on every run after it.
  if (resolved.youtube.length === 0 && options.run !== null) {
    const discovered = await bootstrapYouTubeSeeds(options, resolved);
    if (discovered.length > 0) resolved.youtube = discovered;
  }

  return resolved;
}

/**
 * Discover YouTube channels and, if there is somewhere to put them, keep them.
 *
 * NEVER THROWS. Discovery is an improvement on having nothing; if it fails,
 * the deployment is exactly as badly off as it was a moment ago, and taking
 * the whole registry down would turn "YouTube found no seeds" into "the page
 * is broken". The adapter's own `unavailableReason` still explains the empty
 * list.
 *
 * Persisting is best-effort for the same reason: an in-memory list still makes
 * THIS run work, and the next run rediscovers. A store that refuses writes —
 * which is every store on a deployment without a service-role key — must not
 * stop the run it was trying to help.
 */
async function bootstrapYouTubeSeeds(
  options: RegistryOptions,
  resolved: Record<Platform, readonly string[]>,
): Promise<readonly string[]> {
  const run = options.run ?? remoteRunner();
  if (!run) return [];

  let channels: Awaited<ReturnType<typeof discoverYouTubeChannels>>;
  try {
    channels = await discoverYouTubeChannels(run);
  } catch {
    return [];
  }
  if (channels.length === 0) return [];

  const store = options.seedStore;
  if (store && "addSeed" in store && !(store as { readOnlyReason?: string | null }).readOnlyReason) {
    for (const channel of channels) {
      try {
        await (store as unknown as { addSeed: (s: unknown) => Promise<unknown> }).addSeed({
          platform: "youtube",
          seed: channel.channelId,
          note: channel.channelName
            ? `auto-discovered: ${channel.channelName}`
            : "auto-discovered from YouTube hashtag feeds",
          addedBy: null,
        });
      } catch {
        // A duplicate, or a store that will not take it. Either way the
        // in-memory list below still works for this run.
      }
    }
  }

  void resolved;
  return channels.map((c) => c.channelId);
}

/**
 * Read the three credentials this registry spends, and turn them into the
 * objects the adapters take.
 *
 * The three leases go out together because a status page renders all five
 * platforms and three sequential round trips through a SECURITY DEFINER
 * function is a visible pause on a screen whose whole job is one button.
 */
/**
 * The configured remote runner, or undefined to mean "spawn locally".
 *
 * Undefined rather than a thrown error when unconfigured: a developer machine
 * with yt-dlp on PATH is a completely valid deployment and must not need this
 * service. `remoteYtDlpFromEnv` requires the URL and the token together, so a
 * half-configured deployment reads as unconfigured rather than failing to
 * authenticate against a host it cannot name.
 */
function remoteRunner(): YtDlpRunner | undefined {
  const remote = remoteYtDlpFromEnv();
  return remote ? makeRemoteYtDlpRunner(remote) : undefined;
}

async function resolveWiring(options: RegistryOptions = {}): Promise<Wiring> {
  const credentials = options.credentials ?? null;
  const lease = (platform: Platform): Promise<CredentialLease | null> =>
    credentials ? credentials.lease(platform) : Promise.resolve(null);

  // Named for the platform, not for `options.x`, which is X's SEARCH config and
  // a different thing entirely. The vendor lease goes out alongside them and is
  // the only one of the four that cannot reject — see `leaseVendor`.
  const [seeds, xKey, instagramKey, facebookKey, threadsKey, vendorKey] = await Promise.all([
    resolveSeeds(options),
    lease("x"),
    lease("instagram"),
    lease("facebook"),
    // Its own lease and not Instagram's. A Threads token comes from threads.net's
    // own OAuth with its own scopes and goes to its own host; sharing Meta's
    // would let a pasted Page token make Threads report itself configured and
    // then fail every call.
    lease("threads"),
    leaseVendor(credentials),
  ]);

  return {
    // THE RUNNER IS RESOLVED HERE, ONCE, so every adapter in a run shares it.
    //
    // `options.run` wins whenever it is set — that is how every test injects a
    // fake and never spawns anything. Otherwise, if this deployment has been
    // given a yt-dlp SERVICE, use it; otherwise leave it undefined and let each
    // adapter fall back to spawning the local binary.
    //
    // The middle case is the one this exists for. On Vercel there is no yt-dlp
    // and no way to install one, so the local spawn fails with ENOENT and the
    // YouTube adapter correctly but uselessly reports that it is unavailable.
    // See services/ytdlp and lib/platform/ytdlp-remote.ts.
    options: { ...options, run: options.run ?? remoteRunner() },
    seeds,
    vendor: buildVendor(options, seeds, vendorKey.lease, vendorKey.failure),
    // `undefined` means "build one if there is a key"; an explicit null means
    // the caller has said there is to be no X client, and is honoured.
    xClient: options.xClient !== undefined ? options.xClient : xClientFrom(xKey, options),
    instagramToken: instagramKey?.secret?.trim() || null,
    facebookToken: facebookKey?.secret?.trim() || null,
    threadsToken: threadsKey?.secret?.trim() || null,
    igUserId: instagramKey?.identifiers[IG_USER_ID_FIELD]?.trim() || null,
    // ONE budget, handed to BOTH graph.facebook.com adapters below. See the header.
    metaBudget: options.metaBudget ?? new MetaCallBudget(),
    // Threads' own. See `Wiring.threadsBudget` for why it is not the one above.
    threadsBudget: options.threadsBudget ?? new MetaCallBudget(),
  };
}

/**
 * The X client, built from the saved bearer token.
 *
 * THE LINE WHOSE ABSENCE MADE X PERMANENTLY UNAVAILABLE. Null when no X
 * credential is saved, which `XAdapter.unavailableReason()` reports as "no X
 * credential is configured" — true then, and a lie for as long as this function
 * did not exist.
 */
function xClientFrom(lease: CredentialLease | null, options: RegistryOptions): XClient | null {
  const token = lease?.secret?.trim();
  if (!token) return null;
  return new XClient({
    bearerToken: token,
    fetch: options.fetchImpl,
    postFieldsParam: postFieldsParamFrom(options.env ?? process.env),
  });
}

/**
 * The map from platform to adapter. THE ONLY PLACE IT EXISTS.
 *
 * `satisfies Record<Platform, ...>` is load-bearing: add a sixth platform to
 * PLATFORMS and this object stops compiling until somebody says what reads it.
 * A registry that silently returns nothing for a known platform would produce
 * exactly the missing row the honesty rule forbids, and a runtime check would
 * find that out too late.
 *
 * EVERY BUILDER TAKES THE RESOLVED WIRING AND PASSES ON EVERYTHING IT HAS. The
 * previous version of this table dropped the second argument on both Meta
 * adapters and never built an X client at all, and the type system was happy
 * about it because both of those are optional — optional so that the adapters
 * could land without their caller changing on the same commit. That kindness is
 * what let the wiring never arrive.
 */
const BUILDERS = {
  youtube: (w: Wiring) =>
    new YouTubeAdapter({
      seeds: w.seeds.youtube,
      run: w.options.run,
      client: w.options.youtubeClient ?? null,
      now: w.options.now,
    }),
  // THE FIRST ARGUMENT COULD NOT BE WRITTEN UNTIL 2026-09-04. `TikTokAdapter`
  // had no slot for a provider, so the one platform this vendor was bought for
  // was the one it could not reach. It now matches its two Meta siblings —
  // provider first and positional, configuration second.
  tiktok: (w: Wiring) =>
    new TikTokAdapter(w.vendor.providers.tiktok ?? null, {
      seeds: w.seeds.tiktok,
      run: w.options.run,
      now: w.options.now,
    }),
  instagram: (w: Wiring) =>
    new InstagramAdapter(w.vendor.providers.instagram ?? null, {
      igUserId: w.igUserId,
      seeds: w.seeds.instagram,
      token: w.instagramToken,
      budget: w.metaBudget,
      fetchImpl: w.options.fetchImpl,
      now: w.options.now,
    }),
  /*
   * `meterWithX` IS THE SAME DEFECT AGAIN, FOUND WHILE FIXING IT, AND IT IS
   * FIXED ON THIS LINE.
   *
   * lib/platform/x-client.ts's header writes out the registry line that was
   * supposed to exist — `x: (w) => meterWithX(new XAdapter(...), w.xClient)` —
   * and `meterWithX` had ZERO call sites in the tree. So `XMeteredAdapter`,
   * which exists precisely so a run billing $0.005 a row does not report a
   * price of nothing, was never constructed, `spendCapabilities()` saw a plain
   * `XAdapter` with no brand, and `report.spend` stayed structurally empty for
   * a metered platform. That is the fourth instance of "a well-built unit with
   * no caller" in this file's history and the third one this round has had to
   * close.
   *
   * IT RETURNS THE ADAPTER UNCHANGED WHEN THERE IS NO CLIENT, which is the
   * behaviour that matters: an unconfigured X charges nothing and must not
   * appear in a spend list as a zero, because in `report.spend` a missing
   * platform means "quoted no price" and never "was free".
   */
  x: (w: Wiring) =>
    meterWithX(new XAdapter({ ...xConfigFor(w.options), client: w.xClient, now: w.options.now }), w.xClient, {
      ...xConfigFor(w.options),
      now: w.options.now,
    }),
  facebook: (w: Wiring) =>
    new FacebookAdapter(w.vendor.providers.facebook ?? null, {
      seeds: w.seeds.facebook,
      token: w.facebookToken,
      budget: w.metaBudget,
      fetchImpl: w.options.fetchImpl,
      now: w.options.now,
    }),
  // NO PROVIDER ARGUMENT, and its absence is a fact rather than an omission:
  // no data vendor this repo can buy sells Threads, ScrapeCreators included.
  // The token is the only way in, which is why `ThreadsAdapter` does not extend
  // `ProviderBackedAdapter` — a provider slot nothing can ever fill is a slot
  // somebody eventually wires a wrong thing into.
  threads: (w: Wiring) =>
    new ThreadsAdapter({
      token: w.threadsToken,
      budget: w.threadsBudget,
      fetchImpl: w.options.fetchImpl,
      now: w.options.now,
    }),
} satisfies Record<Platform, (wiring: Wiring) => PlatformAdapter>;

/**
 * The adapter for one platform, wired.
 *
 * ASYNC BECAUSE A CREDENTIAL READ IS. See the header for why that was worth a
 * breaking change to four call sites.
 */
export async function adapterFor(platform: Platform, options: RegistryOptions = {}): Promise<PlatformAdapter> {
  return BUILDERS[platform](await resolveWiring(options));
}

/**
 * All five adapters, in the vocabulary's order, sharing one resolution.
 *
 * ONE `resolveWiring` FOR THE WHOLE SET, not one per platform, and that is not
 * an optimisation. It is what makes the Meta budget shared: five separate
 * resolutions would mean two budgets, and two budgets against one Meta app can
 * together spend twice the allowance without either one refusing.
 */
export async function buildAdapters(
  options: RegistryOptions = {},
): Promise<ReadonlyMap<Platform, PlatformAdapter>> {
  const wiring = await resolveWiring(options);
  return new Map(PLATFORMS.map((platform) => [platform, BUILDERS[platform](wiring)]));
}

/**
 * All five platforms and whether each can run right now.
 *
 * Asked concurrently because `unavailableReason()` may shell out to check that
 * yt-dlp exists, and five sequential process spawns is a visible pause on a page
 * whose whole job is one button.
 *
 * A reason-check that THROWS is caught and reported as unavailable. It is never
 * allowed to take the whole list down, and it is never allowed to read as
 * available: an adapter that could not even say whether it works has not said it
 * works.
 *
 * A CREDENTIAL READ THAT THROWS IS NOT CAUGHT and comes out of here. That is
 * the deliberate asymmetry: an adapter failing its own check is one platform's
 * problem and the other four still render, whereas a store that cannot answer
 * is a broken deployment, and reporting five platforms as "no key configured"
 * because the key could not be READ is the exact confusion this repo exists to
 * refuse.
 */
export async function platformStatuses(options: RegistryOptions = {}): Promise<PlatformStatus[]> {
  // RESOLVED HERE RATHER THAN THROUGH `buildAdapters`, because a status row
  // carries something no adapter knows: whether a saved vendor key is reaching
  // this platform. See `PlatformStatus.notes`.
  const wiring = await resolveWiring(options);
  return Promise.all(
    PLATFORMS.map((platform) =>
      statusFor(BUILDERS[platform](wiring), vendorNotesFor(platform, wiring.vendor)),
    ),
  );
}

/**
 * One adapter's status. Exported because the failure it handles — an adapter
 * that throws while being asked whether it works — needs a hostile adapter to
 * test, and building one is not something the registry should have a hole for.
 */
export async function statusFor(
  adapter: PlatformAdapter,
  notes: readonly string[] = [],
): Promise<PlatformStatus> {
  let description: string;
  try {
    description = adapter.describe();
  } catch {
    description = "This adapter could not describe itself.";
  }

  let reason: string | null;
  try {
    reason = await adapter.unavailableReason();
  } catch (cause) {
    reason =
      `could not be checked: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      "Treating that as unavailable — an adapter that cannot say whether it works has not said " +
      "it works.";
  }

  return {
    platform: adapter.platform,
    label: platformLabel(adapter.platform),
    description,
    // AVAILABILITY IS THE ADAPTER'S ANSWER AND A NOTE NEVER OVERRULES IT. A
    // seeded TikTok with no vendor region is available and carries a note; a
    // note that flipped it would report a working platform as broken.
    available: reason === null,
    // Appended when the row is already unavailable, because `reason` is the
    // only field the admin pages render today and a refusal nobody reads is
    // not a refusal. See `PlatformStatus.notes`.
    reason: reason === null ? null : [reason, ...notes].join(" "),
    notes,
  };
}
/**
 * WHICH PLATFORMS CANNOT HAND THE OPERATOR A USABLE MEDIA LINK.
 *
 * A TABLE AND NOT AN `if`, for the reason lib/platform/registry.test.ts states
 * at length: a fork on a platform name is a fork some other platform silently
 * does not take. The keys are checked by the compiler, so a sixth platform
 * cannot be added without somebody deciding this for it.
 *
 * TRUE MEANS: a link resolved for this platform is bound to the address that
 * resolved it, so the bytes have to be fetched by the machine that asked and
 * streamed to the operator. MEASURED for YouTube on 2026-09-08 — every
 * googlevideo URL carries a signed `ip=` parameter:
 *
 *   the same URL, from another address:          HTTP 403, 0 bytes
 *   the same URL, through the originating exit:  HTTP 206, 200001 bytes
 *
 * and the resolve necessarily runs through a proxy, because YouTube gates the
 * player API by address. So the URL belongs to the proxy, not to the person who
 * pressed the button.
 *
 * FALSE IS NOT A CLAIM THAT THE OTHER FOUR ARE FINE. It is the honest state of
 * "nobody has measured this one". Each is false until somebody watches a link
 * fail from a second address, exactly as YouTube's was watched. Flipping one on
 * a hunch would spend proxy bandwidth on a platform that never needed it;
 * flipping it on a measurement is a one-word change.
 */
export const LINK_IS_BOUND_TO_ITS_RESOLVER: Record<Platform, boolean> = {
  youtube: true,
  tiktok: false,
  instagram: false,
  facebook: false,
  x: false,
  threads: false,
};

/** Does a link for this platform have to be served by whoever resolved it? */
export function linkIsBoundToItsResolver(platform: Platform): boolean {
  return LINK_IS_BOUND_TO_ITS_RESOLVER[platform];
}
