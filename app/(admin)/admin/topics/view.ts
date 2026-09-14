/**
 * The shapes the topics page and its actions both need.
 *
 * NO `"use server"` DIRECTIVE HERE, DELIBERATELY. Next publishes every export of
 * a `"use server"` module as a callable endpoint, so a helper living beside the
 * actions would be a route nobody decided to open. The same split the
 * credentials page makes, for the same reason.
 */
import type { Platform } from "@/lib/platform/types";
import type { Topic } from "@/lib/shorts/topics";
import type { TopicChannel } from "@/lib/shorts/topic-channels";

/** What every action on this page answers with. */
export type TopicActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/**
 * Whether a platform can be searched for a subject AT ALL in this deployment.
 *
 * ONE ANSWER FOR THE WHOLE LIST, NOT ONE PER TOPIC, and that is a statement
 * about the question rather than an optimisation. "Can TikTok be searched" is
 * answered by whether a vendor key exists; it does not vary by whether the
 * subject is Shark Tank or Bodycam. The only per-topic reason any adapter gives
 * is "this topic has no search terms", and the store makes that state
 * unreachable. So the page says it once, above the list, where it reads as the
 * fact about the deployment that it is.
 */
export interface PlatformReach {
  readonly platform: Platform;
  readonly label: string;
  /** True when a run would search this platform for every active topic. */
  readonly canSearch: boolean;
  /** Null when it can. The adapter's own sentence when it cannot. */
  readonly reason: string | null;
}

/** What the page is handed. */
export interface TopicsView {
  readonly topics: readonly Topic[];
  /** Where the list came from, in a sentence. */
  readonly explanation: string;
  /** Null when the list can be edited here; a sentence when it cannot. */
  readonly readOnlyReason: string | null;
  /** Which platforms a topic run would actually reach. */
  readonly reach: readonly PlatformReach[];
}

/** Field names, in one place so the form and the action cannot drift. */
export const FIELD = {
  name: "topicName",
  terms: "topicTerms",
  slug: "topicSlug",
  active: "topicActive",
} as const;

/**
 * The platforms a topic can own channels on — the three that can enumerate a
 * creator (YouTube by channel, Instagram by handle, TikTok by sec_uid). X and
 * Facebook are omitted on purpose: X has no user-timeline read and Facebook has
 * no creator search, so a channel there could never be enumerated.
 */
export const CHANNEL_PLATFORMS = ["youtube", "instagram", "tiktok"] as const satisfies readonly Platform[];
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export function isChannelPlatform(value: unknown): value is ChannelPlatform {
  return typeof value === "string" && (CHANNEL_PLATFORMS as readonly string[]).includes(value);
}

/** What identifier to paste for each platform — shown by the add form. */
export const CHANNEL_HINT: Record<ChannelPlatform, string> = {
  youtube: "A channel URL, @handle, or UC… channel id",
  instagram: "A creator @handle",
  tiktok: "A creator sec_uid (MS4wLjABAAAA…) — TikTok's internal id, not the @handle",
};

/** Field names for the channel forms, kept apart from the topic ones. */
export const CHANNEL_FIELD = {
  topicSlug: "chTopicSlug",
  platform: "chPlatform",
  channel: "chChannel",
  active: "chActive",
} as const;

/** A topic's channels, grouped by topic slug, for the panel. */
export type ChannelsByTopic = Readonly<Record<string, readonly TopicChannel[]>>;

/**
 * One term per line is how the textarea is read and written.
 *
 * NOT COMMA-SEPARATED, and that is not a style choice: a search term may
 * legitimately contain a comma ("no, seriously" is a phrase somebody will type)
 * and a newline cannot appear inside one at all. A separator that can occur
 * inside a value silently splits it, and the operator sees two searches where
 * they wrote one.
 */
export function termsToText(terms: readonly string[]): string {
  return terms.join("\n");
}

export function textToTerms(text: string): string[] {
  return text.split(/\r?\n/);
}
