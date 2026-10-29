// What the Buckets screen shows about a bucket and its account: whether the
// account covers it, the cycle's breakdown, and what a refill adds.

import type { CSSProperties } from "react";

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import i18n from "@/i18n";

import { addAmounts, compareAmounts, formatMoney, percentOf, subtractAmounts } from "./money";

const positive = (a: string) => compareAmounts(a, "0") > 0;

/**
 * ok: fully covered; warn: not (yellow); alert: a priority bucket that isn't,
 * or an overspent one (red).
 */
export type Tone = "ok" | "warn" | "alert";

export interface Coverage {
  /** How much of TF the account doesn't back (TF − CAF), or 0. */
  gap: string;
  /** CAF as a % of TF while there's a gap, else 100. */
  coveredPct: number;
  /** TF is below 0: more was spent than the bucket had. */
  overspent: boolean;
  tone: Tone;
}

/** How well a bucket's account backs its TF, and how it should look. */
export function coverage(bucket: Bucket): Coverage {
  const tf = bucket.target_funds;
  const gap = positive(tf) ? subtractAmounts(tf, bucket.current_available_funds) : "0.00";
  const overspent = compareAmounts(tf, "0") < 0;
  if (!positive(gap)) {
    return { gap: "0.00", coveredPct: 100, overspent, tone: overspent ? "alert" : "ok" };
  }
  return {
    gap,
    coveredPct: percentOf(bucket.current_available_funds, tf),
    overspent,
    tone: bucket.priority ? "alert" : "warn",
  };
}

/** The usage bar's color: yellow above 90 %, red when overspent. */
export function usageColor(pct: number): "yellow" | "red" | undefined {
  if (pct > 100) return "red";
  if (pct > 90) return "yellow";
  return undefined;
}

/**
 * An account's buckets together: what's left in them, and what the balance
 * lacks or has to spare. The tone is about the shortage only, so an
 * overspent bucket doesn't change it.
 */
export function accountSummary(
  account: Account,
  buckets: Bucket[],
): { left: string; short: string; unallocated: string; tone: Tone } {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const left = addAmounts(...own.map((b) => b.target_funds));
  const short = own.filter((b) => positive(coverage(b).gap));
  const tone = short.some((b) => b.priority) ? "alert" : short.length > 0 ? "warn" : "ok";
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

/** One part of the breakdown as shown: "Start 500.00", or the sign and "refill 1 500.00". */
export interface BreakdownPiece {
  part: BreakdownPart;
  /** "+" or "−" before every part but the first. */
  sign: string;
  text: string;
}

/** The breakdown's parts, ready to show. */
export function breakdownPieces(figures: BucketFigures, currency: string): BreakdownPiece[] {
  return breakdown(figures).map(({ part, amount }, i) => {
    const negative = compareAmounts(amount, "0") < 0;
    const shown = i > 0 && negative ? subtractAmounts("0", amount) : amount;
    const text = i18n.t(`buckets.parts.${part}`, { amount: formatMoney(shown, currency) });
    if (i === 0) return { part, sign: "", text: text.charAt(0).toUpperCase() + text.slice(1) };
    return { part, sign: negative ? "−" : "+", text };
  });
}

/** The breakdown as a line: "Start 500.00 + refill 1 500.00 − adjusted 200.00". */
export function breakdownText(figures: BucketFigures, currency: string): string {
  return breakdownPieces(figures, currency)
    .map(({ sign, text }) => (sign ? `${sign} ${text}` : text))
    .join(" ");
}

/** A Fully manual bucket (#76): never refilled, its funds only change by hand. */
export function isFullyManual(bucket: Bucket): boolean {
  return bucket.refill_mode === "fully_manual";
}

/**
 * Whether the next refill pays back a negative TF instead of clearing it
 * (#62): only with Keep funds and the debt option.
 */
export function carriesDebt(bucket: Bucket): boolean {
  return bucket.keep_funds && bucket.negative_tf === "debt";
}

/**
 * What refilling a bucket whose TF is `tf` records. This mirrors
 * internal/refill/refill.go (spec §6); change both together.
 * - Keep funds off: TF is set to RA, so REF = RA − TF.
 * - Keep funds on: REF = RA, and what the new TF has above BC overflows. A
 *   negative TF is debt that REF pays back, unless the bucket clears it:
 *   then TF is set to RA, as without Keep funds.
 */
export function refillOf(
  bucket: Bucket,
  tf = bucket.target_funds,
): { amount: string; overflow: string } {
  const clears = !bucket.keep_funds || (!carriesDebt(bucket) && compareAmounts(tf, "0") < 0);
  const amount = clears
    ? subtractAmounts(bucket.refill_amount, tf)
    : addAmounts(bucket.refill_amount);
  // Only a Fully manual bucket, which is never refilled, has no capacity.
  const excess =
    bucket.capacity === null ? "0.00" : subtractAmounts(addAmounts(tf, amount), bucket.capacity);
  return { amount, overflow: bucket.keep_funds && positive(excess) ? excess : "0.00" };
}

/** Mantine colors for a bucket's or account's tone; they follow the color scheme. */
export const TONE_COLOR: Record<Tone, string | undefined> = {
  ok: undefined,
  warn: "yellow",
  alert: "red",
};

export function toneStyle(tone: Tone): CSSProperties | undefined {
  const color = TONE_COLOR[tone];
  return color
    ? {
        backgroundColor: `var(--mantine-color-${color}-light)`,
        borderColor: `var(--mantine-color-${color}-outline)`,
      }
    : undefined;
}

/** The text color for a tone, readable in both color schemes. */
export function toneText(tone: Tone): string | undefined {
  const color = TONE_COLOR[tone];
  return color && `var(--mantine-color-${color}-text)`;
}
