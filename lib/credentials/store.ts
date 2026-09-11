/**
 * The credential store, and the one place a secret is encrypted or decrypted.
 *
 * `EncryptedCredentialStore` holds ALL the security-relevant behaviour —
 * sealing, opening, masking, refusing to hand a plaintext to a read path — and
 * delegates only the dumb row I/O to a backend. That split is on purpose: the
 * in-memory backend used by the tests and the Supabase backend used in
 * production exercise the SAME encryption and masking code, so a test that
 * proves a secret never reaches a serialised response is proving it about the
 * real code path and not about a stub.
 *
 * The backend interface has two read methods and they are not interchangeable:
 *
 *   listRows   returns rows WITHOUT the ciphertext column. This is what every
 *              display path uses.
 *   leaseRow   returns the ciphertext for exactly one active credential. The
 *              Supabase backend reaches it through a SECURITY DEFINER function
 *              granted to `service_role` alone — see
 *              the credentials migration in supabase/migrations/. That schema is
 *              being rewritten for the platform pivot rather than altered, so it is
 *              named by subject here and not by filename.
 */
import { randomUUID } from "node:crypto";

import { packSecrets, parseCredentialValues, primaryField, readIdentifiers, unpackSecrets } from "./fields";
import { maskSecret } from "./mask";
import { credentialProviderInfo } from "./providers";
import { open, seal } from "./secret-box";
import {
  CREDENTIAL_PROVIDERS,
  CredentialError,
  isCredentialProvider,
  type CredentialProvider,
  type CredentialStatus,
  type CredentialStore,
  type MaskedCredential,
  type PlaintextLease,
  type SaveCredentialInput,
} from "./types";

/** A row as the display paths see it. No ciphertext field exists on this type. */
export interface CredentialRow {
  id: string;
  provider: CredentialProvider;
  label: string;
  masked: string;
  /**
   * The non-secret fields. A readable `jsonb` column in the database, granted
   * to `authenticated` alongside `masked` — deliberately, because an app id an
   * operator cannot read back is an app id they cannot check.
   */
  identifiers: Record<string, string>;
  status: CredentialStatus;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  last_check_ok: boolean | null;
  last_check_at: string | null;
  last_check_error: string | null;
}

/**
 * The only shape that carries ciphertext, and only `leaseRow` returns it.
 *
 * It carries `identifiers` too, from the same SECURITY DEFINER call, so that a
 * lease is enough to make a call. It could have been read separately through the
 * admin's session — the column is readable — but then a lease taken by a
 * background job with no session would come back with the token and without the
 * app id it has to be sent with, which is a null nobody would predict.
 */
export interface SealedRow {
  id: string;
  label: string;
  secret_ciphertext: string;
  identifiers: Record<string, string>;
}

export interface CredentialBackend {
  listRows(provider?: CredentialProvider): Promise<CredentialRow[]>;
  insertRow(row: CredentialRow & { secret_ciphertext: string }): Promise<void>;
  removeRow(id: string): Promise<void>;
  /** The active credential for a provider, with ciphertext. Server-side only. */
  leaseRow(provider: CredentialProvider): Promise<SealedRow | null>;
  patchRow(id: string, patch: Partial<CredentialRow>): Promise<void>;
}

export interface EncryptedCredentialStoreOptions {
  /** 32 raw bytes. Comes from `encryptionKey()`; injected so tests need no env. */
  readonly key: Buffer;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class EncryptedCredentialStore implements CredentialStore {
  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly backend: CredentialBackend,
    opts: EncryptedCredentialStoreOptions,
  ) {
    this.key = opts.key;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  async list(provider?: CredentialProvider): Promise<MaskedCredential[]> {
    const rows = await this.backend.listRows(provider);
    // Mapped field by field rather than spread, so a backend that one day
    // returns an extra column cannot widen what leaves this method.
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label,
      masked: r.masked,
      identifiers: readIdentifiers(r.identifiers),
      status: r.status,
      created_at: r.created_at,
      created_by: r.created_by,
      last_used_at: r.last_used_at,
      last_check_ok: r.last_check_ok,
      last_check_at: r.last_check_at,
      last_check_error: r.last_check_error,
    }));
  }

  async save(input: SaveCredentialInput): Promise<MaskedCredential> {
    // The provider arrives from a form field, so it is a string until proven
    // otherwise. TypeScript stops the honest mistakes and nothing else — an
    // unchecked value would reach the SQL enum, which rejects it with a
    // constraint error nobody can read, or reach the in-memory backend, which
    // would happily store a credential no adapter will ever ask for.
    if (!isCredentialProvider(input.provider)) {
      throw new CredentialError(
        `Unknown provider ${JSON.stringify(input.provider)}. Expected one of ${CREDENTIAL_PROVIDERS.join(", ")}.`,
      );
    }
    /**
     * TWO WAYS IN, ONE OF THEM PER CALL.
     *
     * `fields` is the whole submission from the per-provider form. `secret` is
     * the single-value shorthand every pre-2026-09-04 caller uses, interpreted
     * as this provider's primary field. Both at once is refused rather than
     * merged, because a merge has to pick a winner and a settings page that
     * silently drops half of what was typed is the exact failure this directory
     * exists to prevent.
     */
    if (input.fields !== undefined && input.secret !== undefined) {
      throw new CredentialError("A credential is saved either as one secret or as a field map, never both.");
    }
    const submitted: Readonly<Record<string, unknown>> =
      input.fields ?? { [primaryField(input.provider).id]: input.secret ?? "" };
    const values = parseCredentialValues(input.provider, submitted);
    const secret = values.secrets[primaryField(input.provider).id];
    if (!secret) throw new CredentialError("A key is required.");
    const label = input.label.trim();
    if (!label) throw new CredentialError("Give the key a label so anyone can tell which account it belongs to.");

    /**
     * ONE ACTIVE KEY PER PROVIDER, and five providers active at once.
     *
     * `lease()` returns a single key and must not have to pick between two.
     * The database says the same thing in the only way that actually holds —
     * the partial unique index `api_credentials_one_active_per_provider` — and
     * this check exists so an operator gets a sentence instead of a Postgres
     * constraint code. It is UX, not integrity: two simultaneous saves can
     * still race past it and land on the index, which is the correct place for
     * that argument to be settled.
     */
    const existing = await this.backend.listRows(input.provider);
    const active = existing.find((r) => r.status === "active");
    if (active) {
      const { label: providerLabel } = credentialProviderInfo(input.provider);
      throw new CredentialError(
        `${providerLabel} already has an active key (${active.label}). Delete it before saving another — ` +
          "one key per platform, so a run never has to guess which one it is spending.",
      );
    }

    const id = this.newId();
    const row: CredentialRow = {
      id,
      provider: input.provider,
      label,
      // The mask is of the PRIMARY secret alone. Masking every sealed field
      // would put a second row of dots on the page that answers no question an
      // operator has, and the one they do have — "is this the key I think it
      // is" — is answered by four characters of the key itself.
      masked: maskSecret(secret),
      identifiers: { ...values.identifiers },
      status: "active",
      created_at: this.now().toISOString(),
      created_by: input.createdBy,
      last_used_at: null,
      last_check_ok: null,
      last_check_at: null,
      last_check_error: null,
    };
    /**
     * EVERY SEALED FIELD GOES INTO ONE ENVELOPE, not one column per field.
     *
     * One `seal()` per credential means one nonce, one auth tag and one AAD —
     * the row id — binding the whole set together. Per-field columns would let
     * an attacker with write access to the table swap a valid `app_secret` from
     * one row onto another row's `access_token` and have both decrypt
     * individually, because each would be bound only to its own row. Sealing the
     * set makes that a tampered envelope, which fails closed.
     */
    await this.backend.insertRow({
      ...row,
      secret_ciphertext: seal(packSecrets(values.secrets), this.key, id),
    });
    return this.toMasked(row);
  }

  remove(id: string): Promise<void> {
    return this.backend.removeRow(id);
  }

  async lease(provider: CredentialProvider): Promise<PlaintextLease | null> {
    const row = await this.backend.leaseRow(provider);
    if (!row) return null;
    const secrets = unpackSecrets(open(row.secret_ciphertext, this.key, row.id));
    return {
      credentialId: row.id,
      label: row.label,
      secret: secrets[primaryField(provider).id] ?? "",
      secrets,
      identifiers: readIdentifiers(row.identifiers),
      origin: "database",
    };
  }

  noteUse(id: string, at: Date = this.now()): Promise<void> {
    return this.backend.patchRow(id, { last_used_at: at.toISOString() });
  }

  noteCheck(id: string, ok: boolean, error: string | null, at: Date = this.now()): Promise<void> {
    return this.backend.patchRow(id, {
      last_check_ok: ok,
      last_check_at: at.toISOString(),
      // Callers must have scrubbed this already; truncated so a giant API body
      // cannot be parked in the database.
      last_check_error: ok ? null : (error?.slice(0, 500) ?? null),
    });
  }

  private toMasked(r: CredentialRow): MaskedCredential {
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      masked: r.masked,
      identifiers: readIdentifiers(r.identifiers),
      status: r.status,
      created_at: r.created_at,
      created_by: r.created_by,
      last_used_at: r.last_used_at,
      last_check_ok: r.last_check_ok,
      last_check_at: r.last_check_at,
      last_check_error: r.last_check_error,
    };
  }
}

// ------------------------------------------------------------- memory backend

/**
 * In-memory backend. Used by the test suite, and by nothing else.
 *
 * It stores the ciphertext exactly as the database would, so the encryption and
 * masking paths under test are the production ones.
 */
export class MemoryCredentialBackend implements CredentialBackend {
  private rows = new Map<string, CredentialRow & { secret_ciphertext: string }>();

  async listRows(provider?: CredentialProvider): Promise<CredentialRow[]> {
    return [...this.rows.values()]
      .filter((r) => provider === undefined || r.provider === provider)
      .map(({ secret_ciphertext: _ignored, ...rest }) => rest)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async insertRow(row: CredentialRow & { secret_ciphertext: string }): Promise<void> {
    this.rows.set(row.id, { ...row });
  }

  async removeRow(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async leaseRow(provider: CredentialProvider): Promise<SealedRow | null> {
    const active = [...this.rows.values()]
      .filter((r) => r.provider === provider && r.status === "active")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!active) return null;
    return {
      id: active.id,
      label: active.label,
      secret_ciphertext: active.secret_ciphertext,
      identifiers: { ...active.identifiers },
    };
  }

  async patchRow(id: string, patch: Partial<CredentialRow>): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ...patch });
  }
}
