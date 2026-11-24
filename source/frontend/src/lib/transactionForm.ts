// The Create transaction screen's logic, kept apart from the form: the bucket
// split, the "Triggers refill" default, filling in from last time, and what
// editing a transaction starts with and sends.

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import type { components } from "@/api/schema";
import type {
  CounterpartySuggestion,
  Transaction,
  TransactionCorrection,
} from "@/api/transactions";

import { now as clockNow } from "./clock";
import { addAmounts, compareAmounts, splitAmount, subtractAmounts } from "./money";
import { choiceOf, countLaterOf, ownWaiting, sameChoice, type CountChoice } from "./waiting";

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

/**
 * The rows after the amount changes from base.amount, the amount they were
 * last set for. A split that took all of it follows the new amount, shared in
 * the same proportions; one that only took part keeps its amounts unless they
 * no longer fit, and then shrinks to the new amount. Rows without an amount
 * stay as they are.
 */
export function followAmount(
  base: { amount: string | null; lines: SplitLine[] },
  amount: string | null,
): SplitLine[] {
  const amounts = base.lines.map((l) => l.amount);
  if (
    amount === null ||
    base.amount === null ||
    compareAmounts(amount, "0") <= 0 ||
    amounts.length === 0 ||
    amounts.some((a) => a === null || compareAmounts(a, "0") <= 0)
  ) {
    return base.lines;
  }
  const weights = amounts.filter((a) => a !== null);
  const inBuckets = addAmounts(...weights);
  const full = compareAmounts(inBuckets, base.amount) === 0;
  if (!full && compareAmounts(amount, inBuckets) >= 0) return base.lines;
  const shares = splitAmount(amount, weights);
  return base.lines.map((l, i) => ({ ...l, amount: shares[i] ?? l.amount }));
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
export function insideCycle(at: string | null, cycle: Cycle | null, now = clockNow()): boolean {
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

/** The fields a correction can change, as the form holds them. */
export interface EditValues {
  /** Positive, except for OPB and BLA (signed, the account's line). */
  amount: string | null;
  accountId: string | null;
  /** A transfer's receiving account. */
  toAccountId: string | null;
  counterparty: string;
  /** An optional note (#130), possibly several lines. */
  description: string;
  tags: string[];
  lines: SplitLine[];
  triggersRefill: boolean;
  /** When an expense's buckets count it (#264); left out, it doesn't change. */
  count?: CountChoice;
}

const isBalance = (tx: Transaction) => tx.type === "OPB" || tx.type === "BLA";
const positive = (a: string) => (compareAmounts(a, "0") < 0 ? subtractAmounts("0", a) : a);

/** What the edit form starts with: the transaction's effective values. */
export function editState(tx: Transaction): EditValues {
  const from = tx.bank_lines.find((l) => compareAmounts(l.amount, "0") < 0);
  const to = tx.bank_lines.find((l) => compareAmounts(l.amount, "0") > 0);
  const first = tx.bank_lines[0];
  let amount: string | null = first ? positive(first.amount) : null;
  if (isBalance(tx)) amount = first?.amount ?? null;
  return {
    amount,
    accountId: (tx.type === "TRF" ? from : first)?.account_id ?? null,
    toAccountId: tx.type === "TRF" ? (to?.account_id ?? null) : null,
    counterparty: tx.counterparty,
    description: tx.description,
    tags: tx.tags,
    // Parts that wait for their buckets (#264) are the split too.
    lines: [...tx.bucket_lines, ...ownWaiting(tx)].map((l) =>
      newLine(l.bucket_id, positive(l.amount)),
    ),
    triggersRefill: tx.triggers_refill,
    count: choiceOf(tx),
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

const lineKey = (lines: SplitLine[]) => lines.map((l) => `${l.bucketId ?? ""}:${l.amount ?? ""}`);

/**
 * The correction that turns tx into values: only what changed, or null when
 * nothing did. Bucket lines are left out while they're locked.
 */
export function correctionBody(
  tx: Transaction,
  values: EditValues,
  locked: boolean,
): TransactionCorrection | null {
  const start = editState(tx);
  const body: TransactionCorrection = {};
  if (
    values.amount !== null &&
    (start.amount === null || compareAmounts(values.amount, start.amount) !== 0)
  ) {
    body.amount = values.amount;
  }
  if (!isBalance(tx)) {
    if (values.accountId && values.accountId !== start.accountId) {
      body.account_id = values.accountId;
    }
    if (tx.type === "TRF" && values.toAccountId && values.toAccountId !== start.toAccountId) {
      body.to_account_id = values.toAccountId;
    }
  }
  if (values.counterparty.trim() !== start.counterparty) {
    body.counterparty = values.counterparty.trim();
  }
  if (cleanDescription(values.description) !== start.description) {
    body.description = cleanDescription(values.description);
  }
  if (!sameList(values.tags, start.tags)) body.tags = values.tags;
  if (
    !locked &&
    (tx.type === "INC" || tx.type === "EXP") &&
    !sameList(lineKey(values.lines), lineKey(start.lines))
  ) {
    body.bucket_lines = values.lines.map((l) => ({
      bucket_id: l.bucketId ?? "",
      amount: l.amount ?? "",
    }));
  }
  if (tx.type === "INC" && values.triggersRefill !== start.triggersRefill) {
    body.triggers_refill = values.triggersRefill;
  }
  if (tx.type === "EXP" && values.count && !sameChoice(values.count, choiceOf(tx))) {
    const later = countLaterOf(values.count);
    if (later) body.count_later = later;
  }
  return Object.keys(body).length > 0 ? body : null;
}

/** A description as the server stores it: plain line breaks, trimmed. */
export function cleanDescription(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

/** A description's first line, for a list row. */
export function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}
