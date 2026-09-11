"use server";

/**
 * Server actions for the credential settings page.
 *
 * THE VALUE ONLY EVER TRAVELS ONE WAY: in, from the form, into the store, where
 * it is encrypted. Nothing here returns it, echoes it, logs it, or lets it into
 * an error message — every message that could have been built from an API
 * response goes through `scrub()` first, because Google's 400/403 bodies echo
 * the request back often enough that it is not theoretical.
 *
 * Every action re-checks the caller's role server-side. The page also hides
 * itself from non-admins and the proxy redirects anonymous requests, but neither
 * of those is a permission check — they are conveniences on top of this one.
 */
import { revalidatePath } from "next/cache";

import { getViewer, isAdmin } from "@/lib/auth/role";
import { resolveCredentialStore } from "@/lib/credentials/resolve";
import { scrub } from "@/lib/credentials/mask";
import { CredentialError, type MaskedCredential } from "@/lib/credentials/types";
import { YouTubeClient } from "@/lib/yt/client";

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

const CREDENTIALS_PATH = "/admin/credentials";

async function adminStore() {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) throw new CredentialError("Not permitted.");
  const { store, origin, explanation } = await resolveCredentialStore();
  if (!store) throw new CredentialError(explanation);
  return { viewer: viewer!, store, origin };
}

export async function saveCredentialAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const { store, viewer } = await adminStore();
    const secret = String(form.get("secret") ?? "");
    const saved = await store.save({
      provider: "youtube",
      label: String(form.get("label") ?? ""),
      secret,
      createdBy: viewer.userId,
    });
    revalidatePath(CREDENTIALS_PATH);
    // The masked form, and nothing else. Note that `saved` itself carries no
    // secret field — MaskedCredential has nowhere to put one.
    return { ok: true, message: `Saved ${saved.label} (${saved.masked}).` };
  } catch (cause) {
    return { ok: false, message: safeMessage(cause) };
  }
}

export async function deleteCredentialAction(id: string): Promise<ActionResult> {
  try {
    const { store } = await adminStore();
    await store.remove(id);
    revalidatePath(CREDENTIALS_PATH);
    return { ok: true, message: "Deleted." };
  } catch (cause) {
    return { ok: false, message: safeMessage(cause) };
  }
}

/**
 * "Test this key" — one cheap real call, reporting pass/fail and nothing else.
 *
 * `channels.list` by id: 1 declared unit, the cheapest call that proves the key
 * is accepted AND that the Data API is enabled on that Cloud project (a key
 * with the API switched off fails here with a distinct reason, which is the
 * single most common setup mistake).
 */
export async function testCredentialAction(id: string): Promise<ActionResult> {
  let secret: string | null = null;
  try {
    const { store } = await adminStore();
    const lease = await store.lease("youtube");
    if (!lease || lease.credentialId !== id) {
      return { ok: false, message: "That credential is not the active one, so it cannot be tested." };
    }
    secret = lease.secret;

    const client = new YouTubeClient({ apiKey: lease.secret, budgetUnits: 1 });
    await client.call("channels.list", { part: "id", id: "UCBR8-60-B28hp2BmDPdntcQ", maxResults: 1 });

    await store.noteCheck(id, true, null);
    await store.noteUse(id);
    revalidatePath(CREDENTIALS_PATH);
    return { ok: true, message: "Key works. One unit spent." };
  } catch (cause) {
    const message = safeMessage(cause, secret);
    try {
      const { store } = await adminStore();
      await store.noteCheck(id, false, message);
      revalidatePath(CREDENTIALS_PATH);
    } catch {
      // Recording the failure is best-effort; reporting it is not.
    }
    return { ok: false, message };
  }
}

/** Everything a user sees. Never contains a secret; see MaskedCredential. */
export async function listCredentialsAction(): Promise<MaskedCredential[]> {
  const { store } = await adminStore();
  return store.list("youtube");
}

function safeMessage(cause: unknown, secret?: string | null): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return scrub(raw, secret).slice(0, 500);
}
