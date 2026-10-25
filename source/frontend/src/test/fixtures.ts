// Sample data for tests, in the API's shapes.

import type { Account, Bucket } from "@/api/accounts";

export function account(overrides: Partial<Account> & Pick<Account, "id" | "name">): Account {
  return {
    type: "usage",
    currency: "NOK",
    balance: "0.00",
    unallocated: "0.00",
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
    refill_mode: "auto",
    overflow_destination: "unallocated",
    priority: false,
    importance: 5,
    refilled: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
