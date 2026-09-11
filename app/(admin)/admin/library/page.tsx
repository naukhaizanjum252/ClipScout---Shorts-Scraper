/**
 * /admin/library — the accumulated inventory of saved shorts, with used marks.
 *
 * Reads the `shorts` table (every kept short, across all runs) and the
 * `used_shorts` marks, merges them, and hands the client panel a flat list
 * highest-views-first. Reading is free and spends nobody's quota, so — unlike a
 * run — it happens on load.
 *
 * FORCE-DYNAMIC so a mark made a moment ago, or a run that just added rows, is
 * reflected on the next visit rather than served from a cached render.
 */
import { shortKey } from "@/lib/shorts/store";
import { SupabaseShortsStore } from "@/lib/shorts/supabase-store";
import { SupabaseUsedShortsStore } from "@/lib/shorts/used-store";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

import { resolveDownloadUrl } from "../shorts/actions";
import { setUsed } from "./actions";
import { LibraryPanel } from "./library-panel";
import type { LibraryRow, LibraryView } from "./view";

export const dynamic = "force-dynamic";

const LOG_TAG = "[admin/library]";

async function loadLibrary(): Promise<LibraryView> {
  if (!isSupabaseConfigured) {
    return {
      rows: [],
      truncation: null,
      unavailable:
        "The library needs a database to remember what has been found and used. Configure " +
        "Supabase and the shorts your runs keep will appear here.",
    };
  }

  try {
    const client = createSupabaseAdminClient();
    const shortsStore = new SupabaseShortsStore(client);
    const [read, usedKeys] = await Promise.all([
      shortsStore.readShorts(),
      new SupabaseUsedShortsStore(client).listUsedKeys(),
    ]);

    // THE UNVERIFIED ROWS ARE READ SEPARATELY AND TOLERANTLY. They live in their
    // own table (migration 18) and are what puts Instagram keyword reels in the
    // Library at all. If that table is not there yet — a deployment that has not
    // run the migration — this must NOT take the whole Library down: the
    // measured shorts are still worth showing. So a failure here is logged and
    // treated as "no unverified rows", and the page renders the verified list.
    let unverifiedRows: LibraryRow[] = [];
    let unverifiedTruncation: string | null = null;
    try {
      const unverifiedRead = await shortsStore.readUnverified();
      const unverifiedShorts = unverifiedRead.complete
        ? unverifiedRead.shorts
        : unverifiedRead.partial;
      unverifiedTruncation = unverifiedRead.complete ? null : unverifiedRead.truncation.message;
      unverifiedRows = unverifiedShorts.map((short) => ({
        short,
        used: usedKeys.has(shortKey(short)),
        // Never empty by construction, but coerce to null if a row somehow
        // arrived without it, so the card treats it as measured rather than
        // badging it with an empty reason.
        unproven: short.unproven.length > 0 ? short.unproven : null,
      }));
    } catch (cause) {
      console.error(`${LOG_TAG} the unverified shorts could not be read (showing measured only):`, cause);
    }

    const shorts = read.complete ? read.shorts : read.partial;
    const verifiedRows: LibraryRow[] = shorts.map((short) => ({
      short,
      used: usedKeys.has(shortKey(short)),
      unproven: null,
    }));

    const rows = [...verifiedRows, ...unverifiedRows]
      // Highest views first; a null view count (every row with no known views,
      // which many unverified ones are) sorts last rather than as a zero.
      .sort((a, b) => (b.short.view_count ?? -1) - (a.short.view_count ?? -1));

    return {
      rows,
      truncation: read.complete ? unverifiedTruncation : read.truncation.message,
      unavailable: null,
    };
  } catch (cause) {
    console.error(`${LOG_TAG} the library could not be read:`, cause);
    return {
      rows: [],
      truncation: null,
      unavailable:
        "The saved shorts could not be read. This deployment's server log has the reason, tagged " +
        "[admin/library].",
    };
  }
}

export default async function LibraryPage() {
  const view = await loadLibrary();
  return <LibraryPanel view={view} onSetUsed={setUsed} onResolveDownload={resolveDownloadUrl} />;
}
