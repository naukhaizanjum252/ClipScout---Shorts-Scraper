/**
 * YouTube Data API v3 client — key auth, pagination, quota accounting.
 *
 * Ported from `twitch-faceless/tf/helix.py`, which solves the same problem one
 * platform over: one session, follow the cursor, treat a throttle as a fact
 * about the world rather than an exception to retry blindly. Two things are
 * different here and both matter:
 *
 * 1. THERE IS NO TOKEN. Helix needs a client_credentials dance and an on-disk
 *    token cache. The Data API takes a key on the query string, so there is no
 *    cache, no refresh and no 401-then-retry path. The key is read once from
 *    config and NEVER appears in an error message, a log line or an artifact —
 *    `redact()` below is the only thing that formats a URL.
 *
 * 2. EVERY CALL DECLARES ITS COST. `call()` cannot be invoked without naming an
 *    `Operation`, and naming one is what charges the budget. A call site that
 *    could forget to say what it is issuing is a call site that will one day
 *    spend a day's allowance in a loop.
 *
 * THE BUDGET IS NOT A RATE LIMIT. `budgetUnits` stops the run *before* the call
 * that would exceed it, so hitting the ceiling is a clean, logged, resumable
 * outcome instead of a 403 that arrives halfway through a page. Discovering your
 * way into `quotaExceeded` means the day is over and you find out by failing;
 * stopping at a budget means the day is over and you find out by being told.
 *
 * THE BUDGET IS ALSO NOT A BUCKET CEILING, AND THAT IS A KNOWN GAP.
 *
 * A project has TWO daily allowances, not one: a 10,000-unit pool shared by
 * `playlistItems.list`, `videos.list`, `channels.list` and the rest, and a
 * separate bucket for `search.list` limited to 100 CALLS per day. All four
 * operations cost 1 unit each (Google's quota-cost table,
 * https://developers.google.com/youtube/v3/determine_quota_cost, fetched
 * 2026-09-04), so `spent` cannot tell the two apart: a hundred search calls and
 * a hundred playlist pages charge this client the same 100 units, and only one
 * of them has ended the day for its endpoint.
 *
 * SCAR (2026-09-04). This header used to say the design "rests on knowing that
 * a `search.list` costs 100x an uploads-playlist page". It does not cost 100x;
 * it costs the same and is rationed instead. The conclusion the repo drew from
 * the wrong number — walk the uploads playlist, never enumerate through search —
 * is unchanged and now rests on a harder constraint, because a ration cannot be
 * bought off with unspent units the way a price can. What is NOT fixed is this
 * client: it models units and has no notion of a per-endpoint call ceiling, so a
 * loop over `search.list` would pass every budget check here and still die at
 * the 100th call. That is tolerable only because nothing in this repo issues a
 * `search.list` and the seeded path is built so that nothing needs to. If a
 * caller ever does, this client needs a per-bucket CALL counter first — not a
 * larger `budgetUnits`, which would not help at all. The table already carries
 * what such a counter would read (`bucketOf` and `declaredDailyCallCeiling` in
 * ./cost); this client simply does not consult them yet, and saying so here is
 * cheaper than discovering it at the 100th call.
 */
import { COSTS, declaredUnits, maxPageSize, type Operation } from "./cost";

const API_BASE = "https://www.googleapis.com/youtube/v3";

// --------------------------------------------------------------------- errors

export class YouTubeApiError extends Error {
  constructor(
    readonly operation: Operation,
    readonly status: number,
    readonly reason: string | null,
    detail: string,
  ) {
    super(`${operation} failed (${status}${reason ? ` ${reason}` : ""}): ${detail}`);
    this.name = "YouTubeApiError";
  }
}

/**
 * The API says a daily allowance is gone. Which one it means — the 10,000-unit
 * shared pool or the separate 100-call `search.list` bucket — is not something
 * this error is asked to distinguish, because neither refills today and the
 * response to both is identical. Terminal for the day: nothing retries out of
 * this, and callers must record it on the run rather than looping.
 */
export class QuotaExceededError extends YouTubeApiError {
  constructor(operation: Operation, detail: string) {
    super(operation, 403, "quotaExceeded", detail);
    this.name = "QuotaExceededError";
  }
}

/** The client's own ceiling, hit before the call went out. Not an API error. */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly operation: Operation,
    readonly spentUnits: number,
    readonly budgetUnits: number,
    readonly wouldCost: number,
  ) {
    super(
      `budget exhausted: ${operation} would cost ${wouldCost} declared units, ` +
        `${spentUnits}/${budgetUnits} already spent. No request was sent.`,
    );
    this.name = "BudgetExhaustedError";
  }
}

// ---------------------------------------------------------------- call ledger

/**
 * One issued request, as observed. This is the raw material `verify/quota.ts`
 * turns into a recording — which is why it holds what was SEEN (status, items,
 * timing) separately from what was CLAIMED (`declaredUnits`).
 */
export interface CallRecord {
  readonly operation: Operation;
  /** ISO timestamp the request went out. */
  readonly at: string;
  readonly status: number;
  /** Google's `error.errors[0].reason`, when the response carried one. */
  readonly reason: string | null;
  /** Units our cost table SAYS this cost. Not a measurement. */
  readonly declaredUnits: number;
  /** Items in the response body's `items` array, or null if there was none. */
  readonly items: number | null;
  /** `pageInfo.totalResults` when present — the API's own count. */
  readonly totalResults: number | null;
  /** Whether the response carried a `nextPageToken`. */
  readonly hasNextPage: boolean;
  readonly durationMs: number;
  /** Query parameter names sent, sorted. NEVER the values, and never the key. */
  readonly paramNames: readonly string[];
}

// --------------------------------------------------------------------- client

export interface YouTubeClientOptions {
  readonly apiKey: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Hard ceiling in DECLARED units for this client's lifetime. `null` means no
   * ceiling, which is only ever right for a single measured call.
   */
  readonly budgetUnits?: number | null;
  /** Injectable clock/sleep so retry backoff is instant under test. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Attempts per request for 429 / 5xx. Default 4. */
  readonly maxAttempts?: number;
}

export type Params = Record<string, string | number | undefined>;

export class YouTubeClient {
  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  readonly budgetUnits: number | null;

  private spent = 0;
  private readonly ledger: CallRecord[] = [];

  constructor(opts: YouTubeClientOptions) {
    if (!opts.apiKey) throw new Error("YouTubeClient needs an API key.");
    this.apiKey = opts.apiKey;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.budgetUnits = opts.budgetUnits ?? null;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.maxAttempts = opts.maxAttempts ?? 4;
  }

  /** Declared units charged so far. */
  get spentUnits(): number {
    return this.spent;
  }

  /** Declared units left before the budget stops the run, or null if unbounded. */
  get remainingUnits(): number | null {
    return this.budgetUnits === null ? null : this.budgetUnits - this.spent;
  }

  /** Every request issued, oldest first. The quota harness reads this. */
  get calls(): readonly CallRecord[] {
    return this.ledger;
  }

  /** Would `op` fit in what is left? Callers check this to stop cleanly. */
  canAfford(op: Operation): boolean {
    return this.budgetUnits === null || this.spent + declaredUnits(op) <= this.budgetUnits;
  }

  /**
   * Issue one request. Charges the budget BEFORE the network call, so a crash
   * mid-flight never under-reports spend — the units are gone either way.
   */
  async call<T = unknown>(op: Operation, params: Params): Promise<T> {
    const cost = declaredUnits(op);
    if (!this.canAfford(op)) {
      throw new BudgetExhaustedError(op, this.spent, this.budgetUnits as number, cost);
    }
    this.spent += cost;

    const url = this.buildUrl(op, params);
    const paramNames = Object.keys(params)
      .filter((k) => params[k] !== undefined)
      .sort();

    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const started = this.now();
      let response: Response;
      try {
        response = await this.doFetch(url, {
          headers: { accept: "application/json", "user-agent": "shorts-scraper/0.1" },
        });
      } catch (cause) {
        lastError = cause;
        await this.backoff(attempt);
        continue;
      }
      const body = await readJson(response);
      const reason = errorReason(body);

      this.ledger.push({
        operation: op,
        at: new Date(started).toISOString(),
        status: response.status,
        reason,
        declaredUnits: cost,
        items: Array.isArray((body as { items?: unknown })?.items)
          ? ((body as { items: unknown[] }).items.length as number)
          : null,
        totalResults: totalResults(body),
        hasNextPage: typeof (body as { nextPageToken?: unknown })?.nextPageToken === "string",
        durationMs: this.now() - started,
        paramNames,
      });

      if (response.ok) return body as T;

      // Terminal for the day. Never retried — the units do not come back.
      if (response.status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
        throw new QuotaExceededError(op, errorMessage(body) ?? "daily quota exhausted");
      }

      if (response.status === 429 || (response.status === 403 && reason === "rateLimitExceeded")) {
        lastError = new YouTubeApiError(op, response.status, reason, errorMessage(body) ?? "rate limited");
        await this.backoff(attempt, response.headers.get("retry-after"));
        continue;
      }

      if (response.status >= 500) {
        lastError = new YouTubeApiError(op, response.status, reason, errorMessage(body) ?? "server error");
        await this.backoff(attempt);
        continue;
      }

      throw new YouTubeApiError(op, response.status, reason, errorMessage(body) ?? redact(url));
    }

    if (lastError instanceof YouTubeApiError) throw lastError;
    throw new YouTubeApiError(
      op,
      0,
      null,
      `no response after ${this.maxAttempts} attempts: ${String(lastError)}`,
    );
  }

  /**
   * Follow `nextPageToken` until `limit` items or the pages run out.
   *
   * Stops cleanly on the budget instead of throwing, because a paged walk that
   * ran out of budget has still produced everything it yielded — the caller
   * checks `remainingUnits` and resumes tomorrow. That is the `tf/collect.py`
   * rule: a kill costs one item, not the run.
   */
  async *paginate<T = unknown>(
    op: Operation,
    params: Params,
    limit = Number.POSITIVE_INFINITY,
  ): AsyncGenerator<T, void, undefined> {
    const perPage = Math.min(maxPageSize(op), Number.isFinite(limit) ? Math.max(1, limit) : maxPageSize(op));
    let pageToken: string | undefined;
    let yielded = 0;

    while (yielded < limit) {
      if (!this.canAfford(op)) return;
      const body = await this.call<{ items?: T[]; nextPageToken?: string }>(op, {
        ...params,
        maxResults: perPage,
        pageToken,
      });
      const items = body.items ?? [];
      if (items.length === 0) return;
      for (const item of items) {
        yield item;
        if (++yielded >= limit) return;
      }
      if (!body.nextPageToken) return;
      pageToken = body.nextPageToken;
    }
  }

  private buildUrl(op: Operation, params: Params): string {
    const url = new URL(`${API_BASE}/${COSTS[op].path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set("key", this.apiKey);
    return url.toString();
  }

  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const header = retryAfter ? Number(retryAfter) : Number.NaN;
    const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt;
    await this.sleep(Math.min(seconds, 60) * 1000);
  }
}

// --------------------------------------------------------------------- helpers

/**
 * The only function allowed to turn a request URL into a string a human reads.
 * The API key travels on the query string, so an un-redacted URL in a thrown
 * error is a credential in a log file.
 */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("key")) u.searchParams.set("key", "REDACTED");
    return u.toString();
  } catch {
    return "[unparseable url]";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorReason(body: unknown): string | null {
  const errors = (body as { error?: { errors?: Array<{ reason?: string }> } })?.error?.errors;
  const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
  return typeof reason === "string" ? reason : null;
}

function errorMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: string } })?.error?.message;
  return typeof message === "string" ? message : null;
}

function totalResults(body: unknown): number | null {
  const n = (body as { pageInfo?: { totalResults?: number } })?.pageInfo?.totalResults;
  return typeof n === "number" ? n : null;
}
