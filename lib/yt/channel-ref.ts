/**
 * Turning whatever a human pasted into something the API can be asked about.
 *
 * The team pastes "reference channel links". In practice that is any of:
 *
 *   https://www.youtube.com/@somehandle
 *   https://youtube.com/@somehandle/shorts
 *   https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
 *   https://www.youtube.com/c/SomeLegacyName
 *   https://www.youtube.com/user/SomeVeryLegacyName
 *   @somehandle
 *   somehandle
 *   UCxxxxxxxxxxxxxxxxxxxxxx
 *
 * Only the last of those is directly usable. Everything else needs a
 * `channels.list` resolve (1 unit) before anything cheap can happen, so the
 * parse result says WHICH — `resolved` costs nothing, `handle`/`legacy` costs a
 * lookup. Nothing here calls the API; this file is pure so it can be tested
 * without a key, and it is where the pasted-link mess stops.
 *
 * NOTE ON `/c/` AND `/user/`: the Data API has no endpoint that resolves a
 * legacy custom URL. `forHandle` exists, `forUsername` exists for the very old
 * `/user/` form, and `/c/` has neither. That is recorded as a known gap rather
 * than papered over with a search fallback, because a `search.list` fallback
 * would spend one of the project's hundred daily search calls per pasted link.
 * That is not an expense, it is a ration: 101 pasted links and intake is over
 * for the day, and no amount of unspent unit budget buys the 101st back,
 * because `search.list` draws on a bucket of its own.
 *
 * SCAR (2026-09-04). This file used to justify all of the above with "a
 * `search.list` costs 100 units". It does not. Google's quota-cost table
 * (https://developers.google.com/youtube/v3/determine_quota_cost, fetched
 * 2026-09-04) prices `search.list`, `playlistItems.list`, `videos.list` and
 * `channels.list` at 1 unit each, and puts `search.list` in a separate bucket
 * with a default limit of 100 calls per day, alongside a 10,000-unit daily pool
 * shared by everything else. Every conclusion in this file survived that
 * correction unchanged; only the reason had to be rewritten, and it came out
 * sharper. What made the error catchable is worth keeping: lib/yt/cost.ts had
 * always labelled its figure a published CLAIM rather than a measured fact, so
 * when the claim changed there was an honest place to put the correction
 * instead of a number nobody could question.
 */

/** A channel id: `UC` followed by 22 characters of base64url. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A handle: 3-30 chars of letters, digits, underscore, hyphen, period. */
const HANDLE = /^[A-Za-z0-9._-]{3,30}$/;

export type ChannelRef =
  /** A canonical channel id. Free — no resolve call needed. */
  | { kind: "id"; channelId: string }
  /** An @handle. Resolvable with `channels.list?forHandle=` — 1 unit. */
  | { kind: "handle"; handle: string }
  /** A legacy `/user/` name. Resolvable with `channels.list?forUsername=` — 1 unit. */
  | { kind: "username"; username: string };

export class ChannelRefParseError extends Error {
  constructor(
    readonly raw: string,
    reason: string,
  ) {
    super(`Cannot read a channel out of ${JSON.stringify(raw)}: ${reason}`);
    this.name = "ChannelRefParseError";
  }
}

export function isChannelId(value: string): boolean {
  return CHANNEL_ID.test(value);
}

/**
 * The uploads playlist of a channel.
 *
 * Every channel has one, and its id is the channel id with the `UC` prefix
 * replaced by `UU`. This one substitution is the load-bearing fact of the whole
 * seeded path, and what it buys is not a discount — it is a different ration.
 *
 * `search.list` and `playlistItems.list` each cost 1 unit per call. The
 * difference is which allowance the call draws down. `search.list` has a bucket
 * of its own, capped at 100 calls a day, and that ceiling cannot be raised by
 * spending from anywhere else. `playlistItems.list` draws on the 10,000-unit
 * pool shared by every other endpoint, at 1 unit per 50 videos — effectively
 * unbounded for this workload. So the substitution turns "enumerate a channel"
 * from an act that consumes 1% of the day's discovery capacity into one that
 * consumes a rounding error of a pool we cannot exhaust. Without it, every
 * pasted link would eat one of only 100 daily search calls, and 101 links would
 * end the day. (Source: Google's quota-cost table,
 * https://developers.google.com/youtube/v3/determine_quota_cost, fetched
 * 2026-09-04. Google's own `search.list` reference separately advises against
 * using `search.list` to fetch a channel's recent uploads, which is this same
 * conclusion reached from their side.)
 *
 * And the substitution itself is free: it is arithmetic on an id we already
 * hold, not a lookup. Nothing is called to perform it.
 *
 * It is validated rather than assumed. Handing this function anything that is
 * not a real channel id produces a playlist id that 404s deep inside a paging
 * loop, which is a much worse place to find out.
 */
export function uploadsPlaylistId(channelId: string): string {
  if (!isChannelId(channelId)) {
    throw new ChannelRefParseError(
      channelId,
      "not a channel id (expected `UC` followed by 22 base64url characters)",
    );
  }
  return `UU${channelId.slice(2)}`;
}

/** Inverse of `uploadsPlaylistId`, for reading provenance back out of stored ids. */
export function channelIdFromUploadsPlaylist(playlistId: string): string {
  if (!/^UU[A-Za-z0-9_-]{22}$/.test(playlistId)) {
    throw new ChannelRefParseError(playlistId, "not an uploads playlist id");
  }
  return `UC${playlistId.slice(2)}`;
}

/** Parse a pasted link, handle or id. Never calls the network. */
export function parseChannelRef(raw: string): ChannelRef {
  const input = raw.trim();
  if (!input) throw new ChannelRefParseError(raw, "empty");

  if (isChannelId(input)) return { kind: "id", channelId: input };

  if (input.startsWith("@")) return handleRef(raw, input.slice(1));

  if (!/^[a-z]+:\/\//i.test(input) && !input.includes("/") && !input.includes(".")) {
    // A bare word. Handles are the only bare thing worth guessing at, and the
    // guess is cheap to check (1 unit) and unambiguous when it fails.
    return handleRef(raw, input);
  }

  const url = toUrl(input);
  if (!url) throw new ChannelRefParseError(raw, "not a channel id, a handle, or a URL");

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtu.be") {
    throw new ChannelRefParseError(raw, `not a youtube.com URL (host was ${url.hostname})`);
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) throw new ChannelRefParseError(raw, "the URL names no channel");

  const [first, second] = segments;

  if (first.startsWith("@")) return handleRef(raw, first.slice(1));

  if (first === "channel") {
    if (!second) throw new ChannelRefParseError(raw, "`/channel/` with no id after it");
    if (!isChannelId(second)) {
      throw new ChannelRefParseError(raw, `\`/channel/${second}\` is not a valid channel id`);
    }
    return { kind: "id", channelId: second };
  }

  if (first === "user") {
    if (!second) throw new ChannelRefParseError(raw, "`/user/` with no name after it");
    return { kind: "username", username: second };
  }

  if (first === "c") {
    // Deliberate refusal — see the file header. The only way to resolve a `/c/`
    // URL is `search.list`, which is rationed at 100 calls a day in a bucket of
    // its own. Spending one per pasted link means the 101st link finds intake
    // already over, for a reason nobody would connect back to here. Refusing
    // loudly costs the operator one copy-paste; the fallback costs a day.
    throw new ChannelRefParseError(
      raw,
      "legacy `/c/` custom URLs cannot be resolved by the Data API. Open the channel in a " +
        "browser and paste its `/@handle` or `/channel/UC...` URL instead",
    );
  }

  throw new ChannelRefParseError(raw, `unrecognised YouTube URL shape \`/${first}/\``);
}

function handleRef(raw: string, handle: string): ChannelRef {
  if (!HANDLE.test(handle)) {
    throw new ChannelRefParseError(raw, `\`@${handle}\` is not a valid handle`);
  }
  return { kind: "handle", handle };
}

function toUrl(input: string): URL | null {
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}
