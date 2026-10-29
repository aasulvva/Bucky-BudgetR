// Bucket setup's adjustments (spec §9), kept apart from the page: what an
// adjustment, a move of funds, or adding or removing a Fully manual bucket's
// funds would do, as the API does it (internal/buckets Adjust and Transfer).

import type { Account, Bucket } from "@/api/accounts";
import type { components } from "@/api/schema";

import { capacityAfter } from "./budget";
import { accountSummary, isFullyManual } from "./buckets";
import { addAmounts, canonicalAmount, compareAmounts, subtractAmounts } from "./money";

export type AdjustMode = components["schemas"]["AdjustmentMode"];

export const ADJUST_MODES: AdjustMode[] = ["temporary", "future", "both"];

/** Whether the mode records a transaction, so it needs an active cycle. */
export function changesThisCycle(mode: AdjustMode): boolean {
  return mode !== "future";
}

interface Change {
  from: string;
  to: string;
}

export interface AdjustPreview {
  ra: Change;
  tf: Change;
  /** The Budget Adjustment (BUA) it records: TF's change, 0 for none. */
  bua: string;
  /** The capacity after an RA change; a fixed one below RA is raised. */
  capacity: { capacity: string; raised: boolean };
}

/**
 * What adjusting the bucket would do. value is the new TF for temporary,
 * the new RA otherwise. Both changes TF by RA's change, and may take it
 * below 0.
 */
export function adjustPreview(bucket: Bucket, mode: AdjustMode, value: string): AdjustPreview {
  const ra = canonicalAmount(bucket.refill_amount);
  const tf = canonicalAmount(bucket.target_funds);
  const newRa = mode === "temporary" ? ra : canonicalAmount(value);
  const bua =
    mode === "temporary"
      ? subtractAmounts(value, tf)
      : mode === "both"
        ? subtractAmounts(newRa, ra)
        : "0.00";
  return {
    ra: { from: ra, to: newRa },
    tf: { from: tf, to: addAmounts(tf, bua) },
    bua,
    capacity: capacityAfter(bucket, newRa),
  };
}

/** Why the adjustment can't be applied, if it can't. */
export function adjustProblem(
  bucket: Bucket,
  mode: AdjustMode,
  value: string | null,
): "empty" | "negative" | "same" | null {
  if (value === null) return "empty";
  if (compareAmounts(value, "0") < 0) return "negative";
  const was = mode === "temporary" ? bucket.target_funds : bucket.refill_amount;
  return compareAmounts(value, was) === 0 ? "same" : null;
}

export interface MovePreview {
  from: { ra: Change; tf: Change };
  to: { ra: Change; tf: Change };
  /** The sending bucket's TF ends below 0. */
  overspends: boolean;
}

/** What moving amount from one bucket to another would do. */
export function movePreview(
  from: Bucket,
  to: Bucket,
  mode: AdjustMode,
  amount: string,
): MovePreview {
  const side = (b: Bucket, sign: 1 | -1) => {
    const d = sign > 0 ? canonicalAmount(amount) : subtractAmounts("0", amount);
    const ra = canonicalAmount(b.refill_amount);
    const tf = canonicalAmount(b.target_funds);
    return {
      ra: { from: ra, to: mode === "temporary" ? ra : addAmounts(ra, d) },
      tf: { from: tf, to: mode === "future" ? tf : addAmounts(tf, d) },
    };
  };
  const out = { from: side(from, -1), to: side(to, 1) };
  return { ...out, overspends: compareAmounts(out.from.tf.to, "0") < 0 };
}

/** Why the move can't be made, if it can't. */
export function moveProblem(
  from: Bucket,
  mode: AdjustMode,
  amount: string | null,
  to?: Bucket,
): "empty" | "notPositive" | "overRefill" | "overCapacity" | null {
  if (amount === null) return "empty";
  if (compareAmounts(amount, "0") <= 0) return "notPositive";
  if (mode !== "temporary" && compareAmounts(amount, from.refill_amount) > 0) return "overRefill";
  if (to && overCapacity(to, addAmounts(to.target_funds, amount))) return "overCapacity";
  return null;
}

/**
 * Whether tf is above a Fully manual bucket's capacity; the API refuses it
 * (internal/buckets checkCapacity).
 */
function overCapacity(bucket: Bucket, tf: string): boolean {
  return (
    isFullyManual(bucket) && bucket.capacity !== null && compareAmounts(tf, bucket.capacity) > 0
  );
}

/** Adding to, or removing from, a Fully manual bucket's funds (#76). */
export type FundsKind = "add" | "remove";

export interface FundsPreview {
  tf: Change;
  /** The Budget Adjustment (BUA) it records, signed. */
  bua: string;
  /**
   * How much more the account's balance lacks afterwards (accountSummary's
   * short), or 0. Adding more than the account has unallocated is allowed.
   */
  short: string;
}

/**
 * What adding or removing amount would do: a temporary adjustment to
 * TF ± amount. buckets are all the user's, for the account's shortage.
 */
export function fundsPreview(
  bucket: Bucket,
  account: Account | undefined,
  buckets: Bucket[],
  kind: FundsKind,
  amount: string,
): FundsPreview {
  const tf = canonicalAmount(bucket.target_funds);
  const bua = kind === "add" ? canonicalAmount(amount) : subtractAmounts("0", amount);
  const to = addAmounts(tf, bua);
  let short = "0.00";
  if (account) {
    const after = buckets.map((b) => (b.id === bucket.id ? { ...b, target_funds: to } : b));
    const more = subtractAmounts(
      accountSummary(account, after).short,
      accountSummary(account, buckets).short,
    );
    if (compareAmounts(more, "0") > 0) short = more;
  }
  return { tf: { from: tf, to }, bua, short };
}

/** What can still be added before the capacity, or null with no capacity. */
export function fundsRoom(bucket: Bucket): string | null {
  if (bucket.capacity === null) return null;
  const room = subtractAmounts(bucket.capacity, bucket.target_funds);
  return compareAmounts(room, "0") > 0 ? room : "0.00";
}

/** Why the funds can't be added or removed, if they can't. */
export function fundsProblem(
  bucket: Bucket,
  kind: FundsKind,
  amount: string | null,
): "empty" | "notPositive" | "overCapacity" | "overFunds" | null {
  if (amount === null) return "empty";
  if (compareAmounts(amount, "0") <= 0) return "notPositive";
  if (kind === "add") {
    return overCapacity(bucket, addAmounts(bucket.target_funds, amount)) ? "overCapacity" : null;
  }
  return compareAmounts(amount, bucket.target_funds) > 0 ? "overFunds" : null;
}
