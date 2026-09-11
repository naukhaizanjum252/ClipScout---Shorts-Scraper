/**
 * The local-development fallback.
 *
 * A key in `YOUTUBE_API_KEY` — or `X_API_KEY`, or `INSTAGRAM_APP_SECRET` —
 * belongs to whoever is sitting at the machine. That is fine for poking at an
 * API on a laptop and is NOT how the tool runs: in production every operator
 * supplies their own keys through the settings page, they are stored per-tenant
 * and encrypted at rest, and the environment variables play no part at all.
 *
 * The whole point of this file is that it is OBVIOUS which store is in play:
 *
 *   - `origin` on every lease says `environment` rather than `database`
 *   - `list()` labels every row with the variable it came out of, so the
 *     settings page shows it as what it is
 *   - `save()` and `remove()` REFUSE, because there is nothing to write to
 *   - `resolveCredentialStore()` will not choose this store in production
 *
 * If a run's logs say `environment`, somebody's laptop key is paying for it.
 *
 * IT IS PER PROVIDER, and that is not cosmetic. This store used to know one
 * variable and answer `youtube` questions only; every other provider got the
 * same answer as "no key configured", which is the exact collapse this repo
 * forbids elsewhere — a platform nobody set a key for and a platform whose key
 * was ignored have to be distinguishable, on a laptop as much as in production.
 *
 * IT IS NOW PER FIELD AS WELL, 2026-09-04, and that is the same argument one
 * level down. A Meta credential is four values. A store that read only
 * `INSTAGRAM_API_KEY` would hand the credential check a token with no app id,
 * and the check would report a setup problem that the developer had in fact
 * configured — in the variables this file was not reading. Every field declares
 * its own variable in lib/credentials/fields.ts, greppable, and this store reads
 * all of them.
 *
 * A ROW APPEARS ONLY WHEN THE PRIMARY SECRET IS SET. Setting
 * `INSTAGRAM_APP_ID` alone does not conjure a credential: an app id is not a
 * key, and a slot that looked filled because a non-secret identifier was
 * exported would be the settings page lying about what it holds. The other
 * fields are read alongside the primary and their absence is reported by the
 * credential check, in a sentence naming which one is missing.
 */
import { credentialFields, primaryField, readIdentifiers } from "./fields";
import { maskSecret } from "./mask";
import { allCredentialProviders, credentialProviderInfo } from "./providers";
import {
  CredentialError,
  type CredentialProvider,
  type CredentialStore,
  type CredentialValues,
  type MaskedCredential,
  type PlaintextLease,
} from "./types";

/** `env:YOUTUBE_API_KEY` — stable, and says where it came from. */
export function envCredentialId(provider: CredentialProvider): string {
  return `env:${credentialProviderInfo(provider).envVar}`;
}

/** Names the variable, so nobody mistakes a laptop key for an operator's. */
export function envCredentialLabel(provider: CredentialProvider): string {
  return `local .env.local — ${credentialProviderInfo(provider).envVar} (development)`;
}

export class EnvCredentialStore implements CredentialStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  /** The primary secret, which is what decides whether a slot is filled at all. */
  private secret(provider: CredentialProvider): string | null {
    const raw = this.env[primaryField(provider).envVar]?.trim();
    return raw ? raw : null;
  }

  /** Every declared field this machine happens to have exported, split by kind. */
  private values(provider: CredentialProvider): CredentialValues {
    const secrets: Record<string, string> = {};
    const identifiers: Record<string, string> = {};
    for (const field of credentialFields(provider)) {
      const raw = this.env[field.envVar]?.trim();
      if (!raw) continue;
      if (field.kind === "secret") secrets[field.id] = raw;
      else identifiers[field.id] = raw;
    }
    return { secrets, identifiers };
  }

  async list(provider?: CredentialProvider): Promise<MaskedCredential[]> {
    const wanted = provider === undefined ? allCredentialProviders() : [credentialProviderInfo(provider)];
    const rows: MaskedCredential[] = [];
    for (const info of wanted) {
      const secret = this.secret(info.id);
      if (!secret) continue;
      rows.push({
        id: envCredentialId(info.id),
        provider: info.id,
        label: envCredentialLabel(info.id),
        masked: maskSecret(secret),
        identifiers: readIdentifiers(this.values(info.id).identifiers),
        status: "active",
        created_at: new Date(0).toISOString(),
        created_by: null,
        last_used_at: null,
        last_check_ok: null,
        last_check_at: null,
        last_check_error: null,
      });
    }
    return rows;
  }

  async save(): Promise<MaskedCredential> {
    throw new CredentialError(
      "This deployment is reading its keys from the environment, so keys cannot be saved here. " +
        "Configure Supabase (NEXT_PUBLIC_SUPABASE_URL) to store operator keys.",
    );
  }

  async remove(): Promise<void> {
    throw new CredentialError("Environment keys are removed by editing .env.local, not from this page.");
  }

  async lease(provider: CredentialProvider): Promise<PlaintextLease | null> {
    const secret = this.secret(provider);
    if (!secret) return null;
    const { secrets, identifiers } = this.values(provider);
    return {
      credentialId: envCredentialId(provider),
      label: envCredentialLabel(provider),
      secret,
      secrets,
      identifiers,
      origin: "environment",
    };
  }

  async noteUse(): Promise<void> {
    /* nothing to write to */
  }

  async noteCheck(): Promise<void> {
    /* nothing to write to */
  }
}
