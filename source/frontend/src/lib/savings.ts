// Savings targets and their held funds (#231, spec §8): what the Savings and
// Savings setup screens work out, kept apart from the pages. The server
// checks it all again.

import { accountTypeLabel, type Account, type AccountType, type Bucket } from "@/api/accounts";
import type {
  FixedBudgetEntry,
  SavingsBudgetEntry,
  SavingsDistributor,
  SavingsRule,
  SavingsTarget,
  SweepEntry,
  SweepWhen,
} from "@/api/savings";
import i18n from "@/i18n";

import { addAmounts, compareAmounts, formatMoney, percentOf, subtractAmounts } from "./money";

/** The account types that can be a savings target. */
export const TARGET_ACCOUNT_TYPES: AccountType[] = ["savings", "bsu", "fund", "investment"];

export function canBeTargetAccount(account: Account): boolean {
  return TARGET_ACCOUNT_TYPES.includes(account.type);
}

/** The Fully manual buckets that aren't a target yet. */
export function freeBuckets(buckets: Bucket[], targets: SavingsTarget[]): Bucket[] {
  return buckets.filter(
    (b) => b.refill_mode === "fully_manual" && !targets.some((t) => t.bucket_id === b.id),
  );
}

/** The accounts of a target type that aren't a target yet. */
export function freeAccounts(accounts: Account[], targets: SavingsTarget[]): Account[] {
  return accounts.filter(
    (a) => canBeTargetAccount(a) && !targets.some((t) => t.account_id === a.id),
  );
}

/** The highest goal a bucket can have: its fixed capacity, or none. */
export function goalLimit(bucket: Bucket | undefined): string | null {
  return bucket?.cap_mode === "fixed" ? bucket.capacity : null;
}

export type GoalProblem = "notPositive" | "aboveCapacity";

export function goalProblem(goal: string | null, bucket: Bucket | undefined): GoalProblem | null {
  if (goal === null || compareAmounts(goal, "0") <= 0) return "notPositive";
  const limit = goalLimit(bucket);
  if (limit !== null && compareAmounts(goal, limit) > 0) return "aboveCapacity";
  return null;
}

export interface Progress {
  /** What the target has plus what's held for it. */
  saved: string;
  /** Saved as a share of the goal, 0–100. */
  pct: number;
  /** The current part (TF or balance) and the held part, as shares of the goal. */
  currentPct: number;
  heldPct: number;
  /** What's still missing, or 0 once the goal is reached. */
  left: string;
  reached: boolean;
}

/** A target's progress towards its goal: current plus held. */
export function progress(target: SavingsTarget): Progress {
  const current = compareAmounts(target.current, "0") > 0 ? target.current : "0.00";
  const saved = addAmounts(current, target.held_total);
  const reached = compareAmounts(saved, target.goal) >= 0;
  const currentPct = Math.min(100, percentOf(current, target.goal));
  return {
    saved,
    pct: Math.min(100, percentOf(saved, target.goal)),
    currentPct,
    heldPct: Math.max(0, Math.min(100, percentOf(saved, target.goal)) - currentPct),
    left: reached ? "0.00" : subtractAmounts(target.goal, saved),
    reached,
  };
}

/** The accounts money can be added to a target from: its currency, not itself. */
export function sourceAccounts(target: SavingsTarget, accounts: Account[]): Account[] {
  return accounts.filter((a) => a.currency === target.currency && a.id !== target.account_id);
}

/** The target's bucket, if it's a bucket target. */
export function targetBucket(target: SavingsTarget, buckets: Bucket[]): Bucket | undefined {
  return target.bucket_id === null ? undefined : buckets.find((b) => b.id === target.bucket_id);
}

/**
 * How Add to savings works from the account: `direct` straight into a bucket
 * target funded from it (an SVB, needs a cycle), else `hold` (an SVR).
 */
export function addKind(
  target: SavingsTarget,
  accountId: string,
  buckets: Bucket[],
): "direct" | "hold" {
  return targetBucket(target, buckets)?.source_account_id === accountId ? "direct" : "hold";
}

/** What a bucket target's fixed capacity leaves room for, or null for no cap. */
export function bucketRoom(bucket: Bucket | undefined): string | null {
  const limit = goalLimit(bucket);
  if (!bucket || limit === null) return null;
  const room = subtractAmounts(limit, bucket.target_funds);
  return compareAmounts(room, "0") > 0 ? room : "0.00";
}

export type AmountProblem = "notPositive" | "overUnallocated" | "overHeld" | "overCapacity";

/** Add to savings: at most the account's unallocated money, and room in a capped bucket. */
export function addProblem(
  target: SavingsTarget,
  account: Account | undefined,
  amount: string | null,
  buckets: Bucket[],
): AmountProblem | null {
  if (amount === null || compareAmounts(amount, "0") <= 0) return "notPositive";
  if (!account || compareAmounts(amount, account.unallocated) > 0) return "overUnallocated";
  if (addKind(target, account.id, buckets) === "direct") {
    const room = bucketRoom(targetBucket(target, buckets));
    if (room !== null && compareAmounts(amount, room) > 0) return "overCapacity";
  }
  return null;
}

/** What's held for the target on the account. */
export function heldOn(target: SavingsTarget, accountId: string): string {
  return target.held.find((h) => h.account_id === accountId)?.amount ?? "0.00";
}

/** Done and Clear: at most what's held; Done into a capped bucket, within its room. */
export function heldProblem(
  target: SavingsTarget,
  accountId: string,
  amount: string | null,
  buckets: Bucket[],
  done: boolean,
): AmountProblem | null {
  if (amount === null || compareAmounts(amount, "0") <= 0) return "notPositive";
  if (compareAmounts(amount, heldOn(target, accountId)) > 0) return "overHeld";
  if (done) {
    const room = bucketRoom(targetBucket(target, buckets));
    if (room !== null && compareAmounts(amount, room) > 0) return "overCapacity";
  }
  return null;
}

/** Whether adding the amount takes the target past its goal (allowed, with a note). */
export function pastGoal(target: SavingsTarget, amount: string | null): boolean {
  if (amount === null) return false;
  return compareAmounts(addAmounts(progress(target).saved, amount), target.goal) > 0;
}

/** Whether a Done for the target records a bucket line, so it needs a running cycle. */
export function doneNeedsCycle(target: SavingsTarget): boolean {
  return target.bucket_id !== null;
}

/** Savings held on an account and not covered by its balance, if any. */
export function uncoveredOn(account: Account): string | null {
  return compareAmounts(account.reserved_uncovered, "0") > 0 ? account.reserved_uncovered : null;
}

/** The targets that would go if the bucket or account went, with what's held for them. */
export function targetOf(
  targets: SavingsTarget[],
  ref: { bucketId?: string; accountId?: string },
): SavingsTarget | undefined {
  return targets.find(
    (t) =>
      (ref.bucketId !== undefined && t.bucket_id === ref.bucketId) ||
      (ref.accountId !== undefined && t.account_id === ref.accountId),
  );
}

/** What a target is: "Bucket on Main", or the account's type ("BSU"). */
export function targetKindText(
  target: SavingsTarget,
  accounts: Account[],
  buckets: Bucket[],
): string {
  if (target.bucket_id !== null) {
    const bucket = buckets.find((b) => b.id === target.bucket_id);
    const account = accounts.find((a) => a.id === bucket?.source_account_id);
    return account
      ? i18n.t("savings.kindBucketOn", { account: account.name })
      : i18n.t("savings.kindBucket");
  }
  const account = accounts.find((a) => a.id === target.account_id);
  return account ? accountTypeLabel(account.type) : i18n.t("savings.kindAccount");
}

// The distributor (#232, spec §8.4).

/** A rule's range as the forms edit it: from, and to (null: no end). */
export interface RangeInput {
  from: string | null;
  to: string | null;
}

/** The target's rules, by where they start. */
export function rulesOf(rules: SavingsRule[], targetId: string): SavingsRule[] {
  return rules
    .filter((r) => r.target_id === targetId)
    .sort((a, b) => compareAmounts(a.from, b.from));
}

export type RangeProblem = "noFrom" | "toNotAbove" | "overlap";

/**
 * What's wrong with a range among its target's other rules (skip: the one
 * being edited). Ranges run from up to, not including, to, so touching ones
 * are fine; the server checks it again.
 */
export function rangeProblem(
  input: RangeInput,
  siblings: SavingsRule[],
  skip?: string,
): { problem: RangeProblem; with?: SavingsRule } | null {
  const from = input.from;
  if (from === null || compareAmounts(from, "0") < 0) return { problem: "noFrom" };
  if (input.to !== null && compareAmounts(input.to, from) <= 0) return { problem: "toNotAbove" };
  for (const r of siblings) {
    if (r.id === skip) continue;
    const startsBeforeItEnds = r.to === null || compareAmounts(from, r.to) < 0;
    const endsAfterItStarts = input.to === null || compareAmounts(r.from, input.to) < 0;
    if (startsBeforeItEnds && endsAfterItStarts) return { problem: "overlap", with: r };
  }
  return null;
}

/** The stretches of position no rule of the target covers, below its last range. */
export function gapsOf(rules: SavingsRule[]): RangeInput[] {
  const sorted = [...rules].sort((a, b) => compareAmounts(a.from, b.from));
  const gaps: RangeInput[] = [];
  let edge = "0.00";
  for (const r of sorted) {
    if (compareAmounts(r.from, edge) > 0) gaps.push({ from: edge, to: r.from });
    if (r.to === null) return gaps;
    if (compareAmounts(r.to, edge) > 0) edge = r.to;
  }
  return gaps;
}

/** Where the target's last range ends, or null when it has no end; "0.00" without rules. */
export function rulesEnd(rules: SavingsRule[]): string | null {
  let edge = "0.00";
  for (const r of rules) {
    if (r.to === null) return null;
    if (compareAmounts(r.to, edge) > 0) edge = r.to;
  }
  return edge;
}

/** "0 kr – 40 000 kr", or "40 000 kr and up". */
export function rangeText(range: { from: string; to: string | null }, currency: string): string {
  const from = formatMoney(range.from, currency);
  return range.to === null
    ? i18n.t("savingsSetup.distributor.rangeOpen", { from })
    : i18n.t("savingsSetup.distributor.range", { from, to: formatMoney(range.to, currency) });
}

/** A target's position as the distributor sees it: its balance or TF, not below 0, plus held. */
export function position(target: SavingsTarget): string {
  return progress(target).saved;
}

/** What the distributor holds on the account. */
export function distributorHeldOn(distributor: SavingsDistributor, accountId: string): string {
  return distributor.held.find((h) => h.account_id === accountId)?.amount ?? "0.00";
}

/** The accounts the distributor can take money from: the targets' currencies. */
export function distributorSources(accounts: Account[], targets: SavingsTarget[]): Account[] {
  const currencies = new Set(targets.map((t) => t.currency));
  return accounts.filter((a) => currencies.has(a.currency));
}

/** What adding to the distributor does now, by its hold mode. */
export function addOutcome(
  distributor: SavingsDistributor,
  accountId: string,
  amount: string,
): "split" | "waits" | "reachesMinimum" | "belowMinimum" {
  if (distributor.hold_mode === "immediate") return "split";
  if (distributor.hold_mode === "manual") return "waits";
  const after = addAmounts(distributorHeldOn(distributor, accountId), amount);
  return compareAmounts(after, distributor.min_amount ?? "0") >= 0
    ? "reachesMinimum"
    : "belowMinimum";
}

/** Where a bucket's overflow goes (#233): the distributor, a target's name, or null for unallocated. */
export function overflowTo(bucket: Bucket, targets: SavingsTarget[]): string | null {
  switch (bucket.overflow_destination) {
    case "savings_distribution":
      return i18n.t("savingsSetup.distributor.title");
    case "savings_target":
      return (
        targets.find((x) => x.id === bucket.overflow_target_id)?.name ??
        i18n.t("transactions.unknownTarget", { id: bucket.overflow_target_id ?? "" })
      );
    default:
      return null;
  }
}

/** The buckets that send their overflow to the target, which switch to the distributor if it goes. */
export function overflowingInto(buckets: Bucket[], targetId: string): Bucket[] {
  return buckets.filter((b) => b.overflow_target_id === targetId);
}

/** Whether a savings budget entry is a sweep of unallocated money (#235). */
export function isSweep(entry: SavingsBudgetEntry): entry is SweepEntry {
  return entry.when === "after_refills" || entry.when === "cycle_end";
}

/** The entries with a fixed amount, not the sweeps. */
export function fixedEntries(entries: SavingsBudgetEntry[]): FixedBudgetEntry[] {
  return entries.filter((e): e is FixedBudgetEntry => !isSweep(e) && e.amount !== null);
}

/** The sweeps (the server always sends their keep). */
export function sweepEntries(entries: SavingsBudgetEntry[]): SweepEntry[] {
  return entries.filter(isSweep);
}

/**
 * The sweep modes the account has a sweep with already, but `exceptId`'s
 * (an account has one sweep per mode, #235).
 */
export function takenSweepModes(
  entries: SavingsBudgetEntry[],
  accountId: string | null,
  exceptId?: string,
): SweepWhen[] {
  const modes: SweepWhen[] = ["after_refills", "cycle_end"];
  return modes.filter((w) =>
    entries.some((e) => e.account_id === accountId && e.when === w && e.id !== exceptId),
  );
}

/**
 * Whether every bucket funded from the account but the Fully manual ones is
 * refilled in the active cycle, which an After the refills sweep waits for
 * (#235). An account without such buckets is.
 */
export function accountRefilled(buckets: Bucket[], accountId: string): boolean {
  return buckets
    .filter((b) => b.source_account_id === accountId && b.refill_mode !== "fully_manual")
    .every((b) => b.refilled);
}

/** What a sweep would take now: the account's unallocated money above keep, at least 0. */
export function sweepNow(unallocated: string, keep: string): string {
  const above = subtractAmounts(unallocated, keep);
  return compareAmounts(above, "0") > 0 ? above : "0.00";
}

/**
 * Where a sweep is in this cycle: stopped, swept (some), nothing swept (all
 * of it was within keep, or it was set up to start next cycle), waiting for
 * the account's refills, waiting for the cycle's end, or without a running
 * cycle.
 */
export type SweepStatus =
  "stopped" | "swept" | "nothingSwept" | "waitingRefills" | "atCycleEnd" | "noCycle";

export function sweepStatus(entry: SweepEntry, running: boolean): SweepStatus {
  if (entry.stopped) return "stopped";
  const run = entry.this_cycle;
  if (run) return compareAmounts(run.reserved, "0") > 0 ? "swept" : "nothingSwept";
  if (!running) return "noCycle";
  return entry.when === "after_refills" ? "waitingRefills" : "atCycleEnd";
}

/** Where a savings budget entry saves to (#234): its target's name, or the distributor. */
export function budgetDestination(entry: SavingsBudgetEntry, targets: SavingsTarget[]): string {
  if (entry.target_id === null) return i18n.t("savingsSetup.distributor.title");
  return (
    targets.find((x) => x.id === entry.target_id)?.name ??
    i18n.t("transactions.unknownTarget", { id: entry.target_id })
  );
}

/**
 * Where a savings budget entry is in this cycle: stopped (its target went),
 * saved (all of it), short, waiting for the next cycle (set up to start
 * then, or At cycle start without having run), waiting for an income, ready
 * to save by hand, or without a running cycle.
 */
export type BudgetStatus =
  "stopped" | "saved" | "short" | "nextCycle" | "waitingIncome" | "saveNow" | "noCycle";

export function budgetStatus(entry: FixedBudgetEntry, running: boolean): BudgetStatus {
  if (entry.stopped) return "stopped";
  const run = entry.this_cycle;
  if (run) {
    if (compareAmounts(run.wanted, "0") === 0) return "nextCycle";
    return compareAmounts(run.reserved, run.wanted) < 0 ? "short" : "saved";
  }
  if (!running) return "noCycle";
  switch (entry.when) {
    case "on_income":
      return "waitingIncome";
    case "manual":
      return "saveNow";
    default:
      return "nextCycle";
  }
}

/** What an account's live savings budget entries add up to per cycle. */
export function budgetTotal(entries: FixedBudgetEntry[], accountId: string): string {
  return addAmounts(
    ...entries.filter((e) => e.account_id === accountId && !e.stopped).map((e) => e.amount),
  );
}

/** The targets a savings budget entry from the account can save to: its currency, not itself. */
export function budgetTargets(
  targets: SavingsTarget[],
  account: Account | undefined,
): SavingsTarget[] {
  if (!account) return [];
  return targets.filter((x) => x.currency === account.currency && x.account_id !== account.id);
}
