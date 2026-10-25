// Sample data for tests, in the API's shapes.

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { addDays, endAtFor, startAtFor, today } from "@/lib/cycles";

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
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
