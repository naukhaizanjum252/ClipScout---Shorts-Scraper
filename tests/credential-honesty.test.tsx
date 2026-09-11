// @vitest-environment jsdom
import * as fs from "node:fs";
import * as path from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialPanel } from "@/app/(admin)/admin/credentials/credential-panel";
import { allCredentialProviders, credentialProviderInfo } from "@/lib/credentials/providers";
import { CREDENTIAL_PROVIDERS, type MaskedCredential } from "@/lib/credentials/types";

/**
 * WHAT THIS BUILD DOES WITH A KEY: SAID TRUTHFULLY, AND SAID OUT LOUD.
 *
 * THE DEFECT THIS FILE EXISTS FOR (2026-09-04 review, B6). The credentials page
 * invited an operator to paste an X bearer token — billed per Post returned,
 * against their own card — and a Meta token that costs Business Verification
 * plus App Review to obtain, and it never said what this build would do with
 * either. `usedBy`, the field lib/credentials/providers.ts calls "THE HONEST
 * FIELD AND THE REASON THIS FILE EXISTS", was null for x, instagram and
 * facebook, was a stale claim for youtube, and was RENDERED ON NO SCREEN AT
 * ALL. Every existing test asked whether the field held the value the file's
 * comments said it held. None asked whether it was true, and none asked whether
 * anybody could read it.
 *
 * So there are two halves here and they are different questions.
 *
 *   IS IT SAID? Rendered through `CredentialPanel` with the same
 *   `allCredentialProviders()` array page.tsx hands it — not a fixture, not a
 *   hand-built prop object. A test that builds its own provider record proves
 *   the component and says nothing about what the deployed page contains, which
 *   is the exact shape of mistake this round exists to close.
 *
 *   IS IT TRUE? Read out of the run path's OWN SOURCE. A provider may claim its
 *   key is spent on a run only if something under lib/platform, lib/shorts,
 *   app/(admin)/admin/shorts or scripts actually leases that provider's
 *   credential. That is what makes the claim survive a rewiring: when somebody
 *   changes which credentials the registry leases, this goes red until the
 *   sentence on the page is changed to match.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE. That a leased key produces anything
 * useful. Instagram media carries no duration and Facebook's video edges
 * document no read; both of those are `limits`, they are printed beside this,
 * and no test can turn them into a working platform. The claim under test is
 * narrower and it is the one about money: is this key spent, or is it idle.
 */

afterEach(cleanup);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROVIDERS = [...allCredentialProviders()];
const noop = vi.fn(async () => ({ ok: true, message: "" }));

/** The whole rendered page text, whitespace-flattened so JSX wrapping is moot. */
const rendered = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function renderPanel(over: Partial<Parameters<typeof CredentialPanel>[0]> = {}) {
  return render(
    <CredentialPanel
      providers={PROVIDERS}
      credentials={[]}
      canEdit
      readOnlyReason={null}
      onSave={vi.fn(async () => ({ ok: true, message: "saved" }))}
      onTest={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

/** A saved credential, as `list()` would return it. Never carries a secret. */
function saved(over: Partial<MaskedCredential> = {}): MaskedCredential {
  return {
    id: "cred-1",
    provider: "x",
    label: "Lucky35 X project",
    masked: "••••••••4f2a",
    identifiers: {},
    status: "active",
    created_at: "2026-09-01T00:00:00.000Z",
    created_by: null,
    last_used_at: null,
    last_check_ok: null,
    last_check_at: null,
    last_check_error: null,
    ...over,
  };
}

/**
 * WHAT THE VERDICT IS NOW, AND WHY THE PROSE STOPPED BEING ASSERTED.
 *
 * Erik, 2026-09-05: *"EVERYTHING, this is a 'enter these credentials here' page
 * not an info page"*. Every explanatory paragraph came off the credentials
 * screen, `usedBy.detail` included — it was a paragraph per slot explaining
 * which module leases the key and what the vendor charges.
 *
 * THE VERDICT ITSELF DID NOT COME OFF, and that is the line these cases moved
 * to. "Spent on a run." / "Not spent on a run." is four words, it is the fact
 * that decides whether pasting a key eventually bills somebody, and it is still
 * printed in every slot, on the save form, and to a viewer who cannot press
 * anything. So the question this block asks is unchanged in substance — CAN AN
 * OPERATOR FIND OUT WHETHER THIS BUILD SPENDS THE KEY — and only the length of
 * the answer changed.
 *
 * THE TRUTHFULNESS HALF BELOW IS UNTOUCHED AND IS THE HALF THAT MATTERS. A
 * provider may still claim `onARun: true` only if the run path actually leases
 * its credential, read out of that path's own source. Shortening a claim cannot
 * make it true, so nothing there was relaxed.
 *
 * WHAT WAS DELIBERATELY NOT DONE: the detail strings were NOT deleted from
 * lib/credentials/providers.ts. They are the reasoning behind each verdict and
 * the thing a reviewer checks it against; they simply no longer render.
 */
describe("the page says what this build does with each key", () => {
  it("prints a verdict in every slot, with no key saved", () => {
    renderPanel();
    const page = rendered();
    for (const info of PROVIDERS) {
      expect(page, `${info.id}: nothing says whether this build spends the key`).toContain(
        info.usedBy.onARun ? "Spent on a run." : "Not spent on a run.",
      );
    }
  });

  it("still prints it for a slot that already holds a key", () => {
    // The question does not stop mattering once a key is saved — this is the
    // slot an operator reads when they are deciding whether to delete one.
    renderPanel({ credentials: [saved()] });
    expect(credentialProviderInfo("x").usedBy.onARun).toBe(true);
    expect(rendered()).toContain("Spent on a run.");
  });

  it("still prints it for a viewer who cannot edit anything", () => {
    // A member without the admin role sees the slots and no buttons. What the
    // tool spends is not an admin-only fact.
    renderPanel({ canEdit: false, readOnlyReason: "You need an admin role to manage credentials." });
    const page = rendered();
    for (const info of PROVIDERS) {
      expect(page, `${info.id}, read-only`).toContain(
        info.usedBy.onARun ? "Spent on a run." : "Not spent on a run.",
      );
    }
  });

  it("prints it in the slot, above that slot's Save button", () => {
    // ABOVE SAVE IS THE CLAIM, AND IT IS ABOUT ORDER RATHER THAN ABOUT WHICH
    // ELEMENT CONTAINS IT. After the button this sentence is a receipt; before
    // it, it is the disclosure that decides whether to paste the key at all.
    //
    // It used to be inside the <form>, because there was one shared form and
    // inside-the-form was the only way to be near the button. Every provider
    // now has its own section, the verdict is rendered in the section header
    // above that section's form, and the assertion follows the fact: same
    // slot, before the button, checked with compareDocumentPosition against
    // the whole document rather than within one element.
    renderPanel();

    const marker = document.querySelector('input[name="provider"][value="youtube"]');
    const slot = marker?.closest("li");
    expect(slot, "the youtube slot did not render").not.toBeNull();

    expect(credentialProviderInfo("youtube").usedBy.onARun).toBe(false);
    const slotText = (slot?.textContent ?? "").replace(/\s+/g, " ");
    expect(slotText).toContain("Not spent on a run.");

    const button = slot?.querySelector("button[type=submit]");
    expect(button, "no Save button in the youtube slot").not.toBeNull();

    const sentence = [...(slot?.querySelectorAll("p") ?? [])].find((p) =>
      p.textContent?.includes("Not spent on a run."),
    );
    expect(sentence, "the spend sentence is not in the slot at all").toBeDefined();
    // DOCUMENT_POSITION_FOLLOWING (4) when the button comes after the sentence.
    expect(
      (sentence as Element).compareDocumentPosition(button as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says which it is in words, never in colour alone", () => {
    renderPanel();
    const page = rendered();
    // DESIGN.md: colour is never the only carrier. Here it is the difference
    // between a key that bills a card and a key that sits idle.
    expect(page).toContain("Spent on a run.");
    expect(page).toContain("Not spent on a run.");
  });
});

/**
 * THE TRUTHFULNESS HALF.
 *
 * A sentence on a settings page is worth exactly as much as the mechanism that
 * keeps it true. `usedBy.onARun` is checked against the run path's source, so
 * the claim cannot outlive the wiring it describes.
 */
describe("what the page claims about spending agrees with the code that spends", () => {
  /** The directories a "Get latest shorts" run is actually made of. */
  const RUN_PATH = ["lib/platform", "lib/shorts", "app/(admin)/admin/shorts", "scripts"];

  function sourceUnder(dir: string): string {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) return "";
    let out = "";
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out += sourceUnder(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // A test's fake store leases everything. Only the shipped code counts.
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out += fs.readFileSync(path.join(REPO_ROOT, child), "utf8");
    }
    return out;
  }

  /** Run-path source with its comments removed — prose about X is not a lease. */
  const runPathCode = RUN_PATH.map(sourceUnder)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*/, "$1"))
    .join("\n");

  /** Providers the run path leases a credential for, by name. */
  const leased = new Set(
    CREDENTIAL_PROVIDERS.filter((provider) =>
      new RegExp(`lease\\(\\s*["'\`]${provider}["'\`]\\s*\\)`).test(runPathCode),
    ),
  );

  it("found the run path, and something in it that leases a key", () => {
    // The guard that stops this whole block passing vacuously. If the wiring is
    // rewritten to lease by looping over PLATFORMS rather than by naming each
    // provider, this fails FIRST and says so — better than every `onARun: true`
    // going red one by one with no explanation between them.
    expect(runPathCode.length).toBeGreaterThan(1000);
    expect(
      [...leased],
      "nothing under lib/platform, lib/shorts, app/(admin)/admin/shorts or scripts contains a " +
        'lease("<provider>") call. Either the run spends no key at all — in which case every ' +
        "usedBy.onARun must be false — or the leases are no longer written provider by provider " +
        "and this detector needs rewriting to match. It must not be deleted: it is the only thing " +
        "keeping the sentence on the credentials page tied to the code that spends the key.",
    ).not.toEqual([]);
  });

  for (const provider of CREDENTIAL_PROVIDERS) {
    it(`${provider}: the claim about a run matches what the run path leases`, () => {
      const info = credentialProviderInfo(provider);
      expect(
        info.usedBy.onARun,
        info.usedBy.onARun
          ? `${provider} claims its key is spent on every run, and no file on the run path leases ` +
            "it. That is the expensive direction of this lie: an operator reads it, believes the " +
            "key is working, and waits for results that no code will ever fetch."
          : `${provider} says its key is NOT spent on a run, but the run path leases it. That is ` +
            "the other expensive direction: a key billing somebody's account while the page tells " +
            "them it is idle. Update lib/credentials/providers.ts to say what the wiring now does.",
      ).toBe(leased.has(provider));
    });

    it(`${provider}: says what happens to the key, and names something checkable`, () => {
      const { detail } = credentialProviderInfo(provider).usedBy;
      expect(detail.length, `${provider} has nothing to say about its own key`).toBeGreaterThan(80);

      // "It has to name the module, so the claim can be checked by opening it"
      // — providers.ts's own rule. A named module that does not exist is a
      // claim nobody can check, which is the same failure wearing a citation.
      const named = [...detail.matchAll(/\b((?:lib|app|scripts|verify)\/[\w./()-]*\.tsx?)/g)].map((m) => m[1]);
      expect(named.length, `${provider}: no module named in "${detail}"`).toBeGreaterThan(0);
      for (const module of named) {
        expect(fs.existsSync(path.join(REPO_ROOT, module)), `${provider} names ${module}`).toBe(true);
      }
    });
  }
});
