/**
 * THE "USED / UNUSED" DECISION LAYER.
 *
 * `shorts` holds observations and `upsertShorts` replaces a row on every re-run
 * (lib/shorts/store.ts), so the decision "I have used this clip" cannot live on
 * that row — the next run would wipe it. It lives here, in its own table keyed
 * by the same identity, and a re-run of `shorts` never touches it. See
 * supabase/migrations/20260910_17_used_shorts.sql.
 *
 * PRESENCE IS THE DECISION. `listUsedKeys` returns the set of `shortKey()`s
 * currently marked used; `setUsed(ref, true)` inserts the mark, `setUsed(ref,
 * false)` deletes it. There is no boolean to fall out of step with the row.
 */
import type { Platform } from "../platform/types";
import type { TenantClient } from "../supabase/config";
import { shortKey } from "./store";

export const USED_SHORTS_TABLE = "used_shorts" as const;

/** A short's identity — the only thing a mark is about. */
export interface ShortRef {
  readonly platform: Platform;
  readonly platform_video_id: string;
}

export class UsedShortsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsedShortsStoreError";
  }
}

export interface UsedShortsStore {
  /** The set of `shortKey()`s currently marked used. */
  listUsedKeys(): Promise<Set<string>>;
  /** Mark (`used=true`) or unmark (`used=false`). Idempotent either way. */
  setUsed(ref: ShortRef, used: boolean): Promise<void>;
}

const PAGE = 1000;
const MAX_REQUESTS = 512;

export class SupabaseUsedShortsStore implements UsedShortsStore {
  constructor(private readonly client: TenantClient) {}

  async listUsedKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    let rowsRead = 0;
    let widest = 0;
    // Paged for the same reason every read in this repo is: PostgREST caps a
    // response silently. A table of marks is small, but "small" is not a thing
    // the code is allowed to assume.
    for (let req = 0; req < MAX_REQUESTS; req += 1) {
      const { data, error } = await this.client
        .from(USED_SHORTS_TABLE)
        .select("platform,platform_video_id")
        .order("platform", { ascending: true })
        .order("platform_video_id", { ascending: true })
        .range(rowsRead, rowsRead + PAGE - 1);
      if (error) throw new UsedShortsStoreError(`listUsedKeys: ${error.message}`);
      const page = (data ?? []) as ShortRef[];
      if (page.length === 0) break;
      for (const row of page) keys.add(shortKey(row));
      rowsRead += page.length;
      if (page.length < widest) break;
      widest = page.length;
    }
    return keys;
  }

  async setUsed(ref: ShortRef, used: boolean): Promise<void> {
    if (used) {
      const { error } = await this.client
        .from(USED_SHORTS_TABLE)
        .upsert(
          { platform: ref.platform, platform_video_id: ref.platform_video_id },
          { onConflict: "platform,platform_video_id" },
        );
      if (error) throw new UsedShortsStoreError(`setUsed(true): ${error.message}`);
      return;
    }
    const { error } = await this.client
      .from(USED_SHORTS_TABLE)
      .delete()
      .eq("platform", ref.platform)
      .eq("platform_video_id", ref.platform_video_id);
    if (error) throw new UsedShortsStoreError(`setUsed(false): ${error.message}`);
  }
}

/** In-memory implementation, for tests and a database-less run. */
export class MemoryUsedShortsStore implements UsedShortsStore {
  private readonly keys = new Set<string>();

  async listUsedKeys(): Promise<Set<string>> {
    return new Set(this.keys);
  }

  async setUsed(ref: ShortRef, used: boolean): Promise<void> {
    const key = shortKey(ref);
    if (used) this.keys.add(key);
    else this.keys.delete(key);
  }
}
