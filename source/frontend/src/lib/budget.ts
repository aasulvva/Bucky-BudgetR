// Budget setup's logic (spec §9), kept apart from the page: the values being
// edited, what they add up to per account, and what saving them sends.

import type { Account, Bucket } from "@/api/accounts";

import {
  addAmounts,
  canonicalAmount,
  compareAmounts,
  multiplyAmount,
  percentOf,
  subtractAmounts,
} from "./money";

/**
 * The values edited and not saved yet, by account and bucket ID. A value is
 * canonical, or null when the field is empty or invalid. What isn't here
 * shows the saved value.
 */
export interface BudgetDraft {
  incomes: Partial<Record<string, string | null>>;
  ras: Partial<Record<string, string | null>>;
}

export const EMPTY_DRAFT: BudgetDraft = { incomes: {}, ras: {} };

const saved = (amount: string | null) => (amount === null ? null : canonicalAmount(amount));

/** The expected income shown for an account. */
export function draftIncome(draft: BudgetDraft, account: Account): string | null {
  return account.id in draft.incomes
    ? (draft.incomes[account.id] ?? null)
    : saved(account.expected_income);
}

/** The refill amount shown for a bucket. */
export function draftRefill(draft: BudgetDraft, bucket: Bucket): string | null {
  return bucket.id in draft.ras ? (draft.ras[bucket.id] ?? null) : saved(bucket.refill_amount);
}

/** Why a refill amount can't be saved, if it can't. */
export function refillProblem(ra: string | null): "empty" | "negative" | null {
  if (ra === null) return "empty";
  return compareAmounts(ra, "0") < 0 ? "negative" : null;
}

/** The same for an expected income, which may be empty. */
export function incomeProblem(income: string | null): "negative" | null {
  return income !== null && compareAmounts(income, "0") < 0 ? "negative" : null;
}

/** part as a % of whole with one decimal, rounded down; null without a positive whole. */
export function shareOf(part: string, whole: string | null): number | null {
  if (whole === null || compareAmounts(whole, "0") <= 0) return null;
  return percentOf(multiplyAmount(part, "10"), whole) / 10;
}

export interface AccountBudget {
  expected: string | null;
  /** Σ RA of the account's buckets; an empty field counts as 0. */
  allocated: string;
  /** allocated as a % of expected; null without an income. */
  percent: number | null;
  /** expected − allocated; null without an income. */
  remainder: string | null;
  /** More is allocated than expected. */
  over: boolean;
}

/** What an account's buckets take of its expected income, as edited. */
export function accountBudget(
  draft: BudgetDraft,
  account: Account,
  buckets: Bucket[],
): AccountBudget {
  const expected = draftIncome(draft, account);
  const allocated = addAmounts(
    ...buckets
      .filter((b) => b.source_account_id === account.id)
      .map((b) => draftRefill(draft, b) ?? "0"),
  );
  const valid = expected !== null && incomeProblem(expected) === null;
  const remainder = valid ? subtractAmounts(expected, allocated) : null;
  return {
    expected,
    allocated,
    percent: valid ? shareOf(allocated, expected) : null,
    remainder,
    over: remainder !== null && compareAmounts(remainder, "0") < 0,
  };
}

/**
 * The bucket's capacity once its refill amount is ra. This mirrors
 * internal/buckets (settings.check): a multiplier follows RA, and a fixed
 * capacity below RA is raised to it.
 */
export function capacityAfter(bucket: Bucket, ra: string): { capacity: string; raised: boolean } {
  if (bucket.cap_mode === "multiplier") {
    return { capacity: multiplyAmount(ra, bucket.cap_multiplier ?? "1"), raised: false };
  }
  const fixed = bucket.cap_amount ?? bucket.capacity;
  return compareAmounts(ra, fixed) > 0
    ? { capacity: canonicalAmount(ra), raised: true }
    : { capacity: canonicalAmount(fixed), raised: false };
}

export interface BudgetChanges {
  incomes: { account_id: string; expected_income: string | null }[];
  ras: { bucket_id: string; refill_amount: string }[];
  /** How many fields differ from what's saved. */
  count: number;
  /** Some edited field can't be saved. */
  invalid: boolean;
}

/** What differs from the saved values, and what saving would send. */
export function budgetChanges(
  draft: BudgetDraft,
  accounts: Account[],
  buckets: Bucket[],
): BudgetChanges {
  const same = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : compareAmounts(a, b) === 0;
  const out: BudgetChanges = { incomes: [], ras: [], count: 0, invalid: false };
  for (const a of accounts) {
    if (!(a.id in draft.incomes)) continue;
    const value = draftIncome(draft, a);
    if (same(value, saved(a.expected_income))) continue;
    out.count++;
    if (incomeProblem(value)) out.invalid = true;
    else out.incomes.push({ account_id: a.id, expected_income: value });
  }
  for (const b of buckets) {
    if (!(b.id in draft.ras)) continue;
    const value = draftRefill(draft, b);
    if (same(value, saved(b.refill_amount))) continue;
    out.count++;
    if (value === null || refillProblem(value)) out.invalid = true;
    else out.ras.push({ bucket_id: b.id, refill_amount: value });
  }
  return out;
}
