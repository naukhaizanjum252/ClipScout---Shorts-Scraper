"use client";

/**
 * /admin/library — EVERY SAVED SHORT, AS CARDS, AND WHICH ONES YOU HAVE USED.
 *
 * The run screen (/admin/shorts) shows the LAST run. This shows the whole
 * inventory the `shorts` table has accumulated across every run, so a clip found
 * last week is still here. Each card can be marked used; the filter separates
 * used from unused, which is the workflow this page exists for.
 *
 * THE USED STATE IS OPTIMISTIC. A click flips the card immediately and the
 * server write happens behind it; waiting a round trip to see a button move
 * reads as broken. If the write fails the card flips back and the reason shows.
 */
import { useState, useTransition } from "react";

import { PLATFORMS, platformLabel, type Platform, type ShortRecord } from "@/lib/platform/types";
import { shortKey } from "@/lib/shorts/store";

import { ShortCard } from "../_components/short-card";
import type { DownloadOutcome } from "../shorts/view";
import type { LibraryFilter, LibraryRow, LibraryView, MarkResult, MarkUsedRequest } from "./view";

/**
 * Where a per-card "Get file" press has got to. Resolving a media URL is a
 * live call — yt-dlp or a vendor — so the button owns a little state machine,
 * the same three phases the run screen's MediaCell uses.
 *
 * A resolved URL is SHORT-LIVED and nothing is stored (a signed CDN address
 * dies within hours), so "ready" is not cached across a reload — press again
 * for a fresh one. YouTube is the sharp edge: its file link is signed to the
 * address that resolved it, so a link resolved on this server 403s from a
 * browser unless a yt-dlp service streams it (see resolveDownloadUrl). That is
 * surfaced as the server's own refusal message rather than pretended around.
 */
type DownloadPhase =
  | { readonly kind: "resolving" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "refused"; readonly message: string };

/** An http(s) URL, or null — the resolved string came from outside this app. */
function httpHref(raw: string): string | null {
  return /^https?:\/\//i.test(raw) ? raw : null;
}

function DownloadButton({
  short,
  phase,
  onResolve,
}: {
  readonly short: ShortRecord;
  readonly phase: DownloadPhase | undefined;
  readonly onResolve: (short: ShortRecord) => void;
}) {
  if (phase === undefined) {
    return (
      <button
        type="button"
        className="btn btn-quiet btn-small"
        onClick={() => onResolve(short)}
        aria-label={`Get the video file link for ${short.title ?? short.platform_video_id}`}
      >
        Get file
      </button>
    );
  }
  if (phase.kind === "resolving") {
    return (
      <button type="button" className="btn btn-quiet btn-small" disabled>
        Resolving&#8230;
      </button>
    );
  }
  if (phase.kind === "refused") {
    return (
      <span className="faint" title={phase.message}>
        no file
      </span>
    );
  }
  return (
    <a
      className="link btn-small"
      href={phase.url}
      target="_blank"
      rel="noreferrer noopener"
      title="Direct file link — short-lived and nothing is stored. Press Get file again for a fresh one."
    >
      Download
    </a>
  );
}

const FILTERS: readonly { readonly id: LibraryFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "unused", label: "Unused" },
  { id: "used", label: "Used" },
];

/** "all", or one platform. */
type PlatformFilter = Platform | "all";

/**
 * The badge for a row that came from the unverified table. Null for a measured
 * short, which is most of the library. The wording names WHAT could not be
 * checked, because "unmeasured" alone reads as "broken" — a reel with a real
 * post link and an estimated view count is a usable find, just not a proven
 * Short. The estimate itself is already marked with "≈" on the view count by
 * the card; this says why the row is not in the measured list.
 */
function unverifiedFlag(unproven: readonly string[] | null) {
  if (!unproven || unproven.length === 0) return null;
  const noDuration = unproven.includes("duration");
  const noViews = unproven.includes("views");
  const why = noDuration && noViews
    ? "no duration and no measured views"
    : noDuration
      ? "no duration reported, so not confirmed a Short"
      : "views were not measured";
  return (
    <span className="short-flag" title={`Kept but unmeasured: ${why}.`}>
      unmeasured · {noDuration ? "no length" : "est. views"}
    </span>
  );
}

export function LibraryPanel({
  view,
  onSetUsed,
  onResolveDownload,
}: {
  readonly view: LibraryView;
  readonly onSetUsed: (request: MarkUsedRequest) => Promise<MarkResult>;
  readonly onResolveDownload: (short: ShortRecord) => Promise<DownloadOutcome>;
}) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [downloads, setDownloads] = useState<Record<string, DownloadPhase>>({});
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function resolveDownload(short: ShortRecord) {
    const key = shortKey(short);
    if (downloads[key]?.kind === "resolving") return;
    setDownloads((current) => ({ ...current, [key]: { kind: "resolving" } }));
    startTransition(async () => {
      const outcome = await onResolveDownload(short).catch(
        (): DownloadOutcome => ({ ok: false, message: "The file link could not be resolved." }),
      );
      const phase: DownloadPhase = !outcome.ok
        ? { kind: "refused", message: outcome.message }
        : httpHref(outcome.url) === null
          ? { kind: "refused", message: "The resolved link was not a usable web address." }
          : { kind: "ready", url: outcome.url };
      setDownloads((current) => ({ ...current, [key]: phase }));
    });
  }

  if (view.unavailable) {
    return (
      <div className="stack">
        <section className="panel">
          <p className="panel-title">Library</p>
          <p className="notice">{view.unavailable}</p>
        </section>
      </div>
    );
  }

  const usedOf = (row: LibraryRow): boolean => {
    const key = shortKey(row.short);
    return key in overrides ? overrides[key] : row.used;
  };

  // How many saved shorts each platform has, so the platform chips can show a
  // count and a platform with none can be left off rather than offered as a
  // dead choice.
  const platformCounts = {} as Record<Platform, number>;
  for (const p of PLATFORMS) platformCounts[p] = 0;
  for (const row of view.rows) {
    const p = row.short.platform;
    if (p in platformCounts) platformCounts[p] += 1;
  }
  const platformsPresent = PLATFORMS.filter((p) => platformCounts[p] > 0);

  // The platform choice narrows first; the used/unused counts and the list are
  // then computed within that subset, so switching platform updates them both.
  const inPlatform = view.rows.filter((row) => platform === "all" || row.short.platform === platform);

  let usedCount = 0;
  for (const row of inPlatform) if (usedOf(row)) usedCount += 1;
  const counts: Record<LibraryFilter, number> = {
    all: inPlatform.length,
    used: usedCount,
    unused: inPlatform.length - usedCount,
  };

  const rows = inPlatform.filter((row) => {
    if (filter === "used") return usedOf(row);
    if (filter === "unused") return !usedOf(row);
    return true;
  });

  function toggle(row: LibraryRow) {
    const key = shortKey(row.short);
    const next = !usedOf(row);
    setError(null);
    setOverrides((current) => ({ ...current, [key]: next }));
    setPending((current) => new Set(current).add(key));
    startTransition(async () => {
      const result = await onSetUsed({
        platform: row.short.platform,
        platformVideoId: row.short.platform_video_id,
        used: next,
      });
      setPending((current) => {
        const copy = new Set(current);
        copy.delete(key);
        return copy;
      });
      if (!result.ok) {
        setOverrides((current) => {
          const copy = { ...current };
          delete copy[key];
          return copy;
        });
        setError(result.message);
      }
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <p className="panel-title">Your clip library</p>
        <p className="note">
          Every short this tool has kept, across all runs, highest views first. Rows marked{" "}
          <span className="short-flag">unmeasured</span> could not be fully checked — an Instagram
          reel with no duration, say — and their view counts may be estimates (shown with{" "}
          <span className="mono">≈</span>). Mark the ones you have used and switch to{" "}
          <strong>Unused</strong> to see only what is left; a mark is remembered separately from the
          clip, so re-running a search never resets it.
        </p>

        <div className="lib-tabs" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              data-active={filter === f.id}
              className="lib-tab"
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="dim">({counts[f.id]})</span>
            </button>
          ))}
        </div>

        {/* PLATFORM FILTER. Only platforms that actually have saved shorts get a
            chip — a platform with none is not a choice, it is a dead end, and a
            zero-count chip reads as "broken" rather than "empty". Hidden
            entirely until there is more than one platform to choose between. */}
        {platformsPresent.length > 1 ? (
          <div className="lib-tabs" role="tablist" aria-label="Platform">
            <button
              type="button"
              role="tab"
              aria-selected={platform === "all"}
              data-active={platform === "all"}
              className="lib-tab"
              onClick={() => setPlatform("all")}
            >
              All platforms <span className="dim">({view.rows.length})</span>
            </button>
            {platformsPresent.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={platform === p}
                data-active={platform === p}
                className="lib-tab"
                onClick={() => setPlatform(p)}
              >
                {platformLabel(p)} <span className="dim">({platformCounts[p]})</span>
              </button>
            ))}
          </div>
        ) : null}

        {error ? (
          <p className="field-error mt-2" role="alert">
            {error}
          </p>
        ) : null}

        {view.truncation ? <p className="notice mt-2">{view.truncation}</p> : null}
      </section>

      {view.rows.length === 0 ? (
        <p className="empty">
          No clips saved yet. Run a search on <strong>Shorts</strong> and the ones that clear the
          view threshold are saved here automatically.
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">
          Nothing to show for{" "}
          <strong>
            {platform === "all" ? filter : `${platformLabel(platform)}, ${filter}`}
          </strong>
          . Switch the filters above.
        </p>
      ) : (
        <div className="short-grid">
          {rows.map((row) => {
            const key = shortKey(row.short);
            const used = usedOf(row);
            const isPending = pending.has(key);
            return (
              <ShortCard
                key={key}
                short={row.short}
                dim={used}
                flag={unverifiedFlag(row.unproven)}
                footer={
                  <div className="lib-used">
                    <DownloadButton
                      short={row.short}
                      phase={downloads[key]}
                      onResolve={resolveDownload}
                    />
                    {used ? (
                      <span className="state state-ok">
                        <span className="state-mark" aria-hidden="true" /> used
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={isPending}
                      onClick={() => toggle(row)}
                    >
                      {isPending ? "Saving…" : used ? "Mark unused" : "Mark used"}
                    </button>
                  </div>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
