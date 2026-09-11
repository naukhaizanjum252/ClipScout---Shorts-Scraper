"use server";

/**
 * The one endpoint behind /admin/library: mark a saved short used, or unmark it.
 *
 * WHAT THIS FILE MAY EXPORT. Async server actions and nothing else — Next
 * publishes every export of a `"use server"` module as a callable endpoint, so
 * the shapes live in ./view.ts, which has no directive.
 *
 * NOTHING HERE SPENDS ANYTHING. A used/unused mark is a local decision about a
 * row already stored; it reads and writes one small table and touches no
 * platform, so it carries no spend gate, unlike ../shorts/actions.ts.
 *
 * EVERYTHING THAT ARRIVES IS UNTRUSTED, including the platform and the id — an
 * action id out of the client bundle can post anything — so both are validated
 * before a row is written.
 */
import { revalidatePath } from "next/cache";

import { getViewer, isAdmin } from "@/lib/auth/role";
import { isPlatform } from "@/lib/platform/types";
import { SupabaseUsedShortsStore } from "@/lib/shorts/used-store";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

import type { MarkResult, MarkUsedRequest } from "./view";

const LIBRARY_PATH = "/admin/library";
const LOG_TAG = "[admin/library]";

export async function setUsed(request: MarkUsedRequest): Promise<MarkResult> {
  // The rail hides nothing an action id cannot reach, so the role is re-checked
  // here rather than trusted from the page. With sign-in removed this passes for
  // everyone (see lib/auth/role.ts); it is the seam a restored gate edits.
  if (!isAdmin(await getViewer())) {
    return { ok: false, message: "You are not allowed to do that." };
  }

  if (!isSupabaseConfigured) {
    return {
      ok: false,
      message: "No database is configured, so there is nowhere to remember a used mark.",
    };
  }

  const platform = request?.platform;
  const platformVideoId =
    typeof request?.platformVideoId === "string" ? request.platformVideoId.trim() : "";
  const used = request?.used;

  if (!isPlatform(platform) || platformVideoId === "" || typeof used !== "boolean") {
    // Not a refusal an operator can act on — every row on the page carries a
    // real platform and id — so it is logged and answered plainly.
    console.error(`${LOG_TAG} setUsed called with something that is not a saved short.`);
    return { ok: false, message: "That is not a short this tool has saved." };
  }

  try {
    await new SupabaseUsedShortsStore(createSupabaseAdminClient()).setUsed(
      { platform, platform_video_id: platformVideoId },
      used,
    );
  } catch (cause) {
    console.error(`${LOG_TAG} the used mark could not be written:`, cause);
    return {
      ok: false,
      message:
        "The used mark could not be saved. This deployment's server log has the reason, tagged " +
        "[admin/library].",
    };
  }

  // The page reads the marks server-side, so it has to be re-rendered for the
  // change to show. The client also updates optimistically; this keeps a reload
  // honest.
  revalidatePath(LIBRARY_PATH);
  return { ok: true };
}
