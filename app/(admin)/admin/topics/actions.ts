"use server";

/**
 * The four endpoints behind /admin/topics: add, edit terms, switch on or off,
 * and put the plan's list back.
 *
 * WHAT THIS FILE MAY EXPORT. Async server actions and nothing else — Next
 * publishes every export of a `"use server"` module as a callable endpoint, so
 * an exported helper here is a route nobody decided to open. The shapes live in
 * ./view.ts, which has no directive and therefore cannot become one.
 *
 * EVERY ACTION RE-CHECKS THE ROLE. The page hiding a button is a courtesy; an
 * action id out of the client bundle is a public endpoint whether or not the
 * page that mentions it ever rendered.
 *
 * NOTHING HERE SPENDS ANYTHING, which is the difference between this file and
 * ./../shorts/actions.ts and the reason it has no metered slot, no forecast and
 * no spend authorisation. Editing what to look for is free; looking is not.
 */
import { revalidatePath } from "next/cache";

import { getViewer, isAdmin } from "@/lib/auth/role";
import { resolveTopicStore, TopicStoreError, type TopicStore } from "@/lib/shorts/topic-store";
import { cleanTerms } from "@/lib/shorts/topics";

import { FIELD, textToTerms, type TopicActionResult } from "./view";

const TOPICS_PATH = "/admin/topics";
const LOG_TAG = "[admin/topics]";

/**
 * Add a subject to search for.
 *
 * THE TERMS ARRIVE AS TEXT AND ARE SPLIT HERE, not in the browser. The browser
 * is not what posts to this endpoint; the action id is, and it can carry
 * anything. `topicProblems` inside the store is the validation that matters and
 * this is only the shape it expects.
 */
export async function addTopic(form: FormData): Promise<TopicActionResult> {
  return await write(async (store) => {
    const name = String(form.get(FIELD.name) ?? "");
    const terms = textToTerms(String(form.get(FIELD.terms) ?? ""));
    const topic = await store.addTopic({ name, terms, source: "manual" });
    return (
      `Added ${topic.name}, searching for ${topic.terms.length} ` +
      `phrase${topic.terms.length === 1 ? "" : "s"}. It will be included in the next run.`
    );
  });
}

/** Change what a topic searches for. The name is not editable — see the store. */
export async function setTopicTerms(form: FormData): Promise<TopicActionResult> {
  return await write(async (store) => {
    const slug = String(form.get(FIELD.slug) ?? "");
    const terms = cleanTerms(textToTerms(String(form.get(FIELD.terms) ?? "")));
    const topic = await store.setTopicTerms(slug, terms);
    return (
      `${topic.name} now searches for ${topic.terms.length} ` +
      `phrase${topic.terms.length === 1 ? "" : "s"}: ${topic.terms.join(", ")}.`
    );
  });
}

/**
 * Switch a topic on or off.
 *
 * OFF IS NOT DELETE, and the message says so, because the two are easy to
 * confuse on a screen with one toggle: the row stays, its terms stay, and every
 * short it has already found keeps its label. It simply stops being searched
 * for.
 */
export async function setTopicActive(form: FormData): Promise<TopicActionResult> {
  return await write(async (store) => {
    const slug = String(form.get(FIELD.slug) ?? "");
    const active = String(form.get(FIELD.active) ?? "") === "true";
    const topic = await store.setTopicActive(slug, active);
    return active
      ? `${topic.name} is on and will be searched for in the next run.`
      : `${topic.name} is off. Its search terms and everything it has already found are kept — ` +
          "nothing was deleted; it just stops being looked for.";
  });
}

/**
 * Put back any of the plan's thirty topics that are missing.
 *
 * NON-DESTRUCTIVE AND IT SAYS SO. It skips every slug already present, so a
 * topic somebody edited or switched off is left exactly as it is. A button that
 * silently undid a week of tuning would be worse than no button, and an
 * operator cannot tell which kind this is without being told.
 */
export async function restorePlanTopics(): Promise<TopicActionResult> {
  return await write(async (store) => {
    const written = await store.seedPlanTopics();
    if (written.length === 0) {
      return (
        "Every topic from the client's plan is already here, so nothing was added. Topics you " +
        "edited or switched off were left alone — this only ever fills in what is missing."
      );
    }
    return (
      `Added ${written.length} topic${written.length === 1 ? "" : "s"} from the plan: ` +
      `${written.map((t) => t.name).join(", ")}. Anything already here was left untouched.`
    );
  });
}

/**
 * The role check, the store, the write, and the one place a failure becomes a
 * sentence.
 *
 * A `TopicStoreError` IS SHOWN AS WRITTEN and anything else is not. The store's
 * own messages are written for an operator — "there is already a topic
 * addressed as …" — and are safe by construction because the store built them
 * from values the operator typed. An unexpected throw could be a driver error
 * carrying a connection string, so it goes to the log and the screen gets a
 * sentence naming the log. Same rule the credentials and shorts actions apply.
 */
async function write(
  action: (store: TopicStore) => Promise<string>,
): Promise<TopicActionResult> {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) {
    return { ok: false, message: "Only an admin can change what this deployment looks for." };
  }

  let store: TopicStore;
  let readOnlyReason: string | null;
  try {
    const resolved = await resolveTopicStore();
    store = resolved.store;
    readOnlyReason = resolved.store.readOnlyReason;
  } catch (cause) {
    console.error(`${LOG_TAG} the topic store could not be opened:`, cause);
    return {
      ok: false,
      message:
        "The topic list could not be opened, so nothing was changed. The reason is in the " +
        "server log, tagged [admin/topics].",
    };
  }

  if (readOnlyReason) return { ok: false, message: readOnlyReason };

  try {
    const message = await action(store);
    // The page reads the list on every render, so the cache has to be told or
    // an operator sees the row they just edited in its old state and edits it
    // again.
    revalidatePath(TOPICS_PATH);
    return { ok: true, message };
  } catch (cause) {
    if (cause instanceof TopicStoreError) return { ok: false, message: cause.message };
    console.error(`${LOG_TAG} a topic could not be written:`, cause);
    return {
      ok: false,
      message:
        "That could not be saved, and nothing was changed. The reason is in the server log, " +
        "tagged [admin/topics].",
    };
  }
}
