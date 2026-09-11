/**
 * ONE place decides which credential store is in play.
 *
 *   Supabase configured        -> the database store (encrypted, per-operator)
 *   otherwise, non-production  -> the environment store (a laptop key)
 *   otherwise                  -> no store at all
 *
 * The decision is returned, not hidden: `origin` comes back with the store so
 * every caller can say which one it got, and the settings page shows it. A
 * deployment reading keys out of environment variables should be impossible to
 * mistake for one where operators supply their own.
 *
 * `allowEnvFallback` defaults to false in production. That is the guard that
 * stops Erik's laptop key from ever becoming the thing paying for a client's
 * quota, which is the entire reason this store exists.
 *
 * THE ENVIRONMENT BRANCH IS NO LONGER A YOUTUBE BRANCH. It used to test
 * `YOUTUBE_API_KEY` alone, so a developer with a TikTok key and no YouTube one
 * got `origin: "none"` and a sentence saying no credential was configured —
 * false, and false in the direction that wastes an afternoon. Any of the five
 * provider variables now selects this store, and the explanation names the ones
 * that are actually set.
 */
import { allCredentialProviders } from "./providers";
import { encryptionKey } from "./secret-box";
import { EncryptedCredentialStore } from "./store";
import { EnvCredentialStore } from "./env-store";
import { SupabaseCredentialBackend } from "./supabase-backend";
import { CredentialError, type CredentialStore } from "./types";
import { isSupabaseConfigured } from "../supabase/config";

// `../supabase/server` pulls in `next/headers`, which only exists inside a Next
// request. This module is also imported by verify/quota.ts, a plain CLI. So the
// Next-only import is deferred to the branch that actually needs it, and
// `--selftest` runs on a machine with no Next runtime at all.

export type StoreOrigin = "database" | "environment" | "none";

export interface ResolvedStore {
  readonly store: CredentialStore | null;
  readonly origin: StoreOrigin;
  /** One line for the settings page and the run log. Never contains a value. */
  readonly explanation: string;
}

export interface ResolveOptions {
  readonly env?: Record<string, string | undefined>;
  /** Override the production check (tests only). */
  readonly allowEnvFallback?: boolean;
}

export async function resolveCredentialStore(opts: ResolveOptions = {}): Promise<ResolvedStore> {
  const env = opts.env ?? process.env;
  const production = env.NODE_ENV === "production";
  const allowEnv = opts.allowEnvFallback ?? !production;

  if (isSupabaseConfigured) {
    let key: Buffer;
    try {
      key = encryptionKey(env);
    } catch (cause) {
      // Deliberately not falling through to the environment store. A
      // deployment that meant to hold operator keys and cannot decrypt them
      // must say so, not quietly start billing somebody else's project.
      throw new CredentialError(
        `Supabase is configured but credentials cannot be encrypted: ${(cause as Error).message}`,
      );
    }
    const { createSupabaseAdminClient } = await import("../supabase/server");
    const client = createSupabaseAdminClient();
    return {
      store: new EncryptedCredentialStore(new SupabaseCredentialBackend(client), { key }),
      origin: "database",
      explanation: "Operator keys are stored in this project's database, encrypted at rest.",
    };
  }

  const envVarsSet = allCredentialProviders()
    .map((p) => p.envVar)
    .filter((name) => env[name]?.trim());

  if (allowEnv && envVarsSet.length > 0) {
    return {
      store: new EnvCredentialStore(env),
      origin: "environment",
      explanation:
        `DEVELOPMENT ONLY — using the keys in ${envVarsSet.join(", ")}. ` +
        "These are a local machine's keys, not an operator's. Configure Supabase before anyone " +
        "else uses this deployment.",
    };
  }

  return {
    store: null,
    origin: "none",
    explanation:
      "No API credential is configured for any platform. That is not a statement about what those " +
      "platforms contain — each adapter reports for itself whether it can run without a key.",
  };
}
