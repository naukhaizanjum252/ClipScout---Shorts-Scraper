import { minViews, shortMaxSeconds } from "@/lib/config";
import { activeTopics, resolveTopicStore, TopicsNotInstalledError } from "@/lib/shorts/topic-store";
import { topicRef } from "@/lib/shorts/topics";

import { downloadUsdMicros } from "@/lib/config";
import { estimateLatestShortsSpend, getLatestShorts, resolveDownloadUrl } from "./actions";
import { lastRun } from "./last-run";
import { ShortsConsole } from "./shorts-console";
import {
  formatDownloadCost,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_ROWS_PER_PLATFORM,
  type TopicChoices,
} from "./view";

/**
 * /admin/shorts — THE SCREEN. As far as the client is concerned this page is
 * the product.
 *
 * Erik, 2026-09-02: *"I want to get 'get latest shorts' you scrape ALL
 * platforms, come back with shorts over 500k views categorized by platform, AXE
 * the rest."* One action, one list. The channel inventory and its review queue
 * that used to live at /admin/channels were a misread of that brief and have
 * been deleted rather than deprecated.
 *
 * WHY THIS FILE IS THIN, AND WHAT THAT BUYS
 *
 * It does three things: refuse an anonymous visitor, read the two configured
 * numbers, and hand the client component three server actions as props. Nothing
 * is fetched here. That is deliberate — a run costs somebody's API quota and
 * real money on X, which bills per post returned, and doing it on page load
 * means every refresh, every back button and every Next prefetch spends that.
 * "Get latest shorts" is a button because it is an expensive verb, not because
 * a button looked nicer. The estimate beside it is a second button for the same
 * reason in reverse: it is cheap, so it is offered, and it is still not
 * automatic, because an operator who already knows what a run costs should not
 * have to pay a round trip to be told again.
 *
 * It also means the actions arrive at the browser through props rather than
 * through an import in the client component, which keeps shorts-console.tsx out
 * of the "use server" module graph and therefore renderable in a jsdom test with
 * no cookies, no Supabase and no platform registry. The last version of this
 * repo shipped its two most important buttons with no test at all precisely
 * because they could not be rendered without all of that.
 *
 * THERE IS NO SIGN-IN CHECK HERE ANY MORE, AND ITS REMOVAL IS NOT A WEAKENING.
 * This page used to open with `if (isSupabaseConfigured && !viewer) redirect(...)`,
 * described in this comment as "the courtesy, not the guard" — the guard being
 * proxy.ts and the server actions. Both halves of that sentence are now false in
 * different ways, which is why the line is gone rather than adjusted:
 *
 *   - The proxy no longer gates anything (Erik's call, 2026-09-04, see proxy.ts).
 *   - `getViewer()` cannot return null. It returns a frozen OPEN_ACCESS viewer,
 *     so `!viewer` was already unreachable — a redirect to a page that had
 *     itself been deleted, behind a condition that could never be true. Dead
 *     code that LOOKS like an access check is worse than no access check,
 *     because the next reader counts it as one.
 *
 * What genuinely still refuses is unchanged: an action is a public endpoint
 * whether or not the page that mentions it rendered, so ./actions.ts does its
 * own checking and does not trust this file.
 *
 * The two numbers come from lib/config.ts rather than being typed in, so this
 * page cannot drift from the thresholds the run actually applies. `minViews` is
 * the starting value of a control the operator may move; `maxDurationSeconds`
 * is BOTH the starting value of the "maximum length" control AND the highest
 * number that control accepts. Erik asked for a minimum and a maximum length on
 * 2026-09-05, and those two jobs are how the screen gives him one without
 * letting a box on a page redefine what a Short is: the window may be narrowed
 * to any part of 0-120s and may not be widened past the ceiling, because above
 * that line the video is not a Short and this tool is not asking about it.
 *
 * THE THIRD NUMBER IS NOT FROM lib/config.ts, and the difference is the point.
 * `DEFAULT_ROWS_PER_PLATFORM` is where the "most videos per platform" control
 * starts, and it is a cost ceiling nobody has stated rather than a figure with
 * a person and a date behind it — ./view.ts says so at the constant. Putting it
 * beside `MIN_VIEWS` would give it a provenance it does not have.
 *
 * WHICH PLATFORMS TO READ IS NOT A PROP AT ALL on a cold screen. It starts as
 * all five inside the console, because that is the brief this screen was built
 * from; the checkboxes are there to narrow a run, not to assemble one. A
 * RESTORED run overrides that from its own outcomes — see `restored` below.
 *
 * TWO THINGS ARE NOW FETCHED HERE AND NEITHER IS A RUN. `lastRun()` reads the
 * most recent stored report so the console can put back the screen an operator
 * already paid for (Erik, 2026-09-05: *"The run should not disappear after a
 * while."*). That does not contradict the paragraph above, which is about an
 * EXPENSIVE VERB: a run spends API quota and, on X, real money per Post
 * returned, so it stays behind a button. This is one indexed row of stored JSON
 * and it spends nobody's anything.
 *
 * IT IS SHARED RATHER THAN PER-BROWSER, which was Erik's call on the same day
 * and is the reason it is read here instead of out of `localStorage` in the
 * console. The second person to open this page today sees what the first person
 * paid for. The price is that an operator can be looking at a list they did not
 * fetch, so the console is REQUIRED to say when it was made before it says
 * anything about the internet — and `lastRun()` returns null for every failure
 * as well as for an empty table, because a page seeding itself does the same
 * thing in all of those cases and none of them is a claim about any platform.
 *
 * The second is `selectableTopics()`, the menu behind "Look for", and its own
 * comment at the foot of this file makes the same argument: one read of the
 * topics table, no platform asked, nothing spent.
 */
export const dynamic = "force-dynamic";

export default async function ShortsPage() {
  const [restored, topics] = await Promise.all([lastRun(), selectableTopics()]);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-14">
      <div className="page-head">
        {/* An inline size because Tailwind's preflight resets heading sizes to
            `inherit`; the house sheet styles `.page-head h1` and this is the
            same value it gives it. The sibling credentials page does the same. */}
        <h1 style={{ fontSize: "30px" }}>Latest shorts</h1>

        <p>
          Pick a topic and the platforms to read, then fetch the shorts that clear your view
          threshold — newest run first, grouped by platform.
        </p>
      </div>

      <ShortsConsole
        defaultMinViews={minViews()}
        defaultLimit={DEFAULT_ROWS_PER_PLATFORM}
        defaultMinDuration={DEFAULT_MIN_DURATION_SECONDS}
        maxDurationSeconds={shortMaxSeconds()}
        topics={topics}
        restored={restored}
        run={getLatestShorts}
        resolveDownload={resolveDownloadUrl}
        // PRICED ON THE SERVER. The rate lives in the environment and the console
        // is a client component, so a figure computed there would read as free.
        costPerDownload={formatDownloadCost(1, downloadUsdMicros(1))}
        estimate={estimateLatestShortsSpend}
      />
    </main>
  );
}

/**
 * THE SUBJECTS THIS SCREEN MAY BE POINTED AT.
 *
 * A SECOND THING FETCHED ON LOAD, AND IT DOES NOT CONTRADICT THE HEADER. The
 * argument above is about an EXPENSIVE VERB — a run spends API quota and, on X,
 * real money per Post — and this is one indexed read of the topics table, the
 * same read /admin/topics makes on every visit. It spends nobody's anything and
 * nothing is asked of any platform.
 *
 * IT IS ACTIVE TOPICS ONLY, because the menu is a list of things a run can be
 * aimed at and a switched-off subject is not one. `activeTopics` also drops any
 * row with no usable search terms, which is the same filter the run applies —
 * offering a subject that would be dropped before the first request is offering
 * a choice that does nothing.
 *
 * WHY THE THREE EMPTY CASES GET THREE DIFFERENT SENTENCES. An empty menu is the
 * one thing on this screen that could be read as "this deployment has nothing
 * to look for", and only one of the three ways of arriving at it means that.
 * See `TopicChoices` in ./view.ts. The third — the read genuinely failed — is
 * the one that matters most, because the run is about to refuse for the same
 * reason, and a silent empty menu would send an operator to press a button that
 * cannot work.
 */
async function selectableTopics(): Promise<TopicChoices> {
  try {
    const { store, origin } = await resolveTopicStore();
    const list = activeTopics(await store.listTopics()).map(topicRef);
    if (list.length > 0) return { list, note: null };
    return {
      list,
      note:
        origin === "plan"
          ? "No database is configured, so there is no editable topic list and nothing to narrow " +
            "a run to."
          : "No subject is switched on, so a run reads whatever is biggest on each platform " +
            "rather than a kind of clip. Switch one on under “What to look for”.",
    };
  } catch (cause) {
    if (cause instanceof TopicsNotInstalledError) {
      console.warn(`[admin/shorts] ${cause.message}`);
      return {
        list: [],
        note:
          "This deployment has no topic list yet, so a run reads whatever is biggest on each " +
          "platform. That is the tool as it was before subjects existed, not a fault.",
      };
    }
    // NOT AN EMPTY LIST WITH NOTHING SAID. The run reads the same table and
    // refuses when it cannot, so a silent menu here would be a screen inviting
    // a press that is already known to fail.
    console.error("[admin/shorts] the topic list could not be read:", cause);
    return {
      list: [],
      note:
        "The list of subjects could not be read, so there is nothing to choose from and a run " +
        "will refuse rather than read whatever is biggest. The reason is in the server log, " +
        "tagged [admin/shorts].",
    };
  }
}
