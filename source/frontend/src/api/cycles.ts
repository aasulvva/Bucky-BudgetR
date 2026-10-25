// Budget cycles: the queries the shell and the Cycles screen share.

import { useQuery, useQueryClient } from "@tanstack/react-query";

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
