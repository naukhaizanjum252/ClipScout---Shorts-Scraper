/**
 * The Supabase backend for the credential store.
 *
 * SERVER ONLY. Importing this from a client component is a bug, and the
 * `server-only`-shaped guard at the bottom of `resolve.ts` is what catches it.
 *
 * TWO CLIENTS, ON PURPOSE
 *
 *   The signed-in admin's client (publishable key + their session cookie) does
 *   the listing, the insert and the delete. It CANNOT read the ciphertext
 *   column: the credentials migration revokes column-level SELECT on `secret_ciphertext`
 *   from `authenticated`, so even a hand-written PostgREST query with
 *   `select=*` comes back without it. That is a stronger guarantee than "the
 *   code does not ask for it".
 *
 *   The service-role client does exactly one thing — call
 *   `shorts_scraper.lease_api_credential(provider)`, a SECURITY DEFINER function
 *   granted to `service_role` and revoked from PUBLIC, `anon` and
 *   `authenticated`. That is the only path in the system that yields plaintext,
 *   and it exists only inside a server process about to make an API call.
 *
 * NOTE: this backend is written but UNEXERCISED. Q4 is answered — LookUp
 * Media's own Supabase, one shared database, this tool in its own
 * `shorts_scraper` schema — but no project reference has been handed over yet,
 * so nothing here has been run against a live database. `verify/db.ts` is the
 * harness that will prove it and it is red until then. The security-relevant
 * behaviour this delegates to — sealing, opening, masking — IS covered by
 * tests, because `EncryptedCredentialStore` is shared with the in-memory
 * backend.
 *
 * SHARED-DATABASE CAVEAT, stated where somebody will read it: the service-role
 * key is per Supabase PROJECT, not per schema, so a co-tenant project holding
 * it can select from `shorts_scraper.api_credentials`. What they get is
 * ciphertext. `CREDENTIALS_ENCRYPTION_KEY` lives in this app's environment and
 * never in the database, so a co-tenant needs BOTH to reach a plaintext key.
 */
import { createClient } from "@supabase/supabase-js";

import { DB_SCHEMA, supabaseServiceRoleKey, supabaseUrl, type TenantClient } from "../supabase/config";
import { CredentialError, type CredentialProvider } from "./types";
import type { CredentialBackend, CredentialRow, SealedRow } from "./store";

/**
 * The columns an admin session is allowed to read. `secret_ciphertext` is
 * absent, and the database refuses it independently — belt and braces, because
 * the belt is the one a future edit could undo.
 *
 * `identifiers` IS ON THIS LIST DELIBERATELY. It holds a Meta app id, a Page id,
 * an Instagram business account id — values that are not secrets and that an
 * operator has to be able to read back, because "which app is this key for" is
 * otherwise only answerable by deleting the credential and typing it in again
 * blind. The column-level grant in the credentials migration names it too; the
 * secret half of the same credential is in `secret_ciphertext` and is on neither
 * list.
 */
const DISPLAY_COLUMNS =
  "id, provider, label, masked, identifiers, status, created_at, created_by, last_used_at, last_check_ok, last_check_at, last_check_error";

export class SupabaseCredentialBackend implements CredentialBackend {
  constructor(private readonly client: TenantClient) {}

  async listRows(provider?: CredentialProvider): Promise<CredentialRow[]> {
    let query = this.client.from("api_credentials").select(DISPLAY_COLUMNS).order("created_at");
    if (provider !== undefined) query = query.eq("provider", provider);
    const { data, error } = await query;
    if (error) throw new CredentialError(`Could not read credentials: ${error.message}`);
    return (data ?? []) as unknown as CredentialRow[];
  }

  /**
   * Save a new credential. NAMED COLUMN BY COLUMN, NOT SPREAD.
   *
   * SCAR, 2026-09-05. This used to be `.insert(row)`, spreading the whole
   * `CredentialRow`. That row type carries `last_used_at`, `last_check_ok`,
   * `last_check_at` and `last_check_error` — four columns that are ALWAYS NULL
   * at insert, because nothing has used or tested the key yet. PostgREST builds
   * its column list from the JSON keys it is given and does not care that the
   * values are null, so the statement named thirteen columns. The INSERT grant
   * names nine, deliberately: those four are written only by `patchRow`, under
   * a separate UPDATE grant. Postgres checks column privileges before anything
   * else, so every save of every provider's key was refused with 42501 and the
   * credentials page said "Could not save the credential (42501)" — a number,
   * about a column the operator never typed.
   *
   * Nothing was red. The insert-grant assertion in tests/migrations.test.ts
   * checked only that `secret_ciphertext` and `identifiers` were IN the grant,
   * never that everything the code sends is; the equivalent check on the UPDATE
   * side already diffed against the store's own source. That gap is now closed
   * the same way — see "grants the store every credential column it inserts".
   *
   * So the payload is written out, and the rule for editing it is the grant:
   * a key added here that migration 02 and migration 09 do not name fails at
   * runtime and nowhere else.
   */
  async insertRow(row: CredentialRow & { secret_ciphertext: string }): Promise<void> {
    const { error } = await this.client.from("api_credentials").insert({
      id: row.id,
      provider: row.provider,
      label: row.label,
      secret_ciphertext: row.secret_ciphertext,
      masked: row.masked,
      identifiers: row.identifiers,
      status: row.status,
      created_at: row.created_at,
      created_by: row.created_by,
    });
    if (error) {
      // The row contains ciphertext. PostgREST error messages can echo the
      // offending row back, so the message is not passed through verbatim.
      throw new CredentialError(`Could not save the credential (${error.code ?? "unknown"}).`);
    }
  }

  async removeRow(id: string): Promise<void> {
    const { error } = await this.client.from("api_credentials").delete().eq("id", id);
    if (error) throw new CredentialError(`Could not delete the credential: ${error.message}`);
  }

  /**
   * Record what happened when a key was used. THIS RUNS AS `authenticated`.
   *
   * SCAR, 2026-09-04 review. It always did — `resolveCredentialStore()` builds
   * this backend on the signed-in admin's client — and the database had no
   * UPDATE grant and no UPDATE policy on `api_credentials` for that role. So
   * every `noteCheck` and `noteUse` was refused by Postgres, and the refusal
   * came back through `testCredentialAction` onto the credentials screen: the
   * operator paid for a real call to X or to Google, the call succeeded, and
   * the page told them their key had failed with a message naming a column.
   * The suite was green throughout, because the store's tests run on
   * `MemoryCredentialBackend`, which has no grants to get wrong.
   *
   * What makes it work now is a COLUMN-LEVEL grant of exactly four columns plus
   * an admins-only UPDATE policy (see the credentials and RLS migrations). The
   * consequence to know before it bites: `patch` may only ever carry those four
   * columns. A fifth added here without being added to the grant fails at
   * runtime and nowhere else — which is why tests/migrations.test.ts reads the
   * keys `EncryptedCredentialStore` actually patches and checks each one
   * against the grant.
   *
   * The message keeps `error.message` on purpose, unlike `insertRow` above:
   * nothing in `patch` is a secret — four timestamps and a boolean — so there
   * is no ciphertext for PostgREST to echo back, and an operator staring at a
   * failed write is entitled to the database's own sentence.
   */
  async patchRow(id: string, patch: Partial<CredentialRow>): Promise<void> {
    const { error } = await this.client.from("api_credentials").update(patch).eq("id", id);
    if (error) throw new CredentialError(`Could not update the credential: ${error.message}`);
  }

  /**
   * The only plaintext path. Refuses to run without a service-role key rather
   * than falling back to the admin's session, which would silently require the
   * ciphertext column to be readable by `authenticated` — i.e. would require
   * undoing the whole design.
   */
  async leaseRow(provider: CredentialProvider): Promise<SealedRow | null> {
    const key = supabaseServiceRoleKey();
    if (!key) {
      throw new CredentialError(
        "SUPABASE_SERVICE_ROLE_KEY is not set on this server, so no API credential can be leased. " +
          "The keyless `ytdlp` adapter needs no credential and is the default.",
      );
    }
    const service = createClient(supabaseUrl, key, {
      auth: { persistSession: false },
      db: { schema: DB_SCHEMA },
    });
    const { data, error } = await service.rpc("lease_api_credential", { p_provider: provider });
    if (error) throw new CredentialError(`Could not lease a credential (${error.code ?? "unknown"}).`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      id: String(row.id),
      label: String(row.label),
      secret_ciphertext: String(row.secret_ciphertext),
      // Narrowed by `readIdentifiers` in the store rather than trusted here:
      // this is a `jsonb` column in a SHARED database, so what comes back is
      // whatever is in the row, not whatever this code last wrote.
      identifiers: (row.identifiers ?? {}) as Record<string, string>,
    };
  }
}
