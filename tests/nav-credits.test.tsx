// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NavCredits } from "@/app/(admin)/admin/nav-credits";
import { writeCreditCache } from "@/app/(admin)/admin/credit-cache";
import type { CreditBalanceOutcome } from "@/app/(admin)/admin/credentials/view";

/**
 * THE CREDIT CHIP IN THE RAIL, UNDER TEST.
 *
 * The chip's whole reason for existing the way it does is a cost: reading the
 * balance charges a credit, so the tool must never fetch it on its own. These
 * cases assert that discipline (no call on mount), the hide rule (no key, no
 * chip), and the one honest thing a free readout can be — the last value a
 * person deliberately checked, read back from storage with its age.
 */
afterEach(() => {
  cleanup();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

const ok = (credits: number, readAt = new Date().toISOString()): CreditBalanceOutcome => ({
  ok: true,
  credits,
  highWaterMark: credits,
  readAt,
  charged: true,
});

describe("the credit chip in the rail", () => {
  it("renders nothing at all when no key is saved", () => {
    const check = vi.fn(async () => ok(1000));
    render(<NavCredits hasKey={false} canCheck check={check} />);

    expect(screen.queryByText(/credits/i)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  /**
   * THE ASSERTION THE COST TURNS ON. A chip that read the balance on mount would
   * spend a credit every time any admin page loaded — the biggest single
   * consumer of the thing it displays. It must wait for a press.
   */
  it("does not read the balance on mount — a read costs a credit", async () => {
    const check = vi.fn(async () => ok(1000));
    render(<NavCredits hasKey canCheck check={check} />);

    // Give any stray effect a tick to fire before asserting it did not.
    await waitFor(() => expect(screen.getByText(/not checked here yet/i)).toBeTruthy());
    expect(check).not.toHaveBeenCalled();
  });

  it("reads the live balance only when the button is pressed, and shows it", async () => {
    const user = userEvent.setup();
    const check = vi.fn(async () => ok(25_100));
    render(<NavCredits hasKey canCheck check={check} />);

    await user.click(screen.getByRole("button", { name: /check/i }));

    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("25,100")).toBeTruthy();
  });

  /**
   * The press is priced ON the control that charges it, the same discipline the
   * credentials bar keeps. Without this a future tidy-up could drop the "1
   * credit" and leave a button that quietly spends money.
   */
  it("says on the button what the press costs", () => {
    render(<NavCredits hasKey canCheck check={async () => ok(1000)} />);

    expect(screen.getByRole("button", { name: /1 credit/i })).toBeTruthy();
  });

  it("shows the last checked balance from storage without pressing anything", async () => {
    localStorage.setItem(
      "clipscout.credits.last",
      JSON.stringify({ credits: 42_000, readAt: new Date().toISOString() }),
    );
    const check = vi.fn(async () => ok(1));
    render(<NavCredits hasKey canCheck check={check} />);

    expect(await screen.findByText("42,000")).toBeTruthy();
    // A restored figure is still a free readout: nothing was fetched to show it.
    expect(check).not.toHaveBeenCalled();
  });

  /**
   * A viewer who may not spend the operator's credits gets the figure but not
   * the button — the same split the credentials bar makes with `canCheck`.
   */
  it("hides the check button when the viewer may not spend credits", () => {
    render(<NavCredits hasKey canCheck={false} check={async () => ok(1000)} />);

    expect(screen.getByText(/credits/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /check/i })).toBeNull();
  });

  /**
   * THE FIX FOR "I STILL DON'T SEE CREDITS". A check on the credentials page
   * writes the one shared cache, and the rail chip must reflect it live — not
   * only after a reload — or the operator checks their balance and the chrome
   * goes on saying it was never checked.
   */
  it("updates live when a check elsewhere writes the shared cache", async () => {
    const check = vi.fn(async () => ok(1));
    render(<NavCredits hasKey canCheck check={check} />);
    await waitFor(() => expect(screen.getByText(/not checked here yet/i)).toBeTruthy());

    // Something else (e.g. the credentials bar) records a fresh balance.
    writeCreditCache({ credits: 30_500, readAt: new Date().toISOString() });

    expect(await screen.findByText("30,500")).toBeTruthy();
    // And nothing on the rail spent a credit to show it.
    expect(check).not.toHaveBeenCalled();
  });

  it("surfaces a failed check rather than a stale number", async () => {
    const user = userEvent.setup();
    const check = vi.fn(async (): Promise<CreditBalanceOutcome> => ({
      ok: false,
      message: "No ScrapeCreators key is saved, so there is no account to ask.",
    }));
    render(<NavCredits hasKey canCheck check={check} />);

    await user.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/no scrapecreators key is saved/i)).toBeTruthy();
  });
});
