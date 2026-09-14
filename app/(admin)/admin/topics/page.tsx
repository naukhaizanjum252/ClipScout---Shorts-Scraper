import { PLATFORMS, platformLabel } from "@/lib/platform/types";
import { asTopical, noTopicalReaderReason } from "@/lib/platform/topical";
import { buildAdapters } from "@/lib/platform/registry";
import { resolveCredentialStore } from "@/lib/credentials/resolve";
import { resolveSeedStore } from "@/lib/shorts/seeds";
import { resolveTopicStore, TopicsNotInstalledError } from "@/lib/shorts/topic-store";

import { resolveTopicChannelStore, type TopicChannel } from "@/lib/shorts/topic-channels";

import {
  addTopic,
  addTopicChannel,
  removeTopicChannel,
  restorePlanTopics,
  setTopicActive,
  setTopicChannelActive,
  setTopicTerms,
} from "./actions";
import { TopicsPanel } from "./topics-panel";
import type { ChannelsByTopic, PlatformReach } from "./view";

/**
 * /admin/topics — what this deployment is looking for.
 *
 * WHY THIS IS A PAGE AND NOT A PANEL ON /admin/shorts. The shorts screen is one
 * expensive verb and its own results; a topic list is a standing decision that
 * outlives any run. Putting them together would also have put a thirty-row
 * editor above a results table somebody is trying to read.
 *
 * IT BUILDS THE ADAPTERS, WHICH THE SHORTS PAGE DELIBERATELY DOES NOT, and the
 * difference is worth stating because the shorts page's header argues at length
 * against exactly this. That argument is about COST: a run spends API quota and
 * real money on X, so it stays behind a button. Building an adapter spends
 * nothing — it leases a credential, which is a database round trip and a
 * decrypt — and `topicUnavailableReason` is answerable locally on every adapter
 * in this repo, by design and for this reason. Nothing on this page is billed.
 *
 * WHAT IT ASKS THEM. One question, once: can you be searched for a subject at
 * all? Not per topic — see `PlatformReach` for why that would be a worse
 * question badly answered.
 */
export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const { store, explanation } = await resolveTopicStore();

  // A DEPLOYMENT THAT HAS NOT RUN MIGRATION 14 GETS THE PAGE, not a crash.
  // It has zero topics — a real state, and the one this tool was in until
  // 2026-09-05 — and the page's job then is to say exactly which migration
  // turns it on. A 500 here would leave an operator with a broken link in the
  // rail and no way to find out why. See `TopicsNotInstalledError`.
  let topics: Awaited<ReturnType<typeof store.listTopics>> = [];
  let notInstalled: string | null = null;
  try {
    topics = await store.listTopics();
  } catch (cause) {
    if (!(cause instanceof TopicsNotInstalledError)) throw cause;
    notInstalled = cause.message;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-14">
      <div className="page-head">
        {/* An inline size because Tailwind's preflight resets heading sizes to
            `inherit`; the house sheet styles `.page-head h1` and this is the
            same value it gives it. The sibling pages do the same. */}
        <h1 style={{ fontSize: "30px" }}>What to look for</h1>

        <p>
          A run searches every platform it can for each of these subjects, instead of returning
          whatever happened to be biggest. Each topic is a name and the words that find it; the
          words are what actually get sent, and they are meant to be edited once you have seen what
          they bring back.
        </p>
      </div>

      <TopicsPanel
        topics={topics}
        explanation={explanation}
        readOnlyReason={notInstalled ?? store.readOnlyReason}
        reach={await reachOfEachPlatform()}
        channels={await channelsByTopic()}
        addTopic={addTopic}
        setTopicTerms={setTopicTerms}
        setTopicActive={setTopicActive}
        restorePlanTopics={restorePlanTopics}
        addTopicChannel={addTopicChannel}
        setTopicChannelActive={setTopicChannelActive}
        removeTopicChannel={removeTopicChannel}
      />
    </main>
  );
}

/**
 * Which platforms a topic run would actually reach.
 *
 * A FAILURE TO BUILD THE ADAPTERS IS REPORTED AS "cannot say", never as "cannot
 * search". The two are different claims and only one of them is about the
 * platforms: if the credential store will not open, this page knows nothing
 * about TikTok, and saying TikTok cannot be searched would be inventing a
 * finding out of a local fault. The same rule the run applies to an empty
 * result.
 */
/**
 * Every topic's channels, grouped by slug, for the panel.
 *
 * TOLERANT: a deployment that has not run migration 19 has no `topic_channels`
 * table, and reading it throws. That must not take the page down — the topics
 * still edit fine — so a failure is logged and treated as "no topic has
 * channels", the same tolerance /admin/library and the run path keep.
 */
async function channelsByTopic(): Promise<ChannelsByTopic> {
  try {
    const { store } = await resolveTopicChannelStore();
    const grouped: Record<string, TopicChannel[]> = {};
    for (const row of await store.listChannels()) {
      (grouped[row.topic_slug] ??= []).push(row);
    }
    return grouped;
  } catch (cause) {
    console.error("[admin/topics] the topic channels could not be read:", cause);
    return {};
  }
}

const REACH_TTL_MS = 60_000;
let reachCache: { at: number; value: PlatformReach[] } | null = null;

/**
 * The reachability answer, memoised in-process.
 *
 * `computeReachOfEachPlatform` builds every adapter and probes each one —
 * credential leases, and a `yt-dlp` spawn for YouTube — which is the bulk of
 * this page's render time (~2.3s measured 2026-09-12). That answer is the same
 * for minutes at a time: it changes only when a credential or the config does,
 * never per request. So it is cached in the pm2 process with a short TTL — one
 * probe a minute, every visit in between instant — and cleared on restart. This
 * is an advisory readout, so a value up to a minute stale is fine; it must only
 * never be a stale CORRECTNESS claim, and reachability is not one.
 */
async function reachOfEachPlatform(): Promise<PlatformReach[]> {
  if (reachCache && Date.now() - reachCache.at < REACH_TTL_MS) return reachCache.value;
  const value = await computeReachOfEachPlatform();
  reachCache = { at: Date.now(), value };
  return value;
}

async function computeReachOfEachPlatform(): Promise<PlatformReach[]> {
  let built: Awaited<ReturnType<typeof buildAdapters>>;
  try {
    const [{ store: credentials }, { store: seedStore }] = await Promise.all([
      resolveCredentialStore(),
      resolveSeedStore(),
    ]);
    built = await buildAdapters({ credentials, seedStore });
  } catch (cause) {
    console.error("[admin/topics] the adapters could not be built:", cause);
    return PLATFORMS.map((platform) => ({
      platform,
      label: platformLabel(platform),
      canSearch: false,
      reason:
        "This page could not build the readers, so it cannot say whether this platform would be " +
        "searched. That is a fault in this deployment, not a statement about the platform — the " +
        "reason is in the server log, tagged [admin/topics].",
    }));
  }

  return await Promise.all(
    PLATFORMS.map(async (platform): Promise<PlatformReach> => {
      const adapter = built.get(platform);
      if (!adapter) {
        return {
          platform,
          label: platformLabel(platform),
          canSearch: false,
          reason: `No adapter is configured to read ${platformLabel(platform)} at all.`,
        };
      }

      const topical = asTopical(adapter);
      if (!topical) {
        return {
          platform,
          label: platformLabel(platform),
          canSearch: false,
          reason: noTopicalReaderReason(platform),
        };
      }

      // A PROBE TOPIC, not a real one. Every adapter's per-topic refusal is
      // either about the topic having no terms — which the store makes
      // impossible — or about the deployment, so one well-formed topic gets the
      // deployment's answer without this page having to pick a favourite
      // subject to ask about.
      const reason = await topical.topicUnavailableReason({
        id: "probe",
        name: "any subject",
        slug: "probe",
        terms: ["probe"],
        active: true,
        source: "manual",
        publishesTo: null,
        note: null,
        addedAt: new Date(0).toISOString(),
      });

      return {
        platform,
        label: platformLabel(platform),
        canSearch: reason === null,
        reason,
      };
    }),
  );
}
