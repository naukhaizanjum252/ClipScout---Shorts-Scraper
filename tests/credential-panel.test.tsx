// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialPanel } from "@/app/(admin)/admin/credentials/credential-panel";
import { FIELD_PREFIX } from "@/app/(admin)/admin/credentials/view";
import { allCredentialProviders, credentialProviderInfo } from "@/lib/credentials/providers";
import type { MaskedCredential } from "@/lib/credentials/types";

/**
 * THE CREDENTIALS SCREEN, RENDERED.
 *
 * WHY THIS FILE EXISTS. Erik asked for Instagram and Facebook to be scaffolded
 * so that a key can be entered and tested, and for X to be built properly
 * because he is paying for it. The part of that an operator actually touches is
 * this panel, and the two things it has to get right are behaviours rather than
 * shapes:
 *
 *   THE FORM FOLLOWS THE PLATFORM. Pick X and there is one bearer-token box.
 *   Pick Instagram and there are four boxes of two different kinds. A form that
 *   silently kept the single-secret shape would take a Meta token, drop the app
 *   id nobody was asked for, and then fail every test with a message about the
 *   key.
 *
 *   A SECRET LOOKS DIFFERENT FROM AN IDENTIFIER. Secrets are password inputs and
 *   are never read back; identifiers are plain text and ARE shown back, because
 *   "which app is this key for" has to be answerable without deleting the
 *   credential.
 *
 * It can be rendered at all because page.tsx hands the server actions down as
 * props. An import would have pulled the `"use server"` graph — cookies,
 * Supabase, the credential store — into this file, and the previous version of
 * this repo shipped its most important controls untested for exactly that
 * reason.
 *
 * NOTE: every "key" below is a literal typed in this file. No real credential
 * exists in this repo or in its history.
 */

afterEach(cleanup);

const PROVIDERS = [...allCredentialProviders()];

const noop = vi.fn(async () => ({ ok: true, message: "" }));

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
    provider: "instagram",
    label: "Lucky35 Meta app",
    masked: "••••••••4f2a",
    identifiers: { app_id: "1234567890", ig_business_account_id: "5555555555" },
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
 * EVERY SLOT IS ITS OWN FORM, AND THE PICKER IS GONE.
 *
 * Erik, 2026-09-05: *"this is stupid, give each platform and vendor their own
 * section"*. There used to be one form at the top of the panel with a
 * `<select>` naming the provider, so entering two keys meant choose-fill-save
 * twice through the same three controls. Each provider now renders its own
 * fields under its own heading, and the provider travels on a hidden input.
 *
 * THESE CASES ASK THE SAME QUESTIONS AS BEFORE, SCOPED TO A FORM instead of to
 * the document: does a provider get exactly the fields it declares, are secrets
 * masked and identifiers readable, and does a save carry the right provider.
 */
function formFor(provider: string): HTMLFormElement {
  const marker = document.querySelector(`input[name="provider"][value="${provider}"]`);
  const form = marker?.closest("form");
  if (!form) throw new Error(`no form rendered for ${provider}`);
  return form as HTMLFormElement;
}

const fieldIn = (form: HTMLFormElement, id: string) =>
  form.querySelector(`[name="${FIELD_PREFIX}${id}"]`) as HTMLInputElement | null;

describe("every provider has its own section", () => {
  it("asks for one bearer token for X and four values for Instagram, at the same time", () => {
    renderPanel();

    // No picking, no waiting: both forms are on the page at once, which is the
    // whole point of the change.
    const x = formFor("x");
    for (const field of credentialProviderInfo("x").fields) {
      expect(fieldIn(x, field.id), field.id).not.toBeNull();
    }
    expect(x.querySelectorAll(`[name^="${FIELD_PREFIX}"]`)).toHaveLength(1);

    const instagram = credentialProviderInfo("instagram").fields;
    expect(instagram.length).toBe(4);
    const ig = formFor("instagram");
    for (const field of instagram) {
      expect(fieldIn(ig, field.id), field.id).not.toBeNull();
    }
    expect(ig.querySelectorAll(`[name^="${FIELD_PREFIX}"]`)).toHaveLength(4);
  });

  /**
   * THE SPLIT AN OPERATOR CAN SEE. A password box says "this is sealed and you
   * will not get it back"; a text box says "check this, it is yours to read".
   * Getting it the wrong way round would either hide an app id somebody has to
   * verify or put an app secret on screen in the clear.
   */
  it("renders secrets as password inputs and identifiers as text", () => {
    renderPanel();
    const ig = formFor("instagram");
    for (const field of credentialProviderInfo("instagram").fields) {
      expect(fieldIn(ig, field.id)?.getAttribute("type"), field.id).toBe(
        field.kind === "secret" ? "password" : "text",
      );
    }
  });

  /**
   * THE BUG THIS REPLACES IS NOW STRUCTURALLY IMPOSSIBLE, and that is worth a
   * case rather than a deletion.
   *
   * Instagram and Facebook both declare `app_secret`. Under the single shared
   * form, switching provider re-rendered the same input element, so a value
   * typed for one would arrive as the other's — sealed under the wrong
   * provider, then failing every check for a reason invisible on screen. The
   * old form defended against it with a `${info.id}:${f.id}` remount key.
   *
   * There is nothing to remount now: the two inputs are different elements in
   * different <form>s and are never the same slot in the tree. This types into
   * one and proves the other did not move.
   */
  it("keeps each provider's app secret in its own box", async () => {
    const user = userEvent.setup();
    renderPanel();

    const igSecret = fieldIn(formFor("instagram"), "app_secret") as HTMLInputElement;
    const fbSecret = fieldIn(formFor("facebook"), "app_secret") as HTMLInputElement;
    expect(igSecret).not.toBe(fbSecret);

    await user.type(igSecret, "typed-into-instagram-0000");
    expect(igSecret.value).toBe("typed-into-instagram-0000");
    expect(fbSecret.value).toBe("");
  });

  it("carries its own provider on every form, so a save cannot assume one", () => {
    renderPanel();
    for (const info of PROVIDERS) {
      const marker = formFor(info.id).querySelector('input[name="provider"]') as HTMLInputElement;
      expect(marker.value, info.id).toBe(info.id);
      // Hidden, not chosen: the section heading already said which slot this is.
      expect(marker.type).toBe("hidden");
    }
    expect(screen.queryByRole("combobox"), "the provider picker is gone").toBeNull();
  });
});

describe("what the page says a key buys, and what it cannot", () => {
  /**
   * These two sentences are the answer to the question Erik asked. An operator
   * who reads them here has been saved Business Verification plus App Review —
   * weeks — to discover the same thing afterwards.
   */
  it("no longer prints the platform limits, which is a decision and not a regression", () => {
    // Erik, 2026-09-05: this is a page for entering credentials, not for
    // reading about APIs. The `limits` list — Instagram media carrying no
    // duration field, Facebook's video edges documenting no read — came off
    // the screen with every other explanatory block.
    //
    // THE FACTS THEMSELVES ARE NOT GONE AND THIS ASSERTS THAT. They are still
    // in lib/credentials/providers.ts with the reference each was read from,
    // and tests/credential-honesty.test.tsx still checks the spend claims that
    // sit beside them against the run path's own source. What changed is where
    // an operator meets them: in the repo, not on a form.
    //
    // Inverted rather than deleted, so quietly re-adding a wall of prose to
    // this page goes red and has to be argued for.
    renderPanel();
    expect(screen.queryAllByText(/NO DURATION FIELD ON INSTAGRAM MEDIA/i)).toHaveLength(0);
    expect(screen.queryAllByText(/video_reels/)).toHaveLength(0);

    const instagram = PROVIDERS.find((p) => p.id === "instagram");
    expect(instagram?.limits.join(" "), "the limits were deleted, not just unrendered").toMatch(
      /NO DURATION FIELD ON INSTAGRAM MEDIA/i,
    );
  });

  it("names every platform, including the ones holding no key", () => {
    renderPanel();
    for (const info of PROVIDERS) {
      expect(screen.getAllByText(info.label).length, info.label).toBeGreaterThan(0);
    }
    // Five slots, five "No key saved" states: a platform left off the page would
    // read as "that one is handled".
    expect(screen.getAllByText("No key saved")).toHaveLength(PROVIDERS.length);
  });
});

/**
 * THE X SLOT TELLS SOMEBODY WHERE TO GO, TWICE, IN ORDER.
 *
 * Erik, 2026-09-05: *"I need those links displayed as steps on the X platform
 * keys box"*. X is the one slot on this page that costs real money, and getting
 * a key for it is two errands on two pages: buy credits, then copy the bearer
 * token. The order is not presentation — X blocks requests on a zero balance
 * (docs.x.com/x-api/getting-started/pricing, read 2026-09-05), so a token
 * fetched first fails on this page exactly like a bad one.
 */
describe("the X slot spells out both errands", () => {
  const slotFor = (provider: string) => {
    const marker = document.querySelector(`input[name="provider"][value="${provider}"]`);
    const slot = marker?.closest("li");
    if (!slot) throw new Error(`no slot rendered for ${provider}`);
    return slot as HTMLLIElement;
  };

  it("links buying credits first and the bearer token second", () => {
    renderPanel();
    const steps = within(slotFor("x")).getAllByRole("listitem");
    const links = steps
      .flatMap((li) => Array.from(li.querySelectorAll("a")))
      .filter((a) => a.getAttribute("href")?.includes("console.x.com"));

    expect(links).toHaveLength(2);
    expect(links[0]!.textContent).toMatch(/credit/i);
    expect(links[0]!.getAttribute("href")).toBe("https://console.x.com");
    expect(links[1]!.textContent).toMatch(/bearer token/i);
    expect(links[1]!.getAttribute("href")).toBe("https://console.x.com/apps");

    // Outbound, to a console the operator is about to authenticate against.
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer noopener");
    }
  });

  /**
   * INSTEAD OF the generic link, not alongside it. Two links to the same console
   * worded differently is the page asking the operator which one it meant.
   */
  it("drops the one-size link where there are steps, and keeps it where there are not", () => {
    renderPanel();
    expect(within(slotFor("x")).queryByText(/^Get a X key$/)).toBeNull();
    expect(within(slotFor("youtube")).getByText(/^Get a YouTube key$/)).toBeTruthy();
    // The docs link is a different question and survives either way.
    expect(within(slotFor("x")).getByText("API documentation")).toBeTruthy();
  });
});

describe("a saved credential", () => {
  it("shows the identifiers back and never the secret", () => {
    renderPanel({ credentials: [saved()] });
    expect(screen.getByText("1234567890")).toBeTruthy();
    expect(screen.getByText("5555555555")).toBeTruthy();
    expect(screen.getByText("••••••••4f2a")).toBeTruthy();
    // There is no reveal control and there cannot be one: the browser is never
    // given the value.
    expect(screen.queryByRole("button", { name: /reveal|show key/i })).toBeNull();
  });

  /**
   * THE BUTTON FOLLOWS `check`, NOT WHETHER ANYTHING SPENDS THE KEY YET. That is
   * the whole point of this round: Erik is deciding whether to pay for these
   * APIs, so proving a key is valid has to be possible before anything is ready
   * to spend it.
   */
  it("offers Test where there is a documented call, priced, and says so plainly where there is not", () => {
    renderPanel({ credentials: [saved({ provider: "instagram" })] });
    expect(screen.getByRole("button", { name: "Test this key" })).toBeTruthy();

    // THE PRICE SURVIVED THE 2026-09-05 CUT AND THIS IS WHY IT IS ASSERTED.
    // Everything else about the check — which endpoint, what a pass proves,
    // where it is documented — left the page as explanatory text. The COST did
    // not, because one press of the vendor check is a billable request and a
    // button that spends a credit without saying so is a trap rather than a
    // clean form. Read from the provider table, never typed here.
    const instagram = PROVIDERS.find((p) => p.id === "instagram");
    expect(instagram?.check?.cost, "instagram has no check to price").toBeTruthy();
    expect(screen.getAllByText(instagram!.check!.cost).length).toBeGreaterThan(0);

    // And the endpoint narration is gone, deliberately.
    expect(screen.queryAllByText(/debug_token/)).toHaveLength(0);

    cleanup();
    renderPanel({ credentials: [saved({ provider: "tiktok", identifiers: {} })] });
    expect(screen.queryByRole("button", { name: "Test this key" })).toBeNull();
    expect(screen.getByText("No test available.")).toBeTruthy();
  });

  it("presses the action it was handed, with the credential's own id", async () => {
    const user = userEvent.setup();
    const onTest = vi.fn(async () => ({ ok: true, message: "Token accepted." }));
    renderPanel({ credentials: [saved()], onTest });

    await user.click(screen.getByRole("button", { name: "Test this key" }));
    expect(onTest).toHaveBeenCalledWith("cred-1");
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Token accepted.");
  });

  /**
   * A REQUIRED IDENTIFIER THAT IS ABSENT IS AN EM DASH THAT SAYS SO, never an
   * empty cell. An empty cell reads as "nothing to say"; the truth is "this
   * credential is missing something it needs".
   */
  it("marks a missing identifier as an unknown that explains itself", () => {
    renderPanel({ credentials: [saved({ identifiers: { app_id: "1234567890" } })] });
    const dash = screen.getByTitle(/saved without this value/i);
    expect(dash.textContent).toBe("—");
  });

  it("hides every control from a viewer who may not edit", () => {
    renderPanel({ credentials: [saved()], canEdit: false, readOnlyReason: "You need an admin role." });
    expect(screen.queryByRole("button", { name: "Test this key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("You need an admin role.")).toBeTruthy();
  });
});

describe("one key per platform", () => {
  /**
   * THE RULE IS UNCHANGED; WHERE IT IS EXPRESSED IS NOT.
   *
   * A slot holding an active key used to appear in the picker as a disabled
   * option reading "Instagram — key already saved". With the picker gone, the
   * slot simply renders its saved detail and a Delete button instead of an
   * entry form. That says the same thing by being true rather than by being
   * greyed out, and it puts the way to replace the key in the same place as
   * the statement that one exists.
   */
  it("offers no entry form for a slot that already holds a key", () => {
    renderPanel({ credentials: [saved({ provider: "instagram" })] });

    expect(
      document.querySelector('input[name="provider"][value="instagram"]'),
      "instagram still offers a form despite holding a key",
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    // And the slots that are still empty are unaffected.
    expect(formFor("x")).toBeTruthy();
  });
});
