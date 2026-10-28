// Budget cycles: the queries the shell and the Cycles screen share.

import { keepPreviousData, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LocalDate } from "@/lib/cycles";
import type { CycleRule } from "@/lib/cycleRule";

import { useRefreshMoney } from "./accounts";
import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type Cycle = components["schemas"]["Cycle"];

export const CYCLES_KEY = ["cycles"] as const;
export const CURRENT_CYCLES_KEY = ["cycles", "current"] as const;

/** All the user's cycles, oldest first. */
export function useCycles() {
  return useQuery({
    queryKey: CYCLES_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/cycles")),
  });
}

/** The active cycle and the next planned one; either can be null. */
export function useCurrentCycles() {
  return useQuery({
    queryKey: CURRENT_CYCLES_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/cycles/active")),
  });
}

/**
 * The periods a cycle rule gives, from the one containing `from` (today
 * without it). Nothing is fetched without a rule.
 */
export function useCyclePeriods(rule: CycleRule | null, from?: LocalDate, count = 4) {
  return useQuery({
    queryKey: ["cycle-rule-periods", rule, from, count],
    queryFn: rule
      ? () => unwrap(api.POST("/api/v1/cycle-rule/periods", { body: { rule, from, count } }))
      : skipToken,
    placeholderData: keepPreviousData,
  });
}

/**
 * Refreshes the cycles, and with them everything a cycle's start or end
 * moves: TF, CAF and balances (refills and overflow) and transactions.
 */
export function useRefreshCycles(): () => Promise<void> {
  const client = useQueryClient();
  const refreshMoney = useRefreshMoney();
  return async () => {
    await Promise.all([client.invalidateQueries({ queryKey: CYCLES_KEY }), refreshMoney()]);
  };
}
