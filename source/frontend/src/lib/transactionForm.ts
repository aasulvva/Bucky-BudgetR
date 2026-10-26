// The Create transaction screen's logic, kept apart from the form: the bucket
// split, the "Triggers refill" default and filling in from last time.

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import type { components } from "@/api/schema";
import type { CounterpartySuggestion } from "@/api/transactions";

import { addAmounts, compareAmounts, subtractAmounts } from "./money";

type IncomeRefillRule = components["schemas"]["IncomeRefillRule"];

/** One row of the bucket split. */
export interface SplitLine {
  /** Stable across edits, for React. */
  key: number;
  bucketId: string | null;
  /** A canonical positive amount, or null when empty or invalid. */
  amount: string | null;
}

let nextKey = 0;

export function newLine(bucketId: string | null, amount: string | null): SplitLine {
  nextKey += 1;
  return { key: nextKey, bucketId, amount };
}

/** What the rows put in buckets, what's left of the amount, and whether they're over it. */
export function bucketTotals(
  amount: string | null,
  lines: SplitLine[],
): { inBuckets: string; notTied: string; over: boolean } {
  const inBuckets = addAmounts(...lines.map((l) => l.amount ?? "0"));
  const notTied = subtractAmounts(amount ?? "0", inBuckets);
  return { inBuckets, notTied, over: compareAmounts(notTied, "0") < 0 };
}

/** The amount a new row starts with: what isn't tied to a bucket yet, or empty. */
export function prefillFor(amount: string | null, lines: SplitLine[]): string | null {
  const { notTied } = bucketTotals(amount, lines);
  return compareAmounts(notTied, "0") > 0 ? notTied : null;
}

/** The account's "On income" buckets that haven't been refilled in this cycle. */
export function waitingOnIncome(buckets: Bucket[], accountId: string | null): Bucket[] {
  return buckets.filter(
    (b) => b.source_account_id === accountId && b.refill_mode === "on_income" && !b.refilled,
  );
}

/**
 * Whether an income matches one of the income rules: the same counterparty,
 * ignoring case and outer spaces, and at least the rule's amount. This is
 * refill.Triggers on the backend; change both together.
 */
export function ruleMatches(
  rules: IncomeRefillRule[],
  counterparty: string,
  amount: string | null,
): boolean {
  const name = counterparty.trim().toLowerCase();
  if (name === "" || amount === null) return false;
  return rules.some(
    (r) =>
      r.counterparty.trim().toLowerCase() === name && compareAmounts(amount, r.min_amount) >= 0,
  );
}

/** Whether a transaction at `at` (null for now) falls inside the cycle. */
export function insideCycle(at: string | null, cycle: Cycle | null, now = new Date()): boolean {
  if (!cycle) return false;
  const t = at === null ? now.getTime() : new Date(at).getTime();
  return t >= new Date(cycle.start_at).getTime() && t < new Date(cycle.end_at).getTime();
}

export interface FormState {
  amount: string | null;
  accountId: string | null;
  /** The user picked the account themselves; a suggestion doesn't change it then. */
  accountTouched: boolean;
  tags: string[];
  lines: SplitLine[];
  /** Bucket rows can be added (an active cycle). */
  bucketsAllowed: boolean;
}

/**
 * What picking an earlier counterparty fills in, from its last transaction:
 * its account, unless the user chose one; its tags, if none are entered; and
 * its buckets, if there are no rows yet and they're still funded from the
 * account. The first bucket gets what's left of the amount.
 */
export function fromLastTime(
  suggestion: CounterpartySuggestion,
  state: FormState,
  accounts: Account[],
  buckets: Bucket[],
): Partial<Pick<FormState, "accountId" | "tags" | "lines">> {
  const out: Partial<Pick<FormState, "accountId" | "tags" | "lines">> = {};
  let accountId = state.accountId;
  if (!state.accountTouched && accounts.some((a) => a.id === suggestion.account_id)) {
    accountId = suggestion.account_id;
    if (accountId !== state.accountId) out.accountId = accountId;
  }
  if (state.tags.length === 0 && suggestion.tags.length > 0) out.tags = suggestion.tags;
  if (state.bucketsAllowed && state.lines.length === 0) {
    const ids = suggestion.bucket_ids.filter((id) =>
      buckets.some((b) => b.id === id && b.source_account_id === accountId),
    );
    if (ids.length > 0) {
      out.lines = ids.map((id, i) => newLine(id, i === 0 ? prefillFor(state.amount, []) : null));
    }
  }
  return out;
}

/** The account to start with: the last one used in this browser, if it still exists, or the only one. */
export function initialAccount(accounts: Account[], last: string | null): string | null {
  if (last && accounts.some((a) => a.id === last)) return last;
  return accounts.length === 1 ? (accounts[0]?.id ?? null) : null;
}
