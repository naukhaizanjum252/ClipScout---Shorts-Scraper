/**
 * Masking, and the scrubber that stands between a secret and anything a human
 * or a log file will ever see.
 *
 * `maskSecret` is the display form. `scrub` is the safety net: every error
 * message that could conceivably have been built from a response body or a URL
 * goes through it before being stored or shown, so a key that leaked into a
 * string somewhere upstream still does not leave the process.
 *
 * A safety net is not a substitute for not leaking. Both are used.
 */

/** How many trailing characters of a key are shown. Four, as specified. */
export const VISIBLE_TAIL = 4;

/**
 * `••••••••4f2a` — eight dots and the last four characters.
 *
 * The dot count is FIXED and does not encode the real length: a mask that grew
 * with the secret would leak its length, which is a small thing that costs
 * nothing to not do. A secret too short to mask safely returns all dots.
 */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.length <= VISIBLE_TAIL * 2) return "••••••••";
  return `••••••••${s.slice(-VISIBLE_TAIL)}`;
}

/**
 * Remove any occurrence of the given secrets from a string.
 *
 * Applied to every error message that comes back from a live API call before it
 * is written to `api_credentials.last_check_error` or shown in the UI. Google's
 * 400/403 bodies echo the request back often enough that this is not
 * theoretical.
 *
 * Also strips credential-bearing query parameters wholesale, because an error
 * can carry a URL built from a credential this call site was never given.
 *
 * THE PARAMETER LIST GREW ON 2026-09-04 AND THE REASON IS SPECIFIC. The Meta
 * credential check calls `GET /debug_token`, which takes the token being
 * inspected as `input_token` and an app access token as `access_token` — both
 * on the QUERY STRING, both in any URL a Graph error echoes back. `input_token`
 * did not match the old pattern, so the belt was there and the braces were not.
 * `bearer` is here for the same class of mistake one host over.
 */
export function scrub(message: string, ...secrets: Array<string | null | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    const s = secret?.trim();
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out.replace(
    /([?&](?:key|api_key|apikey|access_token|input_token|client_secret|app_secret|bearer_token|token)=)[^&\s"'`]+/gi,
    "$1[REDACTED]",
  );
}

/**
 * Assert that a value about to be serialised carries no secret.
 *
 * Used by the tests, and by `saveCredential`'s return path in development. It
 * walks the whole serialised form rather than checking known field names,
 * because the failure mode this guards against is a secret arriving in a field
 * nobody thought to check.
 */
export function containsSecret(value: unknown, secret: string): boolean {
  const s = secret.trim();
  if (s.length < 8) return false;
  return JSON.stringify(value ?? null).includes(s);
}
