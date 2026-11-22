// Sample data for tests, in the API's shapes.

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import type { FixedBudgetEntry, SavingsTarget, SweepEntry } from "@/api/savings";
import type { Transaction } from "@/api/transactions";
import { addDays, endAtFor, startAtFor, today } from "@/lib/cycles";

export function account(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    type: "usage",
    currency: "NOK",
    bank: "",
    balance: "0.00",
    unallocated: "0.00",
    reserved: "0.00",
    reserved_uncovered: "0.00",
    expected_income: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function bucket(
  overrides: Partial<Bucket> & Pick<Bucket, "id" | "name" | "source_account_id">,
): Bucket {
  return {
    currency: "NOK",
    refill_amount: "0.00",
    cap_mode: "multiplier",
    cap_multiplier: "1",
    cap_amount: null,
    capacity: "0.00",
    target_funds: "0.00",
    current_available_funds: "0.00",
    keep_funds: false,
    negative_tf: "debt",
    refill_mode: "auto",
    overflow_destination: "unallocated",
    overflow_target_id: null,
    priority: false,
    importance: 5,
    refilled: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A bucket's figures for a cycle; all 0 unless given. */
export function bucketFigures(
  overrides: Partial<BucketFigures> & Pick<BucketFigures, "bucket_id">,
): BucketFigures {
  return {
    start: "0.00",
    refills: "0.00",
    income: "0.00",
    opening_funds: "0.00",
    adjustments: "0.00",
    transfers: "0.00",
    budget: "0.00",
    used: "0.00",
    overflow: "0.00",
    capped: "0.00",
    swept: "0.00",
    left: "0.00",
    ...overrides,
  };
}

/**
 * A cycle; by default the active one, at local midnights from 10 days ago
 * to 19 days ahead (its last day).
 */
export function cycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: "100001000001",
    start_at: startAtFor(addDays(today(), -10)),
    end_at: endAtFor(addDays(today(), 19)),
    state: "active",
    generated: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** An expense of 100 on account 1234, now, with no buckets; change what a test needs. */
export function transaction(
  overrides: Partial<Transaction> & Pick<Transaction, "id">,
): Transaction {
  return {
    type: "EXP",
    at: new Date().toISOString(),
    counterparty: "",
    description: "",
    tags: [],
    triggers_refill: false,
    created_at: new Date().toISOString(),
    created_by: "00000000-0000-0000-0000-000000000001",
    corrected: false,
    reversed: false,
    replaces: null,
    replaced_by: null,
    schedule_id: null,
    bank_lines: [{ account_id: "1234", amount: "-100.00" }],
    bucket_lines: [],
    savings_lines: [],
    before_reversal: null,
    balances_after: [],
    ...overrides,
  };
}

/** A savings target on an account, with a goal of 10 000 and nothing held; change what a test needs. */
export function savingsTarget(
  overrides: Partial<SavingsTarget> & Pick<SavingsTarget, "id" | "name">,
): SavingsTarget {
  return {
    custom_name: null,
    bucket_id: null,
    account_id: "2345",
    currency: "NOK",
    goal: "10000.00",
    note: "",
    current: "0.00",
    held_total: "0.00",
    held: [],
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A savings budget entry (#234): from account 1234 to the distributor, not run this cycle. */
export function budgetEntry(
  overrides: Partial<FixedBudgetEntry> & Pick<FixedBudgetEntry, "id">,
): FixedBudgetEntry {
  return {
    account_id: "1234",
    target_id: null,
    amount: "500.00",
    keep: null,
    when: "cycle_start",
    stopped: false,
    this_cycle: null,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A sweep (#235): from account 1234 to the distributor after the refills, keeping nothing, not run this cycle. */
export function sweepEntry(overrides: Partial<SweepEntry> & Pick<SweepEntry, "id">): SweepEntry {
  return {
    account_id: "1234",
    target_id: null,
    amount: null,
    keep: "0.00",
    when: "after_refills",
    stopped: false,
    this_cycle: null,
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
