/**
 * WHAT EACH PROVIDER'S CREDENTIAL IS ACTUALLY MADE OF.
 *
 * THE DECISION THIS FILE RECORDS: a credential is no longer one string.
 *
 * It was, and it was wrong the moment the tool stopped being a YouTube tool. A
 * YouTube Data API v3 credential really is one opaque key on a query string. An
 * X credential is one bearer token. A META credential is not one of anything —
 * `debug_token` cannot be called without an app id AND an app secret AND the
 * token being inspected, and Business Discovery cannot be called without the
 * operator's own Instagram business account id on top. Forcing that into a
 * single `secret` box leaves the operator pasting a token, pressing Test, and
 * being told their key is bad when what is actually missing is a number they
 * were never asked for.
 *
 * SO THE SHAPE IS DECLARED, PER PROVIDER, AND THE SECURITY PROPERTY IS PER
 * FIELD RATHER THAN PER CREDENTIAL.
 *
 *   kind: "secret"      sealed with AES-256-GCM, never leaves the server, never
 *                       rendered, no reveal control exists and none can.
 *   kind: "identifier"  a Facebook app id, a Page id, an Instagram business
 *                       account id. These are not secrets — an app id is
 *                       printed in every Meta login dialog — and they are the
 *                       things an operator most needs to SEE to know they
 *                       pasted the right one. They are stored in a readable
 *                       column and shown.
 *
 * Calling an app id a secret would be security theatre with a real cost: the
 * operator could never check it, and every support conversation about "which
 * app is this key for" would end in deleting the credential and re-entering it
 * blind. Calling an app SECRET an identifier would be the actual failure. The
 * split is the point of this file.
 *
 * EXACTLY ONE FIELD PER PROVIDER IS `primary`, AND IT IS ALWAYS A SECRET.
 * It is the value the mask is taken from, the value `PlaintextLease.secret`
 * carries, and the value the provider's development environment variable holds.
 * That is what keeps the pre-existing single-secret callers — `verify/quota.ts`
 * and the YouTube path — compiling and correct while the shape widens
 * underneath them. `assertFieldSpecs()` at the bottom of this file fails at
 * import time if a provider ever has zero or two of them.
 *
 * WHERE THE FIELD NAMES COME FROM. Every one is the name the issuer uses, read
 * out of the vendor's own reference on 2026-09-04 and cited on the field:
 * `input_token` and `access_token` and the `{app-id}|{app-secret}` app-token
 * shortcut from developers.facebook.com, `business_discovery.username(...)` on
 * an IG User node from the Instagram Platform reference, `Authorization: Bearer`
 * from docs.x.com. Nothing here is a name this repo made up, and nothing here
 * is a name for a vendor nobody has chosen.
 */
import { CredentialError, type CredentialProvider, type CredentialValues } from "./types";

export type CredentialFieldKind = "secret" | "identifier";

export interface CredentialField {
  /** Form field name and storage key. Lower snake_case. */
  readonly id: string;
  /** What the issuer calls it, so the operator can find it in their console. */
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly required: boolean;
  /**
   * The one secret whose mask is displayed and which `lease().secret` returns.
   * Exactly one per provider.
   */
  readonly primary: boolean;
  /** Development-only environment variable. Declared, so it is greppable. */
  readonly envVar: string;
  /** Where the operator gets this value, in one sentence. */
  readonly hint: string;
}

/**
 * The field specs.
 *
 * TIKTOK'S SLOT IS FOR TIKTOK'S OWN API AND THERE IS STILL NOTHING TO PUT IN
 * IT. All three of TikTok's official APIs — Research, Display, Commercial
 * Content — are closed to this use. Declaring `client_key` / `client_secret`
 * here would be inventing the shape of an integration nobody can sign up for.
 * One slot, one sentence saying it sits unused.
 *
 * THE VENDOR KEY IS NOT IN THAT SLOT AND MUST NEVER BE PUT THERE. Until
 * 2026-09-04 this comment said "no third-party data provider has been chosen",
 * which was true when it was written and stopped being true the day Erik chose
 * ScrapeCreators. The tempting fix was to let a ScrapeCreators key live in
 * `tiktok`, and it is wrong for a reason the whole vocabulary rewrite turns on:
 * ONE ScrapeCreators key serves TikTok AND Instagram AND Facebook, so putting
 * it in a platform slot would force an operator to buy and paste the same key
 * three times, into three slots, each of which would then bill the same
 * account and none of which could say so. It has its own slot below.
 */
const SPECS: Readonly<Record<CredentialProvider, readonly CredentialField[]>> = {
  youtube: [
    {
      id: "api_key",
      label: "YouTube Data API v3 key",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "YOUTUBE_API_KEY",
      hint: "Google Cloud console, APIs & Services, Credentials, Create credentials, API key — in a project that has YouTube Data API v3 enabled.",
    },
  ],

  tiktok: [
    {
      id: "api_key",
      label: "TikTok data provider key",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "TIKTOK_API_KEY",
      hint: "There is nowhere to get this yet. No TikTok data provider has been chosen and TikTok's own APIs are closed to this use.",
    },
  ],

  /**
   * X. ONE BEARER TOKEN, WHICH IS GENUINELY ALL IT IS.
   *
   * X API v2 authenticates an app-only read with `Authorization: Bearer
   * <token>`; the token is generated in the X developer portal for a project's
   * app. There is no second field to collect: the api key / api secret pair
   * exists in the portal but is what MINTS a bearer token, not what a v2 read
   * sends. Asking for all three would be asking the operator to hand over more
   * than the tool needs.
   */
  x: [
    {
      id: "bearer_token",
      label: "Bearer token (app-only)",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "X_API_KEY",
      hint: "X developer portal, your project's app, Keys and tokens, Bearer Token. It is shown once.",
    },
  ],

  /**
   * INSTAGRAM. FOUR FIELDS, AND THE FOURTH IS THE ONE PEOPLE FORGET.
   *
   * Business Discovery is read FROM a node, not from a global search endpoint:
   * `GET /<IG_USER_ID>?fields=business_discovery.username(<USERNAME>)`
   * (developers.facebook.com, Instagram Platform reference, fetched
   * 2026-09-04). `<IG_USER_ID>` is the operator's OWN Instagram business
   * account — the account doing the asking. Without it there is no request to
   * make, which is why it is required rather than nice to have.
   *
   * The app id and app secret are here because the credential check calls
   * `debug_token`, which needs an app access token, and the documented shortcut
   * for one is passing `{app-id}|{app-secret}` as `access_token`.
   */
  instagram: [
    {
      id: "access_token",
      label: "Long-lived access token",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "INSTAGRAM_API_KEY",
      hint: "A long-lived user access token for the Facebook user who administers the Page linked to your Instagram business account. Meta documents long-lived tokens as lasting about 60 days and warns that lifetime can change without notice.",
    },
    {
      id: "app_id",
      label: "Meta app ID",
      kind: "identifier",
      required: true,
      primary: false,
      envVar: "INSTAGRAM_APP_ID",
      hint: "Meta app dashboard, App settings, Basic. Not a secret — it appears in every login dialog — so it is stored readable and shown back to you.",
    },
    {
      id: "app_secret",
      label: "Meta app secret",
      kind: "secret",
      required: true,
      primary: false,
      envVar: "INSTAGRAM_APP_SECRET",
      hint: "Meta app dashboard, App settings, Basic, Show. Used only to form the app access token the credential check needs; never shown again.",
    },
    {
      id: "ig_business_account_id",
      label: "Instagram business account ID",
      kind: "identifier",
      required: true,
      primary: false,
      envVar: "INSTAGRAM_BUSINESS_ACCOUNT_ID",
      hint: "YOUR OWN account's id, not the creator you want to read. Business Discovery is asked from this node. Find it with GET /<page-id>?fields=instagram_business_account.",
    },
  ],

  /**
   * FACEBOOK. THE SAME META TRIPLE, PLUS THE PAGE.
   *
   * `page_id` is REQUIRED and that is a product statement, not a form
   * convenience: on the official route there is no cross-account Facebook
   * search at all, so a Facebook credential that does not name a Page the
   * operator administers buys nothing. Making it optional would let somebody
   * save a credential that cannot possibly be used and be told nothing.
   */
  facebook: [
    {
      id: "access_token",
      label: "Long-lived Page access token",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "FACEBOOK_API_KEY",
      hint: "A long-lived Page access token for a Page you administer. Meta documents long-lived tokens as lasting about 60 days and warns that lifetime can change without notice.",
    },
    {
      id: "app_id",
      label: "Meta app ID",
      kind: "identifier",
      required: true,
      primary: false,
      envVar: "FACEBOOK_APP_ID",
      hint: "Meta app dashboard, App settings, Basic. Not a secret, so it is stored readable and shown back to you.",
    },
    {
      id: "app_secret",
      label: "Meta app secret",
      kind: "secret",
      required: true,
      primary: false,
      envVar: "FACEBOOK_APP_SECRET",
      hint: "Meta app dashboard, App settings, Basic, Show. Used only to form the app access token the credential check needs; never shown again.",
    },
    {
      id: "page_id",
      label: "Page ID",
      kind: "identifier",
      required: true,
      primary: false,
      envVar: "FACEBOOK_PAGE_ID",
      hint: "The Page you administer. Facebook's official API has no cross-account search, so a Facebook credential that names no Page has nothing it could read.",
    },
  ],

  /**
   * THREADS. ONE FIELD, AND IT IS NOT A META TOKEN.
   *
   * Threads has its own OAuth on threads.net and its own host,
   * graph.threads.net. A Facebook Page token pasted here authenticates nothing:
   * the two are different credentials for different APIs that happen to be
   * owned by the same company. That is why Threads has its own provider slot
   * rather than reading Instagram's — see
   * supabase/migrations/20260908_15_threads.sql.
   *
   * THE SCOPE IS THE WHOLE STORY. `threads_basic` alone gets you a token that
   * can read YOUR OWN posts and returns nothing for anybody else's, so keyword
   * search comes back empty and looks exactly like a quiet day. The second
   * scope, `threads_keyword_search`, is the one that makes this platform worth
   * having, and it needs App Review. An operator who skips it will see no
   * error — just no results — which is why the hint says so here rather than in
   * a doc nobody opens.
   */
  threads: [
    {
      id: "access_token",
      label: "Threads access token",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "THREADS_API_KEY",
      hint: "From threads.net's own OAuth — NOT a Facebook Page token. It must carry both threads_basic and threads_keyword_search; without the second scope the search returns only your own posts and a topic run looks empty rather than failing.",
    },
  ],

  /**
   * SCRAPECREATORS. THE FIRST CREDENTIAL IN THIS BUILD THAT IS NOT A PLATFORM.
   *
   * ONE FIELD, and that is the vendor's whole authentication scheme rather than
   * a simplification: docs.scrapecreators.com/introduction, read 2026-09-04,
   * verbatim — "All API requests require authentication using an API key.
   * You'll need to include your API key in the `x-api-key` header with every
   * request." No app id, no account id, no secret pair, nothing to look up in a
   * dashboard afterwards. Every extra required box on a form is an operator
   * stuck on a value nobody can give them, so there is exactly one.
   *
   * THE SPEC LIVES HERE AND NOT IN lib/credentials/providers.ts, which is where
   * it was written on 2026-09-04 while this file's vocabulary had no word for a
   * vendor. That was the right call at the time and it is the wrong shape now:
   * `credentialFields()` is what the save form renders, what
   * `parseCredentialValues()` validates against and what `EnvCredentialStore`
   * reads variables for, and a provider whose fields lived somewhere else was a
   * provider the store would crash on. providers.ts now re-exports this array
   * rather than declaring a second one.
   *
   * THE HEADER NAME IS NOT DECLARED HERE. It is `SCRAPECREATORS_AUTH_HEADER` in
   * lib/credentials/providers.ts and `API_KEY_HEADER` in
   * lib/platform/scrapecreators.ts, and lib/credentials/credentials.test.ts
   * asserts those two are the same string — because the page advertising one
   * header while the client sends another produces a 401 that reads exactly
   * like a bad key.
   */
  scrapecreators: [
    {
      id: "api_key",
      label: "ScrapeCreators API key",
      kind: "secret",
      required: true,
      primary: true,
      envVar: "SCRAPECREATORS_API_KEY",
      hint: "Your ScrapeCreators dashboard.",
    },
  ],
};

/** Every field for a provider, in the order the form renders them. */
export function credentialFields(provider: CredentialProvider): readonly CredentialField[] {
  return SPECS[provider];
}

/** The one secret whose mask is shown and whose value `lease().secret` carries. */
export function primaryField(provider: CredentialProvider): CredentialField {
  // Non-null because `assertFieldSpecs()` runs at import time and refuses a
  // provider without exactly one.
  return SPECS[provider].find((f) => f.primary) as CredentialField;
}

/** A field by id, or null. Used when a stored key no longer matches the spec. */
export function credentialField(provider: CredentialProvider, id: string): CredentialField | null {
  return SPECS[provider].find((f) => f.id === id) ?? null;
}

/**
 * Turn whatever arrived from a form into the two maps, or REFUSE.
 *
 * Everything here is untrusted. A key that is not in the spec is dropped rather
 * than stored, because an unknown key that survives into the sealed blob is a
 * place for something nobody declared to sit unread forever.
 *
 * THE LENGTH RULE APPLIES TO SECRETS ONLY, and it is not a format check on any
 * vendor's behalf — it is a guard against a label, a URL fragment or half a
 * token being pasted into the box. Identifiers are numeric ids and are short by
 * nature; the same rule applied to them would reject every real Page id.
 */
export function parseCredentialValues(
  provider: CredentialProvider,
  raw: Readonly<Record<string, unknown>>,
): CredentialValues {
  const secrets: Record<string, string> = {};
  const identifiers: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of credentialFields(provider)) {
    const value = typeof raw[field.id] === "string" ? (raw[field.id] as string).trim() : "";
    if (!value) {
      if (field.required) missing.push(field.label);
      continue;
    }
    if (field.kind === "secret" && value.length < MIN_SECRET_LENGTH) {
      throw new CredentialError(
        `${field.label}: that does not look like an API key (under ${MIN_SECRET_LENGTH} characters). Nothing was saved.`,
      );
    }
    if (field.kind === "secret") secrets[field.id] = value;
    else identifiers[field.id] = value;
  }

  if (missing.length > 0) {
    throw new CredentialError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for this provider. Nothing was saved.`,
    );
  }
  return { secrets, identifiers };
}

/**
 * The minimum length of a secret. Sixteen, unchanged from when a credential was
 * one string, and the sentence it produces is the same one operators already
 * see.
 */
export const MIN_SECRET_LENGTH = 16;

/**
 * The sealed blob is JSON: `{"access_token":"...","app_secret":"..."}`.
 *
 * Keys are sorted so two saves of the same credential produce the same
 * plaintext, which makes a diff of the encryption path readable. It does NOT
 * make the ciphertext equal — the nonce is random per seal, and
 * `credentials.test.ts` asserts that two seals of the same value differ, so
 * equal keys stay undetectable from the ciphertext.
 */
export function packSecrets(secrets: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(secrets).sort()) sorted[key] = secrets[key];
  return JSON.stringify(sorted);
}

/**
 * The other direction, and it is STRICT ON PURPOSE.
 *
 * It would be easy to say "if this does not parse as JSON, treat the whole
 * plaintext as the primary secret" and quietly accept a row written by an older
 * build. Two reasons not to. First, no migration in this repo has ever been
 * applied to any database, so the row that fallback would rescue does not
 * exist — it is speculative machinery, which is the thing this codebase keeps
 * deleting. Second, the fallback is a sniff: a secret that happened to parse as
 * a JSON object of strings would be silently reinterpreted as a field map, and
 * the operator would never learn which reading was used.
 *
 * So a plaintext that is not a field map is an error naming the fix.
 */
export function unpackSecrets(plaintext: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new CredentialError(
      "This credential was stored in an older single-value format. Delete it and enter the key again.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CredentialError(
      "This credential was stored in an older single-value format. Delete it and enter the key again.",
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new CredentialError("This credential's stored fields are malformed. Delete it and enter the key again.");
    }
    out[key] = value;
  }
  return out;
}

/**
 * Whatever came back in the readable identifiers column, narrowed to strings.
 *
 * The column is `jsonb`, so what arrives is whatever is in the database rather
 * than whatever this code last wrote — a co-tenant with the service-role key
 * can write into it (see the shared-database caveat in supabase-backend.ts).
 * Anything that is not a string is dropped rather than rendered.
 */
export function readIdentifiers(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * The invariant every function above assumes, checked once at import.
 *
 * A provider with two primaries would mask an arbitrary one of them; a provider
 * with none would crash inside `primaryField` at save time, on a settings page,
 * with a key already typed into a box. Failing at import is loud, early, and
 * cannot reach an operator.
 */
function assertFieldSpecs(): void {
  for (const [provider, fields] of Object.entries(SPECS)) {
    const primaries = fields.filter((f) => f.primary);
    if (primaries.length !== 1) {
      throw new Error(`${provider} must declare exactly one primary field, has ${primaries.length}.`);
    }
    if (primaries[0].kind !== "secret") {
      throw new Error(`${provider}'s primary field must be a secret; it is an identifier.`);
    }
    if (!primaries[0].required) {
      throw new Error(`${provider}'s primary field must be required.`);
    }
    const ids = fields.map((f) => f.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${provider} has a duplicate field id.`);
    }
    for (const field of fields) {
      if (!/^[a-z][a-z0-9_]*$/.test(field.id)) {
        throw new Error(`${provider}.${field.id} is not a lower snake_case field id.`);
      }
    }
  }
}

assertFieldSpecs();
