// Bank accounts and buckets: the queries the screens share, and what to
// refresh after money moves.

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type Account = components["schemas"]["Account"];
export type AccountType = components["schemas"]["AccountType"];
export type Bucket = components["schemas"]["Bucket"];

export const ACCOUNTS_KEY = ["accounts"] as const;
export const BUCKETS_KEY = ["buckets"] as const;

export const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "usage", label: "Usage" },
  { value: "savings", label: "Savings" },
  { value: "bsu", label: "BSU" },
  { value: "fund", label: "Fund/ASK" },
  { value: "investment", label: "Investment" },
];

export function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.label ?? type;
}

/** The user's accounts, sorted by name, with their balances. */
export function useAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/accounts")),
  });
}

/** The user's buckets, sorted by name, with TF and CAF. */
export function useBuckets() {
  return useQuery({
    queryKey: BUCKETS_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/buckets")),
  });
}

/**
 * Refreshes what a transaction or an account change can move: balances,
 * unallocated money, the buckets' TF and CAF, and transaction lists.
 */
export function useRefreshMoney(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      [ACCOUNTS_KEY, BUCKETS_KEY, ["transactions"]].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  };
}
