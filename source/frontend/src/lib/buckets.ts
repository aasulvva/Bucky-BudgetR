// What the Buckets screen shows about a bucket and its account: whether the
// account covers it, the cycle's breakdown, and what a refill adds.

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import i18n from "@/i18n";

import { addAmounts, compareAmounts, formatMoney, subtractAmounts } from "./money";

const positive = (a: string) => compareAmounts(a, "0") > 0;

/** ok: fully covered; warn: not (yellow); alert: a priority bucket that isn't (red). */
export type Tone = "ok" | "warn" | "alert";

/** How much of a bucket's TF its account doesn't back (TF − CAF), and its tone. */
export function coverage(bucket: Bucket): { gap: string; tone: Tone } {
  const gap = positive(bucket.target_funds)
    ? subtractAmounts(bucket.target_funds, bucket.current_available_funds)
    : "0.00";
  if (!positive(gap)) return { gap: "0.00", tone: "ok" };
  return { gap, tone: bucket.priority ? "alert" : "warn" };
}

/** An account's buckets together: what's left in them, and what the balance lacks or has to spare. */
export function accountSummary(
  account: Account,
  buckets: Bucket[],
): { left: string; short: string; unallocated: string; tone: Tone } {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const left = addAmounts(...own.map((b) => b.target_funds));
  const tones = own.map((b) => coverage(b).tone);
  const tone = tones.includes("alert") ? "alert" : tones.includes("warn") ? "warn" : "ok";
  const missing = subtractAmounts(
    addAmounts(...own.map((b) => (positive(b.target_funds) ? b.target_funds : "0"))),
    account.balance,
  );
  return {
    left,
    short: positive(missing) ? missing : "0.00",
    unallocated: account.unallocated,
    tone,
  };
}

/** The parts of a cycle's budget, in the order the breakdown names them. */
export const BREAKDOWN_PARTS = [
  "start",
  "refills",
  "income",
  "opening_funds",
  "adjustments",
  "transfers",
] as const;

export type BreakdownPart = (typeof BREAKDOWN_PARTS)[number];

/** The budget's parts that aren't 0, signed: "Start 500 + refill 1 500". */
export function breakdown(figures: BucketFigures): { part: BreakdownPart; amount: string }[] {
  return BREAKDOWN_PARTS.map((part) => ({ part, amount: figures[part] })).filter(
    (p) => compareAmounts(p.amount, "0") !== 0,
  );
}

/** The breakdown as a line: "Start 500.00 + refill 1 500.00 − adjusted 200.00". */
export function breakdownText(figures: BucketFigures, currency: string): string {
  return breakdown(figures)
    .map(({ part, amount }, i) => {
      const negative = compareAmounts(amount, "0") < 0;
      const shown = i > 0 && negative ? subtractAmounts("0", amount) : amount;
      const text = i18n.t(`buckets.parts.${part}`, { amount: formatMoney(shown, currency) });
      if (i === 0) return text.charAt(0).toUpperCase() + text.slice(1);
      return `${negative ? "−" : "+"} ${text}`;
    })
    .join(" ");
}

/**
 * What refilling a bucket whose TF is `tf` records. This mirrors
 * internal/refill/refill.go (spec §6); change both together.
 * - Keep funds off: TF is set to RA, so REF = RA − TF.
 * - Keep funds on: REF = RA, and what the new TF has above BC overflows.
 */
export function refillOf(
  bucket: Bucket,
  tf = bucket.target_funds,
): { amount: string; overflow: string } {
  const amount = bucket.keep_funds
    ? addAmounts(bucket.refill_amount)
    : subtractAmounts(bucket.refill_amount, tf);
  const excess = subtractAmounts(addAmounts(tf, amount), bucket.capacity);
  return { amount, overflow: bucket.keep_funds && positive(excess) ? excess : "0.00" };
}
