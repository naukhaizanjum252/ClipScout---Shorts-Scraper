/**
 * In-memory `ShortsStore`.
 *
 * IT IS NOT A STUB. It keys on the real `shortKey`, replaces on conflict
 * exactly as the `onConflict: "platform,platform_video_id"` upsert does, and
 * applies the real `matchesFilter` — so the tests that prove "running it twice
 * does not duplicate a row" are proving it about the production identity rule
 * and the production filter, not about a look-alike. What it does not exercise
 * is SQL, PostgREST, or the paging that PostgREST's silent row cap makes
 * necessary; those are asserted separately in supabase-store.test.ts.
 *
 * IT IS ALSO THE ONLY STORE THAT EXISTS TODAY. No Supabase project has been
 * handed over, so `scripts/latest.ts` runs the real "get latest shorts" against
 * this and prints what would have been stored. That is what makes the product
 * demonstrable before a database exists, which was the whole reason the seeded
 * path this replaces defaulted to a keyless source.
 *
 * A READ FROM HERE IS ALWAYS COMPLETE, and that is a claim this implementation
 * can honestly make: there is no server, no row cap and no request budget, so
 * there is nothing that could truncate. `complete: true` here is a fact, not an
 * optimism — which is precisely why the Supabase one may not copy it.
 */
import type { ShortRecord } from "../platform/types";
import {
  matchesFilter,
  primaryKeyOrder,
  shortKey,
  type ShortsFilter,
  type ShortsRead,
  type ShortsStore,
  type StoredUnverifiedShort,
  type UnverifiedRead,
} from "./store";

export class MemoryShortsStore implements ShortsStore {
  private readonly rows = new Map<string, ShortRecord>();
  private readonly unverifiedRows = new Map<string, StoredUnverifiedShort>();

  /** How many times `upsertShorts` was called. Read by tests and the CLI. */
  writes = 0;
  /** How many times `upsertUnverified` was called. Read by tests. */
  unverifiedWrites = 0;

  constructor(seed: readonly ShortRecord[] = []) {
    for (const record of seed) this.rows.set(shortKey(record), record);
  }

  /**
   * REPLACES the row rather than merging into it.
   *
   * That is what makes this a faithful stand-in for the Supabase upsert, and it
   * matters for every counted field: `view_count` is the number the product
   * sorts by, and a store that kept the first reading would pin the whole
   * ranking to whenever a short was first seen while the page went on calling
   * itself the latest. A merge would also quietly resurrect a title or a
   * thumbnail the platform has since removed.
   */
  async upsertShorts(records: readonly ShortRecord[]): Promise<void> {
    this.writes += 1;
    for (const record of records) this.rows.set(shortKey(record), record);
  }

  async readShorts(filter: ShortsFilter = {}): Promise<ShortsRead> {
    const shorts = primaryKeyOrder([...this.rows.values()].filter((r) => matchesFilter(r, filter)));
    return { complete: true, shorts };
  }

  /** REPLACES on conflict, like `upsertShorts`, into the separate unverified map. */
  async upsertUnverified(records: readonly StoredUnverifiedShort[]): Promise<void> {
    this.unverifiedWrites += 1;
    for (const record of records) this.unverifiedRows.set(shortKey(record), record);
  }

  async readUnverified(): Promise<UnverifiedRead> {
    const shorts = primaryKeyOrder([...this.unverifiedRows.values()]) as StoredUnverifiedShort[];
    return { complete: true, shorts };
  }

  /** Row count, without going through the read. Test and CLI convenience. */
  get size(): number {
    return this.rows.size;
  }

  /** Unverified row count. Test convenience. */
  get unverifiedSize(): number {
    return this.unverifiedRows.size;
  }
}
