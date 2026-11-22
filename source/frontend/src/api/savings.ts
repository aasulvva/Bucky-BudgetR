// Savings targets (#231), the distributor (#232) and the savings budget (#234): what the screens share. Money moves refresh them
// with the accounts (useRefreshMoney), since held funds change unallocated.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type SavingsTarget = components["schemas"]["SavingsTarget"];
export type SavingsHeld = components["schemas"]["SavingsHeld"];
export type SavingsDistributor = components["schemas"]["SavingsDistributor"];

export const SAVINGS_KEY = ["savings"] as const;

/** The user's savings targets, oldest first, with their progress and held funds. */
export function useSavingsTargets() {
  return useQuery({
    queryKey: SAVINGS_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/savings/targets")),
  });
}

/** The user's savings distributor (#232): its hold mode and what it holds. */
export function useSavingsDistributor() {
  return useQuery({
    queryKey: [...SAVINGS_KEY, "distributor"],
    queryFn: () => unwrap(api.GET("/api/v1/savings/distributor")),
  });
}

export type SavingsHoldMode = components["schemas"]["SavingsHoldMode"];
export type SavingsRule = components["schemas"]["SavingsRule"];
export type SavingsPreview = components["schemas"]["SavingsPreview"];

export const HOLD_MODES: SavingsHoldMode[] = ["immediate", "minimum", "manual"];

/** The distributor's rules (#232), of the live targets, by target and range. */
export function useSavingsRules() {
  return useQuery({
    queryKey: [...SAVINGS_KEY, "rules"],
    queryFn: () => unwrap(api.GET("/api/v1/savings/rules")),
  });
}

/**
 * What splitting the amount from the account would give each target now;
 * nothing is asked until both are set and the amount is above 0.
 */
export function useDistributionPreview(accountId: string | null, amount: string | null) {
  return useQuery({
    queryKey: [...SAVINGS_KEY, "preview", accountId, amount],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/savings/distributor/preview", {
          params: { query: { account_id: accountId ?? "", amount: amount ?? "" } },
        }),
      ),
    enabled: accountId !== null && amount !== null && Number(amount) > 0,
    placeholderData: keepPreviousData,
  });
}

export type SavingsBudgetEntry = components["schemas"]["SavingsBudgetEntry"];
export type SavingsBudgetWhen = components["schemas"]["SavingsBudgetWhen"];
export type NewSavingsBudgetEntry = components["schemas"]["NewSavingsBudgetEntry"];
export type SavingsBudgetEntryUpdate = components["schemas"]["SavingsBudgetEntryUpdate"];

export const BUDGET_WHEN: SavingsBudgetWhen[] = ["cycle_start", "on_income", "manual"];

/** The savings budget's fixed amounts (#234), oldest first, with this cycle's runs. */
export function useSavingsBudget() {
  return useQuery({
    queryKey: [...SAVINGS_KEY, "budget"],
    queryFn: () => unwrap(api.GET("/api/v1/savings/budget")),
  });
}
