// What ending the active cycle will do to the buckets, for the confirmation.
// This mirrors the cycle-end and cycle-start routines in
// internal/refill/refill.go (spec §6); change both together.

import type { Bucket } from "@/api/accounts";

import { refillOf } from "./buckets";
import { addAmounts, compareAmounts } from "./money";

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

  return {
    emptied,
    backToUnallocated: [...new Set(emptied.map((e) => e.bucket.currency))].map((currency) => ({
      currency,
      amount: addAmounts(
        ...emptied.filter((e) => e.bucket.currency === currency).map((e) => e.funded),
      ),
    })),
    refilled,
  };
}
