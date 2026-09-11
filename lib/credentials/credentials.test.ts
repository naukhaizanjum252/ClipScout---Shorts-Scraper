import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runCredentialCheck } from "./checks";
import { EnvCredentialStore, envCredentialLabel } from "./env-store";
import {
  MIN_SECRET_LENGTH,
  credentialFields,
  packSecrets,
  parseCredentialValues,
  primaryField,
  readIdentifiers,
  unpackSecrets,
} from "./fields";
import { containsSecret, maskSecret, scrub } from "./mask";
import {
  SCRAPECREATORS_API_BASE,
  SCRAPECREATORS_AUTH_HEADER,
  SCRAPECREATORS_CREDIT_BALANCE_URL,
  SCRAPECREATORS_FIELDS,
  SCRAPECREATORS_INFO,
  SCRAPECREATORS_PROVIDER,
  allCredentialProviders,
  checkableFields,
  checkablePrimaryField,
  credentialCheckPlan,
  credentialProviderInfo,
  credentialProvidersOfKind,
  primaryCredentialProviders,
  secondaryCredentialProviders,
  providerEnvVar,
} from "./providers";
import { SecretBoxError, encryptionKey, open, seal, secretsEqual } from "./secret-box";
import { EncryptedCredentialStore, MemoryCredentialBackend } from "./store";
import {
  CREDENTIAL_PROVIDERS,
  PLATFORM_CREDENTIAL_PROVIDERS,
  VENDOR_CREDENTIAL_PROVIDERS,
  credentialProviderKind,
  isCredentialProvider,
  isVendorCredentialProvider,
  platformsServedBy,
} from "./types";
import { PLATFORMS } from "../platform/types";
import {
  API_KEY_HEADER,
  ENDPOINTS,
  SCRAPECREATORS_BASE,
  ScrapeCreatorsClient,
  resolveScrapeCreatorsKey,
} from "../platform/scrapecreators";

/**
 * NOTE: every "key" in this file is a random string generated at test time. No
 * real credential exists in this repo, in these fixtures, or anywhere in this
 * project's history.
 */
const FAKE_SECRET = "not-a-real-key-0000000000000000";

function newStore() {
  const key = randomBytes(32);
  const backend = new MemoryCredentialBackend();
  return { key, backend, store: new EncryptedCredentialStore(backend, { key }) };
}

/**
 * A complete, valid submission for any provider, built from the provider's own
 * field spec.
 *
 * WHY IT IS DERIVED RATHER THAN WRITTEN OUT FIVE TIMES. A provider that grows a
 * required field would otherwise leave every test in this file passing against
 * the old shape, which is the exact failure this repo keeps writing scars about:
 * a check that cannot notice the thing it exists to notice. Built this way, a
 * new required field appears in every test the moment it is declared.
 */
function submissionFor(provider: (typeof CREDENTIAL_PROVIDERS)[number], salt = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of credentialFields(provider)) {
    out[field.id] =
      field.kind === "secret" ? `${FAKE_SECRET}-${provider}-${field.id}${salt}` : `1234567890${salt || "0"}`;
  }
  return out;
}

describe("secret-box", () => {
  it("round-trips", () => {
    const key = randomBytes(32);
    expect(open(seal(FAKE_SECRET, key, "row-1"), key, "row-1")).toBe(FAKE_SECRET);
  });

  it("produces different ciphertext each time, so equal keys are not detectable", () => {
    const key = randomBytes(32);
    expect(seal(FAKE_SECRET, key, "row-1")).not.toBe(seal(FAKE_SECRET, key, "row-1"));
  });

  it("refuses to open with the wrong key", () => {
    const sealed = seal(FAKE_SECRET, randomBytes(32), "row-1");
    expect(() => open(sealed, randomBytes(32), "row-1")).toThrow(SecretBoxError);
  });

  it("refuses to open under a different row id — a ciphertext moved between rows is dead", () => {
    const key = randomBytes(32);
    const sealed = seal(FAKE_SECRET, key, "row-1");
    expect(() => open(sealed, key, "row-2")).toThrow(SecretBoxError);
  });

  it("refuses a tampered envelope", () => {
    const key = randomBytes(32);
    const sealed = seal(FAKE_SECRET, key, "row-1");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => open(parts.join("."), key, "row-1")).toThrow(SecretBoxError);
  });

  it("never mentions the value in a failure", () => {
    const key = randomBytes(32);
    const sealed = seal(FAKE_SECRET, key, "row-1");
    try {
      open(sealed, randomBytes(32), "row-1");
      throw new Error("should have thrown");
    } catch (cause) {
      expect((cause as Error).message).not.toContain(FAKE_SECRET);
      expect((cause as Error).message).not.toContain(sealed);
    }
  });

  it("insists on a 32-byte key rather than stretching a short one", () => {
    expect(() => encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: "short" })).toThrow(SecretBoxError);
    expect(() => encryptionKey({})).toThrow(/not set/);
    expect(encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toHaveLength(32);
    expect(encryptionKey({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("hex") })).toHaveLength(32);
  });

  it("compares secrets in constant time", () => {
    expect(secretsEqual(FAKE_SECRET, FAKE_SECRET)).toBe(true);
    expect(secretsEqual(FAKE_SECRET, `${FAKE_SECRET}x`)).toBe(false);
  });
});

describe("masking", () => {
  it("shows the last four characters and a fixed number of dots", () => {
    expect(maskSecret("ABCDEFGHIJKLMNOP")).toBe("••••••••MNOP");
    // The dot count does not grow with the secret, so the mask does not leak length.
    expect(maskSecret("A".repeat(80))).toBe("••••••••AAAA");
  });

  it("shows nothing at all for something too short to mask safely", () => {
    expect(maskSecret("abcd")).toBe("••••••••");
  });

  it("scrubs a secret and any key= parameter out of an error message", () => {
    const message = `Request failed: https://www.googleapis.com/youtube/v3/videos?part=id&key=${FAKE_SECRET}`;
    const cleaned = scrub(message, FAKE_SECRET);
    expect(cleaned).not.toContain(FAKE_SECRET);
    expect(cleaned).toContain("[REDACTED]");
  });

  it("scrubs a key= parameter even for a secret it was never given", () => {
    const cleaned = scrub("...?key=SOME_OTHER_KEY_ENTIRELY&part=id");
    expect(cleaned).not.toContain("SOME_OTHER_KEY_ENTIRELY");
  });

  /**
   * THE META CHECK CALLS `GET /debug_token`, WHICH PUTS TWO CREDENTIALS ON THE
   * QUERY STRING: `input_token` and `access_token`. `input_token` did not match
   * the original pattern, so a Graph error echoing the request URL back would
   * have carried the operator's token into `last_check_error` and onto the
   * page — through the one function whose entire job is to stop that.
   */
  it("scrubs every credential-bearing query parameter the Meta check uses", () => {
    const url =
      "Graph error for https://graph.facebook.com/v26.0/debug_token" +
      "?input_token=TOKEN_THE_SCRUBBER_WAS_NOT_GIVEN&access_token=APPID%7CAPPSECRET_NOT_GIVEN";
    const cleaned = scrub(url);
    expect(cleaned).not.toContain("TOKEN_THE_SCRUBBER_WAS_NOT_GIVEN");
    expect(cleaned).not.toContain("APPSECRET_NOT_GIVEN");
  });
});

/**
 * THE FIELD SPEC. A CREDENTIAL IS NOT ONE STRING ANY MORE.
 *
 * This block is the machinery that made the Meta slots possible, and every
 * assertion in it is about a way the split could silently go wrong: a secret
 * routed into the readable column, a required field that nothing enforces, an
 * environment variable two providers share.
 */
describe("the per-provider credential shape", () => {
  it("gives every provider exactly one primary field, and it is a required secret", () => {
    for (const provider of CREDENTIAL_PROVIDERS) {
      const primaries = credentialFields(provider).filter((f) => f.primary);
      expect(primaries, provider).toHaveLength(1);
      expect(primaries[0].kind, provider).toBe("secret");
      expect(primaries[0].required, provider).toBe(true);
      expect(primaryField(provider)).toEqual(primaries[0]);
    }
  });

  /**
   * TWO FIELDS SHARING A VARIABLE WOULD MEAN A DEVELOPER SETTING ONE AND
   * FILLING TWO. On a laptop that is a confusing afternoon; the reason it is
   * asserted across ALL providers rather than within each is that the collision
   * that actually bites is `INSTAGRAM_APP_SECRET` and `FACEBOOK_APP_SECRET`
   * being written as the same name because both are "the Meta app secret".
   * They are different Meta apps as far as this tool is concerned.
   */
  it("gives every field on every provider its own environment variable", () => {
    const all = CREDENTIAL_PROVIDERS.flatMap((p) => credentialFields(p).map((f) => f.envVar));
    expect(new Set(all).size).toBe(all.length);
  });

  it("routes secrets and identifiers to different maps, by declared kind", () => {
    const values = parseCredentialValues("instagram", submissionFor("instagram"));
    expect(Object.keys(values.secrets).sort()).toEqual(["access_token", "app_secret"]);
    expect(Object.keys(values.identifiers).sort()).toEqual(["app_id", "ig_business_account_id"]);
  });

  it("refuses a submission missing a required field, and names it", () => {
    const partial = { ...submissionFor("instagram") };
    delete partial.ig_business_account_id;
    expect(() => parseCredentialValues("instagram", partial)).toThrow(
      /Instagram business account ID.*required/s,
    );
  });

  /**
   * A key that is not in the spec is DROPPED, not stored. An undeclared key that
   * survived into the sealed blob would be a place for something nobody decided
   * on to sit unread forever — and, worse, to be handed back by `lease()` to a
   * caller that never asked for it.
   */
  it("drops a field the provider never declared", () => {
    const values = parseCredentialValues("x", {
      ...submissionFor("x"),
      not_a_declared_field: "something-somebody-posted",
    });
    expect(values.secrets).not.toHaveProperty("not_a_declared_field");
    expect(values.identifiers).not.toHaveProperty("not_a_declared_field");
  });

  it("applies the length guard to secrets only, so a short Page id is not rejected as a bad key", () => {
    expect(() => parseCredentialValues("x", { bearer_token: "nope" })).toThrow(
      /does not look like an API key/,
    );
    // A real Page id is short. The same rule applied to identifiers would reject
    // every one of them.
    const values = parseCredentialValues("facebook", { ...submissionFor("facebook"), page_id: "1234" });
    expect(values.identifiers.page_id).toBe("1234");
    expect(MIN_SECRET_LENGTH).toBeGreaterThan(4);
  });

  it("packs and unpacks the sealed field map", () => {
    const secrets = { b_second: "value-two", a_first: "value-one" };
    // Sorted, so the same credential produces the same plaintext every time.
    expect(packSecrets(secrets)).toBe('{"a_first":"value-one","b_second":"value-two"}');
    expect(unpackSecrets(packSecrets(secrets))).toEqual(secrets);
  });

  /**
   * STRICT ON PURPOSE. The tempting alternative — "if it does not parse, treat
   * the whole plaintext as the primary secret" — is a sniff: a secret that
   * happened to parse as a JSON object would be silently reinterpreted as a
   * field map and nobody would ever learn which reading was used.
   */
  it("refuses a stored value that is not a field map, instead of guessing", () => {
    expect(() => unpackSecrets("a-bare-secret-string")).toThrow(/older single-value format/);
    expect(() => unpackSecrets('["not","an","object"]')).toThrow(/older single-value format/);
    expect(() => unpackSecrets('{"app_id":12345}')).toThrow(/malformed/);
  });

  it("narrows whatever the identifiers column happens to contain", () => {
    // A jsonb column in a SHARED database: what comes back is whatever is in the
    // row, not whatever this code last wrote.
    expect(readIdentifiers({ app_id: "1", junk: 7, nested: { a: 1 } })).toEqual({ app_id: "1" });
    expect(readIdentifiers(null)).toEqual({});
    expect(readIdentifiers(["a"])).toEqual({});
    expect(readIdentifiers("not an object")).toEqual({});
  });
});

describe("EncryptedCredentialStore", () => {
  it("stores the key encrypted and returns only a masked view", async () => {
    const { store, backend } = newStore();
    const saved = await store.save({
      provider: "youtube",
      label: "operator project",
      secret: FAKE_SECRET,
      createdBy: "user-1",
    });

    expect(saved.masked).toBe(maskSecret(FAKE_SECRET));
    expect(saved).not.toHaveProperty("secret");
    expect(containsSecret(saved, FAKE_SECRET)).toBe(false);

    // The row on disk holds ciphertext, not the key.
    const rows = await backend.listRows();
    expect(containsSecret(rows, FAKE_SECRET)).toBe(false);
  });

  /**
   * THE TEST THE SECOND DESIGN CHANGE ASKED FOR: the secret does not appear in
   * ANY serialised response. Not in the save result, not in a listing, not in a
   * check result. Asserted over the whole JSON rather than by checking field
   * names, because the failure mode is a secret arriving in a field nobody
   * thought to check.
   */
  it("never lets the secret into anything that gets serialised", async () => {
    const { store } = newStore();
    const saved = await store.save({
      provider: "youtube",
      label: "operator project",
      secret: FAKE_SECRET,
      createdBy: "user-1",
    });
    await store.noteUse(saved.id);
    await store.noteCheck(saved.id, false, scrub(`bad key ${FAKE_SECRET}`, FAKE_SECRET));

    const listed = await store.list("youtube");
    for (const payload of [saved, listed, listed[0]]) {
      expect(JSON.stringify(payload)).not.toContain(FAKE_SECRET);
      expect(containsSecret(payload, FAKE_SECRET)).toBe(false);
    }
    expect(listed[0].last_check_ok).toBe(false);
    expect(listed[0].last_check_error).toContain("[REDACTED]");
  });

  /**
   * THE SAME GUARANTEE, FOR THE PROVIDER THAT HAS FOUR FIELDS.
   *
   * The widening on 2026-09-04 is exactly the kind of change that quietly opens
   * a hole: three of Instagram's four values are new, two of them are secrets,
   * and every one of them travels through code the single-string tests never
   * exercised. This asserts over the whole serialised listing, for every secret
   * on the credential, that none of them came back.
   */
  it("seals every secret field on a multi-field credential and shows back only the identifiers", async () => {
    const { store, backend } = newStore();
    const submission = submissionFor("instagram");
    const saved = await store.save({
      provider: "instagram",
      label: "Lucky35 Meta app",
      fields: submission,
      createdBy: "user-1",
    });

    // The mask is of the PRIMARY secret, and only of that one.
    expect(saved.masked).toBe(maskSecret(submission.access_token));

    // Identifiers are readable on purpose: an app id an operator cannot check
    // is an app id they can only fix by deleting the credential.
    expect(saved.identifiers).toEqual({
      app_id: submission.app_id,
      ig_business_account_id: submission.ig_business_account_id,
    });

    const listed = await store.list("instagram");
    const rows = await backend.listRows();
    for (const secretValue of [submission.access_token, submission.app_secret]) {
      for (const payload of [saved, listed, rows]) {
        expect(containsSecret(payload, secretValue)).toBe(false);
      }
    }
  });

  it("leases the plaintext back for an outbound call, and only there", async () => {
    const { store } = newStore();
    const saved = await store.save({
      provider: "youtube",
      label: "operator project",
      secret: FAKE_SECRET,
      createdBy: "user-1",
    });
    const lease = await store.lease("youtube");
    expect(lease?.secret).toBe(FAKE_SECRET);
    expect(lease?.credentialId).toBe(saved.id);
    expect(lease?.origin).toBe("database");
  });

  /**
   * A LEASE HAS TO BE USABLE ON ITS OWN. The Meta check cannot be made with an
   * access token alone — it needs the app id to form the app access token it is
   * authenticated with. A lease that returned the secret and left the caller to
   * find the identifiers elsewhere would work from a request with an admin
   * session and fail from a background job with none.
   */
  it("returns every sealed field and every identifier on one lease", async () => {
    const { store } = newStore();
    const submission = submissionFor("instagram");
    await store.save({ provider: "instagram", label: "meta", fields: submission, createdBy: null });

    const lease = await store.lease("instagram");
    expect(lease?.secret).toBe(submission.access_token);
    expect(lease?.secrets).toEqual({
      access_token: submission.access_token,
      app_secret: submission.app_secret,
    });
    expect(lease?.identifiers).toEqual({
      app_id: submission.app_id,
      ig_business_account_id: submission.ig_business_account_id,
    });
  });

  it("returns null when there is no credential, because keyless is the default", async () => {
    const { store } = newStore();
    expect(await store.lease("youtube")).toBeNull();
  });

  it("refuses to save something that is obviously not a key", async () => {
    const { store } = newStore();
    await expect(
      store.save({ provider: "youtube", label: "x", secret: "nope", createdBy: null }),
    ).rejects.toThrow(/does not look like an API key/);
    await expect(
      store.save({ provider: "youtube", label: "  ", secret: FAKE_SECRET, createdBy: null }),
    ).rejects.toThrow(/label/);
  });

  /**
   * A Meta credential saved with only the token would be a credential that
   * cannot make a single call. Failing at save is the only place an operator
   * still has the missing value in front of them.
   */
  it("refuses a multi-field credential that is missing a required field", async () => {
    const { store } = newStore();
    await expect(
      store.save({
        provider: "facebook",
        label: "meta",
        fields: { access_token: `${FAKE_SECRET}-fb` },
        createdBy: null,
      }),
    ).rejects.toThrow(/required/);
  });

  /**
   * A merge would have to pick a winner, and a settings page that silently
   * discards half of what was typed is the failure this directory exists to
   * prevent.
   */
  it("refuses a save that supplies both a bare secret and a field map", async () => {
    const { store } = newStore();
    await expect(
      store.save({
        provider: "x",
        label: "both",
        secret: FAKE_SECRET,
        fields: submissionFor("x"),
        createdBy: null,
      }),
    ).rejects.toThrow(/either as one secret or as a field map/);
  });

  /**
   * THE PIVOT'S CENTRAL CREDENTIAL CHANGE: five providers, all active at once,
   * and a lease that returns the right one. A store that ignored the provider
   * would hand a YouTube key to the TikTok adapter, which would spend it against
   * the wrong account and report a failure that reads as a bad key.
   */
  it("holds a key per provider, all active at once, and leases the right one", async () => {
    const { store } = newStore();
    const submissions = new Map(CREDENTIAL_PROVIDERS.map((p) => [p, submissionFor(p)]));
    for (const provider of CREDENTIAL_PROVIDERS) {
      await store.save({
        provider,
        label: `${provider} account`,
        fields: submissions.get(provider),
        createdBy: "user-1",
      });
    }

    expect(await store.list()).toHaveLength(CREDENTIAL_PROVIDERS.length);

    for (const provider of CREDENTIAL_PROVIDERS) {
      const listed = await store.list(provider);
      expect(listed.map((r) => r.provider)).toEqual([provider]);
      const expected = submissions.get(provider)![primaryField(provider).id];
      expect((await store.lease(provider))?.secret).toBe(expected);
    }
  });

  /**
   * `lease()` returns ONE key and must never have to choose. The database says
   * the same thing with a partial unique index; this check exists so an operator
   * gets a sentence naming the key already in the slot rather than a Postgres
   * constraint code.
   */
  it("refuses a second active key for a provider, and names the one already there", async () => {
    const { store } = newStore();
    await store.save({ provider: "tiktok", label: "first", secret: FAKE_SECRET, createdBy: null });
    await expect(
      store.save({ provider: "tiktok", label: "second", secret: FAKE_SECRET, createdBy: null }),
    ).rejects.toThrow(/TikTok already has an active key \(first\)/);
    // Per provider, not global: the other platforms are unaffected.
    await expect(
      store.save({ provider: "youtube", label: "yt", secret: FAKE_SECRET, createdBy: null }),
    ).resolves.toMatchObject({ provider: "youtube" });
  });

  /**
   * The provider arrives as a form field. TypeScript does not run on the wire,
   * and an unchecked value would either hit the SQL enum with a message nobody
   * can act on or be stored as a credential no adapter will ever ask for.
   *
   * "NOT IN THE VOCABULARY" IS THE TEST, NOT "NOT A PLATFORM" — this used to be
   * spelled the second way, back when those were the same sentence. They are
   * not any more: `scrapecreators` is not a platform and is a perfectly valid
   * provider, so the assertion below names a value that is neither.
   */
  it("refuses a provider that is not in the vocabulary", async () => {
    const { store } = newStore();
    await expect(
      store.save({
        provider: "vimeo" as never,
        label: "x",
        secret: FAKE_SECRET,
        createdBy: null,
      }),
    ).rejects.toThrow(/Unknown provider/);
    // And the vendor, which is not a platform, is accepted.
    await expect(
      store.save({
        provider: SCRAPECREATORS_PROVIDER,
        label: "vendor",
        secret: FAKE_SECRET,
        createdBy: null,
      }),
    ).resolves.toMatchObject({ provider: SCRAPECREATORS_PROVIDER });
  });

  it("forgets a deleted credential", async () => {
    const { store } = newStore();
    const saved = await store.save({
      provider: "youtube",
      label: "operator project",
      secret: FAKE_SECRET,
      createdBy: null,
    });
    await store.remove(saved.id);
    expect(await store.list("youtube")).toHaveLength(0);
    expect(await store.lease("youtube")).toBeNull();
  });
});

describe("EnvCredentialStore — the development fallback", () => {
  it("labels itself with the variable it came out of, so nobody mistakes it for an operator's", async () => {
    const store = new EnvCredentialStore({ YOUTUBE_API_KEY: FAKE_SECRET });
    const [row] = await store.list();
    expect(row.label).toMatch(/development/i);
    expect(row.label).toContain("YOUTUBE_API_KEY");
    expect(row.masked).toBe(maskSecret(FAKE_SECRET));
    expect(containsSecret(row, FAKE_SECRET)).toBe(false);
    expect((await store.lease("youtube"))?.origin).toBe("environment");
  });

  /**
   * WHY THIS MATTERS: before the pivot this store knew one variable, so a
   * developer with a TikTok key and no YouTube key was told no credential was
   * configured at all. "Nobody set a key" and "your key was ignored" are two
   * different states, and this repo's loudest rule is that they never look alike.
   */
  it("reads a variable per provider and keeps them apart", async () => {
    const store = new EnvCredentialStore({
      TIKTOK_API_KEY: `${FAKE_SECRET}-tiktok`,
      FACEBOOK_API_KEY: `${FAKE_SECRET}-facebook`,
    });

    const listed = await store.list();
    expect(listed.map((r) => r.provider).sort()).toEqual(["facebook", "tiktok"]);

    expect((await store.lease("tiktok"))?.secret).toBe(`${FAKE_SECRET}-tiktok`);
    expect((await store.lease("facebook"))?.secret).toBe(`${FAKE_SECRET}-facebook`);
    // The provider nobody set a variable for is absent, not defaulted.
    expect(await store.lease("youtube")).toBeNull();
    expect(await store.list("youtube")).toHaveLength(0);
  });

  /**
   * THE SAME ARGUMENT ONE LEVEL DOWN, 2026-09-04. A store that read only
   * `INSTAGRAM_API_KEY` would hand the credential check a token with no app id,
   * and the check would report a setup problem the developer had in fact
   * configured — in the variables this store was not reading.
   */
  it("reads every declared field's variable, not just the primary one", async () => {
    const store = new EnvCredentialStore({
      INSTAGRAM_API_KEY: `${FAKE_SECRET}-token`,
      INSTAGRAM_APP_SECRET: `${FAKE_SECRET}-appsecret`,
      INSTAGRAM_APP_ID: "1234567890",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "0987654321",
    });

    const lease = await store.lease("instagram");
    expect(lease?.secrets).toEqual({
      access_token: `${FAKE_SECRET}-token`,
      app_secret: `${FAKE_SECRET}-appsecret`,
    });
    expect(lease?.identifiers).toEqual({ app_id: "1234567890", ig_business_account_id: "0987654321" });

    const [row] = await store.list("instagram");
    expect(row.identifiers).toEqual({ app_id: "1234567890", ig_business_account_id: "0987654321" });
    expect(containsSecret(row, `${FAKE_SECRET}-appsecret`)).toBe(false);
  });

  /**
   * AN APP ID IS NOT A KEY. A slot that looked filled because a non-secret
   * identifier happened to be exported would be the settings page lying about
   * what it holds.
   */
  it("does not conjure a credential from an identifier alone", async () => {
    const store = new EnvCredentialStore({ INSTAGRAM_APP_ID: "1234567890" });
    expect(await store.list("instagram")).toHaveLength(0);
    expect(await store.lease("instagram")).toBeNull();
  });

  it("names every provider's variable in its label", () => {
    for (const info of allCredentialProviders()) {
      expect(envCredentialLabel(info.id)).toContain(info.envVar);
    }
  });

  it("is empty when no key is set", async () => {
    const store = new EnvCredentialStore({});
    expect(await store.list()).toHaveLength(0);
    expect(await store.lease("youtube")).toBeNull();
  });

  it("refuses to save, because there is nothing to save to", async () => {
    await expect(new EnvCredentialStore({}).save()).rejects.toThrow();
  });
});

describe("the provider vocabulary", () => {
  /**
   * THE ASSERTION THAT USED TO BE HERE HAS BEEN RETIRED ON PURPOSE, WHICH IS
   * THE ONE WAY IT WAS ALLOWED TO GO.
   *
   * It read `expect(CREDENTIAL_PROVIDERS).toEqual(PLATFORMS)` and it carried its
   * own expiry note: "The SQL keeps `credential_provider` and `platform` as
   * separate enums so that a third-party vendor could one day become one
   * provider covering three platforms. On the day one is named, this test is
   * retired deliberately and replaced by a platform-to-provider mapping — not
   * deleted because it went red and was in the way."
   *
   * Erik named ScrapeCreators on 2026-09-04. This is that day, and these are
   * the tests that replace it.
   *
   * WHAT WENT WRONG WHILE THE ALIAS STOOD, because it is the reason the
   * replacement is this thorough. `CREDENTIAL_PROVIDERS = PLATFORMS` meant
   * there was no name a vendor credential could have. So
   * lib/platform/scrapecreators.ts shipped a complete, well-tested vendor client
   * that the registry could not lease a key for, it had ZERO production call
   * sites, and the whole file could be moved out of the tree with the suite
   * still green.
   */
  it("separates a platform credential from a vendor credential", () => {
    // The platform half is still the platform list itself, not a copy: the five
    // slots that ARE one-to-one with a platform still cannot drift from it.
    expect(PLATFORM_CREDENTIAL_PROVIDERS).toEqual(PLATFORMS);

    // The vendor half is its own list, and it is not empty — an empty one would
    // mean the alias had been renamed rather than broken.
    expect(VENDOR_CREDENTIAL_PROVIDERS.length).toBeGreaterThan(0);
    expect([...VENDOR_CREDENTIAL_PROVIDERS]).toContain(SCRAPECREATORS_PROVIDER);
    for (const vendor of VENDOR_CREDENTIAL_PROVIDERS) {
      expect(PLATFORMS as readonly string[], `${vendor} is also a platform`).not.toContain(vendor);
    }

    // And the whole vocabulary is the two halves, platforms first.
    expect([...CREDENTIAL_PROVIDERS]).toEqual([
      ...PLATFORM_CREDENTIAL_PROVIDERS,
      ...VENDOR_CREDENTIAL_PROVIDERS,
    ]);
    expect(CREDENTIAL_PROVIDERS.length).toBeGreaterThan(PLATFORMS.length);
  });

  /**
   * THE VOCABULARY HAS TO ACCEPT THE VENDOR OFF A FORM.
   *
   * `isCredentialProvider` is what the save action narrows with before anything
   * reaches the store. While it was `isPlatform` under another name, an operator
   * choosing the vendor slot would have been told "Choose which platform this
   * key is for" — a sentence about a choice they had just made.
   */
  it("accepts the vendor at the boundary and still refuses a stranger", () => {
    expect(isCredentialProvider("tiktok")).toBe(true);
    expect(isCredentialProvider(SCRAPECREATORS_PROVIDER)).toBe(true);
    expect(isCredentialProvider("vimeo")).toBe(false);
    expect(isCredentialProvider("")).toBe(false);
    expect(isCredentialProvider(null)).toBe(false);

    expect(isVendorCredentialProvider(SCRAPECREATORS_PROVIDER)).toBe(true);
    expect(isVendorCredentialProvider("tiktok")).toBe(false);
  });

  /**
   * "WHICH PLATFORMS DOES THIS KEY SERVE" — A REAL ANSWER, FOR EVERY PROVIDER.
   *
   * This is the question the alias made unaskable, so every caller answered it
   * by assuming the provider id WAS the platform. That assumption is correct for
   * five providers out of six, which is the worst possible ratio: it is right
   * often enough that nobody notices it is a guess.
   *
   * The consequences of a wrong answer here are both real and both expensive.
   * Under-claiming means the registry hands the vendor's client to fewer
   * adapters than the key paid for, so an operator buys credits for three
   * platforms and gets one. Over-claiming means it is handed to X, whose
   * 120-second filter would then run on a duration this vendor does not supply.
   */
  it("says which platforms each key actually buys", () => {
    // A platform key serves its own platform and nothing else.
    for (const platform of PLATFORM_CREDENTIAL_PROVIDERS) {
      expect(platformsServedBy(platform), platform).toEqual([platform]);
      expect(credentialProviderKind(platform), platform).toBe("platform");
    }

    // The vendor key serves three, and the two it does NOT serve are findings
    // rather than omissions: X keeps its own API because that API returns the
    // duration this vendor does not sell for X, and YouTube is read keylessly.
    expect(credentialProviderKind(SCRAPECREATORS_PROVIDER)).toBe("vendor");
    expect([...platformsServedBy(SCRAPECREATORS_PROVIDER)].sort()).toEqual([
      "facebook",
      "instagram",
      "tiktok",
    ]);
    expect(platformsServedBy(SCRAPECREATORS_PROVIDER), "X must not be routed through the vendor").not.toContain("x");
    expect(platformsServedBy(SCRAPECREATORS_PROVIDER), "YouTube needs no vendor").not.toContain("youtube");

    // Every platform a vendor claims has to be a real platform. A typo here is
    // a platform that silently never receives the client it was paid for.
    for (const vendor of VENDOR_CREDENTIAL_PROVIDERS) {
      const served = platformsServedBy(vendor);
      expect(served.length, `${vendor} serves nothing`).toBeGreaterThan(0);
      for (const platform of served) {
        expect(PLATFORMS as readonly string[], `${vendor} claims to serve ${platform}`).toContain(platform);
      }
    }
  });

  /**
   * THE RECORD CARRIES THE SAME ANSWER THE FUNCTION GIVES, because the page
   * renders the record and the registry reads the function. Two answers is one
   * more than the number of true things.
   */
  it("derives kind and coverage rather than restating them on the record", () => {
    for (const info of allCredentialProviders()) {
      expect(info.kind, info.id).toBe(credentialProviderKind(info.id));
      expect(info.serves, info.id).toEqual(platformsServedBy(info.id));
    }
    // And the grouping the page uses is a partition of the same list: nothing
    // is in both groups and nothing is in neither.
    const platforms = credentialProvidersOfKind("platform").map((i) => i.id);
    const vendors = credentialProvidersOfKind("vendor").map((i) => i.id);
    expect([...platforms, ...vendors].sort()).toEqual([...CREDENTIAL_PROVIDERS].sort());
    expect(platforms.filter((id) => vendors.includes(id))).toEqual([]);
  });

  it("gives every provider a distinct environment variable", () => {
    const vars = allCredentialProviders().map((p) => p.envVar);
    // A shared variable would mean two platforms reading one laptop key and
    // each believing it was its own.
    expect(new Set(vars).size).toBe(vars.length);
    expect(providerEnvVar("youtube")).toBe("YOUTUBE_API_KEY");
  });

  /**
   * `envVar` and `fields` are DERIVED from lib/credentials/fields.ts rather than
   * restated on the provider record. A second declaration is how `envVar` comes
   * to name a variable `EnvCredentialStore` does not read, with nothing going
   * red when it happens.
   */
  it("derives its fields and its primary variable from the one field spec", () => {
    for (const info of allCredentialProviders()) {
      expect(info.fields).toEqual(credentialFields(info.id));
      expect(info.envVar).toBe(primaryField(info.id).envVar);
    }
  });

  /**
   * `usedBy` is the honest field: null means nothing in this build spends a key
   * for that platform on a discovery run. It is asserted here because it is the
   * claim a future adapter has to come back and update, and a silent drift in
   * either direction is a lie about whose account is being billed.
   */
  it("answers, for every provider, what spends its key on a run", () => {
    // SCAR: THIS TEST USED TO ASSERT THE ABSENCE OF THE ANSWER.
    //
    // It required `usedBy` to be NULL for tiktok, instagram, x and facebook,
    // which pinned in place the exact defect a reviewer later raised as a
    // blocker: the credentials page invited an operator to paste a billable X
    // bearer token, and to begin weeks of Meta App Review, while saying nothing
    // about whether this build would ever spend either. Null was being read as
    // "not applicable" when it meant "nobody wrote it down".
    //
    // The honest shape is that EVERY provider answers. Some answer "nothing
    // spends this yet, and here is why" — which is a fact an operator needs
    // BEFORE they act, not an empty field they have to interpret.
    for (const info of allCredentialProviders()) {
      expect(info.usedBy, `${info.id} does not say what spends its key`).not.toBeNull();
      expect(info.usedBy?.detail.length ?? 0, info.id).toBeGreaterThan(0);
      expect(info.note.length, info.id).toBeGreaterThan(0);
    }
  });

  it("distinguishes a provider something spends from one nothing spends", () => {
    // The distinction is the whole point, and a field that always said the same
    // thing would be decoration. `onARun` is the machine-readable half: false
    // means a saved key sits idle, and the page must be able to say so plainly
    // rather than implying the key is doing work.
    const spent = allCredentialProviders().filter((info) => info.usedBy?.onARun);
    const idle = allCredentialProviders().filter((info) => !info.usedBy?.onARun);
    expect(spent.length, "no provider spends a key on a run — that cannot be right").toBeGreaterThan(0);
    expect(idle.length, "no provider is idle — check tiktok, which is read keylessly").toBeGreaterThan(0);
  });

  /**
   * THE LIMITS ARE THE ANSWER TO THE QUESTION ERIK ASKED, and they are printed
   * on the page above the Save button. These assertions are what stop somebody
   * tidying away the two sentences that decide whether Instagram and Facebook
   * can serve this product at all — the ones that cost weeks of App Review to
   * rediscover.
   */
  it("keeps the verified Meta limits on the page", () => {
    const instagram = credentialProviderInfo("instagram").limits.join(" ");
    expect(instagram, "Instagram media carries no duration field").toMatch(/NO DURATION FIELD/i);
    expect(instagram, "hashtag search has no view count").toMatch(/hashtag search/i);
    expect(instagram).toMatch(/App Review/i);

    const facebook = credentialProviderInfo("facebook").limits.join(" ");
    expect(facebook, "the reference documents no read on either video edge").toMatch(/video_reels/);
    expect(facebook, "Content Library eligibility").toMatch(/academic and non-profit/i);
  });

  it("says out loud that the X view count has not been observed", () => {
    const x = credentialProviderInfo("x").limits.join(" ");
    expect(x).toMatch(/view_count/);
    expect(x, "a documented field is not an observed one").toMatch(/HAS NOT BEEN OBSERVED/i);
  });

  it("gives every check plan a source, a cost and a statement of what it proves", () => {
    for (const info of allCredentialProviders()) {
      if (info.check === null) continue;
      expect(info.check.call.length, info.id).toBeGreaterThan(0);
      expect(info.check.source.length, info.id).toBeGreaterThan(0);
      expect(info.check.cost.length, info.id).toBeGreaterThan(0);
      expect(info.check.proves.length, info.id).toBeGreaterThan(0);
    }
  });
});

/**
 * THE TEST BUTTON.
 *
 * NOTHING HERE HAS EVER TOUCHED A LIVE API — there are no keys on this machine,
 * so every response below is a fixture built from the vendor's documented shape
 * and nothing more. What these tests prove is that the CLASSIFICATION is right:
 * that a 401 and a 403 do not produce the same sentence, that a token from the
 * wrong app is caught, that a missing field stops the call rather than being
 * reported as a bad key. What they cannot prove is that the endpoints answer the
 * way the documentation says. That needs a key.
 */
describe("runCredentialCheck", () => {
  const graphOk = (over: Record<string, unknown> = {}) => ({
    data: {
      app_id: "1234567890",
      is_valid: true,
      scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
      expires_at: 0,
      ...over,
    },
  });

  function fetchReturning(status: number, body: unknown) {
    return vi.fn(async () =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("has no plan for TikTok, and refuses to invent one", async () => {
    expect(credentialCheckPlan("tiktok")).toBeNull();
    await expect(
      runCredentialCheck("tiktok", { secrets: { api_key: FAKE_SECRET }, identifiers: {} }),
    ).rejects.toThrow(/no test call for tiktok/i);
  });

  /**
   * THE PLAN AND THE RUNNER ARE TWO SEPARATE TABLES IN TWO FILES, and this is
   * what stops them disagreeing.
   *
   * A provider given a plan but no runner would print a call on the page, offer
   * a button, and throw when it was pressed. A provider given a runner but no
   * plan would make a real request against a metered API with nothing on screen
   * saying which one. Both are one careless addition away, and neither has a
   * compiler that notices.
   */
  it("gives every provider a plan and a runner together, or neither", async () => {
    for (const provider of CREDENTIAL_PROVIDERS) {
      // A complete credential, split the way the store would split it, so a
      // provider with a runner really reaches the network rather than stopping
      // at the missing-field guard.
      const values = parseCredentialValues(provider, submissionFor(provider));
      const attempt = runCredentialCheck(provider, values, {
        fetch: fetchReturning(200, graphOk()) as unknown as typeof globalThis.fetch,
      });
      if (credentialCheckPlan(provider) === null) {
        await expect(attempt, provider).rejects.toThrow(/no test call/i);
      } else {
        const result = await attempt;
        expect(result.message, provider).not.toMatch(/No call was made/);
      }
    }
  });

  /**
   * A MISSING FIELD IS A SETUP PROBLEM, NOT AN API VERDICT. Reporting it as one
   * sends an operator to regenerate a token that was fine. The assertion that no
   * fetch happened is the load-bearing half.
   */
  it("stops before the network when a required field is not stored", async () => {
    const doFetch = fetchReturning(200, graphOk());
    const result = await runCredentialCheck(
      "instagram",
      { secrets: { access_token: `${FAKE_SECRET}-t`, app_secret: `${FAKE_SECRET}-s` }, identifiers: {} },
      { fetch: doFetch as unknown as typeof globalThis.fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Meta app ID/);
    expect(result.message).toMatch(/No call was made/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  describe("X", () => {
    const values = { secrets: { bearer_token: `${FAKE_SECRET}-bearer` }, identifiers: {} };

    it("calls the documented recent-counts endpoint with a bearer header", async () => {
      const doFetch = fetchReturning(200, { data: [], meta: { total_post_count: 4321 } });
      const result = await runCredentialCheck("x", values, {
        fetch: doFetch as unknown as typeof globalThis.fetch,
      });

      const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("https://api.x.com/2/tweets/counts/recent");
      expect(url).toContain("granularity=day");
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${FAKE_SECRET}-bearer`,
      );
      expect(result.ok).toBe(true);
      expect(result.message).toContain("4,321");
    });

    /**
     * `meta.total_post_count` is documented as optional. An absent count is
     * reported as absent — never as zero, which on this screen would read as
     * "X has nothing", the exact collapse the rest of the tool forbids.
     */
    it("reports an absent count as absent rather than as zero", async () => {
      const doFetch = fetchReturning(200, { data: [], meta: {} });
      const result = await runCredentialCheck("x", values, {
        fetch: doFetch as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/no total post count/i);
      expect(result.message).not.toMatch(/\b0 posts\b/);
    });

    /**
     * THE DISTINCTION THIS WHOLE FILE EXISTS FOR. 401 is the token. 403 is the
     * access tier. Telling an operator the second is the first sends them to
     * regenerate a bearer token that was never the problem.
     */
    it("tells a rejected token apart from an endpoint the plan does not include", async () => {
      const unauthorised = await runCredentialCheck("x", values, {
        fetch: fetchReturning(401, { title: "Unauthorized" }) as unknown as typeof globalThis.fetch,
      });
      expect(unauthorised.ok).toBe(false);
      expect(unauthorised.status).toBe(401);
      expect(unauthorised.message).toMatch(/rejected the bearer token/i);

      const forbidden = await runCredentialCheck("x", values, {
        fetch: fetchReturning(403, { title: "Forbidden" }) as unknown as typeof globalThis.fetch,
      });
      expect(forbidden.ok).toBe(false);
      expect(forbidden.status).toBe(403);
      expect(forbidden.message).toMatch(/access level/i);
      expect(forbidden.message, "a 403 is not evidence the token is wrong").toMatch(/NOT evidence/);
    });

    it("says a rate limit taught it nothing, rather than recording a failure", async () => {
      const result = await runCredentialCheck("x", values, {
        fetch: fetchReturning(429, {}) as unknown as typeof globalThis.fetch,
      });
      expect(result.message).toMatch(/Nothing was learned/i);
    });

    it("never returns the token, even when X echoes it back", async () => {
      const doFetch = fetchReturning(401, {
        title: `Unauthorized for Bearer ${FAKE_SECRET}-bearer`,
      });
      const result = await runCredentialCheck("x", values, {
        fetch: doFetch as unknown as typeof globalThis.fetch,
      });
      expect(result.message).not.toContain(`${FAKE_SECRET}-bearer`);
      expect(result.message).toContain("[REDACTED]");
    });
  });

  describe("Meta", () => {
    const values = {
      secrets: { access_token: `${FAKE_SECRET}-token`, app_secret: `${FAKE_SECRET}-appsecret` },
      identifiers: { app_id: "1234567890", ig_business_account_id: "5555555555" },
    };

    it("inspects the token with the documented app-token shortcut", async () => {
      const doFetch = fetchReturning(200, graphOk());
      const result = await runCredentialCheck("instagram", values, {
        fetch: doFetch as unknown as typeof globalThis.fetch,
      });

      const [url] = doFetch.mock.calls[0] as unknown as [string];
      expect(url).toContain("https://graph.facebook.com/v26.0/debug_token");
      expect(url).toContain(`input_token=${encodeURIComponent(`${FAKE_SECRET}-token`)}`);
      // `{app-id}|{app-secret}` as the access_token parameter.
      expect(url).toContain(encodeURIComponent(`1234567890|${FAKE_SECRET}-appsecret`));
      expect(result.ok).toBe(true);
      // A PASS IS NOT A GREEN LIGHT, and the sentence saying so is load-bearing.
      // `debug_token` proves the token is real; Business Discovery still will
      // not answer until Business Verification and App Review are done. An
      // operator who reads "Token accepted" and nothing else concludes they are
      // finished.
      expect(result.message).toMatch(/App Review/);
    });

    /**
     * A TOKEN FROM A DIFFERENT APP IS THE MISTAKE THAT LOOKS LIKE EVERYTHING
     * WORKING: it is valid, so nothing errors, and every later call fails for a
     * reason nobody connects back to this screen.
     */
    it("catches a valid token that belongs to a different app", async () => {
      const result = await runCredentialCheck("instagram", values, {
        fetch: fetchReturning(200, graphOk({ app_id: "9999999999" })) as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("9999999999");
      expect(result.message).toContain("1234567890");
    });

    /**
     * THE MOST USEFUL THING THIS BUTTON CAN SAY BEFORE APP REVIEW: which of the
     * permissions Business Discovery needs the token does not yet have, and that
     * they come from App Review rather than from regenerating the token.
     */
    it("names the Business Discovery permissions the token is missing", async () => {
      const result = await runCredentialCheck("instagram", values, {
        fetch: fetchReturning(
          200,
          graphOk({ scopes: ["instagram_basic"] }),
        ) as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("instagram_manage_insights");
      expect(result.message).toContain("pages_read_engagement");
      expect(result.message).toMatch(/App Review/);
    });

    /**
     * FACEBOOK IS NOT HELD TO INSTAGRAM'S SCOPE LIST. There is no verified read
     * edge for a Page's videos to require permissions for, so requiring any
     * would be inventing a rule — and failing operators over it would be
     * inventing a rule with consequences.
     */
    it("does not require Instagram's permissions of a Facebook token", async () => {
      const result = await runCredentialCheck("facebook", {
        secrets: values.secrets,
        identifiers: { app_id: "1234567890", page_id: "777" },
      }, {
        fetch: fetchReturning(200, graphOk({ scopes: [] })) as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/does not mean any Page's videos can be listed/i);
    });

    it("reports an expiry in days rather than a unix timestamp nobody can read", async () => {
      const now = new Date("2026-09-04T00:00:00Z");
      const expires = Math.floor(now.getTime() / 1000) + 30 * 86_400;
      const result = await runCredentialCheck("instagram", values, {
        fetch: fetchReturning(200, graphOk({ expires_at: expires })) as unknown as typeof globalThis.fetch,
        now: () => now,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("30 days");
    });

    it("reports an invalid token in Meta's own words, scrubbed", async () => {
      const result = await runCredentialCheck("instagram", values, {
        fetch: fetchReturning(200, {
          data: {
            is_valid: false,
            error: { code: 190, message: `Error validating access token ${FAKE_SECRET}-token` },
          },
        }) as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not valid/i);
      expect(result.message).not.toContain(`${FAKE_SECRET}-token`);
    });

    it("reports a transport-level Graph error separately from an invalid token", async () => {
      const result = await runCredentialCheck("instagram", values, {
        fetch: fetchReturning(400, {
          error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 },
        }) as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.message).toMatch(/Meta refused the request/);
      expect(result.message).toContain("code 190");
    });

    /**
     * An HTML error page from a proxy is a normal thing to receive. A JSON parse
     * failure must not surface as "the call could not be completed", which is a
     * different and wrong diagnosis from "the API returned 502".
     */
    it("survives a response body that is not JSON", async () => {
      const doFetch = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
      const result = await runCredentialCheck("instagram", values, {
        fetch: doFetch as unknown as typeof globalThis.fetch,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
    });
  });

  /**
   * THREADS — WHERE A 200 IS NOT AN ANSWER.
   *
   * The slot's own notes say the Test button "performs a real search precisely
   * so this is caught here instead of in a week". The check did not: it read
   * the status code and nothing else, so the one credential the notes call
   * useless — standard access, which Meta documents as searching "only ...
   * posts owned by the authenticated user" and answering 200 while it does —
   * passed the button built to catch it. These tests are the button's
   * conscience.
   */
  describe("Threads", () => {
    const values = { secrets: { access_token: `${FAKE_SECRET}-threads` }, identifiers: {} };
    const check = (status: number, body: unknown) =>
      runCredentialCheck("threads", values, {
        fetch: fetchReturning(status, body) as unknown as typeof globalThis.fetch,
      });

    it("passes only when the search actually returned somebody's post", async () => {
      const result = await check(200, { data: [{ id: "17901234567890123" }] });
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      // The green must not overclaim: discovery is proven, measurement never is.
      expect(result.message).toMatch(/unverified/i);
    });

    /**
     * THE LOAD-BEARING TEST IN THIS FILE'S THREADS BLOCK.
     *
     * 200 with an empty page is the documented shape of a token without
     * advanced access. Reported green, it costs weeks of topic runs that look
     * like quiet days; reported red, it costs one more press of a button that
     * bills nothing.
     */
    it("refuses a 200 that came back empty, and blames the scope rather than the word", async () => {
      const result = await check(200, { data: [] });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(200);
      expect(result.message).toMatch(/threads_keyword_search/);
      expect(result.message).toMatch(/App Review/i);
    });

    it("treats a 200 with no data array as unreadable, not as working", async () => {
      const result = await check(200, { id: "17901234567890123" });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/unreadable/i);
    });

    /** Meta names the missing permission in its own words; show them. */
    it("repeats Meta's complaint on a refusal and names the scope", async () => {
      const result = await check(400, {
        error: { message: "(#10) Application does not have permission for this action", type: "OAuthException" },
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.message).toMatch(/threads_keyword_search/);
      expect(result.message).toMatch(/Application does not have permission/);
    });

    it("reads a 429 as proof the token is real", async () => {
      const result = await check(429, { error: { message: "rate limited" } });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/the token is real/i);
    });

    /** The secret is in the query string on this host. It must never come back out. */
    it("never puts the token in the message", async () => {
      const result = await check(400, { error: { message: `bad token ${FAKE_SECRET}-threads` } });
      expect(result.message).not.toContain(`${FAKE_SECRET}-threads`);
    });
  });

  it("reports a network failure as a network failure, not as a bad key", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.x.com");
    });
    const result = await runCredentialCheck(
      "x",
      { secrets: { bearer_token: `${FAKE_SECRET}-bearer` }, identifiers: {} },
      { fetch: doFetch as unknown as typeof globalThis.fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toMatch(/not a verdict on the key/i);
  });
});

/**
 * ============================================================================
 * SCRAPECREATORS — THE VENDOR CHOSEN ON 2026-09-04
 * ============================================================================
 *
 * A credential that is not named after a platform, for a vendor that serves
 * three of them with one key.
 *
 * THE SLOT EXISTS NOW, AND THAT CHANGES WHAT THIS BLOCK IS FOR. The header here
 * used to open "The slot does not exist in `CREDENTIAL_PROVIDERS` yet — that
 * needs lib/credentials/types.ts, lib/credentials/fields.ts and the
 * `credential_provider` enum in Postgres, none of which this change owns — so
 * none of the loops above reach it." All three have widened, so every loop
 * above DOES reach the vendor: it is saved, sealed, listed, leased and checked
 * by the same tests that cover the five platform slots, with no special case.
 * That is the real proof, and it is why the generic tests are not duplicated
 * down here.
 *
 * WHAT STAYS: the facts that are about THIS VENDOR and nothing else — the
 * classification of its failures, the two risks it carries, the one credit each
 * press of Test costs, and the seams at either end of the credential. Those are
 * at the bottom of this block and they are the ones that would still be worth
 * writing if every generic test above were deleted.
 *
 * WHAT THEY CANNOT PROVE: that ScrapeCreators answers the way its documentation
 * says. There is no key on this machine. Every response below is a fixture
 * built from the documented response shape and nothing more.
 */
describe("ScrapeCreators", () => {
  const KEY = `${FAKE_SECRET}-scrapecreators`;
  const VALUES = { secrets: { api_key: KEY }, identifiers: {} };

  function fetchStub(status: number, body: unknown) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      calls.push({ url: String(input), headers });
      return new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return { calls, fetch: impl as unknown as typeof globalThis.fetch };
  }

  it("is one required secret and nothing else — no app id, no account id", () => {
    // The whole credential is a key in a header. A form that asked for more
    // would be inventing a shape the vendor does not have, and every extra
    // required box is an operator stuck on a value nobody can give them.
    expect(SCRAPECREATORS_FIELDS.map((f) => f.id)).toEqual(["api_key"]);
    expect(SCRAPECREATORS_FIELDS.filter((f) => f.primary && f.required && f.kind === "secret")).toHaveLength(1);
    expect(checkableFields(SCRAPECREATORS_PROVIDER)).toEqual(SCRAPECREATORS_FIELDS);
    expect(checkablePrimaryField(SCRAPECREATORS_PROVIDER).id).toBe("api_key");
  });

  it("names TikTok, Instagram and Facebook as what spends the key, and rules X out", () => {
    // Requirement, and the reason `usedBy` exists: an operator must be able to
    // read what a key buys before buying it. X is called out by name because
    // this vendor cannot supply the duration the 120-second filter needs, so a
    // reader who assumed "it covers everything" would be wrong about the one
    // platform that costs real money per post.
    const { detail } = SCRAPECREATORS_INFO.usedBy;
    expect(detail).toMatch(/TikTok/);
    expect(detail).toMatch(/Instagram/);
    expect(detail).toMatch(/Facebook/);
    expect(detail, "nothing says X is excluded").toMatch(/NOT be handed to X/);
    expect(detail, "the reason X is excluded is the field it cannot supply").toMatch(/duration/i);
  });

  /**
   * DOES THE RUN PATH ACTUALLY LEASE THIS KEY — READ OUT OF ITS OWN SOURCE.
   *
   * tests/credential-honesty.test.tsx runs the same check for every provider in
   * `CREDENTIAL_PROVIDERS`, which now includes this one, so this is no longer
   * the only place the vendor's claim is checked. It is kept, and made
   * STRONGER, because of what the vocabulary rewrite exposed about how these
   * detectors fail.
   *
   * THE HOLE THIS VERSION CLOSES. The sibling detector looks for a lease spelled
   * with a string literal — `lease("scrapecreators")`. lib/platform/registry.ts
   * declares `VENDOR_PROVIDER = "scrapecreators"` and leases through the
   * constant, which is better code and invisible to that regex. A detector that
   * silently sees nothing does not fail; it reports "nothing leases this" and
   * quietly agrees with a page saying the key is idle while every run spends it.
   * That is the expensive direction, and it is the same shape of blindness as
   * the round where `new XClient` had no call sites and 746 tests were green.
   *
   * So this one resolves single-assignment constants bound to the provider id
   * first, then looks for a lease through ANY of the names it found. It cannot
   * follow an arbitrary expression, and it is not trying to: what it has to
   * survive is the ordinary refactor of naming a string, which is exactly what
   * happened.
   */
  it("agrees with the run path about whether anything leases this key", () => {
    const RUN_PATH = ["lib/platform", "lib/shorts", "app/(admin)/admin/shorts", "scripts"];
    const root = path.resolve(import.meta.dirname, "..", "..");

    const read = (dir: string): string => {
      const full = path.join(root, dir);
      if (!fs.existsSync(full)) return "";
      let out = "";
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          out += read(path.join(dir, entry.name));
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        out += fs.readFileSync(path.join(full, entry.name), "utf8");
      }
      return out;
    };

    // Comments are prose about the plan, not a lease. The registry's header
    // describes this wiring at length, and describing it is not doing it.
    const code = RUN_PATH.map(read)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*/, "$1"))
      .join("\n");

    expect(code.length, "the run path was not found — this check would pass vacuously").toBeGreaterThan(1000);

    // Every spelling of the provider id the run path uses: the literal, plus any
    // constant it was assigned to. `export const VENDOR_PROVIDER =
    // "scrapecreators"` in lib/platform/registry.ts is the one that exists.
    const literal = `["'\`]${SCRAPECREATORS_PROVIDER}["'\`]`;
    const aliases = [
      ...code.matchAll(
        new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*${literal}`, "g"),
      ),
    ].map((m) => m[1]);
    const spellings = [literal, ...aliases];

    const leased = spellings.some((spelling) =>
      new RegExp(`lease\\(\\s*${spelling}\\s*\\)`).test(code),
    );

    expect(
      SCRAPECREATORS_INFO.usedBy.onARun,
      leased
        ? "the run path leases the ScrapeCreators credential and the page still says nothing " +
          `spends it. Set onARun to true in lib/credentials/providers.ts. (Leased through: ${spellings.join(", ")}.)`
        : "the page claims a run spends ScrapeCreators credits and nothing on the run path leases " +
          "that credential under any of these names: " +
          `${spellings.join(", ")}. Either the wiring was removed, or it was never added, or it ` +
          "now leases through an expression this detector cannot follow — in which case widen it " +
          "rather than deleting it.",
    ).toBe(leased);
  });

  it("says on the page, before the button is pressed, that testing costs a credit", () => {
    // Every scraping route and the account route alike are documented at one
    // credit per request. A Test button that spends money silently is the
    // surprise this whole file is built to prevent.
    const plan = credentialCheckPlan(SCRAPECREATORS_PROVIDER);
    expect(plan, "there is no test plan for the vendor").not.toBeNull();
    expect(plan?.cost, "the cost does not mention a credit").toMatch(/credit/i);
    expect(plan?.source).toContain("docs.scrapecreators.com");
    expect(plan?.proves, "a pass must not be read as 'every platform works'").toMatch(/does NOT prove/i);
  });

  it("requests exactly the URL and the header the page advertises", async () => {
    // The failure this closes: a page naming one endpoint while the button
    // calls another. It is the reason the plan and the constants live in one
    // file and the runner imports them.
    const stub = fetchStub(200, { success: true, credits_remaining: 24931, credits_charged: 1 });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe(SCRAPECREATORS_CREDIT_BALANCE_URL);
    expect(credentialCheckPlan(SCRAPECREATORS_PROVIDER)?.call).toContain(SCRAPECREATORS_CREDIT_BALANCE_URL);
    expect(stub.calls[0].headers[SCRAPECREATORS_AUTH_HEADER]).toBe(KEY);
    expect(stub.calls[0].headers.authorization, "this API does not take a bearer token").toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("24,931");
  });

  it("reports an absent balance as unknown rather than as zero credits", async () => {
    // The house rule: a source that did not say is not a source that said zero.
    // Zero credits means the next run fails; an unanswered question does not.
    const stub = fetchStub(200, { success: true });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/unknown/i);
    expect(result.message).not.toMatch(/\b0 credits\b/);
  });

  it("reads `creditCount` as the balance when `credits_remaining` is absent", async () => {
    // THE TWO BUTTONS MUST AGREE, and both now read `credits_remaining ??
    // creditCount`. 2026-09-09: the live endpoint dropped `credits_remaining`
    // and returned `creditCount` as the balance, confirmed by its own message
    // ("You have 25100 credits remaining"). `credits_remaining` still wins when
    // both are present, so the old example (333 beside 1,000,000) reads as
    // 1,000,000 — see the sibling test in credit-balance.test.tsx.
    const stub = fetchStub(200, { success: true, creditCount: 333 });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("333");
  });

  it("does not call an account out of credits a bad key", async () => {
    // 402 is the branch that matters. Told their key was rejected, an operator
    // regenerates a perfectly good key and still cannot make a call.
    const stub = fetchStub(402, { error: "Insufficient credits" });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(402);
    expect(result.message).toMatch(/THE KEY IS PROBABLY FINE/);
    expect(result.message).toMatch(/out of credits/i);
  });

  it("names the header when the key is rejected, because the wrong header looks identical", async () => {
    const stub = fetchStub(401, { error: "Invalid API key" });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain(SCRAPECREATORS_AUTH_HEADER);
    expect(result.message).toMatch(/does not use Authorization: Bearer/);
  });

  it("blames this build, not the key, when the documented path 404s", async () => {
    // An endpoint that moved produces a 401-shaped experience otherwise: the
    // operator reads "test failed" and goes looking at their key.
    const stub = fetchStub(404, {});
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a verdict on your key/i);
    expect(result.message).toMatch(/re-checking/i);
  });

  it("stops before the call when no key is stored, rather than reporting a rejection", async () => {
    const stub = fetchStub(200, { success: true });
    const result = await runCredentialCheck(
      SCRAPECREATORS_PROVIDER,
      { secrets: {}, identifiers: {} },
      { fetch: stub.fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(stub.calls, "a credit was spent proving nothing").toHaveLength(0);
    expect(result.message).toMatch(/No call was made/);
  });

  it("never puts the key in a message, however the vendor echoes it", async () => {
    // ScrapeCreators takes the key in a header rather than on the query string,
    // so this is less exposed than the Graph API — but an error body that
    // echoes the request would still carry it, and the scrubber is what stops
    // it reaching `last_check_error` and the screen.
    const stub = fetchStub(400, { error: `bad request for key ${KEY}` });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, { fetch: stub.fetch });
    expect(result.message).not.toContain(KEY);
    expect(containsSecret(result.message, KEY)).toBe(false);
  });

  it("reports a dead socket as a network failure, not as a verdict on the key", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await runCredentialCheck(SCRAPECREATORS_PROVIDER, VALUES, {
      fetch: impl as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toMatch(/not a verdict on the key/i);
  });

  it("keeps the two risks and the per-request billing on the page", () => {
    // These are the sentences that decide whether an operator trusts a Facebook
    // view count and whether they read a broken Instagram leg as "no results".
    // They are the reason this vendor was written up at all, and they are the
    // first thing a tidy-up deletes.
    const limits = SCRAPECREATORS_INFO.limits.join(" ");
    expect(limits, "the Instagram durability risk").toMatch(/Instagram is the leg this build expects to break/);
    expect(limits, "the Facebook view-count risk").toMatch(/LOWER than the public Reels badge/i);
    expect(limits, "the observed undercount").toMatch(/408 views/);
    expect(limits, "per-request billing is what makes the price work").toMatch(/PER REQUEST, NOT PER RECORD/);
    expect(limits, "Facebook can never be discovered").toMatch(/PAGE-SEEDED ONLY/);
    expect(limits, "the price and its date").toMatch(/\$47 for 25,000 credits/);
    expect(limits).toMatch(/2026-09-04/);
  });

  /**
   * ==========================================================================
   * THE TWO SEAMS. THESE ARE THE TESTS THIS ROUND EXISTS FOR.
   * ==========================================================================
   *
   * Every test above this line is about the vendor's own behaviour and would
   * pass with the credential vocabulary still aliased to the platform list —
   * which is exactly how the previous round ended green over a client nothing
   * could reach. The two below are about the JOINS, and they are the ones that
   * fail if either end is removed.
   */

  /**
   * SEAM ONE: A REAL STORE CAN HOLD THIS CREDENTIAL.
   *
   * THE CRASH THIS PINS, in the words lib/platform/registry.ts used while it
   * was still refusing to wire the lease: "Asking a real store for it does not
   * return null: the environment store crashes looking up a field spec that
   * does not exist and the Supabase store gets an enum rejection back from the
   * RPC. Both surface on /admin/credentials and /admin/shorts, which render
   * every platform, so a speculative lease takes out the whole page."
   *
   * That prediction was exactly right, and the fix is not a try/catch around
   * the lease — it is the field spec existing. Both stores are exercised
   * because they fail differently: the environment store would have thrown on
   * `primaryField()`, and the sealed store would have sealed a credential the
   * SQL enum then refuses.
   */
  it("round-trips through the sealed store and the environment store, with no field spec missing", async () => {
    // The sealed store: save, mask, list, and lease the plaintext back.
    const { store, backend } = newStore();
    const saved = await store.save({
      provider: SCRAPECREATORS_PROVIDER,
      label: "Lucky35 ScrapeCreators",
      fields: { api_key: KEY },
      createdBy: "user-1",
    });
    expect(saved.provider).toBe(SCRAPECREATORS_PROVIDER);
    expect(saved.masked).toBe(maskSecret(KEY));
    // A vendor credential is one secret and no identifiers, so nothing readable
    // comes back — and nothing sealed leaks into the display shape either.
    expect(saved.identifiers).toEqual({});
    expect(containsSecret(saved, KEY), "the masked view carries the key").toBe(false);
    expect(containsSecret(await backend.listRows(), KEY), "a listed row carries the key").toBe(false);

    const lease = await store.lease(SCRAPECREATORS_PROVIDER);
    expect(lease?.secret).toBe(KEY);
    expect(lease?.secrets).toEqual({ api_key: KEY });
    expect(lease?.origin).toBe("database");

    // The environment store: the development fallback, reading the variable the
    // field spec declares. This is the one that used to throw rather than
    // return null.
    const env = new EnvCredentialStore({ SCRAPECREATORS_API_KEY: KEY });
    expect((await env.lease(SCRAPECREATORS_PROVIDER))?.secret).toBe(KEY);
    expect((await env.lease(SCRAPECREATORS_PROVIDER))?.origin).toBe("environment");
    const [row] = await env.list(SCRAPECREATORS_PROVIDER);
    expect(row.provider).toBe(SCRAPECREATORS_PROVIDER);
    expect(row.label).toContain("SCRAPECREATORS_API_KEY");

    // And a store with nothing set answers null rather than throwing, which is
    // the state every deployment is in until somebody buys credits.
    expect(await new EnvCredentialStore({}).lease(SCRAPECREATORS_PROVIDER)).toBeNull();
  });

  /**
   * SEAM TWO: THE KEY GETS FROM THE STORE INTO THE VENDOR'S OWN REQUEST.
   *
   * WHY THIS TEST IS WORTH ITS WEIGHT. The credentials half of this repo and
   * lib/platform/scrapecreators.ts each declare the vendor's host and auth
   * header independently — `SCRAPECREATORS_API_BASE` / `SCRAPECREATORS_AUTH_HEADER`
   * here, `SCRAPECREATORS_BASE` / `API_KEY_HEADER` there. Nothing but this
   * compares them, and the repo already has a scar from exactly that pattern:
   * the Graph API version was pinned twice, at two different versions, so the
   * URL the credentials page advertised and the URL the adapters requested were
   * not the same. A header mismatch here is worse than a version mismatch,
   * because sending the key as `Authorization: Bearer` produces a 401 that
   * reads exactly like a bad key — the operator regenerates a perfectly good
   * key and it fails again.
   *
   * IT ALSO GOES THROUGH THE REAL STORE, not a string. `ScrapeCreatorsClient`
   * takes a key SOURCE that is called at the moment of use rather than a key
   * cached in a constructor, because a cached key outlives its rotation. What
   * this proves is that a lease satisfies that source and that the value
   * arrives, unaltered, in the header the vendor documents.
   *
   * NOTHING HERE TOUCHES THE NETWORK and nothing here proves ScrapeCreators
   * behaves as documented. There is no key on this machine.
   */
  it("carries a leased key into the vendor client's own request, in the header the page advertises", async () => {
    // One declaration each, and they must agree.
    expect(API_KEY_HEADER, "the client sends a different header from the one the page names").toBe(
      SCRAPECREATORS_AUTH_HEADER,
    );
    expect(SCRAPECREATORS_BASE, "the client calls a different host from the one the page names").toBe(
      SCRAPECREATORS_API_BASE,
    );

    const { store } = newStore();
    await store.save({
      provider: SCRAPECREATORS_PROVIDER,
      label: "Lucky35 ScrapeCreators",
      fields: { api_key: KEY },
      createdBy: null,
    });

    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new ScrapeCreatorsClient({
      // The shape the registry builds: lease at the moment of use.
      apiKey: async () => (await store.lease(SCRAPECREATORS_PROVIDER))?.secret ?? null,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
        sent.push({ url: String(input), headers });
        return new Response(JSON.stringify({ credits_charged: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });

    // The response body is deliberately not a valid page of results — what is
    // under test is the request, and a shape failure afterwards is the client's
    // own business.
    await client.get(ENDPOINTS.tiktokTrending, { region: "US" }, "the TikTok trending feed").catch(() => {});

    expect(sent, "the vendor client sent no request at all").toHaveLength(1);
    expect(sent[0].headers[SCRAPECREATORS_AUTH_HEADER]).toBe(KEY);
    expect(sent[0].headers.authorization, "this API does not take a bearer token").toBeUndefined();
    expect(sent[0].url.startsWith(SCRAPECREATORS_API_BASE), sent[0].url).toBe(true);
    // The key travels in a header and never in a URL, which is what makes a
    // logged URL safe by construction.
    expect(sent[0].url).not.toContain(KEY);
  });

  /**
   * THE KEY IS THE SAME ONE THE ENVIRONMENT FALLBACK WOULD HAVE PRODUCED, and
   * `resolveScrapeCreatorsKey` trims rather than sending whitespace.
   *
   * A pasted key with a trailing newline is the single most common way a
   * perfectly good credential fails its first call, and the two ends of this
   * seam each have their own idea of where trimming happens
   * (`parseCredentialValues` on the way in, `resolveScrapeCreatorsKey` on the
   * way out). Both, and neither alone, is the correct answer.
   */
  it("agrees with the vendor client about what counts as a key at all", async () => {
    expect(await resolveScrapeCreatorsKey(`  ${KEY}\n`)).toBe(KEY);
    expect(await resolveScrapeCreatorsKey("   ")).toBeNull();
    expect(await resolveScrapeCreatorsKey(null)).toBeNull();

    const { store } = newStore();
    const saved = await store.save({
      provider: SCRAPECREATORS_PROVIDER,
      label: "pasted with a trailing newline",
      fields: { api_key: `  ${KEY}\n` },
      createdBy: null,
    });
    expect(saved.masked).toBe(maskSecret(KEY));
    expect((await store.lease(SCRAPECREATORS_PROVIDER))?.secret).toBe(KEY);
  });
});

/**
 * A provider nobody can find the console for is a provider nobody can onboard.
 *
 * Erik asked for the ScrapeCreators link on the credentials page so it could be
 * opened directly. The field was generalised to every provider, because each one
 * sends the operator to a different console — Google Cloud, the X developer
 * portal, Meta's app dashboard, the vendor's own site — and a form that asks for
 * a key while making somebody go hunting for where to get it is doing half a job.
 *
 * These assertions are what stop the next provider shipping without them.
 */
describe("every provider says where to get its key", () => {
  it("gives a signup and a docs link, both real absolute https URLs", () => {
    for (const info of allCredentialProviders()) {
      for (const [which, url] of [["signup", info.where.signup], ["docs", info.where.docs]] as const) {
        expect(url, `${info.id}.where.${which} is empty`).toBeTruthy();
        // Absolute and https: a relative path would resolve against the admin
        // origin and 404, and http would downgrade a link to a console an
        // operator is about to authenticate against.
        expect(() => new URL(url), `${info.id}.where.${which} is not a URL`).not.toThrow();
        expect(new URL(url).protocol, `${info.id}.where.${which}`).toBe("https:");
      }
    }
  });

  it("points ScrapeCreators at the vendor Erik chose, not at a platform console", () => {
    // The specific ask. ScrapeCreators is a VENDOR slot serving three platforms,
    // so its link must go to the vendor — pointing it at, say, TikTok's own
    // developer site would send an operator somewhere that cannot issue this key
    // at all.
    const vendor = credentialProviderInfo("scrapecreators");
    expect(vendor.where.signup).toContain("scrapecreators.com");
    expect(vendor.where.docs).toContain("scrapecreators.com");
  });

  /**
   * THE TWO-ERRAND CASE. Erik, 2026-09-05: *"I just want a link someone with an
   * account can hit so that we can buy the needed API key and then a second link
   * to actually reach the API key"*.
   *
   * A provider may answer that with ordered `steps` instead of one signup link.
   * What must not happen is a slot pointing at two different front doors — the
   * rendered steps replace the signup link, so a `where.signup` that disagreed
   * with step one would be an address nobody could see and nobody could check.
   */
  it("keeps a provider's steps real, ordered, and agreeing with its signup link", () => {
    for (const info of allCredentialProviders()) {
      if (!info.steps) continue;
      expect(info.steps.length, `${info.id}.steps is empty`).toBeGreaterThan(1);
      for (const step of info.steps) {
        expect(step.label.trim(), `${info.id} step label`).toBeTruthy();
        expect(step.detail.trim(), `${info.id} step detail`).toBeTruthy();
        expect(() => new URL(step.href), `${info.id} step href is not a URL`).not.toThrow();
        expect(new URL(step.href).protocol, `${info.id} step href`).toBe("https:");
      }
      // Step one IS the signup link, under better wording.
      expect(new URL(info.steps[0]!.href).origin, `${info.id} step 1 vs where.signup`).toBe(
        new URL(info.where.signup).origin,
      );
    }
  });

  /**
   * X SPECIFICALLY, AND THE ORDER IS THE FACT.
   *
   * docs.x.com/x-api/getting-started/pricing, read 2026-09-05: the API is
   * pay-per-usage, credits are bought up front in the Developer Console, and a
   * balance that reaches zero BLOCKS requests. So a valid bearer token fetched
   * before any credit is bought fails exactly like an invalid one, on a page
   * whose whole job is telling those two apart. Buying is step one because of
   * that, not because it reads better.
   */
  it("sends X to buy credits before it sends X to fetch a token", () => {
    const steps = credentialProviderInfo("x").steps;
    expect(steps, "X lost its steps").toBeDefined();
    expect(steps).toHaveLength(2);
    expect(steps![0]!.label).toMatch(/credit/i);
    expect(steps![1]!.label).toMatch(/bearer token/i);
    // The console X's own getting-access page names, not the old developer
    // portal — which still resolves, which is what makes it worth asserting.
    for (const step of steps!) expect(new URL(step.href).hostname).toBe("console.x.com");
    expect(credentialProviderInfo("x").where.signup).not.toContain("developer.x.com");
  });

  it("does not send a platform provider to the vendor by mistake", () => {
    // youtube, x, instagram and facebook are each their OWN API and their keys
    // come from that platform's console. Only the vendor slot — and TikTok,
    // which this build reads through the vendor — may point at ScrapeCreators.
    for (const id of ["youtube", "x", "instagram", "facebook"] as const) {
      expect(credentialProviderInfo(id).where.signup, id).not.toContain("scrapecreators");
    }
  });
});

describe("the credentials page emphasises two slots without losing the other four", () => {
  it("puts every provider in exactly one of the two lists", () => {
    // THE RISK THIS CLOSES. The page renders `primaryCredentialProviders()`
    // prominently and folds `secondaryCredentialProviders()` behind a
    // disclosure. A provider in NEITHER list is in the database enum, savable
    // by the server action, and invisible on the only screen that manages it --
    // a key nobody can rotate or delete. A provider in BOTH renders twice, with
    // two "add" forms writing the same slot.
    const primary = primaryCredentialProviders().map((p) => p.id);
    const secondary = secondaryCredentialProviders().map((p) => p.id);
    const all = allCredentialProviders().map((p) => p.id);

    expect([...primary, ...secondary].sort()).toEqual([...all].sort());
    expect(primary.filter((id) => secondary.includes(id))).toEqual([]);
  });

  it("emphasises the two that actually reach all five platforms", () => {
    // Erik, 2026-09-04: "2 simple layers, X signin, scraperCreator key."
    // Pinned by name, because this is a product decision rather than something
    // derivable -- and because getting it wrong means an operator pays for a
    // key they did not need, or cannot find the one they did.
    expect(primaryCredentialProviders().map((p) => p.id)).toEqual(["x", "scrapecreators"]);
  });

  it("keeps youtube out of the emphasised pair, because it needs no key", () => {
    // The one that would look like an omission in review. YouTube is the
    // platform the client cares most about AND the only one that reads with no
    // credential at all, via yt-dlp. If a YouTube key ever becomes REQUIRED,
    // this assertion is what forces the page to say so.
    expect(primaryCredentialProviders().map((p) => p.id)).not.toContain("youtube");
    expect(secondaryCredentialProviders().map((p) => p.id)).toContain("youtube");
  });
});
