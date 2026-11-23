// BSU accounts (#214, spec §2.1): the history setup that unlocks a BSU, and
// the admins' deposit rules.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useRefreshMoney } from "./accounts";
import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type BsuStatus = components["schemas"]["BSUStatus"];
export type BsuHistory = components["schemas"]["BSUHistory"];
export type BsuRule = components["schemas"]["BSURule"];
export type BsuSetUp = components["schemas"]["BSUSetUp"];
export type BsuYear = components["schemas"]["BSUYear"];

const BSU_RULES_KEY = ["admin", "bsu-rules"] as const;

/** What the app has recorded on a BSU account, for its setup. */
export function useBsuHistory(accountId: string, enabled = true) {
  return useQuery({
    queryKey: ["bsu-history", accountId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/accounts/{accountId}/bsu-history", {
          params: { path: { accountId } },
        }),
      ),
    enabled,
    // It must match the account right now.
    staleTime: 0,
  });
}

/** Sets up a BSU account's history, which unlocks it. */
export function useSetUpBsu(accountId: string) {
  const refresh = useRefreshMoney();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BsuSetUp) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/bsu-history", {
          params: { path: { accountId } },
          body,
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      client.removeQueries({ queryKey: ["bsu-history", accountId] });
      await refresh();
    },
  });
}

/** The deposit limits, oldest first (admins only). */
export function useBsuRules(enabled = true) {
  return useQuery({
    queryKey: BSU_RULES_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/admin/bsu-rules")),
    enabled,
  });
}

/** Creates or changes the rule from a year (admins only). */
export function useSetBsuRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ year, ...body }: { year: number; yearly_limit: string; total_limit: string }) =>
      unwrap(api.PUT("/api/v1/admin/bsu-rules/{year}", { params: { path: { year } }, body })),
    meta: { silentError: true },
    onSuccess: () => client.invalidateQueries({ queryKey: BSU_RULES_KEY }),
  });
}

/** Deletes the rule from a year (admins only); the last one stays. */
export function useDeleteBsuRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (year: number) =>
      unwrap(api.DELETE("/api/v1/admin/bsu-rules/{year}", { params: { path: { year } } })),
    meta: { silentError: true },
    onSuccess: () => client.invalidateQueries({ queryKey: BSU_RULES_KEY }),
  });
}
