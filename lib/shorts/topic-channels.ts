/**
 * WHERE A TOPIC'S OWN CHANNELS LIVE.
 *
 * A topic can be searched two ways now: by its KEYWORDS (the existing topical
 * path) and by a set of CHANNELS attached to it — creators the tool enumerates
 * only when that topic runs, and grows over time. This module is the store for
 * that second set. It is deliberately SEPARATE from `platform_seeds`
 * (lib/shorts/seeds.ts), which stay global per platform: a seed is a creator
 * with no subject; a topic channel is a creator chosen FOR one subject. See
 * supabase/migrations/20260914_19_topic_channels.sql for the argument.
 *
 * The shape mirrors `Seed` — snake_case across the wire, `channel` stored
 * verbatim (a YouTube id/@handle, an Instagram handle, a TikTok sec_uid),
 * deactivated-never-deleted, `source` manual|auto. Scope in practice is YouTube,
 * Instagram and TikTok — the platforms that can enumerate a creator.
 *
 * A READ IS ALL OF THEM OR IT THROWS, the same rule `SeedStore` keeps and for
 * the same reason: a topic run that silently enumerates fewer channels and then
 * reports success is the honesty rule broken by arithmetic. No page could show
 * it, so a read that cannot finish refuses.
 */
import { PLATFORMS, type Platform } from "../platform/types";
import type { TenantClient } from "../supabase/config";

export const TOPIC_CHANNELS_TABLE = "topic_channels" as const;

export type ChannelSource = "manual" | "auto";

/** One channel attached to one topic on one platform. Mirrors `Seed`. */
export interface TopicChannel {
  readonly topic_slug: string;
  readonly platform: Platform;
  /** Whatever that platform's adapter enumerates. Stored and handed on verbatim. */
  readonly channel: string;
  readonly active: boolean;
  /** A person added it (`manual`) or the self-growing loop did (`auto`). */
  readonly source: ChannelSource;
  readonly note: string | null;
  readonly added_at: string | null;
  readonly added_by: string | null;
  readonly deactivated_at: string | null;
  readonly deactivated_by: string | null;
  /** Last run of this topic+platform that finished ok while this was active. NOT proof it produced anything. */
  readonly last_fetched_ok_at: string | null;
}

export interface NewTopicChannel {
  readonly topicSlug: string;
  readonly platform: Platform;
  readonly channel: string;
  readonly source?: ChannelSource;
  readonly note?: string | null;
  readonly addedBy?: string | null;
  readonly addedAt?: string;
}

export class TopicChannelStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicChannelStoreError";
  }
}

/**
 * The active channels for a topic, folded to the `Record<Platform, string[]>`
 * shape the adapter-enumeration path consumes — the exact analogue of
 * `activeSeedsByPlatform` in lib/shorts/seeds.ts. Inactive and blank rows are
 * dropped; order is preserved.
 */
export function activeChannelsByPlatform(
  channels: readonly TopicChannel[],
): Record<Platform, readonly string[]> {
  const out = {} as Record<Platform, string[]>;
  for (const platform of PLATFORMS) out[platform] = [];
  for (const row of channels) {
    if (!row.active) continue;
    const value = row.channel.trim();
    if (value === "") continue;
    if (row.platform in out) out[row.platform].push(value);
  }
  return out;
}

/**
 * The run's channel map — `slug -> platform -> active channels` — for a set of
 * topic slugs. One read, grouped for only the topics being searched, folded to
 * the shape `run` consumes. The caller wraps this in a try/catch: a deployment
 * without migration 19 has no table, and a keyword-only run is the right
 * fallback, not a crash.
 */
export async function channelMapForTopics(
  store: TopicChannelStore,
  slugs: Iterable<string>,
): Promise<Map<string, Partial<Record<Platform, readonly string[]>>>> {
  const wanted = new Set(slugs);
  const map = new Map<string, Partial<Record<Platform, readonly string[]>>>();
  if (wanted.size === 0) return map;

  const bySlug = new Map<string, TopicChannel[]>();
  for (const row of await store.listChannels()) {
    if (!wanted.has(row.topic_slug)) continue;
    const list = bySlug.get(row.topic_slug) ?? [];
    list.push(row);
    bySlug.set(row.topic_slug, list);
  }
  for (const [slug, rows] of bySlug) map.set(slug, activeChannelsByPlatform(rows));
  return map;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface TopicChannelStore {
  /** Null when this store can be written to; a sentence when it cannot. */
  readonly readOnlyReason: string | null;

  /** Every channel, or only one topic's when `topicSlug` is given. */
  listChannels(topicSlug?: string): Promise<TopicChannel[]>;

  /** Add a channel to a topic. Re-adding a deactivated one reactivates it. */
  addChannel(input: NewTopicChannel): Promise<TopicChannel>;

  /** Switch a channel on or off for a topic. Off is a deactivation, not a delete. */
  setChannelActive(
    topicSlug: string,
    platform: Platform,
    channel: string,
    active: boolean,
    by?: string | null,
    at?: string,
  ): Promise<TopicChannel>;

  /** Hard-remove a channel from a topic — for a mistake, not for retiring a dud. */
  removeChannel(topicSlug: string, platform: Platform, channel: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Paging (truncation-safe, same discipline as SeedStore)
// ---------------------------------------------------------------------------

const READ_PAGE_ROWS = 1000;
const MAX_REQUESTS_PER_READ = 64;

interface PagedQuery<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  range(from: number, to: number): PagedQuery<T>;
}

async function readAll<T>(newQuery: () => PagedQuery<T>): Promise<T[]> {
  const rows: T[] = [];
  let widestPage = 0;
  for (let request = 0; request < MAX_REQUESTS_PER_READ; request += 1) {
    const { data, error } = await newQuery().range(rows.length, rows.length + READ_PAGE_ROWS - 1);
    if (error) throw new TopicChannelStoreError(`${TOPIC_CHANNELS_TABLE}: ${error.message}`);
    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page);
    if (page.length < widestPage) return rows;
    widestPage = page.length;
  }
  throw new TopicChannelStoreError(
    `The ${TOPIC_CHANNELS_TABLE} read used all ${MAX_REQUESTS_PER_READ} of its requests without ` +
      "reaching the end. A partial list is not returned: a run made with one enumerates fewer " +
      "channels than configured and still reports success.",
  );
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export class SupabaseTopicChannelStore implements TopicChannelStore {
  readonly readOnlyReason = null;

  constructor(private readonly client: TenantClient) {}

  async listChannels(topicSlug?: string): Promise<TopicChannel[]> {
    return readAll<TopicChannel>(() => {
      let query = this.client
        .from(TOPIC_CHANNELS_TABLE)
        .select("*")
        // Full key order, so range-paging never drops or repeats a tied row.
        .order("topic_slug", { ascending: true })
        .order("platform", { ascending: true })
        .order("channel", { ascending: true });
      if (topicSlug !== undefined) query = query.eq("topic_slug", topicSlug);
      return query as unknown as PagedQuery<TopicChannel>;
    });
  }

  async addChannel(input: NewTopicChannel): Promise<TopicChannel> {
    const channel = input.channel.trim();
    if (channel === "") throw new TopicChannelStoreError("A channel cannot be blank.");
    const topicSlug = input.topicSlug.trim();
    if (topicSlug === "") throw new TopicChannelStoreError("A topic is required.");

    // UPSERT so re-adding a channel that was switched off turns it back on rather
    // than failing on the primary key. `added_at`/`added_by` are omitted from the
    // payload, so a conflict-update leaves the original attribution intact while
    // an insert takes the column default.
    const { data, error } = await this.client
      .from(TOPIC_CHANNELS_TABLE)
      .upsert(
        {
          topic_slug: topicSlug,
          platform: input.platform,
          channel,
          active: true,
          source: input.source ?? "manual",
          note: input.note?.trim() || null,
          deactivated_at: null,
          deactivated_by: null,
          ...(input.addedAt ? { added_at: input.addedAt } : {}),
        },
        { onConflict: "topic_slug,platform,channel" },
      )
      .select()
      .single();

    if (error) throw new TopicChannelStoreError(`addChannel: ${error.message}`);
    return data as TopicChannel;
  }

  async setChannelActive(
    topicSlug: string,
    platform: Platform,
    channel: string,
    active: boolean,
    by: string | null = null,
    at: string = new Date().toISOString(),
  ): Promise<TopicChannel> {
    const patch = active
      ? { active: true, deactivated_at: null, deactivated_by: null }
      : { active: false, deactivated_at: at, deactivated_by: by };

    const { data, error } = await this.client
      .from(TOPIC_CHANNELS_TABLE)
      .update(patch)
      .eq("topic_slug", topicSlug)
      .eq("platform", platform)
      .eq("channel", channel)
      .select()
      .maybeSingle();

    if (error) throw new TopicChannelStoreError(`setChannelActive: ${error.message}`);
    if (!data) {
      // A row that matched nothing comes back null with no error. Refused rather
      // than returned, because a page showing "off" for a channel still being
      // enumerated is the exact lie this module is about.
      throw new TopicChannelStoreError(
        `No channel ${JSON.stringify(channel)} on ${platform} for topic ${JSON.stringify(topicSlug)}.`,
      );
    }
    return data as TopicChannel;
  }

  async removeChannel(topicSlug: string, platform: Platform, channel: string): Promise<void> {
    const { error } = await this.client
      .from(TOPIC_CHANNELS_TABLE)
      .delete()
      .eq("topic_slug", topicSlug)
      .eq("platform", platform)
      .eq("channel", channel);
    if (error) throw new TopicChannelStoreError(`removeChannel: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory (tests and the no-database path)
// ---------------------------------------------------------------------------

const key = (topicSlug: string, platform: Platform, channel: string) =>
  `${topicSlug} ${platform} ${channel}`;

export class MemoryTopicChannelStore implements TopicChannelStore {
  readonly readOnlyReason = null;
  private readonly rows = new Map<string, TopicChannel>();

  constructor(seed: readonly TopicChannel[] = []) {
    for (const row of seed) this.rows.set(key(row.topic_slug, row.platform, row.channel), row);
  }

  async listChannels(topicSlug?: string): Promise<TopicChannel[]> {
    const all = [...this.rows.values()].filter(
      (row) => topicSlug === undefined || row.topic_slug === topicSlug,
    );
    return all.sort(
      (a, b) =>
        a.topic_slug.localeCompare(b.topic_slug) ||
        a.platform.localeCompare(b.platform) ||
        a.channel.localeCompare(b.channel),
    );
  }

  async addChannel(input: NewTopicChannel): Promise<TopicChannel> {
    const channel = input.channel.trim();
    if (channel === "") throw new TopicChannelStoreError("A channel cannot be blank.");
    const topicSlug = input.topicSlug.trim();
    if (topicSlug === "") throw new TopicChannelStoreError("A topic is required.");

    const existing = this.rows.get(key(topicSlug, input.platform, channel));
    const row: TopicChannel = {
      topic_slug: topicSlug,
      platform: input.platform,
      channel,
      active: true,
      source: input.source ?? existing?.source ?? "manual",
      note: input.note?.trim() || existing?.note || null,
      added_at: existing?.added_at ?? input.addedAt ?? new Date().toISOString(),
      added_by: existing?.added_by ?? input.addedBy ?? null,
      deactivated_at: null,
      deactivated_by: null,
      last_fetched_ok_at: existing?.last_fetched_ok_at ?? null,
    };
    this.rows.set(key(topicSlug, input.platform, channel), row);
    return row;
  }

  async setChannelActive(
    topicSlug: string,
    platform: Platform,
    channel: string,
    active: boolean,
    by: string | null = null,
    at: string = new Date().toISOString(),
  ): Promise<TopicChannel> {
    const k = key(topicSlug, platform, channel);
    const existing = this.rows.get(k);
    if (!existing) {
      throw new TopicChannelStoreError(
        `No channel ${JSON.stringify(channel)} on ${platform} for topic ${JSON.stringify(topicSlug)}.`,
      );
    }
    const row: TopicChannel = active
      ? { ...existing, active: true, deactivated_at: null, deactivated_by: null }
      : { ...existing, active: false, deactivated_at: at, deactivated_by: by };
    this.rows.set(k, row);
    return row;
  }

  async removeChannel(topicSlug: string, platform: Platform, channel: string): Promise<void> {
    this.rows.delete(key(topicSlug, platform, channel));
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveTopicChannelStoreOptions {
  readonly client?: TenantClient | null;
  /** Overrides `isSupabaseConfigured`. Tests only. */
  readonly configured?: boolean;
}

/**
 * The store this deployment uses. Supabase when configured, otherwise the
 * in-memory one — which cannot persist, so the resolver says so via
 * `explanation` the way `resolveSeedStore` does.
 */
export async function resolveTopicChannelStore(
  options: ResolveTopicChannelStoreOptions = {},
): Promise<{ store: TopicChannelStore; explanation: string }> {
  let configured = options.configured;
  if (configured === undefined) {
    const { isSupabaseConfigured } = await import("../supabase/config");
    configured = isSupabaseConfigured;
  }

  if (configured) {
    const client =
      options.client ?? (await import("../supabase/server")).createSupabaseAdminClient();
    return {
      store: new SupabaseTopicChannelStore(client as TenantClient),
      explanation: "Channels are stored in this project's database.",
    };
  }

  return {
    store: new MemoryTopicChannelStore(),
    explanation:
      "No database is configured, so topic channels live only in memory and are lost when the " +
      "server restarts. Configure Supabase to keep them.",
  };
}
