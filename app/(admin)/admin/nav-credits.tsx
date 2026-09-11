"use client";

import { useEffect, useState, useTransition } from "react";

import {
  readCreditCache,
  subscribeCreditCache,
  writeCreditCache,
  type CreditCacheEntry,
} from "./credit-cache";
import type { CreditBalanceOutcome } from "./credentials/view";

/**
 * THE CREDIT BALANCE, IN THE RAIL, ON EVERY ADMIN PAGE. Asad, 2026-09-10:
 * *"The tool should show the current balance of scrape creators ... maybe in
 * Nav."* The credentials page already has the authoritative bar (see
 * credits-panel.tsx); this is the same figure carried into the chrome so an
 * operator does not have to open Settings to see how much fuel is left.
 *
 * IT NEVER FETCHES ON ITS OWN, and that rule is the whole reason this is not a
 * live number. `/v1/account/credit-balance` costs one credit per request — the
 * same as a scraping call — so a chip that refreshed on mount or on a timer
 * would be the biggest single consumer of the balance it displays. It shows the
 * LAST value a person deliberately checked, read back from `localStorage`, and
 * refreshes only when the button is pressed. The button says what the press
 * costs, on the control that charges it — the same discipline the credentials
 * bar keeps.
 *
 * WHY `localStorage` AND NOT THE SERVER. The balance is not banked anywhere
 * durable server-side (a run banks it into a per-request client that dies with
 * the request), so the only honest "last known" figure available for free is
 * the one this browser last saw. It is per-viewer, which is right: it is a
 * convenience readout, not shared state, and a stale value carries its own read
 * time so it can never pretend to be current.
 *
 * IT RENDERS ONLY WHEN A KEY IS SAVED (`hasKey`), for the same reason the
 * credentials bar hides itself: with no key there is no account and no balance,
 * and a chip explaining its own emptiness in the chrome of every page is noise.
 */
/** "just now" / "3h ago" / "2d ago" — a coarse age, which is all a balance needs. */
function ageOf(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function NavCredits({
  hasKey,
  canCheck,
  check,
}: {
  /** False when no ScrapeCreators key is saved — the chip does not render. */
  readonly hasKey: boolean;
  /** False for a viewer who may not spend the operator's credits. */
  readonly canCheck: boolean;
  readonly check: () => Promise<CreditBalanceOutcome>;
}) {
  // Everything below is read in an effect, so the server renders the neutral
  // placeholder and there is no hydration mismatch on the cached value or the
  // relative age (both of which only exist in a browser). The value comes from
  // the shared cache and is kept in step with it, so a check made on the
  // credentials page lights this up too, live, without a reload.
  const [cached, setCached] = useState<CreditCacheEntry | null>(null);
  const [ready, setReady] = useState(false);
  const [age, setAge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setCached(readCreditCache());
    setReady(true);
    return subscribeCreditCache(setCached);
  }, []);

  useEffect(() => {
    if (!cached) {
      setAge(null);
      return;
    }
    setAge(ageOf(cached.readAt, Date.now()));
  }, [cached]);

  if (!hasKey) return null;

  const onCheck = () =>
    startTransition(async () => {
      setError(null);
      const outcome = await check();
      if (outcome.ok) {
        // Write to the shared cache; the subscription above updates `cached`.
        writeCreditCache({ credits: outcome.credits, readAt: outcome.readAt });
      } else {
        setError(outcome.message);
      }
    });

  return (
    <div className="nav-credits">
      <span className="nav-credits-label mono">CREDITS</span>

      {!ready ? (
        <span className="nav-credits-figure">…</span>
      ) : cached ? (
        <span className="nav-credits-figure mono">{fmt(cached.credits)}</span>
      ) : (
        <span className="nav-credits-none">not checked here yet</span>
      )}

      {ready && cached && age ? <span className="nav-credits-age">checked {age}</span> : null}

      {canCheck ? (
        <button
          type="button"
          className="nav-credits-btn"
          disabled={pending}
          onClick={onCheck}
          title="Reads the live balance from ScrapeCreators. Costs 1 credit, charged like any other request."
        >
          {pending ? "Checking…" : "Check · 1 credit"}
        </button>
      ) : null}

      {error ? (
        <span className="nav-credits-error" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
