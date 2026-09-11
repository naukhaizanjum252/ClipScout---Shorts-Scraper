import { getViewer, isAdmin } from "@/lib/auth/role";
import { resolveCredentialStore, type StoreOrigin } from "@/lib/credentials/resolve";
import {
  primaryCredentialProviders,
  secondaryCredentialProviders,
} from "@/lib/credentials/providers";
import { platformsServedBy, type MaskedCredential } from "@/lib/credentials/types";
import { activeSeedsByPlatform, resolveSeedStore } from "@/lib/shorts/seeds";

import {
  checkScrapeCreatorsCreditsAction,
  deleteCredentialAction,
  saveCredentialAction,
  testCredentialAction,
} from "./actions";
import { CredentialPanel } from "./credential-panel";

/**
 * The credential settings page. Deliberately minimal, because there is not much
 * an operator can honestly be shown about a key they are never allowed to see
 * again — a label, a mask, a date, and whether the last test passed.
 *
 * ONE SLOT PER PLATFORM, 2026-09-04. Erik's pivot made this tool read five
 * platforms rather than one, and he kept this system explicitly: it is how a
 * provider key gets entered. So the page is a list of the five platform slots,
 * each either holding a key or visibly empty, rather than a single YouTube box.
 * The empty slots are not clutter — they are where the tool says out loud what
 * each platform's official API can and cannot do.
 *
 * AND ONE SLOT THAT IS NOT A PLATFORM. ScrapeCreators, chosen 2026-09-04, is a
 * VENDOR: one key that reads TikTok, Instagram and Facebook. Until the
 * credential vocabulary learned the difference, this page could not offer that
 * slot at all — `CREDENTIAL_PROVIDERS` was aliased to the platform list — and
 * the consequence was a complete, tested vendor client in
 * lib/platform/scrapecreators.ts with no production call site, because the
 * registry had no credential to lease. The slot exists now and the panel groups
 * it apart from the five, because "which platforms does this one key buy" is a
 * question a platform slot never raises and a vendor slot always does.
 *
 * WHAT THE SECOND 2026-09-04 PASS ADDED, AND WHY IT IS THE POINT OF THE SCREEN.
 * Erik asked for X to be built properly because he is paying for it, and for
 * Instagram and Facebook to be scaffolded so a key can be entered and TESTED —
 * he wants to find out whether they work before paying anyone. So each slot now
 * carries the credential's real SHAPE (Meta needs four values, not one), a Test
 * button wired to one cheap documented call, and the verified limits that decide
 * whether the platform can serve this product at all. Two of those limits are
 * the answer to his question and the answer is no: Instagram media carries no
 * duration field, so the Shorts ceiling cannot be evaluated from it, and
 * Facebook's Graph reference documents no read on a Page's videos. Finding that
 * out here costs a minute. Finding it out after Business Verification and App
 * Review costs weeks.
 *
 * SCAR (second Phase 3 review): this header used to justify the minimalism with
 * "the review surface is Phase 3 and is out of scope", long after Phase 3 was
 * built. A stale scope note is not harmless on a settings page: the next person
 * reading it concludes something does not exist yet and starts building a
 * second one. That is why the paragraph above carries a date.
 *
 * WHAT IT SHOWS: a label, a mask, when the key was added and by whom, whether
 * the last test passed. WHAT IT CANNOT SHOW: the key. Not to a member, not to an
 * admin, not to the person who pasted it in. `MaskedCredential` has no field for
 * it, the column-level grant in the credentials migration stops `authenticated`
 * selecting the ciphertext, and only a `service_role` call to
 * `lease_api_credential()` yields plaintext — inside a server process about to
 * make an API call.
 */
export const dynamic = "force-dynamic";

/**
 * Which failure this is, in terms somebody can act on — and, more to the point,
 * what does NOT reach the page.
 *
 * REVIEW FINDING (major), and the SECOND time this exact defect has been
 * written. It was found on a sibling screen last round and fixed there; this one
 * kept the original shape, which was to put `cause.message` into the store box
 * as the explanation. `SupabaseCredentialBackend.list()` builds that message as
 * `Could not read credentials: ${error.message}`, so PostgREST's own sentence —
 * which quotes schema, table and column names — was being rendered into the HTML
 * of a screen whose entire subject is API keys, on a deployment roughly forty
 * people at LookUp Media sign in to and screenshot. The text now goes to the
 * server log under a bracketed tag an operator can grep for, and the page shows
 * one of the two classifications below.
 *
 * THE PGRST CODE IS KEPT ON PURPOSE. It is the one part of a PostgREST failure
 * that is actionable and carries nothing about our schema: `PGRST106` is a
 * documented code somebody can look up, and telling an operator "the log has it"
 * when five characters would have saved them the trip is false economy. Note
 * that only the MESSAGE is available to classify — the backend wraps
 * `error.message` and drops `error.code` on this path — so the code is recovered
 * from the text when PostgREST put it there, and is simply absent when it did
 * not.
 *
 * The exposed-schemas case is called out by name because it is the near-certain
 * first failure against a real project, and its fix is a dashboard step rather
 * than a code change.
 */
type CredentialFailure = {
  readonly kind: "schema-not-exposed" | "unclassified";
  readonly code: string | null;
};

const SCHEMA_NOT_EXPOSED = /PGRST106|schema must be one of the following/i;
const PGRST_CODE = /PGRST\d{3}/i;

function classifyFailure(message: string): CredentialFailure {
  return {
    kind: SCHEMA_NOT_EXPOSED.test(message) ? "schema-not-exposed" : "unclassified",
    code: message.match(PGRST_CODE)?.[0].toUpperCase() ?? null,
  };
}

export default async function CredentialsPage() {
  // NO SIGN-IN CHECK. This line used to be followed by a redirect to
  // /admin/login behind `isSupabaseConfigured && !viewer`. The login page is
  // deleted and `getViewer()` cannot return null, so that condition was
  // unreachable and the redirect pointed at a 404. `isAdmin(viewer)` below is
  // kept and still gates editing — see lib/auth/role.ts for what it means now.
  const viewer = await getViewer();

  let credentials: MaskedCredential[] = [];
  let explanation = "";
  let origin: StoreOrigin = "none";
  let readable = false;
  let failure: CredentialFailure | null = null;

  try {
    const resolved = await resolveCredentialStore();
    explanation = resolved.explanation;
    origin = resolved.origin;
    if (resolved.store && (isAdmin(viewer) || origin === "environment")) {
      // Every provider, not one. `list()` with no argument is the whole point of
      // the pivot: five slots, and the page has to be able to show a slot that
      // is empty as distinct from a slot it could not read.
      credentials = await resolved.store.list();
      readable = true;
    }
  } catch (cause) {
    // The viewer gets a classification; the database's own words go here, which
    // is the deployment's server log. Somewhere is not optional — an operator
    // debugging an unexposed schema needs the sentence PostgREST actually sent
    // — but "somewhere" is not the same as "on a page about API keys".
    console.error("[admin/credentials] the credential store could not be read:", cause);
    failure = classifyFailure(cause instanceof Error ? cause.message : String(cause));
    origin = "none";
    explanation = "";
  }

  /**
   * PRESENTATION, 2026-09-04. Erik: *"same style as all of the other luka
   * tools"*. Ported from `impressions` — `.page-head`, `.panel`, `.alert-banner`
   * and the rest are that sheet's vocabulary, so an operator moving between the
   * two tools does not hit a seam. Nothing here is restyled for the pivot; what
   * changed is the words.
   *
   * THE RED STAYS RED, AND STAYS RARE. DESIGN.md gives `--signal` to the one
   * case where somebody has to go and do something outside the app. That is
   * exactly the failure box: the fix for an unexposed schema is a click in the
   * Supabase dashboard, not a retry here. The healthy store box next to it is a
   * plain `.panel`, so the two states cannot be confused at a glance.
   *
   * WHY SOME LABELS OVERRIDE `--faint` TO `--muted`. `--faint` measures about
   * 4.0:1 against the panel ground, which is under AA for the 11px uppercase
   * labels the house uses it on. DESIGN.md's own rule is that a glassy panel
   * failing contrast is worse than the flat one it replaced, so anything an
   * operator has to read gets `--muted` (about 8:1). Headings carry an inline
   * `fontSize` because Tailwind's preflight resets heading sizes to `inherit`.
   */
  /**
   * WHAT ONE RUN WILL ASK THIS VENDOR FOR, COUNTED RATHER THAN GUESSED.
   *
   * ScrapeCreators bills per REQUEST, and a run issues one per active seed on
   * each platform this key serves — so the seed table IS the prediction, and it
   * is read here from the same store the run path reads. A number typed into
   * this file would be a second answer to a question the database already
   * answers, and the one on screen would be the one nobody could check.
   *
   * THE SEED LIST IS NO LONGER SOMETHING A PERSON MAINTAINS (2026-09-05): it
   * is the rolling seven-day top 200 creators per platform, recomputed from
   * what runs observed. So this forecast tracks whatever the last refresh
   * produced, which is the same list the next run will read.
   *
   * A FAILURE TO READ THE SEEDS IS NOT ZERO SEEDS. Zero renders as "a run would
   * spend no credits", which is a claim, and a false one on a deployment whose
   * seed store is simply unreachable. So the count is null on failure and the
   * panel is not rendered at all rather than rendered with a lie in it.
   */
  let seedRequests: number | null = null;
  try {
    const resolved = await resolveSeedStore();
    const byPlatform = activeSeedsByPlatform(await resolved.store.listSeeds());
    seedRequests = platformsServedBy("scrapecreators").reduce(
      (total, platform) => total + (byPlatform[platform]?.length ?? 0),
      0,
    );
  } catch (cause) {
    console.error("[admin/credentials] the seed count for the credit forecast could not be read:", cause);
  }

  const vendorKeySaved = credentials.some(
    (c) => c.provider === "scrapecreators" && c.status === "active",
  );

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-14">
      <div className="page-head">
        <h1 style={{ fontSize: "30px" }}>API credentials</h1>

        {/* THE ONLY SENTENCE ON THIS PAGE THAT THE SLOTS DO NOT PRINT
            THEMSELVES, which is why it is the only one left. It used to run
            four lines and say the same thing four ways: your account, your
            key, your quota, your billing, your terms-of-service exposure,
            nothing shared with another operator, no key of ours underwriting
            your traffic. Every clause of that reduces to whose bill it is. */}
        <p>
          Every key is yours — your account, your quota, your bill.
        </p>
      </div>

      {failure !== null ? (
        <section className="alert-banner">
          {/* The heading is a real <h2> wrapping the <strong> the house sheet
              styles, rather than a <strong> pretending to be a heading: the
              failure box is a landmark somebody lands on, and it has to appear
              in a heading list. */}
          <h2>
            <strong>The credential store could not be read</strong>
          </h2>
          <p className="mt-2">
            A database is configured and it refused this read. Nothing is listed below, and that is
            not the same as no key being saved — this page cannot tell you either way right now.
          </p>
          {failure.kind === "schema-not-exposed" ? (
            <p className="mt-3">
              The database named the cause: this app&apos;s schema is not being served. In the
              Supabase dashboard, Settings, API, Exposed schemas, <em>add</em>{" "}
              <code className="mono">shorts_scraper</code> to the list that is already there.
              Replacing the list takes the other tools in that database down with it.
            </p>
          ) : (
            <>
              <p className="mt-3">
                The database&apos;s own words are in this deployment&apos;s server log, tagged{" "}
                <code className="mono">[admin/credentials]</code>, rather than on this page: they
                quote schema, table and column names, and this screen is about keys.
              </p>
              <p className="mt-3" style={{ color: "var(--muted)" }}>
                On a database this app has not read from before, check the schema first. PostgREST
                serves only the schemas listed under Settings, API, Exposed schemas, and until{" "}
                <code className="mono">shorts_scraper</code> is <em>added</em> to that list every
                query from here fails with <code className="mono">PGRST106</code>.
              </p>
            </>
          )}
          {failure.code === null ? null : (
            <p className="mt-3" style={{ color: "var(--muted)" }}>
              PostgREST returned <code className="mono">{failure.code}</code>. The code is kept
              because it is the part of the failure you can look up; the sentence around it is not.
            </p>
          )}
        </section>
      ) : null}
      {/*
        THE STORE PANEL IS GONE. Erik, 2026-09-05, arrow drawn straight at it.

        It printed one word — "database" — and a sentence saying operator keys
        are stored in this project's database, encrypted at rest. Neither is
        news to somebody looking at a page of key slots, and neither is
        actionable: there is no control anywhere that changes where keys are
        stored, so the box reported a fact nobody could act on, in the most
        prominent position on the screen.

        WHAT IT WAS ACTUALLY FOR SURVIVES, and this is why the branch above it
        is untouched. Its real job was the FAILURE case: when the store cannot
        be read, the operator has to be told, and told specifically enough to
        fix it — that block still renders, still names PGRST106 and still
        explains the exposed-schemas step. What went is the half that fired when
        everything was fine.

        `origin` IS STILL READ. It gates `canEdit` below, because keys coming
        from the environment cannot be edited from a page. It just no longer has
        a box of its own announcing itself.
      */}

      {/*
        FOUR PARAGRAPHS STOOD HERE AND ALL FOUR ARE GONE. Erik, 2026-09-05,
        looking at the page: *"Can we reduce text by like 95% on this page"*.
        He is right, and the reason is sharper than length: every one of them
        was a SECOND COPY of something a slot below already prints, and three
        of the four ended by telling you to go and read that copy instead.
        A page that says "read the cost line in the slot, not this sentence"
        has already conceded which sentence is load-bearing.

        WHERE EACH ONE WENT, so this is checkable rather than asserted:

          - "A key is not what makes a platform readable... YouTube and TikTok
            are read without a key at all" -> the `platform` group blurb in
            credential-panel.tsx says exactly that, in the same words, above
            the slots it describes. The per-platform limits it summarised are
            printed IN each slot, from lib/credentials/providers.ts.
          - "The slots come in two groups..." -> both group headings and both
            blurbs. The paragraph described a grouping the reader can see.
          - "'Test this key' is not free everywhere..." -> every slot prints
            `check.cost` before the button, which is where the price has to be
            to inform the press. That placement was itself a scar fix.
          - "Every slot below also states, in one line, whether this build
            spends that key..." -> the `Spent on a run.` / `Not spent on a
            run.` line in every slot, which tests/credential-honesty.tsx
            asserts is rendered AND checks against the run path's own source.

        THE SCARS THOSE PARAGRAPHS CARRIED ARE NOT DISCARDED WITH THEM, because
        the defects were never about the prose:

          - A paragraph here once sold a key on a false promise: it claimed a
            key bought subscriber counts, which the keyless walk already
            returns and a key does not reliably supply. THE RULE THAT REPLACED
            IT STILL HOLDS — what a key buys is stated per provider, next to
            the field saying whether this build spends it, and every sentence
            there is checkable. Deleting a general paragraph cannot reintroduce
            that defect; writing a new one could.
          - Nothing said what pressing Test cost until a vendor arrived that
            bills a credit per press, and the cost line rendered only AFTER a
            key was saved — strictly after the decision it informs. The fix was
            moving it into every slot and onto the save form. It is still there.
          - Nothing said what THIS BUILD does with a key you are about to paste.
            Two of these cost real money or weeks of Meta review. That line is
            in every slot and is the one thing on this page a test proves.

        WHAT IS DELIBERATELY NOT DONE: none of this moved into a tooltip, a
        popover or a "learn more". Text an operator has to uncover before
        spending money is worse than text they scrolled past.
      */}
      {/*
        SCAR, 2026-09-04. THIS USED TO RENDER NOTHING WHEN THERE WAS NO STORE.
        `origin === "none" ? null : ...` hid the entire panel on a deployment
        with no database — which is every deployment before somebody wires one,
        and precisely the moment an operator is trying to find out WHERE TO GET
        THE KEYS. Erik asked for the vendor's link to be on this page so it
        could be opened directly; it was added, and it was invisible, because
        the thing carrying it only rendered once a database existed. That is
        backwards: obtaining a key is a PREREQUISITE for the database being
        useful, not a consequence of it.
        The panel now always renders. Without a store it cannot save, so it says
        so and the controls are read-only — but every slot still prints where to
        get that key, what it buys, what it cannot do, and whether this build
        spends it. All of that is true with or without a database.
      */}
      {/*
        TWO SLOTS FIRST, THE OTHER FOUR FOLDED AWAY.

        Erik, 2026-09-04: "it should have 2 simple layers, X signin,
        scraperCreator key. That should handle everything else."

        He is right about the coverage: X's own API plus one ScrapeCreators key
        reaches all five platforms, because YouTube needs no key at all. Six
        equally-weighted boxes made an operator's first question "which of
        these do I actually need?", and the honest answer was "two of them".

        The other four are FOLDED, NOT DELETED. A deployment that already holds
        a YouTube Data API key should be able to paste it, and a slot that
        exists in the database enum but nowhere on the page is a key nobody can
        manage. The disclosure below says plainly why they are optional.
      */}
      {/* THE CREDIT BAR IS NO LONGER A PANEL UP HERE. It is one line at the
          foot of the ScrapeCreators slot — Erik, 2026-09-05: "move B to a
          single bar with numbers at the bottom of the ScraperCreators key box
          (hide it if there are no keys)". A card about a key does not belong
          floating above the card for that key.

          `credits` is omitted entirely when the seed count could not be read,
          rather than passed as zero: zero renders as "no seeds, so a run spends
          nothing", which is a claim, and a false one on a deployment whose seed
          store is merely unreachable. */}
      <CredentialPanel
        credits={
          seedRequests === null
            ? undefined
            : {
                provider: "scrapecreators",
                seedRequests,
                check: checkScrapeCreatorsCreditsAction,
              }
        }
        providers={[...primaryCredentialProviders()]}
        credentials={credentials}
        canEdit={isAdmin(viewer) && origin === "database"}
        onSave={saveCredentialAction}
        onTest={testCredentialAction}
        onDelete={deleteCredentialAction}
        readOnlyReason={
          origin === "none"
            ? "No database is configured, so a key cannot be stored yet."
            : origin === "environment"
              ? "Keys come from the environment on this deployment and cannot be edited here."
              : readable
                ? null
                : "You need an admin role to manage credentials."
        }
      />

      <details className="mt-10">
        <summary style={{ cursor: "pointer", color: "var(--muted)" }}>
          Other keys, none of which this deployment needs
        </summary>

        {/* TWO PARAGRAPHS STOOD HERE. They explained that YouTube is read by
            yt-dlp with no key, that Instagram, Facebook and TikTok are covered
            by the ScrapeCreators key above, and that Meta's own APIs cost weeks
            of App Review this build has not been through. All of it is true and
            none of it belongs on a form. The summary line already says these
            are optional, and each slot below prints where its key comes from
            and whether a run spends it. The reasoning is in
            lib/credentials/providers.ts, next to the data it describes. */}
        <p className="mt-3" style={{ color: "var(--muted)", maxWidth: "74ch" }}>
          Optional. Paste one only if you already hold it.
        </p>

        <div className="mt-4">
          <CredentialPanel
            providers={[...secondaryCredentialProviders()]}
            credentials={credentials}
            canEdit={isAdmin(viewer) && origin === "database"}
            onSave={saveCredentialAction}
            onTest={testCredentialAction}
            onDelete={deleteCredentialAction}
            readOnlyReason={
              origin === "none"
                ? "No database is configured, so a key cannot be stored yet."
                : origin === "environment"
                  ? "Keys come from the environment on this deployment and cannot be edited here."
                  : readable
                    ? null
                    : "You need an admin role to manage credentials."
            }
          />
        </div>
      </details>
    </main>
  );
}
