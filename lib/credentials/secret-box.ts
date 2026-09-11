/**
 * Application-level encryption for operator API keys.
 *
 * WHY THIS AND NOT pgsodium / SUPABASE VAULT
 *
 * Vault is the better answer and should be preferred the moment it is
 * available. It is not available to this build. Q4 is now answered — LookUp
 * Media's own Supabase, one shared database, this tool in its own
 * `shorts_scraper` schema (Erik, 2026-09-02) — but no project reference has
 * been handed over, so nothing here can verify that the extension is installed,
 * let alone use it. Choosing Vault on the assumption that it will be there
 * would produce a migration that fails on apply.
 *
 * REVISIT THIS WHEN THE PROJECT EXISTS, and note the shared database changes
 * the sum: Vault's keys would live in the same project every co-tenant's
 * service-role key can reach, whereas CREDENTIALS_ENCRYPTION_KEY lives in this
 * app's environment and no co-tenant has it. That is an argument FOR the
 * current design, not merely an excuse for it.
 *
 * So: AES-256-GCM in the application, with the key held OUTSIDE the database in
 * `CREDENTIALS_ENCRYPTION_KEY`, which is a server-only environment variable.
 *
 * THE TRUST ASSUMPTION, STATED PLAINLY
 *
 * A database dump alone does not yield an operator's API key: the ciphertext is
 * useless without the encryption key, and the encryption key is not in the
 * database. Anyone who has BOTH the database and the server's environment has
 * the plaintext. That is strictly better than storing bare and strictly worse
 * than a KMS or Vault, and it is the honest position of this implementation.
 * Swapping to Vault later is a migration plus a new `CredentialStore`; nothing
 * outside this directory changes.
 *
 * WHAT THIS FILE MUST NEVER DO
 *
 * Throw an error containing plaintext, ciphertext, or the encryption key. Every
 * failure below is deliberately vague about the value and specific about the
 * cause.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Version prefix, so a future re-key can tell old ciphertext from new. */
const PREFIX = "v1";

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/**
 * The encryption key, as raw bytes.
 *
 * Accepts base64 or hex, must decode to exactly 32 bytes. Refuses anything
 * else rather than padding or hashing it into shape — a short key silently
 * stretched is the sort of thing nobody ever notices.
 *
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
export function encryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SecretBoxError(
      "CREDENTIALS_ENCRYPTION_KEY is not set. Generate one with " +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"` ' +
        "and put it in the server environment — NOT in the database, and NOT in this repo.",
    );
  }
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `CREDENTIALS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        "Use 32 random bytes, base64 or hex encoded.",
    );
  }
  return decoded;
}

/**
 * Encrypt. Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * `aad` binds the ciphertext to a context string — this code passes the
 * credential's row id, so a ciphertext lifted from one row and pasted into
 * another fails to decrypt instead of quietly working.
 */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  if (!plaintext) throw new SecretBoxError("refusing to encrypt an empty secret");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, b64(iv), b64(tag), b64(body)].join(".");
}

/** Decrypt. Throws if the ciphertext, the key, or the context does not match. */
export function open(sealed: string, key: Buffer, aad: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new SecretBoxError("stored secret is not in the expected v1 envelope format");
  }
  const iv = unb64(parts[1]);
  const tag = unb64(parts[2]);
  const body = unb64(parts[3]);
  if (iv.length !== IV_BYTES) throw new SecretBoxError("stored secret has a malformed nonce");
  if (tag.length !== TAG_BYTES) throw new SecretBoxError("stored secret has a malformed auth tag");
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately says nothing about the value. Wrong key, tampered row and
    // wrong context are indistinguishable from out here, and should be.
    throw new SecretBoxError(
      "stored secret could not be decrypted — wrong CREDENTIALS_ENCRYPTION_KEY, or the row has been altered",
    );
  }
}

/** Constant-time compare, for anywhere a secret is checked rather than used. */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function b64(b: Buffer): string {
  return b.toString("base64url");
}

function unb64(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
