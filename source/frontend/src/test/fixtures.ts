// Sample data for tests, in the API's shapes.

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import type { Transaction } from "@/api/transactions";
import { addDays, endAtFor, startAtFor, today } from "@/lib/cycles";

export function account(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    type: "usage",
    currency: "NOK",
    balance: "0.00",
    unallocated: "0.00",
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
    before_reversal: null,
    ...overrides,
  };
}
