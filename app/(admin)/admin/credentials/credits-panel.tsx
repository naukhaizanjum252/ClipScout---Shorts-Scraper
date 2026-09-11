"use client";

import { useEffect, useState, useTransition } from "react";

import {
  readCreditCache,
  subscribeCreditCache,
  writeCreditCache,
} from "../credit-cache";
import type { CreditBalanceOutcome } from "./view";

/**
 * THE CREDIT BAR. One line, at the foot of the ScrapeCreators slot.
 *
 * Erik, 2026-09-05, with a screenshot and two arrows: kill the Store panel,
 * *"move B to a single bar with numbers at the bottom of the ScraperCreators
 * key box (hide it if there are no keys)"*.
 *
 * WHAT THIS REPLACES. It was a full-width panel of its own, above the slots,
 * with a heading, a 28px balance, a meter, a "One run costs" sub-heading and
 * three sentences of caveat — a card about a key, floating above the card for
 * that key. Two boxes for one subject, and the top one rendered even with no
 * key saved just to say there was no key saved.
 *
 * THE HIDE RULE IS THE IMPORTANT HALF. With no key there is no account, no
 * balance and nothing to spend, so the bar does not render at all — `hasKey`
 * false returns null. The old panel's "No key saved, so there is no account to
 * ask about" was a box explaining its own emptiness, directly above the empty
 * box it was explaining.
 *
 * NUMBERS, NOT SENTENCES. Three figures separated by middots: what is left,
 * what a run costs, how many runs that covers. The caveats that used to be
 * spelled out are carried by the words themselves — "≥" for the run cost
 * because billing is per request and a seed can span pages, "≤" for runs
 * covered because a floor cost with an optimistic ceiling is the arithmetic
 * error that strands a run mid-flight. The full reasoning did not disappear
 * from the repo; it lives in lib/platform/scrapecreators.ts beside the endpoint
 * and the price table, where whoever maintains this will be reading anyway.
 *
 * STILL NO POLL, AND STILL PRICED ON THE BUTTON. `/v1/account/credit-balance`
 * costs one credit per request — the same as a scraping call — so nothing here
 * fetches on mount or on a timer; 2,880 reads a day would make the balance
 * display the biggest single consumer of the balance. It is a button, and the
 * button says what pressing it costs.
 *
 * NO METER, DELIBERATELY. The bar dropped the progress meter with the panel,
 * and that is a small honesty gain rather than a loss: its denominator was the
 * highest balance this deployment had ever seen, which is an observation
 * standing in for a purchase figure ScrapeCreators does not publish. A number
 * needs no denominator to be true.
 */
export interface CreditsBarProps {
  /** Active seeds on the platforms this key serves, summed. The request floor. */
  readonly seedRequests: number;
  /** False when no key is saved — the bar does not render at all. */
  readonly hasKey: boolean;
  /** False for a viewer who may not spend the operator's credits. */
  readonly canCheck: boolean;
  readonly check: () => Promise<CreditBalanceOutcome>;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function CreditsBar({ seedRequests, hasKey, canCheck, check }: CreditsBarProps) {
  const [outcome, setOutcome] = useState<CreditBalanceOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  // SEED FROM THE SHARED LAST-KNOWN BALANCE, and stay in step with it. A check
  // on either this bar or the rail chip writes one cache (see ../credit-cache),
  // so the balance shows here on arrival without a fresh credit spent, and a
  // check made elsewhere updates it live. Done in an effect so the server render
  // stays neutral and there is no hydration mismatch. `charged: false` because a
  // remembered figure was not charged now — the read time carries the caveat.
  useEffect(() => {
    const apply = () => {
      const cached = readCreditCache();
      setOutcome(
        cached === null
          ? null
          : { ok: true, credits: cached.credits, highWaterMark: cached.credits, readAt: cached.readAt, charged: false },
      );
    };
    apply();
    return subscribeCreditCache(apply);
  }, []);

  // THE HIDE RULE. No key, no account, no bar.
  if (!hasKey) return null;

  const balance = outcome?.ok ? outcome : null;

  /**
   * How many runs the balance covers at the predicted floor.
   *
   * FLOOR DIVISION ON A FLOOR COST, so the answer is a ceiling and is labelled
   * "≤". Rounding the optimistic way here is the one arithmetic error that
   * costs somebody a run that dies halfway through.
   */
  const runsCovered =
    balance && seedRequests > 0 ? Math.floor(balance.credits / seedRequests) : null;

  const figure = { color: "var(--ink)", fontVariantNumeric: "tabular-nums" as const };
  const label = { color: "var(--muted)" };

  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2"
      style={{
        borderTop: "1px solid var(--hairline)",
        paddingTop: "12px",
        fontSize: "12.5px",
      }}
    >
      <span className="mono" style={label}>
        CREDITS
      </span>

      {balance ? (
        <span className="mono" style={figure} title={`Read ${new Date(balance.readAt).toLocaleString()}`}>
          {fmt(balance.credits)} left
        </span>
      ) : (
        <span style={label}>not checked</span>
      )}

      <span style={label}>·</span>

      {seedRequests === 0 ? (
        <span style={label}>no seeds, so a run spends nothing</span>
      ) : (
        <>
          <span className="mono" style={figure}>
            ≥{fmt(seedRequests)}/run
          </span>
          {runsCovered === null ? null : (
            <>
              <span style={label}>·</span>
              <span className="mono" style={figure}>
                ≤{fmt(runsCovered)} runs
              </span>
            </>
          )}
        </>
      )}

      {canCheck ? (
        <button
          type="button"
          className="btn btn-quiet btn-small"
          style={{ marginLeft: "auto" }}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const next = await check();
              setOutcome(next);
              // Share a good read so the rail chip and a reload both see it.
              if (next.ok) writeCreditCache({ credits: next.credits, readAt: next.readAt });
            })
          }
          // The price of a press, on the control that charges it. This is the
          // whole reason there is no poll, and it survived the compression.
          title="Costs 1 credit, charged by ScrapeCreators like any other request."
        >
          {pending ? "Asking…" : "Check balance (1 credit)"}
        </button>
      ) : null}

      {outcome && !outcome.ok ? (
        <p
          className="w-full"
          style={{ color: "var(--signal)", fontSize: "12px", margin: 0 }}
          role="status"
        >
          {outcome.message}
        </p>
      ) : null}
    </div>
  );
}
