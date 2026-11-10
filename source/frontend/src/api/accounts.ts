// Bank accounts and buckets: the queries the screens share, and what to
// refresh after money moves.

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import i18n from "@/i18n";

import { api } from "./client";
import { unwrap } from "./errors";
import { NOTIFICATIONS_KEY } from "./notifications";
import type { components } from "./schema";

export type Account = components["schemas"]["Account"];
export type AccountFlow = components["schemas"]["AccountFlow"];
export type AccountType = components["schemas"]["AccountType"];
export type Bucket = components["schemas"]["Bucket"];
export type BucketFigures = components["schemas"]["BucketFigures"];
export type RefillMode = components["schemas"]["RefillMode"];

export const ACCOUNTS_KEY = ["accounts"] as const;
export const BUCKETS_KEY = ["buckets"] as const;

const ACCOUNT_TYPES: AccountType[] = ["usage", "savings", "bsu", "fund", "investment"];

export function accountTypeLabel(type: AccountType): string {
  return i18n.t(`accounts.types.${type}`);
}

/** The account types, for a select. */
export function accountTypeOptions(): { value: AccountType; label: string }[] {
  return ACCOUNT_TYPES.map((value) => ({ value, label: accountTypeLabel(value) }));
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
 * The buckets' figures for a cycle ("used X of Y"); off without a cycle.
 * Under BUCKETS_KEY, so money changes refresh them with the buckets.
 */
export function useBucketFigures(cycleId: string | undefined) {
  return useQuery({
    queryKey: [...BUCKETS_KEY, "figures", cycleId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/cycles/{cycleId}/bucket-figures", {
          params: { path: { cycleId: cycleId ?? "" } },
        }),
      ),
    enabled: cycleId !== undefined,
  });
}

/**
 * The buckets' figures for several cycles at once (#126), in the order
 * given, under the same keys as useBucketFigures so they share the cache.
 */
export function useBucketFiguresFor(cycleIds: string[]) {
  return useQueries({
    queries: cycleIds.map((cycleId) => ({
      queryKey: [...BUCKETS_KEY, "figures", cycleId],
      queryFn: () =>
        unwrap(
          api.GET("/api/v1/cycles/{cycleId}/bucket-figures", {
            params: { path: { cycleId } },
          }),
        ),
    })),
  });
}

/**
 * Each account's income, expenses and transfers over [from, to) (#90); off
 * without a period. Under the transactions key, so money changes refresh it.
 */
export function useAccountFlows(span: { from: string; to: string } | null) {
  return useQuery({
    queryKey: ["transactions", "flows", span?.from, span?.to],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/reports/flows", {
          params: { query: { from: span?.from ?? "", to: span?.to ?? "" } },
        }),
      ),
    enabled: span !== null,
  });
}

export function refillModeLabel(mode: RefillMode): string {
  return i18n.t(`buckets.modes.${mode}`);
}

/**
 * Refreshes what a transaction or an account change can move: balances,
 * unallocated money, the buckets' TF and CAF, transaction lists, and the
 * notifications they settle.
 */
export function useRefreshMoney(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      [ACCOUNTS_KEY, BUCKETS_KEY, ["transactions"], NOTIFICATIONS_KEY].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  };
}
