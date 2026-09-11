"use client";

import { useActionState, useState, useTransition } from "react";

import { FIELD_PREFIX, type ActionResult, type CreditBalanceOutcome } from "./view";
import { CreditsBar } from "./credits-panel";
import type {
  CredentialCheckPlan,
  CredentialProviderInfo,
  CredentialSpend,
  CredentialStep,
} from "@/lib/credentials/providers";
import type { CredentialProviderKind, MaskedCredential } from "@/lib/credentials/types";
import { platformLabel, type Platform } from "@/lib/platform/types";

/**
 * The paste-a-key panel — one slot per platform, and a form whose SHAPE follows
 * the platform.
 *
 * A CREDENTIAL IS NOT ONE STRING, 2026-09-04, AND THIS IS WHERE THAT SHOWS.
 * YouTube really is one key and X really is one bearer token; Meta is a token
 * plus an app id plus an app secret plus the account or Page the request is made
 * from. The old single "secret" box could not express that, so an operator
 * pasting a perfectly good Meta token would press Test and be told their key was
 * bad — because a number nobody had asked them for was missing. The fields come
 * from lib/credentials/fields.ts and change when the dropdown changes.
 *
 * SECRETS AND IDENTIFIERS LOOK DIFFERENT BECAUSE THEY ARE DIFFERENT. A secret
 * field is `type="password"`, is sealed, and is never read back from the server
 * — there is no reveal button and there cannot be one, because the browser is
 * not given the value. An identifier — an app id, a Page id — is a plain text
 * box, is stored readable, and IS shown back afterwards, because "which app is
 * this key for" is a question an operator must be able to answer without
 * deleting the credential and starting again.
 *
 * EVERY SLOT IS ALWAYS RENDERED. A provider with no key shows as an empty slot
 * rather than being left off the page. That is the same rule the rest of this
 * tool runs on: a thing that was not read and a thing that has nothing to say
 * must not look identical. A missing row would read as "that platform is
 * handled"; an empty slot saying why reads as the truth.
 *
 * TWO GROUPS NOW, AND THE GROUPING IS THE POINT OF THE 2026-09-04 VOCABULARY
 * REWRITE. Five of the slots are a PLATFORM's own API: one key, one platform,
 * billed by that platform, and the slot is named after it. The sixth is a
 * VENDOR — ScrapeCreators — whose single key reads TikTok, Instagram and
 * Facebook together. Listing it as a sixth peer of the platforms would be the
 * page telling the same lie the type system used to: that a credential and a
 * platform are the same kind of thing. An operator who reads it that way pastes
 * the vendor key into the TikTok box and wonders why Instagram is still empty.
 *
 * So the groups carry a heading and a sentence each, and the vendor slot states
 * WHICH PLATFORMS ITS KEY BUYS — from `info.serves`, computed in
 * lib/credentials/types.ts, not typed into this component where it would drift
 * from the code that hands the client to the adapters.
 *
 * THE COST OF THE TEST BUTTON IS PRINTED IN EVERY SLOT, INCLUDING EMPTY ONES.
 * It used to appear only once a key had been saved, which put the sentence
 * "pressing this costs one credit" strictly after the decision it informs. That
 * is tolerable for a free token inspection and not for ScrapeCreators, where
 * every press of Test is a billable request against a balance the operator
 * bought outright. The plan reads the same whether or not a key is in the slot,
 * so there is no reason to withhold it until afterwards.
 *
 * "TEST THIS KEY" NOW FOLLOWS `check`, NOT `usedBy`. It used to be offered only
 * where something in this build already spent that provider's key, which meant
 * four of the five slots had no button at all. That is precisely backwards for
 * what Erik is doing right now: he is deciding whether to pay for these APIs, so
 * being able to prove a key is valid matters long before anything is ready to
 * spend it. The button appears wherever there is a documented call to make, and
 * the call, its source, its cost and what a pass proves are printed next to it
 * BEFORE it is pressed — an operator authorising a request against a metered API
 * is entitled to know which request.
 *
 * WHAT A KEY CANNOT BUY IS PRINTED TOO, and that is the other half of the same
 * honesty. Instagram media carries no duration field; hashtag search carries no
 * view count; Facebook's reference documents no read on a Page's videos. An
 * operator learning that here has been saved Business Verification plus App
 * Review — weeks — to discover it afterwards.
 *
 * PRESENTATION. The house look from `impressions` — `.panel`, `.field`, `.btn`,
 * `.state`. DESIGN.md's credentials section applies here more literally than
 * anywhere, because this is the box an operator pastes a key into that bills
 * their own account: secret inputs are forced to the mono face inline, and
 * nothing about the glassier surface softens the masking.
 *
 * WHY THE ACTIONS ARRIVE AS PROPS. They are handed down by page.tsx rather than
 * imported here, which is the convention the sibling shorts console already
 * documents and it is not stylistic. An import would put this file in the
 * `"use server"` module graph, and the whole graph — cookies, Supabase, the
 * credential store — would have to stand up before a jsdom test could render a
 * single input. The thing most worth testing on this screen is that the FORM
 * FOLLOWS THE PLATFORM: pick X and get one bearer-token box, pick Instagram and
 * get four boxes of two different kinds. That is a behaviour, and a screen that
 * cannot be rendered in a test is how the previous version of this repo shipped
 * its most important controls with no coverage at all.
 *
 * AN ABSENT TIME IS AN EM DASH THAT SAYS WHY. DESIGN.md: an unknown is `—` and
 * never a `0`. This repo goes one further and makes every dash explain itself in
 * a `title`, because a bare dash is a small lie about whether anybody knows. A
 * key that has never been used and a key that has never been tested are two
 * different unknowns and say so.
 */
export interface CredentialPanelProps {
  readonly providers: CredentialProviderInfo[];
  readonly credentials: MaskedCredential[];
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
  /** Saves a new credential. A server action, handed down by page.tsx. */
  readonly onSave: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  /** Makes the one documented call. A server action, handed down by page.tsx. */
  readonly onTest: (id: string) => Promise<ActionResult>;
  /** Deletes one credential. A server action, handed down by page.tsx. */
  readonly onDelete: (id: string) => Promise<ActionResult>;

  /**
   * The credit bar, rendered at the foot of ONE slot's card.
   *
   * Erik, 2026-09-05, with a screenshot and two arrows: *"move B to a single
   * bar with numbers at the bottom of the ScraperCreators key box (hide it if
   * there are no keys)"*. It used to be a panel of its own above the slots — a
   * card about a key, floating above the card for that key.
   *
   * `provider` IS A PROP RATHER THAN A HARDCODED "scrapecreators", and that is
   * not ceremony. lib/platform/registry.test.ts fails the build if a module
   * outside lib/platform branches on platform identity, and this file's own
   * rule is that a slot list which knows which slot is special stops being a
   * list. The page says which provider gets a bar; this component only knows
   * that one of them might.
   *
   * `check` is a server action and crosses the boundary exactly as `onSave`
   * already does.
   */
  readonly credits?: {
    readonly provider: string;
    readonly seedRequests: number;
    readonly check: () => Promise<CreditBalanceOutcome>;
  };
}

/**
 * THE TWO GROUPS, IN THE ORDER `CREDENTIAL_PROVIDERS` DECLARES THEM.
 *
 * A TABLE RATHER THAN TWO HAND-WRITTEN SECTIONS, so a third kind — if the
 * vocabulary ever grows one — appears on this page as an unheaded group nobody
 * wrote a sentence for, which is visible, rather than silently not appearing at
 * all. `groupsFor` below falls back to the raw kind for exactly that reason.
 */
const GROUPS: readonly { readonly kind: CredentialProviderKind; readonly heading: string; readonly blurb: string }[] = [
  {
    kind: "platform",
    heading: "Platform keys",
    blurb:
      "One key, one platform, issued and billed by that platform. Two of these are optional — YouTube " +
      "and TikTok are read without a key at all — and the rest are what that platform's own API needs.",
  },
  {
    kind: "vendor",
    heading: "Vendor keys",
    blurb:
      "One key that reads SEVERAL platforms through a third party. It is not a platform slot: the key " +
      "belongs to the vendor, the bill comes from the vendor, and each slot below names exactly which " +
      "platforms it buys. Paste it here rather than into the platform boxes — one key, one balance, " +
      "one place to rotate it.",
  },
];

function groupsFor(providers: readonly CredentialProviderInfo[]) {
  const known = GROUPS.map((group) => ({ ...group, members: providers.filter((p) => p.kind === group.kind) }));
  const claimed = new Set(GROUPS.map((g) => g.kind as string));
  const rest = providers.filter((p) => !claimed.has(p.kind));
  return [
    ...known,
    ...(rest.length === 0 ? [] : [{ kind: rest[0].kind, heading: "Other keys", blurb: "", members: rest }]),
  ].filter((group) => group.members.length > 0);
}

export function CredentialPanel({
  providers,
  credentials,
  canEdit,
  readOnlyReason,
  onSave,
  onTest,
  onDelete,
  credits,
}: CredentialPanelProps) {
  const [saveResult, save, saving] = useActionState<ActionResult | null, FormData>(onSave, null);
  const [rowResult, setRowResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const active = new Map(credentials.filter((c) => c.status === "active").map((c) => [c.provider, c]));

  /**
   * WHICH SLOT'S SAVE BUTTON IS MID-FLIGHT.
   *
   * `useActionState` gives ONE `saving` flag and there are now as many forms as
   * there are providers, so the flag alone would put "Saving…" on every button
   * on the page at once. This narrows the label to the form that was actually
   * submitted. The DISABLED state is deliberately left global: two saves racing
   * would be two writes to a table whose rule is one active key per slot.
   */
  const [submitting, setSubmitting] = useState<string | null>(null);

  return (
    <section className="mt-10 grid gap-5">
      {readOnlyReason ? (
        <p className="panel" style={{ color: "var(--muted)" }}>
          {readOnlyReason}
        </p>
      ) : null}

      {saveResult ? <Result result={saveResult} /> : null}
      {rowResult ? <Result result={rowResult} /> : null}

      {groupsFor(providers).map((group) => (
        <section key={group.kind} className="grid gap-3">
          <div>
            {/* A real heading, not a styled span: these are landmarks somebody
                lands on, and the difference between a platform key and a vendor
                key has to appear in a heading list. `--muted` rather than the
                sheet's `--faint`, per the contrast note on page.tsx. */}
            <h2 className="panel-title" style={{ color: "var(--muted)", margin: 0 }}>
              {group.heading}
            </h2>
          </div>

          <ul className="grid gap-3">
            {group.members.map((info) => {
          const c = active.get(info.id);
          return (
            <li key={info.id} className="panel">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="section-title">{info.label}</span>
                {c ? (
                  <code className="mono" style={{ color: "var(--muted)" }}>
                    {c.masked}
                  </code>
                ) : (
                  <span className="state state-idle" style={{ color: "var(--muted)" }}>
                    No key saved
                  </span>
                )}
              </div>

              {/* On the CARD as well as the form. The card list is what an
                  operator scans when deciding which key to go and get, so the
                  link belongs here more than it does on the form they only
                  open once they have already decided. */}
              <Where where={info.where} steps={info.steps} label={info.label} />

              <Serves serves={info.serves} />

              <Spend spend={info.usedBy} />

              {/*
                EVERY SLOT OWNS ITS OWN FIELDS, 2026-09-05.

                Erik, looking at the page: *"this is stupid, give each platform
                and vendor their own section"*. He is right, and the reason is
                not cosmetic. There used to be ONE form at the top with a
                `<select>` naming the provider, so entering keys for X and for
                ScrapeCreators meant: choose, fill, save, wait, choose again,
                fill, save. A picker in front of a form is a step that exists to
                tell the form something the section heading already knows.

                WHAT THE SELECT WAS ACTUALLY DOING, and where each part went:

                  - Naming the provider on submit -> a hidden input, below. The
                    value is `info.id`, the same id the section is keyed by, so
                    the form cannot disagree with the heading it sits under.
                  - Deciding which fields to render -> the section renders its
                    own `info.fields` and nothing else.
                  - Disabling a slot that already holds a key -> that slot now
                    renders its saved detail and a Delete button instead of a
                    form, which says the same thing by being true rather than by
                    being greyed out.

                A BUG THIS DELETES OUTRIGHT. The old form remounted its inputs
                on every change of provider, keyed `${info.id}:${f.id}`, because
                Instagram and Facebook both declare `app_secret` and React would
                otherwise carry a value typed for one into the other — sealed
                under the wrong provider, then failing every check for a reason
                invisible on screen. Separate forms cannot do that: the inputs
                are different elements in different <form>s and never share a
                slot in the tree.
              */}
              {c ? (
                <>
                  <dl className="kv" style={{ marginTop: "16px" }}>
                    <dt style={{ color: "var(--muted)" }}>Label</dt>
                    <dd>{c.label}</dd>

                    <dt style={{ color: "var(--muted)" }}>Added</dt>
                    <dd>{new Date(c.created_at).toLocaleDateString()}</dd>

                    <dt style={{ color: "var(--muted)" }}>Status</dt>
                    <dd>{c.status}</dd>

                    {/* The readable half of the credential, shown back on
                        purpose. An app id an operator cannot check is an app id
                        they can only fix by deleting the key and retyping it. */}
                    {info.fields
                      .filter((f) => f.kind === "identifier")
                      .map((f) => (
                        <IdentifierRow key={f.id} label={f.label} value={c.identifiers[f.id]} />
                      ))}

                    <dt style={{ color: "var(--muted)" }}>Last used</dt>
                    <dd>
                      {c.last_used_at ? (
                        new Date(c.last_used_at).toLocaleDateString()
                      ) : (
                        <span title="This key has not been used for a real API call yet, so there is no date to show.">
                          —
                        </span>
                      )}
                    </dd>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {c.last_check_at === null ? (
                      <>
                        <span className="state state-idle" style={{ color: "var(--muted)" }}>
                          Never tested
                        </span>
                        <span
                          className="mono"
                          style={{ color: "var(--muted)", fontSize: "12.5px" }}
                          title="This key has never been tested, so there is no result to time-stamp."
                        >
                          —
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={c.last_check_ok ? "state state-ok" : "state state-signal"}>
                          {c.last_check_ok ? "Passed" : "Failed"}
                        </span>
                        <span className="mono" style={{ color: "var(--muted)", fontSize: "12.5px" }}>
                          {new Date(c.last_check_at).toLocaleString()}
                        </span>
                      </>
                    )}
                  </div>

                  {c.last_check_at !== null && !c.last_check_ok && c.last_check_error ? (
                    <p className="mt-2" style={{ color: "var(--muted)", fontSize: "12.5px" }}>
                      {c.last_check_error}
                    </p>
                  ) : null}

                  {canEdit ? (
                    <>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {info.check === null ? (
                          <span style={{ color: "var(--muted)", fontSize: "12.5px" }}>
                            No test available.
                          </span>
                        ) : (
                          <span className="grid gap-1">
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                startTransition(async () => setRowResult(await onTest(c.id)))
                              }
                              className="btn btn-quiet btn-small justify-self-start"
                            >
                              Test this key
                            </button>
                            {/* THE PRICE STAYS, ON THE CONTROL THAT CHARGES IT.
                                Everything else on this slot went; this did not,
                                because one press of the vendor check is a
                                billable request and a button that spends a
                                credit without saying so is a trap rather than a
                                clean form. It is the cost only — what the call
                                is and what a pass proves live in
                                lib/credentials/providers.ts for whoever
                                maintains this, not on a data-entry screen. */}
                            <span style={{ color: "var(--muted)", fontSize: "11.5px" }}>
                              {info.check.cost}
                            </span>
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => setRowResult(await onDelete(c.id)))
                          }
                          className="btn btn-small btn-danger"
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  ) : null}
                </>
              ) : canEdit ? (
                <form
                  action={save}
                  onSubmit={() => setSubmitting(info.id)}
                  className="mt-4 grid gap-4"
                >
                  {/* The provider travels with the key, as it always did. It is
                      hidden rather than chosen because this form is already
                      inside that provider's section. */}
                  <input type="hidden" name="provider" value={info.id} />

                  <label className="field">
                    <span>Label</span>
                    <input name="label" required placeholder="e.g. main research key" />
                    <span className="hint">So anyone can tell which account this key belongs to.</span>
                  </label>

                  {info.fields.map((f) => (
                    <label className="field" key={f.id}>
                      <span>
                        {f.label}
                        {f.required ? "" : " (optional)"}
                      </span>
                      <input
                        name={`${FIELD_PREFIX}${f.id}`}
                        type={f.kind === "secret" ? "password" : "text"}
                        required={f.required}
                        autoComplete="off"
                        spellCheck={false}
                        style={{ fontFamily: "var(--font-mono)", fontSize: "13px" }}
                      />
                      <span className="hint">{f.hint}</span>
                    </label>
                  ))}

                  <button type="submit" className="btn justify-self-start" disabled={saving}>
                    {saving && submitting === info.id ? "Saving…" : "Save key"}
                  </button>
                </form>
              ) : null}

              {/* THE BAR, on the one slot it belongs to. `hasKey` is whether
                  this slot holds a credential: with none there is no account to
                  ask about, so it renders nothing rather than a line explaining
                  its own emptiness under an empty form. */}
              {credits && credits.provider === info.id ? (
                <CreditsBar
                  seedRequests={credits.seedRequests}
                  hasKey={c !== undefined}
                  canCheck={canEdit}
                  check={credits.check}
                />
              ) : null}
            </li>
          );
            })}
          </ul>
        </section>
      ))}

    </section>
  );
}

/**
 * WHAT THIS BUILD ACTUALLY DOES WITH THE KEY.
 *
 * SCAR, 2026-09-04 review. `usedBy` — the field lib/credentials/providers.ts
 * calls its own reason for existing — was rendered on NO SCREEN. So the page
 * invited an operator to paste a bearer token that bills their card by the
 * Post, and to start Meta Business Verification and App Review, with nothing
 * anywhere saying whether this build would spend the result or leave it idle.
 * The `limits` list told them what the PLATFORM cannot do; nothing told them
 * what THIS TOOL does. Those are different questions and an operator deciding
 * whether to spend two weeks needs both.
 *
 * It is printed in every slot including the empty ones, and above the Save
 * button on the form, because after the button it is a receipt rather than a
 * disclosure.
 *
 * THE LEAD IS A SENTENCE, NOT A COLOUR. `--ink` against `--muted` marks the
 * slots that spend money, and the words "Spent on a run" / "Not spent on a
 * run" carry the same fact on their own — DESIGN.md's rule that colour is never
 * the only carrier applies hardest here, where the difference is somebody's
 * card being charged.
 */
function Spend({ spend }: { spend: CredentialSpend }) {
  return (
    <p className="mt-3" style={{ color: "var(--muted)", fontSize: "12.5px", maxWidth: "74ch" }}>
      <strong style={{ color: spend.onARun ? "var(--ink)" : "var(--muted)" }}>
        {spend.onARun ? "Spent on a run." : "Not spent on a run."}
      </strong>
    </p>
  );
}

/**
 * WHICH PLATFORMS THIS ONE KEY BUYS.
 *
 * SILENT FOR A PLATFORM SLOT, and that is the whole rule rather than a
 * shortcut. A YouTube key serves YouTube; printing "Serves: YouTube" under the
 * YouTube heading is a line that answers a question nobody asked, and a page
 * full of those is a page people stop reading. The line exists for the case
 * where the answer is not obvious from the heading — a vendor key that reads
 * three platforms — which is exactly where an operator can otherwise be wrong
 * about what they just paid for.
 *
 * IT IS DRIVEN BY `info.serves`, computed by `platformsServedBy` in
 * lib/credentials/types.ts from the same table the registry reads when it
 * decides which adapters get the vendor's client. A list typed into this
 * component would be a second answer to "what does this key cover", and the one
 * on screen would be the one nobody could check.
 */
function Serves({ serves }: { serves: readonly Platform[] }) {
  if (serves.length < 2) return null;
  return (
    <p className="mt-3" style={{ color: "var(--muted)", fontSize: "12.5px", maxWidth: "74ch" }}>
      <strong style={{ color: "var(--ink)" }}>
        One key, {serves.length} platforms: {serves.map((p) => platformLabel(p)).join(", ")}.
      </strong>
    </p>
  );
}

/**
 * The links that turn "paste your key" into something an operator can act on:
 * where to obtain it, and where its shape is documented.
 *
 * ONE LINK IS NOT ALWAYS ENOUGH, 2026-09-05. Erik: *"I just want a link someone
 * with an account can hit so that we can buy the needed API key and then a
 * second link to actually reach the API key"*, then *"I need those links
 * displayed as steps on the X platform keys box"*. So a provider that declares
 * `steps` renders them, numbered and in order, INSTEAD of the single "Get a …
 * key" link — not alongside it. Two links to the same console with different
 * wording is the page asking the operator to work out which one it meant.
 *
 * The documentation link renders either way: it answers a different question
 * ("what shape is this key") and it is never the errand.
 *
 * SHORT, BECAUSE OF WHAT CAME OFF THIS PAGE. The `limits` prose was removed on
 * the ruling that this is a page for entering credentials, not for reading about
 * APIs (tests/credential-panel.test.tsx asserts it stays off). A step is a link
 * and one clause. Anything longer belongs in lib/credentials/providers.ts, where
 * each step carries the document it was read from and the date.
 *
 * Every anchor opens in a new tab with rel="noreferrer noopener" — these are
 * outbound links to third-party consoles and the admin session is on the other
 * side of them. They are real anchors rather than printed URLs so the address
 * bar shows the destination before it is clicked.
 */
function Where({
  where,
  steps,
  label,
}: {
  where: { signup: string; docs: string };
  steps?: readonly CredentialStep[];
  label: string;
}) {
  const docs = (
    <a
      href={where.docs}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: "var(--accent)", textDecoration: "underline" }}
    >
      API documentation
    </a>
  );

  if (steps && steps.length > 0) {
    return (
      <div className="mt-3">
        {/* An <ol>, not a styled <div> stack: these are ordered and the order is
            the information. X refuses a token with no credit behind it, so
            "buy" before "copy" is a fact about the API and not a layout. */}
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.href}>
              <a
                href={step.href}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                {step.label}
              </a>{" "}
              <span style={{ color: "var(--muted)" }}>{step.detail}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3" style={{ fontSize: "12.5px", maxWidth: "74ch" }}>
          {docs}
        </p>
      </div>
    );
  }

  return (
    <p className="mt-3" style={{ fontSize: "12.5px", maxWidth: "74ch" }}>
      <a
        href={where.signup}
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: "var(--accent)", textDecoration: "underline" }}
      >
        Get a {label} key
      </a>
      <span style={{ color: "var(--faint)" }}> · </span>
      {docs}
    </p>
  );
}

/**
 * One readable identifier.
 *
 * A required identifier that is absent gets an em dash that says so, rather than
 * an empty cell. On this page an empty cell would read as "nothing to say"; the
 * truth is "this credential is missing something it needs", which is exactly the
 * distinction the rest of the tool refuses to collapse.
 */
function IdentifierRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <dt style={{ color: "var(--muted)" }}>{label}</dt>
      <dd className="mono">
        {value ? (
          value
        ) : (
          <span title="This credential was saved without this value, so calls that need it will fail.">
            —
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * The outcome of a save, a test or a delete.
 *
 * `role="status"` because this appears after the fact, above a list the
 * operator is already looking at, and a result nobody is told about is the same
 * as no result. Green and red are the house `--tier-high` and `--signal`, and
 * the message itself says which it is — the colour is never the only carrier.
 */
function Result({ result }: { result: ActionResult }) {
  return (
    <p className={result.ok ? "field-ok" : "field-error"} role="status">
      {result.message}
    </p>
  );
}
