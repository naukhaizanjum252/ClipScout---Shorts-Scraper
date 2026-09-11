/**
 * ONE SHORT, AS A CARD. Shared by /admin/shorts (a run's results) and
 * /admin/library (the saved inventory), so the two look like one product.
 *
 * The thumbnail leads, because that is the thing a person scans a wall of clips
 * by; the view count is the largest figure, because it is what the threshold is
 * set against (DESIGN.md); everything else is support. A per-card action —
 * download on the run screen, mark-used in the library — goes in `footer`.
 *
 * THE THUMBNAIL IS A PLAIN `img`, DELIBERATELY. `next/image` refuses any remote
 * host not listed under `remotePatterns`, and these are several platforms' CDNs,
 * which rotate. `referrerPolicy` keeps a thumbnail request from telling a
 * platform which internal page is looking at it.
 */
import type { ReactNode } from "react";

import { measurementCaveat } from "@/lib/platform/caveat";
import { platformLabel, type ShortRecord } from "@/lib/platform/types";

/** An http(s) URL, or null. A stored URL is data and is not trusted to be a link. */
function safeHref(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ShortCard({
  short,
  footer,
  flag,
  dim = false,
}: {
  readonly short: ShortRecord;
  readonly footer?: ReactNode;
  /** A small badge under the title — e.g. "unmeasured" in the Library. */
  readonly flag?: ReactNode;
  readonly dim?: boolean;
}) {
  const post = safeHref(short.url);
  const creator = safeHref(short.creator_url);
  const thumbnail = safeHref(short.thumbnail_url);
  const caveat = measurementCaveat(short);
  const estimated = caveat?.basis === "derived";
  const title = short.title ?? "Untitled short";

  return (
    <article className="short-card" data-dim={dim || undefined}>
      <div className="short-thumb">
        {thumbnail === null ? (
          <div className="short-thumb-empty" aria-hidden="true">
            <span>{platformLabel(short.platform)}</span>
          </div>
        ) : post === null ? (
          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <a
            href={post}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Open the post: ${title}`}
          >
            <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </a>
        )}
        <span className="short-plat">{platformLabel(short.platform)}</span>
        {short.duration_seconds !== null ? (
          <span className="short-dur">{formatDuration(short.duration_seconds)}</span>
        ) : null}
      </div>

      <div className="short-card-body">
        <div className="short-views">
          {short.view_count === null ? (
            <span className="unknown" title="The source reported no view count for this short.">
              &#8212;
            </span>
          ) : estimated ? (
            <span className="derived" title={caveat?.note}>
              <span aria-hidden="true">&#8776;</span>
              <span className="sr-only">estimated,</span> {short.view_count.toLocaleString("en")}
            </span>
          ) : (
            short.view_count.toLocaleString("en")
          )}
          <span className="short-views-unit"> views</span>
        </div>

        {post === null ? (
          <span className="short-title unknown">{title}</span>
        ) : (
          <a className="short-title" href={post} target="_blank" rel="noreferrer noopener">
            {title}
          </a>
        )}
        {post === null ? (
          <span
            className="short-nolink"
            title="The post URL the source gave is not an http or https address, so it is not linked."
          >
            no usable link
          </span>
        ) : null}

        <div className="short-sub">
          {short.creator_handle === null ? (
            <span className="unknown">unknown creator</span>
          ) : creator === null ? (
            <span className="mono">{short.creator_handle}</span>
          ) : (
            <a className="link mono" href={creator} target="_blank" rel="noreferrer noopener">
              {short.creator_handle}
            </a>
          )}
          {short.topic_slug === null ? null : (
            <span className="short-topic" title="Found by searching for this subject.">
              {short.topic_slug}
            </span>
          )}
        </div>

        {flag ? <div className="short-flags">{flag}</div> : null}
      </div>

      {footer ? <div className="short-card-foot">{footer}</div> : null}
    </article>
  );
}
