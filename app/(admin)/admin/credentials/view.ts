/**
 * What the credentials page and its server actions agree on, WITH NO
 * `"use server"` DIRECTIVE ON THIS FILE.
 *
 * That absence is the whole reason the file exists. Next turns EVERY export of
 * a `"use server"` module into a callable public endpoint, so a type or a helper
 * exported from `./actions.ts` would be a deployment decision wearing the
 * clothes of a code-organisation one. The scar this rule comes from is
 * lib/actions/decide.ts, where a pure helper was exported from an action module
 * to make a test easier and thereby published an endpoint nobody had chosen to
 * publish. The sibling screen at app/(admin)/admin/shorts/ splits the same way,
 * for the same reason.
 *
 * So: shared shapes here, actions there, and nothing here can become a route.
 */

/** The outcome of a save, a test or a delete, as the panel renders it. */
export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * WHAT THE VENDOR SAID THE BALANCE WAS, AND WHAT IT COST TO ASK.
 *
 * `credits` is the vendor's own `credits_remaining` and nothing derived. There
 * is deliberately no `poolSize` or `creditsPurchased` field: ScrapeCreators
 * documents no such number, and the one candidate in their response —
 * `creditCount` — appears in their own example as 333 beside a balance of
 * 1,000,000, so it is plainly not the pool and they define it nowhere. A
 * denominator that had to be guessed would turn a real balance into a fake
 * percentage, which is the one thing a money display must not do.
 *
 * WHAT THE BAR IS SCALED AGAINST INSTEAD is `highWaterMark` — the largest
 * balance this deployment has ever seen. It is honest because it is observed,
 * it is labelled as such on the page, and on a key whose credits have only ever
 * been spent it is exactly the purchase size anyway.
 */
export type CreditBalanceOutcome =
  | {
      readonly ok: true;
      readonly credits: number;
      readonly highWaterMark: number;
      /** ISO. When the figure was read, not when the page rendered. */
      readonly readAt: string;
      /** True when this cost a credit; false when it came free off a run. */
      readonly charged: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The prefix on every credential field input.
 *
 * The form carries `provider` and `label` alongside the credential's own fields,
 * and those fields are named by the provider — `app_id`, `page_id`,
 * `access_token`. Without a namespace a provider that one day declares a field
 * called `label` would silently overwrite the operator's label, and nothing
 * would go red. One prefix, declared once, used by the form that writes it and
 * the action that reads it.
 */
export const FIELD_PREFIX = "field:";
