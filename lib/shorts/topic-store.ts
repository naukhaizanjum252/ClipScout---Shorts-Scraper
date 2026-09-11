/**
 * WHERE TOPICS LIVE.
 *
 * The same shape as lib/shorts/seeds.ts, and deliberately so — one store
 * interface, a memory implementation, a Supabase implementation, and one
 * function that decides which is in play. A second, differently-shaped way of
 * keeping a small editable list is a second set of bugs.
 *
 * WHICH SOURCE WINS
 *
 *   Supabase configured  -> the database, ALONE.
 *   otherwise            -> the thirty topics from the client's plan, read-only.
 *
 * THE STORELESS FALLBACK IS NOT THE SAME DECISION SEEDS MADE, and the
 * difference is worth stating because the two files otherwise look identical.
 * `resolveSeedStore` falls back to an environment variable that is usually
 * empty, and zero seeds is a legitimate state somebody reached by switching the
 * last one off. Topics have no environment variable and never will — a
 * comma-separated list of thirty niches and their search terms in a `.env` is
 * unreadable and unmaintainable — so the fallback is the plan's own list,
 * shipped in code, READ-ONLY. A deployment with no database can still run
 * topics; it just cannot change them, and `readOnlyReason` says exactly that.
 *
 * ZERO TOPICS STILL MEANS ZERO ON A DATABASE. Once there is a table, an
 * operator who deactivates every topic has said something, and resurrecting the
 * plan's list at that moment would undo it silently — the same argument
 * lib/shorts/seeds.ts makes at length about seeds and the environment.
 */
import type { TenantClient } from "../supabase/config";
import {
  cleanTerms,
  planTopics,
  slugify,
  topicProblems,
  type NewTopic,
  type Topic,
  type TopicSource,
} from "./topics";

/** Every failure a topic store reports. One type, so callers can catch it. */
export class TopicStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TopicStoreError";
  }
}

/**
 * THE TABLE IS NOT THERE. A deployment that has not run migration 14 yet.
 *
 * ITS OWN TYPE BECAUSE IT IS NOT A FAILURE, and the difference decides what
 * the run does. A read that BROKE means this deployment cannot tell what it is
 * supposed to be looking for, and carrying on would return the
 * everything-that-is-big list under whatever subjects were configured — the
 * exact confusion topics exist to remove, so the run refuses. A table that was
 * never created means nobody has configured a subject on this deployment at
 * all, which is ZERO topics: a real, legitimate state, and the state this tool
 * was in until 2026-09-05. The untargeted run is the honest answer to it, and
 * it claims nothing — every row it produces carries `topic_slug: null`, which
 * says no subject was asked for.
 *
 * THE CODES. Postgres answers 42P01 (undefined_table) and PostgREST answers
 * PGRST205 when a relation is missing from its schema cache. Both are matched,
 * because which one arrives depends on whether the schema cache has been
 * reloaded since the table went missing — and a deployment that guessed wrong
 * about that would refuse every run for a reason nobody could find.
 */
export class TopicsNotInstalledError extends TopicStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TopicsNotInstalledError";
  }
}

/** True when this PostgREST error means the table does not exist. */
function isMissingTable(error: { code?: string | null } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

const NOT_INSTALLED =
  "This deployment has no `topics` table yet, so no subject has been configured on it and a " +
  "run reads whatever is biggest on each platform — the way this tool worked before topics " +
  "existed. Apply supabase/migrations/20260905_14_topics.sql to turn it on; the thirty niches " +
  "from the client's plan are in that migration.";

export interface TopicStore {
  /** Null when this store can be written to. A sentence when it cannot. */
  readonly readOnlyReason: string | null;

  /** Every topic, active and inactive, in name order. */
  listTopics(): Promise<Topic[]>;

  addTopic(input: NewTopic): Promise<Topic>;

  /**
   * Change a topic's terms, and only its terms.
   *
   * The name is not editable and that is not an oversight: the slug is derived
   * from it, rows already carry the slug, and a rename would orphan every short
   * this topic has ever found. Delete and re-add is the honest way to change a
   * name, because it is honest about what happens to the history.
   */
  setTopicTerms(slug: string, terms: readonly string[]): Promise<Topic>;

  /** Off means "stop searching for this". There is no delete: history is kept. */
  setTopicActive(slug: string, active: boolean): Promise<Topic>;

  /**
   * Write the plan's thirty topics, skipping any slug already present.
   *
   * IDEMPOTENT AND NON-DESTRUCTIVE. It never overwrites a topic somebody edited
   * and never reactivates one they switched off — a "restore the defaults"
   * button that quietly undid a week of tuning would be worse than no button.
   * Returns the rows it actually wrote.
   */
  seedPlanTopics(): Promise<Topic[]>;
}

/** The active topics, in the order a run should walk them. */
export function activeTopics(topics: readonly Topic[]): Topic[] {
  return topics.filter((t) => t.active && cleanTerms(t.terms).length > 0).sort(byName);
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/** For tests, and for the storeless fallback's read-only base. */
export class MemoryTopicStore implements TopicStore {
  readonly readOnlyReason: string | null;
  private readonly rows = new Map<string, Topic>();
  private readonly now: () => Date;

  constructor(
    seed: readonly Topic[] = [],
    options: { readOnlyReason?: string | null; now?: () => Date } = {},
  ) {
    for (const topic of seed) this.rows.set(topic.slug, topic);
    this.readOnlyReason = options.readOnlyReason ?? null;
    this.now = options.now ?? (() => new Date());
  }

  async listTopics(): Promise<Topic[]> {
    return [...this.rows.values()].sort(byName);
  }

  async addTopic(input: NewTopic): Promise<Topic> {
    this.refuseIfReadOnly();
    const topic = validated(input, this.now().toISOString());
    if (this.rows.has(topic.slug)) {
      throw new TopicStoreError(duplicateMessage(topic.name, topic.slug));
    }
    this.rows.set(topic.slug, topic);
    return topic;
  }

  async setTopicTerms(slug: string, terms: readonly string[]): Promise<Topic> {
    this.refuseIfReadOnly();
    const existing = this.require(slug);
    const problems = topicProblems({ name: existing.name, terms });
    if (problems.length > 0) throw new TopicStoreError(problems.join(" "));
    const updated = { ...existing, terms: cleanTerms(terms) };
    this.rows.set(slug, updated);
    return updated;
  }

  async setTopicActive(slug: string, active: boolean): Promise<Topic> {
    this.refuseIfReadOnly();
    const updated = { ...this.require(slug), active };
    this.rows.set(slug, updated);
    return updated;
  }

  async seedPlanTopics(): Promise<Topic[]> {
    this.refuseIfReadOnly();
    const written: Topic[] = [];
    for (const topic of planTopics(this.now)) {
      if (this.rows.has(topic.slug)) continue;
      this.rows.set(topic.slug, topic);
      written.push(topic);
    }
    return written;
  }

  private require(slug: string): Topic {
    const existing = this.rows.get(slug);
    if (!existing) throw new TopicStoreError(missingMessage(slug));
    return existing;
  }

  private refuseIfReadOnly(): void {
    if (this.readOnlyReason) throw new TopicStoreError(this.readOnlyReason);
  }
}

// ---------------------------------------------------------------------------
// In the database
// ---------------------------------------------------------------------------

export const TOPICS_TABLE = "topics" as const;

/**
 * The row as Postgres holds it. snake_case, mapped explicitly both ways below —
 * see `Topic`'s comment for why this shape is not shared with the wire format.
 */
interface TopicRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly terms: readonly string[] | null;
  readonly active: boolean;
  readonly source: TopicSource;
  readonly publishes_to: string | null;
  readonly note: string | null;
  readonly added_at: string;
}

export class SupabaseTopicStore implements TopicStore {
  readonly readOnlyReason = null;

  constructor(private readonly client: TenantClient) {}

  async listTopics(): Promise<Topic[]> {
    const { data, error } = await this.client
      .from(TOPICS_TABLE)
      .select("*")
      .order("name", { ascending: true });
    // CHECKED BEFORE THE GENERAL FAILURE, because the two mean opposite things
    // to the run. See `TopicsNotInstalledError`.
    if (isMissingTable(error)) throw new TopicsNotInstalledError(NOT_INSTALLED, { cause: error });
    if (error) throw new TopicStoreError(`listTopics: ${error.message}`);
    return ((data ?? []) as TopicRow[]).map(fromRow);
  }

  async addTopic(input: NewTopic): Promise<Topic> {
    const topic = validated(input, new Date().toISOString());
    const { data, error } = await this.client
      .from(TOPICS_TABLE)
      .insert({
        name: topic.name,
        slug: topic.slug,
        terms: topic.terms,
        active: topic.active,
        source: topic.source,
        publishes_to: topic.publishesTo,
        note: topic.note,
      })
      .select()
      .single();
    if (error) {
      // 23505 is unique_violation. Turned into the sentence a person can act on
      // rather than passed through as Postgres's own, which names a constraint.
      if (error.code === "23505") throw new TopicStoreError(duplicateMessage(topic.name, topic.slug));
      throw new TopicStoreError(`addTopic: ${error.message}`);
    }
    return fromRow(data as TopicRow);
  }

  async setTopicTerms(slug: string, terms: readonly string[]): Promise<Topic> {
    const cleaned = cleanTerms(terms);
    if (cleaned.length === 0) {
      throw new TopicStoreError(
        "A topic needs at least one search term. To stop searching for a subject, switch the " +
          "topic off — that keeps the terms and the history, which emptying it would throw away.",
      );
    }
    const { data, error } = await this.client
      .from(TOPICS_TABLE)
      .update({ terms: cleaned })
      .eq("slug", slug)
      .select()
      .maybeSingle();
    if (error) throw new TopicStoreError(`setTopicTerms: ${error.message}`);
    // A row that matched nothing comes back null with no error, which is the
    // same shape as success. Refused, for the reason `SupabaseSeedStore` gives:
    // a page reporting a change that did not happen is the lie to avoid.
    if (!data) throw new TopicStoreError(missingMessage(slug));
    return fromRow(data as TopicRow);
  }

  async setTopicActive(slug: string, active: boolean): Promise<Topic> {
    const { data, error } = await this.client
      .from(TOPICS_TABLE)
      .update({ active })
      .eq("slug", slug)
      .select()
      .maybeSingle();
    if (error) throw new TopicStoreError(`setTopicActive: ${error.message}`);
    if (!data) throw new TopicStoreError(missingMessage(slug));
    return fromRow(data as TopicRow);
  }

  async seedPlanTopics(): Promise<Topic[]> {
    const existing = new Set((await this.listTopics()).map((t) => t.slug));
    const missing = planTopics().filter((t) => !existing.has(t.slug));
    if (missing.length === 0) return [];

    const { data, error } = await this.client
      .from(TOPICS_TABLE)
      .insert(
        missing.map((t) => ({
          name: t.name,
          slug: t.slug,
          terms: t.terms,
          active: t.active,
          source: t.source,
          publishes_to: t.publishesTo,
          note: t.note,
        })),
      )
      .select();
    if (error) throw new TopicStoreError(`seedPlanTopics: ${error.message}`);
    return ((data ?? []) as TopicRow[]).map(fromRow);
  }
}

// ---------------------------------------------------------------------------
// Which store is in play
// ---------------------------------------------------------------------------

export type TopicStoreOrigin = "database" | "plan";

export interface ResolvedTopicStore {
  readonly store: TopicStore;
  readonly origin: TopicStoreOrigin;
  /** One line for the page and the run log. */
  readonly explanation: string;
}

export interface ResolveTopicStoreOptions {
  readonly client?: TenantClient | null;
  /** Overrides `isSupabaseConfigured`. Tests only. */
  readonly databaseConfigured?: boolean;
  readonly now?: () => Date;
}

/** ONE place decides where topics come from. */
export async function resolveTopicStore(
  options: ResolveTopicStoreOptions = {},
): Promise<ResolvedTopicStore> {
  let configured = options.databaseConfigured;
  if (configured === undefined) {
    const { isSupabaseConfigured } = await import("../supabase/config");
    configured = isSupabaseConfigured;
  }

  if (configured) {
    // `../supabase/server` pulls in `next/headers`, which only exists inside a
    // Next request. Deferred to the branch that needs it, exactly as
    // `resolveSeedStore` does, so a CLI can import this module at all.
    const client =
      options.client ?? (await import("../supabase/server")).createSupabaseAdminClient();
    return {
      store: new SupabaseTopicStore(client),
      origin: "database",
      explanation:
        "Topics are rows in this project's database and are edited here. Each one is a subject " +
        "and the words that find it; a run searches every platform that can be searched for each " +
        "active topic, instead of returning whatever happened to be big today.",
    };
  }

  return {
    store: new MemoryTopicStore(planTopics(options.now), {
      readOnlyReason:
        "No database is configured, so the topic list is the thirty niches from the client's plan, " +
        "shipped in code and read-only. Runs still search for them; nothing here can be added, " +
        "edited or switched off until a database is configured.",
      now: options.now,
    }),
    origin: "plan",
    explanation:
      "No database is configured, so topics are the thirty niches from the client's plan document, " +
      "read-only. Their search terms were written to start from and are meant to be edited, which " +
      "needs a database.",
  };
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function validated(input: NewTopic, addedAt: string): Topic {
  const problems = topicProblems(input);
  if (problems.length > 0) throw new TopicStoreError(problems.join(" "));
  const name = input.name.trim();
  return {
    id: slugify(name),
    name,
    slug: slugify(name),
    terms: cleanTerms(input.terms),
    active: input.active ?? true,
    source: input.source ?? "manual",
    publishesTo: input.publishesTo?.trim() || null,
    note: input.note?.trim() || null,
    addedAt,
  };
}

function fromRow(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // A null `terms` is a row written by something that did not know the
    // column, not a topic with no terms. It reads as empty and
    // `activeTopics` then skips it, which is the safe direction: a topic with
    // no words cannot be searched for and must not silently become a run that
    // reads everything.
    terms: cleanTerms(row.terms ?? []),
    active: row.active,
    source: row.source,
    publishesTo: row.publishes_to,
    note: row.note,
    addedAt: row.added_at,
  };
}

function byName(a: Topic, b: Topic): number {
  return a.name.localeCompare(b.name, "en");
}

function duplicateMessage(name: string, slug: string): string {
  return (
    `There is already a topic addressed as ${JSON.stringify(slug)}, so ${JSON.stringify(name)} ` +
    "was not added. Two topics with one address would each claim the other's results. Edit the " +
    "existing one's search terms instead, or give this one a different name."
  );
}

function missingMessage(slug: string): string {
  return (
    `There is no topic addressed as ${JSON.stringify(slug)}, so nothing was changed. A topic is ` +
    "matched by the slug it was stored under, which does not change when anything else does."
  );
}
