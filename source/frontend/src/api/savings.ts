// Savings targets (#231) and the distributor (#232): what the screens share. Money moves refresh them
// with the accounts (useRefreshMoney), since held funds change unallocated.

import { useQuery } from "@tanstack/react-query";

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
