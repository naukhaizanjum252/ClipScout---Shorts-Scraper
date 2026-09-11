/**
 * The shared Graph API layer.
 *
 * Three of the things in here are the kind that are only ever wrong in
 * production: a version that silently is not pinned, a token that leaks into an
 * error, and a usage header that throws while being parsed and takes down a
 * call whose body arrived perfectly. Each has a test below.
 *
 * NOTHING HERE TOUCHES META. `fetch` is replaced throughout; what is under test
 * is the URL, the envelope, the guidance, the budget and the scrubbing.
 */
import { describe, expect, it, vi } from "vitest";

import { safeToShowMessage } from "../shorts/run";

import {
  DEFAULT_CALLS_PER_HOUR,
  GRAPH_HOST,
  GRAPH_VERSION,
  GRAPH_VERSION_AVAILABLE_UNTIL,
  MetaApiError,
  MetaBudgetError,
  MetaCallBudget,
  MetaUnreadableError,
  edgeRows,
  graphUrl,
  metaGet,
  metaGuidance,
  parseMetaUsage,
  resolveMetaToken,
} from "./meta-client";

const TOKEN = "EAAG-not-a-real-token-0000";

function stub(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, urls };
}

describe("the version pin", () => {
  it("is an explicit version, never blank", () => {
    // An unpinned Graph API resolves to whatever default version Meta has
    // rolled the app to, so field sets move without a deploy.
    expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it("carries the date it stops being served, so the pin can be diarised", () => {
    // A pin whose end date is unknown is a pin nobody revisits until it breaks.
    expect(GRAPH_VERSION_AVAILABLE_UNTIL).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(GRAPH_VERSION_AVAILABLE_UNTIL)).toBeGreaterThan(Date.parse("2026-09-04"));
  });

  it("puts the version in every URL it builds", () => {
    expect(graphUrl("123/posts")).toBe(`${GRAPH_HOST}/${GRAPH_VERSION}/123/posts`);
  });
});

describe("graphUrl", () => {
  it("never carries the token — that is the whole reason it is a separate function", () => {
    const url = graphUrl("123", { fields: "id" });
    expect(url).not.toContain("access_token");
  });

  it("drops null and undefined params instead of sending them as strings", () => {
    // `?limit=null` is not "no limit"; Meta reads it literally.
    const url = new URL(graphUrl("123", { fields: "id", limit: null, after: undefined }));
    expect(url.searchParams.get("fields")).toBe("id");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("after")).toBe(false);
  });

  it("tolerates slashes on both sides of the join", () => {
    expect(graphUrl("/123", {}, { apiBase: "https://example.test/" })).toBe(
      `https://example.test/${GRAPH_VERSION}/123`,
    );
  });
});

describe("resolveMetaToken", () => {
  it("takes a plain string, an async function, or nothing", async () => {
    expect(await resolveMetaToken(TOKEN)).toBe(TOKEN);
    expect(await resolveMetaToken(async () => TOKEN)).toBe(TOKEN);
    expect(await resolveMetaToken(null)).toBeNull();
    expect(await resolveMetaToken(undefined)).toBeNull();
  });

  it("reads whitespace as no token at all", async () => {
    // An env var set to "" or " " is a configuration mistake, not a token.
    expect(await resolveMetaToken("   ")).toBeNull();
    expect(await resolveMetaToken(async () => null)).toBeNull();
  });
});

describe("parseMetaUsage — the only authoritative numbers there are", () => {
  it("reads the app usage percentages Meta reports back", () => {
    const usage = parseMetaUsage(
      new Headers({ "x-app-usage": '{"call_count":34,"total_cputime":12,"total_time":9}' }),
    );
    expect(usage.appCallCountPct).toBe(34);
    expect(usage.appCpuTimePct).toBe(12);
    expect(usage.appTotalTimePct).toBe(9);
  });

  it("takes the worst business use case and the wait it reports", () => {
    const usage = parseMetaUsage(
      new Headers({
        "x-business-use-case-usage":
          '{"999":[{"type":"pages","call_count":10,"estimated_time_to_regain_access":0},' +
          '{"type":"instagram","call_count":88,"estimated_time_to_regain_access":30}]}',
      }),
    );
    expect(usage.businessCallCountPct).toBe(88);
    expect(usage.estimatedTimeToRegainAccessMinutes).toBe(30);
  });

  it("returns nulls rather than zeros when the headers are absent", () => {
    // Zero usage and unknown usage are different facts, and only one of them
    // means it is safe to keep going.
    const usage = parseMetaUsage(new Headers());
    expect(usage.appCallCountPct).toBeNull();
    expect(usage.businessCallCountPct).toBeNull();
  });

  it("survives a malformed header without throwing", () => {
    // A reporting problem must never fail a call whose body arrived intact.
    expect(() => parseMetaUsage(new Headers({ "x-app-usage": "{not json" }))).not.toThrow();
    expect(parseMetaUsage(new Headers({ "x-app-usage": "{not json" })).appCallCountPct).toBeNull();
    expect(parseMetaUsage(null).appCallCountPct).toBeNull();
  });
});

describe("MetaCallBudget — a brake that refuses rather than sleeps", () => {
  it("defaults to the smallest sensible reading of Meta's published formula", () => {
    // "Calls within one hour = 200 * Number of Users", one user.
    expect(DEFAULT_CALLS_PER_HOUR).toBe(200);
    expect(new MetaCallBudget().ceiling).toBe(200);
  });

  it("allows exactly the ceiling and then refuses", () => {
    const budget = new MetaCallBudget(2);
    budget.take("instagram");
    budget.take("instagram");
    expect(() => budget.take("instagram")).toThrow(MetaBudgetError);
    expect(budget.spent()).toBe(2);
  });

  it("rolls, so a fixed-window boundary cannot let double through", () => {
    let clock = 0;
    const budget = new MetaCallBudget(2, () => clock);
    budget.take("facebook");
    budget.take("facebook");
    clock += 3_600_001;
    expect(() => budget.take("facebook")).not.toThrow();
    expect(budget.spent()).toBe(1);
  });

  it("explains itself with the formula rather than a bare number", () => {
    const budget = new MetaCallBudget(1);
    budget.take("instagram");
    expect(() => budget.take("instagram")).toThrow(/200 \* Number of Users/);
    expect(() => budget.take("instagram")).toThrow(/not a measurement/);
  });

  it("refuses to be constructed with a nonsense ceiling", () => {
    expect(() => new MetaCallBudget(0)).toThrow(RangeError);
    expect(() => new MetaCallBudget(1.5)).toThrow(RangeError);
  });
});

describe("metaGuidance — what to DO, not just what happened", () => {
  it("prefers the subcode, which is the specific answer", () => {
    // 190 alone says "get a new token". 190/460 says the password changed,
    // which is why — and only one of those tells somebody what happened.
    expect(metaGuidance(190, 460)).toMatch(/password changed/);
    expect(metaGuidance(190, null)).toMatch(/expired, been revoked/);
  });

  it("names the Page role for subcode 492, the likeliest Facebook failure", () => {
    expect(metaGuidance(190, 492)).toMatch(/role on this Page/);
  });

  it("treats the whole 200-299 range as App Review territory", () => {
    for (const code of [200, 250, 299]) {
      expect(metaGuidance(code, null)).toMatch(/App Review/);
    }
  });

  it("says nothing at all for a code it has not read in the docs", () => {
    // A guess dressed up as advice is worse than Meta's own message.
    expect(metaGuidance(999_999, null)).toBeNull();
    expect(metaGuidance(null, null)).toBeNull();
  });
});

describe("metaGet", () => {
  it("adds the token only at the moment of sending", async () => {
    const { impl, urls } = stub({ data: [] });
    const result = await metaGet<{ data: unknown[] }>({
      platform: "instagram",
      path: "123",
      params: { fields: "id" },
      token: TOKEN,
      fetchImpl: impl,
    });
    expect(new URL(urls[0] as string).searchParams.get("access_token")).toBe(TOKEN);
    // And the URL it hands back for logging does not carry it.
    expect(result.safeUrl).not.toContain(TOKEN);
  });

  it("scrubs the token out of an error body that echoed the request back", async () => {
    // Meta's error bodies quote request URLs often enough that this is not
    // theoretical.
    const { impl } = stub(
      { error: { message: `bad token ...?access_token=${TOKEN}`, code: 190, error_subcode: 463 } },
      { status: 400 },
    );
    const error = (await metaGet({
      platform: "facebook",
      path: "123",
      token: TOKEN,
      fetchImpl: impl,
    }).catch((e: Error) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.code).toBe(190);
    expect(error.subcode).toBe(463);
  });

  it("refuses a 200 that carried no readable JSON rather than calling it empty", async () => {
    // An unreadable answer and an empty one must never look the same.
    const { impl } = stub("<html>maintenance</html>");
    await expect(
      metaGet({ platform: "instagram", path: "123", token: TOKEN, fetchImpl: impl }),
    ).rejects.toThrow(/not being reported as 'nothing found'/);
  });

  it("turns a transport failure into a scrubbed MetaApiError", async () => {
    const impl = (async () => {
      throw new Error(`connect ECONNREFUSED for ?access_token=${TOKEN}`);
    }) as unknown as typeof globalThis.fetch;
    const error = (await metaGet({
      platform: "facebook",
      path: "123",
      token: TOKEN,
      fetchImpl: impl,
    }).catch((e: Error) => e)) as MetaApiError;
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(TOKEN);
  });

  it("charges the budget before the request, not after", async () => {
    const budget = new MetaCallBudget(0 + 1);
    budget.take("instagram");
    const { impl } = stub({ data: [] });
    await expect(
      metaGet({ platform: "instagram", path: "123", token: TOKEN, fetchImpl: impl, budget }),
    ).rejects.toBeInstanceOf(MetaBudgetError);
    expect(impl).not.toHaveBeenCalled();
  });

  it("returns the usage it read off the response", async () => {
    const { impl } = stub({ data: [] }, { headers: { "x-app-usage": '{"call_count":7}' } });
    const { usage } = await metaGet({
      platform: "instagram",
      path: "123",
      token: TOKEN,
      fetchImpl: impl,
    });
    expect(usage.appCallCountPct).toBe(7);
  });
});

describe("edgeRows", () => {
  it("gives back the rows, or an empty array for anything else", () => {
    expect(edgeRows({ data: [1, 2] })).toEqual([1, 2]);
    expect(edgeRows({})).toEqual([]);
    expect(edgeRows(null)).toEqual([]);
    expect(edgeRows(undefined)).toEqual([]);
  });
});

// ================ the sentences the Meta adapters wrote for a person to read

/**
 * SCAR, 2026-09-08. Neither of these was marked `markSafeToShow`, so every
 * carefully-worded refusal the three Meta adapters compose went to a log file
 * and /admin/shorts printed "the thrown message is in this deployment's server
 * log" instead. Each of those messages ends by naming what it is REFUSING to
 * do — "it is not being reported as 'no shorts found'" — which is the exact
 * sentence the honesty rule exists to put in front of somebody.
 */
describe("a Meta refusal composed here is fit to print", () => {
  it("shows the unreadable-listing refusal, which names its own likely cause", () => {
    const error = new MetaUnreadableError(
      "instagram",
      "Business Discovery for @someone answered without a business_discovery block. That is an " +
        "unreadable response, not an empty account.",
    );
    expect(safeToShowMessage(error)).toMatch(/unreadable response, not an empty account/);
  });

  it("shows the budget refusal, which is arithmetic done here and never sent", () => {
    const message = safeToShowMessage(new MetaBudgetError("facebook", 200, 200));
    expect(message).toMatch(/200\/200 calls already made/);
    expect(message).toMatch(/no request was sent/);
  });

  it("still hides MetaApiError, because it carries Meta's own text", async () => {
    // The line the rule is drawn on: an error whose message quotes an outside
    // system stays in the log, exactly as `ScrapeCreatorsError` does.
    const { impl } = stub({ error: { message: "nope", code: 100 } }, { status: 400 });
    const error = await metaGet({
      platform: "instagram",
      path: "123",
      token: TOKEN,
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(safeToShowMessage(error)).toBeNull();
  });
});
