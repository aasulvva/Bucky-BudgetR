// Savings targets and their held funds (#231, spec §8): what the Savings and
// Savings setup screens work out, kept apart from the pages. The server
// checks it all again.

import { accountTypeLabel, type Account, type AccountType, type Bucket } from "@/api/accounts";
import type { SavingsTarget } from "@/api/savings";
import i18n from "@/i18n";

import { addAmounts, compareAmounts, percentOf, subtractAmounts } from "./money";

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
