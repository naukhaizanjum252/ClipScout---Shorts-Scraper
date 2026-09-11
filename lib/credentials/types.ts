/**
 * Operator-supplied API credentials.
 *
 * THE RULE THIS WHOLE DIRECTORY EXISTS TO ENFORCE
 *
 * The plaintext key leaves the database in exactly one direction: into an
 * outbound API request. It never reaches the browser, never reaches an admin,
 * never reaches a log line, an error message, a fixture or a JSON response.
 *
 * That is made structural rather than remembered, by having TWO types:
 *
 *   MaskedCredential   what every read path returns. Cannot hold a secret —
 *                      there is no field for one.
 *   PlaintextLease     what a single outbound call gets. Only obtainable from
 *                      `CredentialStore.lease()`, which is server-only.
 *
 * A route or a component that imports `MaskedCredential` physically cannot leak
 * a key, because the object it holds does not contain one. lib/credentials/
 * mask.test.ts asserts that over the real shapes.
 *
 * WHOSE KEY IS IT
 *
 * The operator's. Not Erik's, and not this agency's. Whoever runs the tool sets
 * up their own account with the provider, pastes their own key, and carries
 * their own quota, billing and terms-of-service exposure. That is the answer to
 * the plan's open question Q1(b) — "whose Google Cloud project and billing
 * account?" — and the mechanism for it is this table. Widening the tool to five
 * platforms widened the answer with it: it is now one account per provider, all
 * of them the operator's.
 */
import { PLATFORMS, isPlatform, type Platform } from "../platform/types";

/**
 * ============================================================================
 * THE CREDENTIAL VOCABULARY. A PROVIDER IS NOT A PLATFORM.
 * ============================================================================
 *
 * SCAR, 2026-09-04, AND IT IS THE ROOT CAUSE OF A ROUND THAT FAILED TWICE.
 *
 * This file used to read, in full:
 *
 *     export const CREDENTIAL_PROVIDERS = PLATFORMS;
 *     export type CredentialProvider = Platform;
 *
 * — the credential vocabulary ALIASED to the platform list. The paragraph that
 * stood here defended it and named its own expiry: "THE DAY ERIK NAMES A
 * PROVIDER, this alias is what gives way." Erik named one on 2026-09-04, and
 * the alias did not give way, and everything downstream inherited the
 * consequence. ScrapeCreators is a VENDOR — one key that reads three platforms
 * — so under the alias there was no word for it. `lib/platform/scrapecreators.ts`
 * shipped a complete, well-tested client with ZERO production call sites,
 * because the registry had nothing to lease it FROM: asking a real store for a
 * provider that is not in this list does not return null, it crashes looking up
 * a field spec that does not exist. A reviewer moved that file out of the tree
 * entirely and 976 tests stayed green.
 *
 * So the alias is gone, and what replaces it keeps the distinction IN THE TYPE
 * SYSTEM rather than in a comment:
 *
 *   A PLATFORM CREDENTIAL is a key for a platform's OWN API, and the slot is
 *   named after the platform because that is who issues it and who bills for
 *   it. youtube, tiktok, instagram, x, facebook. One key, one platform, and
 *   `platformsServedBy` returns exactly that platform.
 *
 *   A VENDOR CREDENTIAL is a key for a third party that resells SEVERAL
 *   platforms. scrapecreators. One key, three platforms, and
 *   `platformsServedBy` returns the three — a real answer, computed from a
 *   declared table, not a sentence in a comment somebody has to read.
 *
 * WHY THAT SECOND FUNCTION MATTERS MORE THAN THE UNION DOES. The question
 * "which platforms does this key serve" is asked by the registry (which client
 * do I hand to which adapter), by the credentials page (what does the operator
 * get for their money) and by anyone auditing a bill. Under the alias the
 * question had no spelling at all, so every caller answered it by assuming the
 * provider id WAS the platform. That assumption is now false for one provider
 * out of six, and the compiler cannot catch an assumption. A function can.
 *
 * THE TWO SQL ENUMS WERE RIGHT ALL ALONG. `shorts_scraper.credential_provider`
 * and `shorts_scraper.platform` have always been separate types whose values
 * happened to match, precisely so a vendor could be added as its own value
 * covering several platforms. This file is what finally caught up with the
 * schema, rather than the other way round — and the enum now carries the sixth
 * value. tests/migrations.test.ts asserts the two lists agree, so a value added
 * to one and not the other fails the build instead of failing an insert.
 *
 * SEVERAL PROVIDERS ARE ACTIVE AT ONCE — that is the point. What is still ONE is
 * the active credential *per provider*: `lease()` has to return a single key
 * without guessing, and the database enforces it with a partial unique index
 * (`api_credentials_one_active_per_provider`).
 */

/**
 * The platform-named slots. THIS is `PLATFORMS`, not a copy of it, so the half
 * of the vocabulary that really is one-to-one with a platform still cannot
 * drift from the platform list.
 */
export const PLATFORM_CREDENTIAL_PROVIDERS = PLATFORMS;
export type PlatformCredentialProvider = Platform;

/**
 * The vendor slots. ONE ENTRY, AND ADDING A SECOND IS DELIBERATELY MORE WORK
 * THAN ADDING A PLATFORM: a vendor has to declare which platforms it serves in
 * `VENDOR_SERVES` below or this file does not compile, because a vendor key
 * whose coverage nobody wrote down is a bill nobody can attribute.
 */
export const VENDOR_CREDENTIAL_PROVIDERS = ["scrapecreators"] as const;
export type VendorCredentialProvider = (typeof VENDOR_CREDENTIAL_PROVIDERS)[number];

export type CredentialProvider = PlatformCredentialProvider | VendorCredentialProvider;

/**
 * Platforms first, then vendors. The order is the order the UI groups by, and
 * it is deliberate: an operator scanning the page reads the five slots they
 * already understand before the one that is a new idea.
 */
export const CREDENTIAL_PROVIDERS = [
  ...PLATFORM_CREDENTIAL_PROVIDERS,
  ...VENDOR_CREDENTIAL_PROVIDERS,
] as const;

/** Which of the two a slot is. Rendered, and branched on nowhere else. */
export type CredentialProviderKind = "platform" | "vendor";

/**
 * WHICH PLATFORMS A VENDOR KEY ACTUALLY BUYS. The table, and the whole reason
 * this vocabulary exists.
 *
 * SCRAPECREATORS SERVES THREE AND NOT FIVE, and both exclusions are findings
 * rather than omissions:
 *
 *   NOT X. X's own API returns the view count, the duration and the video
 *   variants in one response, and duration is the only thing that defines a
 *   Short in this product. This vendor supplies no duration for X at all, so
 *   routing X through it would lose the field the 120-second filter runs on.
 *   X stays on the official, metered, first-party API.
 *
 *   NOT YOUTUBE. YouTube is read keylessly by walking the uploads playlist
 *   with yt-dlp. There is nothing for a vendor to add and no reason to pay a
 *   credit for it.
 *
 * A wrong entry here is not cosmetic: it is the difference between an operator
 * believing one purchase covers their whole run and discovering after they have
 * paid that the platform they cared about was never included.
 */
const VENDOR_SERVES: Readonly<Record<VendorCredentialProvider, readonly Platform[]>> = {
  scrapecreators: ["tiktok", "instagram", "facebook"],
};

/** Narrowing test for the vendor half. */
export function isVendorCredentialProvider(value: unknown): value is VendorCredentialProvider {
  return typeof value === "string" && (VENDOR_CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Narrowing test for anything arriving from outside — a form field, a row, a
 * query parameter.
 *
 * It used to be `isPlatform` under another name. It is now the union of the two
 * halves, which is the whole change: a form that posts `scrapecreators` is
 * accepted, and a form that posts `vimeo` is still refused at the boundary
 * rather than at the SQL enum.
 */
export function isCredentialProvider(value: unknown): value is CredentialProvider {
  return isPlatform(value) || isVendorCredentialProvider(value);
}

/** Whether this slot is a platform's own API or a reseller serving several. */
export function credentialProviderKind(provider: CredentialProvider): CredentialProviderKind {
  return isVendorCredentialProvider(provider) ? "vendor" : "platform";
}

/**
 * WHICH PLATFORMS DOES THIS KEY SERVE — a real answer, for every provider.
 *
 * A platform provider serves itself: the identity that used to be assumed
 * everywhere, now stated once, in the one place that is allowed to know it. A
 * vendor provider serves whatever `VENDOR_SERVES` declares.
 *
 * Callers that used to write `lease(this.platform)` and treat the provider id
 * as a platform are the reason this exists. They were right for five providers
 * out of six and there was nothing in the type system to tell them where the
 * sixth broke the pattern.
 */
export function platformsServedBy(provider: CredentialProvider): readonly Platform[] {
  return isVendorCredentialProvider(provider) ? VENDOR_SERVES[provider] : [provider];
}

export type CredentialStatus = "active" | "disabled";

/**
 * A CREDENTIAL IS NOT ONE STRING ANY MORE, AND THIS PAIR IS WHERE THAT LANDS.
 *
 * 2026-09-04. It was one string for as long as the tool read one platform,
 * because a YouTube Data API v3 credential genuinely is one opaque key. X is
 * also one value. Meta is not: `debug_token` cannot be called without an app id
 * and an app secret as well as the token, and Business Discovery additionally
 * needs the operator's own Instagram business account id. Squeezing that into
 * one box produces the worst possible support conversation — the operator
 * pastes a valid token, presses Test, and is told the key is bad because a
 * number nobody asked them for is missing.
 *
 * THE SPLIT IS THE SECURITY BOUNDARY, PER FIELD RATHER THAN PER CREDENTIAL.
 * `secrets` is sealed and never leaves the server. `identifiers` — an app id, a
 * Page id — is not secret, is stored in a readable column and IS shown back, so
 * an operator can check they pasted the right app. See lib/credentials/fields.ts
 * for which field is which and why.
 */
export interface CredentialValues {
  readonly secrets: Readonly<Record<string, string>>;
  readonly identifiers: Readonly<Record<string, string>>;
}

/**
 * A credential as anyone is ever allowed to SEE it.
 *
 * Note what is absent: there is no `secret`, no `ciphertext`, no `key`. This
 * type is the display shape and it is deliberately incapable of carrying one.
 */
export interface MaskedCredential {
  readonly id: string;
  readonly provider: CredentialProvider;
  /** Operator-chosen name, e.g. "Lucky35 research project". */
  readonly label: string;
  /** Last 4 characters only, already formatted — e.g. `••••••••4f2a`. */
  readonly masked: string;
  /**
   * The NON-SECRET fields, by field id — app id, Page id, Instagram business
   * account id. Readable on purpose: these are the values an operator has to be
   * able to check, and hiding them would mean the only way to answer "which app
   * is this key for" is to delete the credential and re-enter it blind.
   *
   * A secret can never arrive here. `parseCredentialValues()` routes a field by
   * its declared `kind` and the store writes the two maps to two different
   * places, so this is not a convention that has to be remembered at a call
   * site.
   */
  readonly identifiers: Readonly<Record<string, string>>;
  readonly status: CredentialStatus;
  readonly created_at: string;
  /** Auth user id of whoever pasted it in. */
  readonly created_by: string | null;
  /** When it was last used for a real call, or null if never. */
  readonly last_used_at: string | null;
  /**
   * Outcome of the last "test this key" press: null = never tested,
   * true = one cheap real call succeeded, false = it did not.
   */
  readonly last_check_ok: boolean | null;
  readonly last_check_at: string | null;
  /** Why the last check failed, with the value scrubbed. Null when it passed. */
  readonly last_check_error: string | null;
}

/**
 * A plaintext key, handed out for one purpose and carrying the identity needed
 * to bill the quota back to the right row.
 *
 * Deliberately NOT called `Credential` and deliberately not spreadable into a
 * response body without it being obvious in review.
 */
export interface PlaintextLease {
  readonly credentialId: string;
  readonly label: string;
  /**
   * The PRIMARY secret — the one field per provider that is the key: the
   * YouTube API key, the X bearer token, the Meta access token.
   *
   * KEPT AS A FLAT STRING DELIBERATELY when the shape widened on 2026-09-04.
   * Every caller that existed at that moment (`verify/quota.ts`, the YouTube
   * path) wants exactly this value, and breaking them to express a shape they
   * do not use would have been churn dressed up as rigour. A caller that needs
   * more than one field reads `secrets` instead.
   */
  readonly secret: string;
  /** Every sealed field, by field id. Includes the primary one. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Every readable field, by field id. Never contains a secret. */
  readonly identifiers: Readonly<Record<string, string>>;
  /** Which store produced it, so a log line can say `env` vs `database`. */
  readonly origin: "database" | "environment";
}

/**
 * What a save is given.
 *
 * TWO WAYS IN, AND EXACTLY ONE OF THEM PER CALL. `fields` is the real one: the
 * raw form submission, keyed by field id, validated and split by
 * `parseCredentialValues()`. `secret` is the single-value shorthand, kept
 * because it is what every pre-2026-09-04 caller passes and because for the two
 * providers whose credential really is one value it stays the honest spelling.
 * It is interpreted as the provider's primary field.
 *
 * Giving both is refused rather than merged. A merge would have to pick a
 * winner, and a settings page that silently discards half of what was typed is
 * the failure this whole directory is built to avoid.
 */
export interface SaveCredentialInput {
  readonly provider: CredentialProvider;
  readonly label: string;
  /** The primary secret on its own. Mutually exclusive with `fields`. */
  readonly secret?: string;
  /** The whole submission, by field id. Mutually exclusive with `secret`. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly createdBy: string | null;
}

/**
 * The credential store. Server-side only — nothing in `app/` may import an
 * implementation into a client component.
 */
export interface CredentialStore {
  /** Everything the operator may see. Never contains a secret. */
  list(provider?: CredentialProvider): Promise<MaskedCredential[]>;
  /** Store a new key. Returns the masked view, never the value back. */
  save(input: SaveCredentialInput): Promise<MaskedCredential>;
  /** Remove one permanently. */
  remove(id: string): Promise<void>;
  /**
   * The active key for ONE provider, in plaintext, for ONE outbound call.
   *
   * `null` means no usable credential for THAT provider. It is a normal state
   * and not an error — some platforms are read without a key — and it is never
   * an answer about the platform's content. An adapter handed a null lease
   * either reads without one or reports itself unavailable and says why; what
   * it must never do is return an empty list that reads as "no shorts found".
   */
  lease(provider: CredentialProvider): Promise<PlaintextLease | null>;
  /** Record that a key was used / tested. Never writes the value anywhere. */
  noteUse(id: string, at?: Date): Promise<void>;
  noteCheck(id: string, ok: boolean, error: string | null, at?: Date): Promise<void>;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}
