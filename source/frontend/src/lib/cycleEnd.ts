// What ending the active cycle will do to the buckets, for the confirmation.
// This mirrors the cycle-end and cycle-start routines in
// internal/refill/refill.go (spec §6); change both together.

import type { Bucket } from "@/api/accounts";

import { refillOf } from "./buckets";
import { addAmounts, compareAmounts, subtractAmounts } from "./money";

export interface Emptied {
  bucket: Bucket;
  /** The OVF: the positive TF taken out. */
  amount: string;
  /** The part of it the account backs (CAF), which becomes unallocated. */
  funded: string;
}

export interface Refilled {
  bucket: Bucket;
  /** The REF: what the refill adds (negative only if TF was above RA). */
  amount: string;
  /** What the new TF has above BC, sent to the overflow destination. */
  overflow: string;
}

export interface EndPreview {
  emptied: Emptied[];
  /** The funded part of the emptied buckets, per currency. */
  backToUnallocated: { currency: string; amount: string }[];
  /** The funded part of the emptied buckets whose overflow goes to savings (#233). */
  toSavings: { currency: string; amount: string }[];
  refilled: Refilled[];
}

const positive = (a: string) => compareAmounts(a, "0") > 0;
const min = (a: string, b: string) => (compareAmounts(a, b) <= 0 ? a : b);

/**
 * Previews the end of the cycle:
 * - Keep funds off: an OVF brings a positive TF to 0.
 * - If a cycle starts right after (`refills`), its Auto buckets are refilled:
 *   Keep funds off sets TF to RA (REF = RA − TF); Keep funds on adds RA and
 *   overflows what's above BC.
 *
 * The amounts use the current CAF; the routine recalculates it first, so the
 * money back to unallocated can differ slightly.
 */
export function endPreview(buckets: Bucket[], refills: boolean): EndPreview {
  const emptied = buckets
    .filter((b) => !b.keep_funds && positive(b.target_funds))
    .map((b) => ({
      bucket: b,
      amount: b.target_funds,
      funded: min(b.current_available_funds, b.target_funds),
    }));

  const refilled: Refilled[] = [];
  if (refills) {
    for (const b of buckets.filter((x) => x.refill_mode === "auto")) {
      // TF after the end routine emptied it.
      const tf = b.keep_funds || !positive(b.target_funds) ? b.target_funds : "0.00";
      const { amount, overflow } = refillOf(b, tf);
      if (compareAmounts(amount, "0") !== 0 || positive(overflow)) {
        refilled.push({ bucket: b, amount, overflow });
      }
    }
  }

  const saved = (e: Emptied) => e.bucket.overflow_destination !== "unallocated";
  return {
    emptied,
    backToUnallocated: perCurrency(emptied.filter((e) => !saved(e))),
    toSavings: perCurrency(emptied.filter(saved)),
    refilled,
  };
}

/** The funded amounts per currency, leaving out currencies with none. */
function perCurrency(emptied: Emptied[]): { currency: string; amount: string }[] {
  return [...new Set(emptied.map((e) => e.bucket.currency))].map((currency) => ({
    currency,
    amount: addAmounts(
      ...emptied.filter((e) => e.bucket.currency === currency).map((e) => e.funded),
    ),
  }));
}

/**
 * About what an At cycle end sweep (#235) takes from the account. It runs
 * after the OVFs, before the next cycle's refills, and takes what's
 * unallocated then above keep (at least 0). By then the emptied buckets have
 * no TF, so the buckets left (Keep funds on, or at 0 or below) are funded
 * first, up to their TF: an underfunded account's freed money goes to them.
 * The savings holds come next, with what the emptied buckets sent to
 * savings (#233). This mirrors balance.NewMoney.
 */
export function sweepEstimate(
  buckets: Bucket[],
  preview: EndPreview,
  account: { id: string; balance: string; reserved: string },
  keep: string,
): string {
  const emptied = new Set(preview.emptied.map((e) => e.bucket.id));
  const left = buckets.filter((b) => b.source_account_id === account.id && !emptied.has(b.id));
  const wanted = addAmounts(
    ...left.map((b) => (positive(b.target_funds) ? b.target_funds : "0.00")),
  );
  const free = positive(account.balance) ? account.balance : "0.00";
  const allocated = min(free, wanted);
  const toSavings = preview.emptied
    .filter(
      (e) =>
        e.bucket.source_account_id === account.id &&
        e.bucket.overflow_destination !== "unallocated",
    )
    .map((e) => e.funded);
  const held = addAmounts(account.reserved, ...toSavings);
  const unallocated = subtractAmounts(subtractAmounts(free, allocated), held);
  const above = subtractAmounts(unallocated, keep);
  return positive(above) ? above : "0.00";
}
