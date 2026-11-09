// Budget setup's logic (spec §9), kept apart from the page: the values being
// edited, what they add up to per account, and what saving them sends.

import type { Account, Bucket } from "@/api/accounts";
import type { components } from "@/api/schema";

import {
  addAmounts,
  canonicalAmount,
  compareAmounts,
  multiplyAmount,
  percentOf,
  subtractAmounts,
} from "./money";

export type BucketCreate = components["schemas"]["BucketCreate"];

/** A bucket added in Budget setup (#112), created on Save; the key tells drafts apart. */
export interface NewBucket {
  key: string;
  body: BucketCreate;
}

/**
 * The values edited and not saved yet, by account and bucket ID. A value is
 * canonical, or null when the field is empty or invalid. What isn't here
 * shows the saved value. `created` are new buckets, in the order added, and
 * `deleted` the IDs of saved buckets to delete (#174).
 */
export interface BudgetDraft {
  incomes: Partial<Record<string, string | null>>;
  ras: Partial<Record<string, string | null>>;
  created: NewBucket[];
  deleted: string[];
}

export const EMPTY_DRAFT: BudgetDraft = { incomes: {}, ras: {}, created: [], deleted: [] };

/** The draft's new buckets on an account. */
export function draftBucketsFor(draft: BudgetDraft, accountId: string): NewBucket[] {
  return draft.created.filter((n) => n.body.source_account_id === accountId);
}

/** Whether a new bucket has a refill amount to budget: not Fully manual (#76). */
export function budgeted(body: BucketCreate): boolean {
  return body.refill_mode !== "fully_manual";
}

// Undefined too: a list fetched from an older server lacks expected_income.
const saved = (amount: string | null | undefined) =>
  amount === null || amount === undefined ? null : canonicalAmount(amount);

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

/**
 * What an account's buckets take of its expected income, as edited: new ones
 * included, deleted ones left out.
 */
export function accountBudget(
  draft: BudgetDraft,
  account: Account,
  buckets: Bucket[],
): AccountBudget {
  const expected = draftIncome(draft, account);
  const allocated = addAmounts(
    ...buckets
      .filter((b) => b.source_account_id === account.id && !draft.deleted.includes(b.id))
      .map((b) => draftRefill(draft, b) ?? "0"),
    ...draftBucketsFor(draft, account.id)
      .filter((n) => budgeted(n.body))
      .map((n) => n.body.refill_amount ?? "0"),
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
  const fixed = bucket.cap_amount ?? bucket.capacity ?? "0";
  return compareAmounts(ra, fixed) > 0
    ? { capacity: canonicalAmount(ra), raised: true }
    : { capacity: canonicalAmount(fixed), raised: false };
}

/** A new bucket's capacity, as the server works it out (see capacityAfter); null for no cap. */
export function newCapacity(body: BucketCreate): string | null {
  const ra = body.refill_amount ?? "0";
  switch (body.cap_mode ?? "multiplier") {
    case "multiplier":
      return multiplyAmount(ra, body.cap_multiplier ?? "1");
    case "fixed": {
      const fixed = body.cap_amount ?? "0";
      return canonicalAmount(compareAmounts(ra, fixed) > 0 ? ra : fixed);
    }
    case "none":
      return null;
  }
}

export interface BudgetChanges {
  /** Saved buckets to delete first, in list order (#174). */
  deleted: Bucket[];
  /** New buckets to create next, in the order added (#112). */
  created: NewBucket[];
  incomes: { account_id: string; expected_income: string | null }[];
  ras: { bucket_id: string; refill_amount: string }[];
  /** How many fields differ from what's saved, and new buckets. */
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
  const deleted = buckets.filter((b) => draft.deleted.includes(b.id));
  const out: BudgetChanges = {
    deleted,
    created: draft.created,
    incomes: [],
    ras: [],
    count: deleted.length + draft.created.length,
    invalid: false,
  };
  for (const a of accounts) {
    if (!(a.id in draft.incomes)) continue;
    const value = draftIncome(draft, a);
    if (same(value, saved(a.expected_income))) continue;
    out.count++;
    if (incomeProblem(value)) out.invalid = true;
    else out.incomes.push({ account_id: a.id, expected_income: value });
  }
  for (const b of buckets) {
    // A deleted bucket's RA edit waits in the draft, for Undo.
    if (!(b.id in draft.ras) || draft.deleted.includes(b.id)) continue;
    const value = draftRefill(draft, b);
    if (same(value, saved(b.refill_amount))) continue;
    out.count++;
    if (value === null || refillProblem(value)) out.invalid = true;
    else out.ras.push({ bucket_id: b.id, refill_amount: value });
  }
  return out;
}

/** A bucket in the save, when it changes this cycle too (#81). */
export interface CycleRow {
  bucket: Bucket;
  ra: { from: string; to: string };
  /** The BUA: the change in RA; null when the bucket isn't refilled yet this cycle. */
  change: string | null;
  tf: { from: string; to: string };
}

export interface CycleAccount {
  account: Account;
  rows: CycleRow[];
  /** How much TF the account's balance doesn't cover afterwards, or 0.00. */
  short: string;
}

/**
 * What saving with "Also change this cycle" does, per account: each refilled
 * bucket's TF moves by its change in RA; one not refilled yet only gets the
 * RA, which its refill then uses. This mirrors SetRefillAmounts in
 * internal/buckets; change both together.
 */
export function cycleChanges(
  changes: BudgetChanges,
  accounts: Account[],
  buckets: Bucket[],
): CycleAccount[] {
  const rows = new Map<string, CycleRow>();
  for (const { bucket_id, refill_amount } of changes.ras) {
    const bucket = buckets.find((b) => b.id === bucket_id);
    if (!bucket) continue;
    const from = canonicalAmount(bucket.refill_amount);
    const change = bucket.refilled ? subtractAmounts(refill_amount, from) : null;
    const tf = canonicalAmount(bucket.target_funds);
    rows.set(bucket.id, {
      bucket,
      ra: { from, to: canonicalAmount(refill_amount) },
      change,
      tf: { from: tf, to: change === null ? tf : addAmounts(tf, change) },
    });
  }
  return accounts.flatMap((account) => {
    const own = buckets.filter((b) => b.source_account_id === account.id);
    const changed = own.flatMap((b) => rows.get(b.id) ?? []);
    if (changed.length === 0) return [];
    // As accountSummary (lib/buckets.ts): positive TFs the balance doesn't cover.
    const tfs = own.map((b) => rows.get(b.id)?.tf.to ?? b.target_funds);
    const missing = subtractAmounts(
      addAmounts(...tfs.filter((tf) => compareAmounts(tf, "0") > 0)),
      account.balance,
    );
    return [
      {
        account,
        rows: changed,
        short: compareAmounts(missing, "0") > 0 ? missing : "0.00",
      },
    ];
  });
}
