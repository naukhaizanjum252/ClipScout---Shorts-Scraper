// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreditsBar } from "@/app/(admin)/admin/credentials/credits-panel";
import type { CreditBalanceOutcome } from "@/app/(admin)/admin/credentials/view";
import { ENDPOINTS, readScrapeCreatorsCreditBalance } from "@/lib/platform/scrapecreators";

/**
 * THE CREDIT BALANCE: WHAT IT COSTS TO ASK, AND WHAT THE PAGE MAY CLAIM.
 *
 * Erik, 2026-09-05: *"can we do a poll for how many credits are available and
 * how big the pool of credits are? ... Here we can also give a prediction of
 * how many credits a run would cost."*
 *
 * WHAT THIS FILE IS REALLY GUARDING is not the arithmetic — it is the three
 * places where this feature could quietly start lying or quietly start
 * spending:
 *
 *   1. THE POLL THAT MUST NOT EXIST. `/v1/account/credit-balance` costs one
 *      credit per request, so anything that calls it on a timer bills the
 *      operator to watch a number. The cases below pin the call to ONE request
 *      per invocation, including across a 5xx, because a retry loop is a poll
 *      with a different name.
 *   2. THE POOL SIZE THAT CANNOT BE KNOWN. ScrapeCreators publishes no
 *      "credits purchased" figure. The bar is scaled against the highest
 *      balance observed, and the page has to SAY that rather than imply a
 *      percentage of a purchase.
 *   3. THE PREDICTION THAT IS A FLOOR. Billing is per request and a seed may
 *      cost more than one, so the figure must read as "at least". A prediction
 *      that reads as a ceiling is the one an operator budgets against.
 *
 * THE FIXTURE IS BUILT FROM THE DOCUMENTED RESPONSE, read 2026-09-05 from
 * https://docs.scrapecreators.com/v1/account/credit-balance, and NOT recorded
 * from a live call — there is still no ScrapeCreators key on this machine. It
 * proves the parser, never the API. The same caveat the sibling
 * lib/platform/scrapecreators.test.ts opens with applies here in full.
 */

const KEY = "sc-test-key-not-a-real-one";

/** The documented body, verbatim in shape. */
const DOCUMENTED = {
  success: true,
  credits_remaining: 1_000_000,
  credits_charged: 1,
  creditCount: 333,
};

function stubFetch(...replies: Array<{ status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let index = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls, headers };
}

afterEach(cleanup);

describe("reading the balance from ScrapeCreators", () => {
  it("returns credits_remaining from the documented body", async () => {
    const f = stubFetch({ body: DOCUMENTED });
    const credits = await readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn });
    expect(credits).toBe(1_000_000);
  });

  it("asks the documented endpoint, with the key in the header and never in the URL", async () => {
    const f = stubFetch({ body: DOCUMENTED });
    await readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn });

    expect(f.calls[0]).toContain(ENDPOINTS.accountCreditBalance);
    expect(f.headers[0]?.["x-api-key"]).toBe(KEY);
    // A key in a query string ends up in access logs, error messages and
    // referrer headers. This vendor takes it in a header and it stays there.
    expect(f.calls[0]).not.toContain(KEY);
  });

  it("spends exactly one request per call, even when the vendor 5xxs", async () => {
    // THE ANTI-POLL CASE. The client retries 5xx up to three times on ordinary
    // reads; a balance check must not, because each attempt is another credit
    // spent to answer a question about credits.
    const f = stubFetch({ status: 500, body: { message: "upstream" } });
    await expect(readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it("refuses rather than reporting zero when neither credit field is present", async () => {
    // Zero means "you are out of credits" — a different and far more alarming
    // claim than "they did not say". A reply with neither `credits_remaining`
    // nor `creditCount` is the "they did not say" case, and it must refuse.
    const f = stubFetch({ body: { success: true, credits_charged: 1 } });
    await expect(readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn })).rejects.toThrow(
      /neither `credits_remaining` nor a usable `creditCount`/,
    );
  });

  /**
   * THE FOUR CASES BELOW ARE ABOUT WHAT A SPENT CREDIT BUYS.
   *
   * Erik pressed Check balance against the live account on 2026-09-05 and got
   * back a complaint that named the missing field and nothing else — a fact he
   * had before pressing. The vendor is not obliged to keep its documented
   * shape, but a 200 that fails to parse must at least say what it contained,
   * because the alternative is buying the same shrug again to find out.
   */
  it("names what the reply did carry, so one credit buys the diagnosis", async () => {
    // Neither balance field is present, so it refuses — and the shape of what
    // DID come back travels with the refusal, so the operator is not billed a
    // second credit just to learn what the reply looked like.
    const f = stubFetch({ body: { success: true, credits_charged: 1 } });
    await expect(readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn })).rejects.toThrow(
      /success=true, credits_charged=1/,
    );
  });

  it("reads `creditCount` as the balance when `credits_remaining` is absent", async () => {
    // 2026-09-09: the live endpoint dropped `credits_remaining` and returned
    // `creditCount` as the balance, confirmed by its own message ("You have
    // 25100 credits remaining"). So a reply carrying only `creditCount` is read
    // from it. `credits_remaining` still wins when both are present — see the
    // documented-body case above, which returns 1,000,000 and not 333.
    const f = stubFetch({ body: { success: true, creditCount: 333 } });
    const credits = await readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn });
    expect(credits).toBe(333);
  });

  it("distinguishes a 200 with no JSON at all from a 200 missing one field", async () => {
    // A reply that is not JSON and a reply missing the field produce the same
    // undefined in the parser and used to produce the same sentence, which sent
    // whoever read it looking at the wrong half of the problem.
    const f = stubFetch({ body: undefined });
    await expect(readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn })).rejects.toThrow(
      /carried no JSON fields at all/,
    );
  });

  it("never puts a string value from the reply into the error", async () => {
    // THE LEAK THIS CLOSES. The 200 branch is the one path that does not run
    // through `scrub`, so a vendor echoing the request back — plenty do — would
    // walk the key into a message the credentials page renders. Names and
    // numbers travel; string contents do not.
    const f = stubFetch({ body: { success: true, sent_key: KEY } });
    const error = await readScrapeCreatorsCreditBalance(KEY, { fetch: f.fn }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error, "the balance was read from a reply that has no balance in it").not.toBeNull();
    expect(error?.message).toContain("sent_key (string)");
    expect(error?.message).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------

function renderPanel(over: Partial<Parameters<typeof CreditsBar>[0]> = {}) {
  const check = vi.fn(async (): Promise<CreditBalanceOutcome> => ({
    ok: true,
    credits: 24_000,
    highWaterMark: 25_000,
    readAt: "2026-09-05T10:00:00.000Z",
    charged: true,
  }));
  render(<CreditsBar seedRequests={12} hasKey canCheck check={check} {...over} />);
  return { check };
}

describe("what the credit bar may claim", () => {
  /**
   * IT IS A BAR NOW, NOT A PANEL. Erik, 2026-09-05, arrows on a screenshot:
   * kill the Store box, and "move B to a single bar with numbers at the bottom
   * of the ScraperCreators key box (hide it if there are no keys)". The cases
   * below are the same guarantees restated against a line of numbers instead
   * of a card of sentences — the claims did not weaken because the words got
   * shorter, and the symbols now carry what the caveats used to spell out.
   */
  it("prices a run as a floor, never as a quote", () => {
    renderPanel();
    // The caveat rides on the symbol now: >=12 per run, never a flat 12.
    // Billing is per request and a seed spanning pages costs another credit.
    expect(screen.getByText(/\u226512\/run/)).toBeTruthy();
  });

  it("does not call the vendor on mount, because asking costs a credit", () => {
    // THE POLL THAT MUST NOT EXIST. If this ever goes red, something started
    // fetching the balance on render — which on a page an operator leaves open
    // is a slow drain on the balance it is displaying.
    const { check } = renderPanel();
    expect(check).not.toHaveBeenCalled();
  });

  it("puts the price of a press on the control that charges it", () => {
    // The price moved INTO the button label when the caption line went with
    // the panel. It must not simply have been dropped.
    renderPanel();
    expect(screen.getByRole("button", { name: /Check balance \(1 credit\)/ })).toBeTruthy();
  });

  it("shows no figure until somebody asks", () => {
    renderPanel();
    expect(document.body.textContent).toMatch(/not checked/i);
  });

  it("renders nothing at all when no key is saved", () => {
    // THE HIDE RULE Erik asked for by name. With no key there is no account,
    // no balance and nothing to spend, so the bar is absent rather than a line
    // explaining its own emptiness underneath an empty form.
    const { container } = render(
      <CreditsBar
        seedRequests={12}
        hasKey={false}
        canCheck
        check={async () => ({
          ok: true as const,
          credits: 1,
          highWaterMark: 1,
          readAt: "",
          charged: true,
        })}
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the balance once asked, as a plain number", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Check balance/ }));

    expect(await screen.findByText(/24,000 left/)).toBeTruthy();
  });

  it("has no meter, so no guessed denominator can creep back", () => {
    // The old panel drew a progress bar scaled to the highest balance ever
    // observed — an observation standing in for a purchase figure
    // ScrapeCreators does not publish anywhere. Dropping it was an honesty
    // gain, not a loss: a number needs no denominator to be true. If a meter
    // ever returns, whatever it divides by has to be defended first.
    renderPanel();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("rounds runs-covered down, so a floor cost cannot imply an optimistic ceiling", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Check balance/ }));
    // 24,000 / 12 = 2,000, and it has to read as a ceiling: <=, never a bare
    // "2,000 runs" that an operator would budget against.
    expect(await screen.findByText(/\u22642,000 runs/)).toBeTruthy();
  });

  it("says a run spends nothing when there are no seeds, without implying a key problem", () => {
    renderPanel({ seedRequests: 0 });
    expect(document.body.textContent).toMatch(/no seeds, so a run spends nothing/i);
    // And it does not send anybody to a page that no longer exists: seeds
    // stopped being a manual task on 2026-09-05 and that screen is deleted.
    expect(document.body.textContent).not.toMatch(/Seeds page/i);
  });

  it("offers no button to a viewer who may not spend the operator's credits", () => {
    renderPanel({ canCheck: false });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a refusal instead of leaving the last figure on screen", async () => {
    const user = userEvent.setup();
    renderPanel({
      check: vi.fn(async () => ({ ok: false as const, message: "The key was rejected (401)." })),
    });
    await user.click(screen.getByRole("button", { name: /Check balance/ }));

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "The key was rejected (401).",
    );
    // And no stale figure is left sitting beside the error.
    expect(document.body.textContent).not.toMatch(/left/);
  });
});
