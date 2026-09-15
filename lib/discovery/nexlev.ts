/**
 * NEXLEV — a third-party YouTube research API, used as an OPTIONAL discovery
 * booster for the self-growing channel lists (lib/shorts/nexlev-boost.ts).
 *
 * It answers ONE question this repo cannot answer from its own run data: "what
 * other YouTube channels are like this one?" The evidence-based grow adopts the
 * creators that already performed for a topic; NexLev broadens that to their
 * lookalikes. It is YouTube-only (NexLev is a YouTube tool) and strictly
 * optional — absent a key, the grow loop stands on its own.
 *
 * ---------------------------------------------------------------------------
 * THE QUOTA IS THE WHOLE DESIGN CONSTRAINT.
 * ---------------------------------------------------------------------------
 *
 * `/api/external/similar-channels/search` costs 20 quota per request against a
 * ~5,000/month API tier — about 250 calls a MONTH, ~8 a day. So nothing here
 * may be called per run or per topic on a loop. The caller (nexlev-boost.ts)
 * spends it against a per-channel "seeded once" marker and a small per-run
 * budget, so total calls track how many NEW channels appear rather than how
 * often a run fires. This client is the thin, honest HTTP seam under that.
 *
 * THE KEY NEVER LEAKS. It rides in an `Authorization: Bearer` header, and every
 * error message is scrubbed of it before it can reach a log or a screen — the
 * same rule the ScrapeCreators and Meta clients keep.
 */
import { scrub } from "../credentials/mask";

const BASE_URL = "https://prod.dashboard.nexlev.io";
const SIMILAR_CHANNELS_PATH = "/api/external/similar-channels/search";

/** One similar channel NexLev returned, reduced to what the booster ranks on. */
export interface SimilarChannel {
  /** The `UC…` channel id — the identifier a run enumerates a YouTube channel by. */
  readonly channelId: string;
  /** NexLev's 0–100 relevance score. The booster keeps only the strong matches. */
  readonly similarityScore: number;
  /** For a human-readable log / note; not used in any decision. */
  readonly channelName: string | null;
  readonly subscriberCount: number | null;
}

export class NexLevError extends Error {
  constructor(
    message: string,
    /** Seconds to wait, from a 429 `retryAfter`, when the API said so. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "NexLevError";
  }
}

export interface NexLevClientOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class NexLevClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: NexLevClientOptions) {
    if (!options.apiKey.trim()) throw new NexLevError("A NexLev API key is required.");
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Channels similar to `channelId` (a `UC…` YouTube channel id), strongest
   * first. `channelType: "all"` and `level: 1` match the documented defaults —
   * one hop of lookalikes across long-form and shorts.
   *
   * COSTS 20 QUOTA. Every caller must treat this as expensive; see the header.
   */
  async similarChannels(channelId: string): Promise<SimilarChannel[]> {
    const id = channelId.trim();
    if (!id) throw new NexLevError("A channelId is required.");

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${SIMILAR_CHANNELS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channelId: id, channelType: "all", level: 1 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new NexLevError(`NexLev request failed: ${this.safe(cause)}`);
    }

    if (response.status === 429) {
      const retry = await this.retryAfter(response);
      throw new NexLevError(
        `NexLev rate limit reached (429). Its quota is small — back off and try later.`,
        retry,
      );
    }
    if (!response.ok) {
      throw new NexLevError(`NexLev answered ${response.status} for a similar-channels request.`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new NexLevError(`NexLev sent a response that was not JSON: ${this.safe(cause)}`);
    }

    return parseSimilarChannels(body);
  }

  /** `retryAfter` from the body if present, else the `Retry-After` header, else null. */
  private async retryAfter(response: Response): Promise<number | null> {
    try {
      const body = (await response.json()) as { retryAfter?: unknown };
      const fromBody = finiteNumber(body?.retryAfter);
      if (fromBody !== null) return fromBody;
    } catch {
      // Fall through to the header.
    }
    return finiteNumber(response.headers.get("retry-after"));
  }

  /** A message safe to log: the key is removed even though it travels in a header. */
  private safe(cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : String(cause);
    return scrub(raw, this.apiKey).slice(0, 300);
  }
}

/**
 * Parse the documented response — `{ data: [ { about: { channelId, ... },
 * similarityScore } ] }` — keeping only rows that carry a real `UC…` id and a
 * numeric score. Anything malformed is dropped rather than guessed at.
 */
export function parseSimilarChannels(body: unknown): SimilarChannel[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return [];
  const out: SimilarChannel[] = [];
  for (const entry of data) {
    const row = asRecord(entry);
    if (!row) continue;
    const about = asRecord(row.about);
    const channelId = nonEmptyString(about?.channelId);
    const score = finiteNumber(row.similarityScore);
    if (channelId === null || score === null) continue;
    out.push({
      channelId,
      similarityScore: score,
      channelName: nonEmptyString(about?.channelName),
      subscriberCount: finiteNumber(about?.subscriberCount),
    });
  }
  return out.sort((a, b) => b.similarityScore - a.similarityScore);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
