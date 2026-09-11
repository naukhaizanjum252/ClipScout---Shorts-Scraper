/**
 * THE LAST KNOWN CREDIT BALANCE, SHARED ACROSS THE PAGE.
 *
 * Two places show the ScrapeCreators balance — the chip in the rail
 * (nav-credits.tsx) and the bar on the credentials page (credentials/
 * credits-panel.tsx). Reading the live balance costs a credit, so neither polls;
 * they show the LAST value someone deliberately checked. Before this module each
 * kept its own copy, so a check on the credentials page left the rail still
 * saying "not checked here yet" — which is exactly what an operator reads as
 * "this doesn't work".
 *
 * This is the one copy. A successful check anywhere writes it; both readers seed
 * from it on mount and subscribe for live updates, so one check lights up the
 * balance everywhere and it survives a reload. It is `localStorage`, so it is
 * per-browser and per-operator — right for a convenience readout, and it always
 * carries the read time so a remembered figure can never pass for a live one.
 *
 * NOT A CREDIT SPENT. Reading and writing this touches only the browser; it
 * never calls ScrapeCreators. Only the explicit "Check" button does that.
 */
export const CREDIT_CACHE_KEY = "clipscout.credits.last";

/** Fired on the same document after a write; `storage` only fires in OTHER tabs. */
const CREDIT_CACHE_EVENT = "clipscout:credits-updated";

export type CreditCacheEntry = { readonly credits: number; readonly readAt: string };

function isEntry(value: unknown): value is CreditCacheEntry {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as CreditCacheEntry).credits === "number" &&
    Number.isFinite((value as CreditCacheEntry).credits) &&
    typeof (value as CreditCacheEntry).readAt === "string"
  );
}

/** The last checked balance in this browser, or null if none/unreadable. */
export function readCreditCache(): CreditCacheEntry | null {
  try {
    const raw = localStorage.getItem(CREDIT_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEntry(parsed) ? parsed : null;
  } catch {
    // A private window, cleared storage, or a blocked accessor. No last value is
    // a fine state — the readers say "not checked" and offer the button.
    return null;
  }
}

/** Record a freshly checked balance and tell every reader on this document. */
export function writeCreditCache(entry: CreditCacheEntry): void {
  try {
    localStorage.setItem(CREDIT_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // If the write fails the figure still shows this session; it just will not
    // survive a reload. Not worth surfacing.
  }
  try {
    window.dispatchEvent(new CustomEvent(CREDIT_CACHE_EVENT, { detail: entry }));
  } catch {
    // No window (SSR) — nothing is listening yet anyway.
  }
}

/**
 * Call `onChange` whenever the cached balance changes — from a write on this
 * document (custom event) or from another tab (the `storage` event). Returns an
 * unsubscribe. No-op and returns a no-op when there is no window.
 */
export function subscribeCreditCache(onChange: (entry: CreditCacheEntry | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === CREDIT_CACHE_KEY) onChange(readCreditCache());
  };
  const onCustom = () => onChange(readCreditCache());
  window.addEventListener("storage", onStorage);
  window.addEventListener(CREDIT_CACHE_EVENT, onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CREDIT_CACHE_EVENT, onCustom);
  };
}
