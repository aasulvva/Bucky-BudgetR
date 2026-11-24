// Purchases that count in their buckets later (#264): the open waiting
// charges, and Take now.

import { useMutation, useQuery } from "@tanstack/react-query";

import { useRefreshMoney } from "./accounts";
import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type CountLater = components["schemas"]["CountLater"];
export type WaitingChargeWhen = components["schemas"]["WaitingChargeWhen"];
export type WaitingCharge = components["schemas"]["WaitingCharge"];
export type OpenWaitingCharge = components["schemas"]["OpenWaitingCharge"];

/** Under ["transactions"], so useRefreshMoney() refreshes it after any save. */
export const WAITING_KEY = ["transactions", "waiting-charges"] as const;

/** The open waiting charges of live buckets, oldest purchase first. */
export function useWaitingCharges() {
  return useQuery({
    queryKey: WAITING_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/waiting-charges")),
  });
}

/** Take now: the bucket counts what's left of the charge in the active cycle. */
export function useTakeCharge(onDone?: () => void) {
  const refresh = useRefreshMoney();
  return useMutation({
    mutationFn: (chargeId: string) =>
      unwrap(
        api.POST("/api/v1/waiting-charges/{chargeId}/take", {
          params: { path: { chargeId } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      onDone?.();
      await refresh();
    },
  });
}
