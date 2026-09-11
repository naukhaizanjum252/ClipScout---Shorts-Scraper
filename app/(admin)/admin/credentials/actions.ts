"use server";

/**
 * The three endpoints behind the credentials page: save, test, delete.
 *
 * THE VALUE ONLY EVER TRAVELS ONE WAY: in, from the form, into the store, where
 * it is encrypted. Nothing here returns it, echoes it, logs it, or lets it into
 * an error message — every message that could have been built from an API
 * response goes through `scrub()` first, because upstream 400/403 bodies echo
 * the request back often enough that it is not theoretical, and because Meta
 * takes its tokens on the QUERY STRING.
 *
 * Every action re-checks the caller's role server-side. The page also hides
 * itself from non-admins and the proxy redirects anonymous requests, but neither
 * of those is a permission check — they are conveniences on top of this one.
 *
 * WHAT THIS FILE MAY EXPORT. Async server actions and nothing else. Next
 * publishes every export of a `"use server"` module as a callable endpoint, so
 * an exported helper here is a route nobody decided to open. `ActionResult` and
 * the field-name prefix live in ./view.ts, which has no directive and therefore
 * cannot become one.
 *
 * WHY THE PROVIDER IS READ OFF THE FORM AND VALIDATED HERE.
 *
 * SCAR, 2026-09-04. The previous version of this screen's save action took the
 * provider dropdown the page rendered and then ignored it, writing every
 * credential as `provider: "youtube"`. An operator choosing X, filling in a
 * bearer token and pressing Save got a YouTube credential — or, if a YouTube key
 * already existed, an error telling them YouTube already had one, which is a
 * sentence about a platform they had not selected. The provider now comes off
 * the form, is narrowed by `isCredentialProvider` before it reaches the store,
 * and decides both which fields are read and which key is leased for a test.
 */
import { revalidatePath } from "next/cache";

import { getViewer, isAdmin } from "@/lib/auth/role";
import { runCredentialCheck } from "@/lib/credentials/checks";
import { readScrapeCreatorsCreditBalance } from "@/lib/platform/scrapecreators";
import { scrub } from "@/lib/credentials/mask";
import { resolveCredentialStore } from "@/lib/credentials/resolve";
import { CredentialError, isCredentialProvider, type CredentialProvider } from "@/lib/credentials/types";

import { FIELD_PREFIX, type ActionResult, type CreditBalanceOutcome } from "./view";

const CREDENTIALS_PATH = "/admin/credentials";

async function adminStore() {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) throw new CredentialError("Not permitted.");
  const { store, origin, explanation } = await resolveCredentialStore();
  if (!store) throw new CredentialError(explanation);
  return { viewer: viewer!, store, origin };
}

/**
 * Everything arriving here is untrusted, INCLUDING the things the page just
 * rendered. A form field is a string a browser sent; the dropdown that produced
 * it is not evidence of anything.
 */
function providerFrom(form: FormData): CredentialProvider {
  const raw = String(form.get("provider") ?? "");
  if (!isCredentialProvider(raw)) {
    throw new CredentialError("Choose which platform this key is for.");
  }
  return raw;
}

/**
 * The credential's own fields, un-prefixed.
 *
 * Only the prefix is stripped here; which field ids are legitimate for this
 * provider, which are required and which are secrets is decided by
 * lib/credentials/fields.ts inside the store. Doing it there rather than here
 * means the same rules apply to a credential saved from a script as to one
 * typed into this form.
 */
function fieldsFrom(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    if (typeof value !== "string") continue;
    out[key.slice(FIELD_PREFIX.length)] = value;
  }
  return out;
}

export async function saveCredentialAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const { store, viewer } = await adminStore();
    const saved = await store.save({
      provider: providerFrom(form),
      label: String(form.get("label") ?? ""),
      fields: fieldsFrom(form),
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
 * "Test this key" — one cheap real call, reporting pass or fail and nothing
 * else.
 *
 * IT IS PER PROVIDER NOW, and that is the feature Erik actually asked for: he
 * wants to paste a key and find out whether it works, before paying anyone and
 * before spending two weeks in Meta App Review. Which call gets made, what it
 * costs and what a pass proves are declared in lib/credentials/providers.ts and
 * printed on the page BEFORE the button is pressed; lib/credentials/checks.ts
 * makes it.
 *
 * THE PROVIDER COMES FROM THE STORE, NOT FROM THE CALLER. The action is given a
 * credential id and finds the provider by looking the row up, so a caller cannot
 * ask for the Instagram credential to be leased and tested against X's endpoint.
 */
export async function testCredentialAction(id: string): Promise<ActionResult> {
  let secrets: string[] = [];
  try {
    const { store } = await adminStore();
    const row = (await store.list()).find((c) => c.id === id);
    if (!row) {
      return { ok: false, message: "That credential no longer exists. Reload the page." };
    }

    const lease = await store.lease(row.provider);
    if (!lease || lease.credentialId !== id) {
      return { ok: false, message: "That credential is not the active one, so it cannot be tested." };
    }
    secrets = Object.values(lease.secrets);

    const result = await runCredentialCheck(row.provider, {
      secrets: lease.secrets,
      identifiers: lease.identifiers,
    });

    await store.noteCheck(id, result.ok, result.ok ? null : result.message);
    // A failed check still reached the API, so the key was still spent. Only a
    // pass used to be recorded as a use, which under-counted exactly the presses
    // an operator makes most: the ones that fail.
    await store.noteUse(id);
    revalidatePath(CREDENTIALS_PATH);
    return { ok: result.ok, message: result.message };
  } catch (cause) {
    const message = safeMessage(cause, secrets);
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

/**
 * ASK SCRAPECREATORS FOR THE CURRENT BALANCE. ONE CREDIT, EVERY PRESS.
 *
 * Erik, 2026-09-05: *"can we do a poll for how many credits are available and
 * how big the pool of credits are?"*
 *
 * THE ANSWER TO "POLL" IS NO, AND THAT IS THE MAIN DESIGN DECISION HERE.
 * `GET /v1/account/credit-balance` is documented at 1 credit per request — the
 * same price as a scraping call. A thirty-second poll is 2,880 credits a day,
 * about $5.41 a day at the Freelance tier, to watch a number that only moves
 * when a run happens. So nothing here runs on a timer.
 *
 * WHAT REPLACES THE POLL: a button, pressed deliberately, priced on its face.
 *
 * A KNOWN GAP, WRITTEN DOWN RATHER THAN LEFT TO BE DISCOVERED. Every ordinary
 * ScrapeCreators response already carries `credits_remaining` and
 * `ScrapeCreatorsClient.recordCredits` banks it — so a run learns the balance
 * at NO extra cost and prints it in its own spend note. NOTHING PERSISTS THAT
 * READING, so this page cannot show it: the client is built per run and dies
 * with it. Storing the last seen balance and its timestamp beside the
 * credential would make the free path serve this screen too and reduce this
 * button to the one case it is genuinely needed for — an operator who has just
 * bought credits and not run anything since. That is a schema change and it is
 * not in this pass; until it lands, every balance shown here cost a credit.
 *
 * THE FAILURE MODE THIS AVOIDS BY BEING A BUTTON: a balance display that spends
 * the balance it displays is a meter that consumes fuel to show the fuel level.
 * At 2,880 reads a day it would be the largest single consumer of credits on a
 * deployment that scrapes a handful of seeds.
 *
 * ADMIN-GATED LIKE THE TEST BUTTON, and for the same reason: this is an
 * endpoint that spends the operator's money, and a server action is reachable
 * by anyone who can POST an action id the client bundle already contains.
 */
export async function checkScrapeCreatorsCreditsAction(): Promise<CreditBalanceOutcome> {
  let secrets: string[] = [];
  try {
    const { store } = await adminStore();
    const lease = await store.lease("scrapecreators");
    if (!lease) {
      return {
        ok: false,
        message:
          "No ScrapeCreators key is saved, so there is no account to ask. Nothing was sent and " +
          "nothing was charged.",
      };
    }
    secrets = Object.values(lease.secrets);

    const key = Object.values(lease.secrets)[0];
    if (!key) {
      return {
        ok: false,
        message: "The saved ScrapeCreators credential has no key in it. Nothing was sent.",
      };
    }

    // THE SEAM BUILDS THE CLIENT, NOT THIS FILE. lib/platform/registry.test.ts
    // asserts that nothing outside lib/platform constructs a
    // `ScrapeCreatorsClient`, because a second client is a second request meter
    // against one credit balance. The rule is right and this action is exactly
    // the kind of module it is aimed at, so the construction — and the ceiling
    // of one request — lives in lib/platform/scrapecreators.ts.
    const credits = await readScrapeCreatorsCreditBalance(key);

    // The read itself is a use of the key, and a failed one is too — the same
    // rule the Test button follows, for the same reason.
    await store.noteUse(lease.credentialId);
    revalidatePath(CREDENTIALS_PATH);

    return {
      ok: true,
      credits,
      highWaterMark: credits,
      readAt: new Date().toISOString(),
      charged: true,
    };
  } catch (cause) {
    // The vendor quotes its own URL in some errors and the key travels in a
    // header, but `scrub` is applied anyway: this is the file that would leak it.
    console.error("[admin/credentials] the credit balance could not be read:", cause);
    return { ok: false, message: safeMessage(cause, secrets) };
  }
}

function safeMessage(cause: unknown, secrets: readonly string[] = []): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return scrub(raw, ...secrets).slice(0, 500);
}
