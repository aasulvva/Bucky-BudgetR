// Bucket setup's adjustments (spec §9), kept apart from the page: what an
// adjustment or a move of funds would do, as the API does it
// (internal/buckets Adjust and Transfer).

import type { Bucket } from "@/api/accounts";
import type { components } from "@/api/schema";

import { capacityAfter } from "./budget";
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
): "empty" | "notPositive" | "overRefill" | null {
  if (amount === null) return "empty";
  if (compareAmounts(amount, "0") <= 0) return "notPositive";
  if (mode !== "temporary" && compareAmounts(amount, from.refill_amount) > 0) return "overRefill";
  return null;
}
