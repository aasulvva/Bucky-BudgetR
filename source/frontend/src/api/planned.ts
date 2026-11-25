// Planned purchases (#265): a pre-order or the like, charged later, set aside
// in its buckets in the cycle of its expected date.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import { NOTIFICATIONS_KEY } from "./notifications";
import type { components } from "./schema";

export type PlannedPurchase = components["schemas"]["PlannedPurchase"];
export type PlannedPurchaseInput = components["schemas"]["PlannedPurchaseInput"];
export type PlannedPurchaseUpdate = components["schemas"]["PlannedPurchaseUpdate"];

export const PLANNED_KEY = ["planned"] as const;

/** The open plans, the soonest expected first; or the charged and cancelled ones. */
export function usePlannedPurchases(status: "open" | "closed" = "open") {
  return useQuery({
    queryKey: [...PLANNED_KEY, "list", status],
    queryFn: () => unwrap(api.GET("/api/v1/planned-purchases", { params: { query: { status } } })),
  });
}

export function usePlannedPurchase(id: string | null) {
  return useQuery({
    queryKey: [...PLANNED_KEY, "detail", id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/planned-purchases/{plannedId}", {
          params: { path: { plannedId: id ?? "" } },
        }),
      ),
    enabled: id !== null,
  });
}

/** After a change: the plans, what the buckets set aside, and the reminders. */
export function useRefreshPlanned() {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      // ["buckets"] is BUCKETS_KEY, which accounts.ts can't lend: it imports this.
      [PLANNED_KEY, ["buckets"], NOTIFICATIONS_KEY].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  };
}

export interface SavePlanned {
  /** Changes this plan; otherwise makes one. */
  id?: string;
  body: PlannedPurchaseInput;
}

export function useSavePlanned(onSaved?: (p: PlannedPurchase) => void | Promise<void>) {
  const refresh = useRefreshPlanned();
  return useMutation({
    mutationFn: ({ id, body }: SavePlanned) =>
      id
        ? unwrap(
            api.PATCH("/api/v1/planned-purchases/{plannedId}", {
              params: { path: { plannedId: id } },
              body,
            }),
          )
        : unwrap(api.POST("/api/v1/planned-purchases", { body })),
    meta: { silentError: true },
    onSuccess: async (p) => {
      await refresh();
      await onSaved?.(p);
    },
  });
}

/** Changes some fields of a plan, such as its date (Move date). */
export function useUpdatePlanned(onSaved?: (p: PlannedPurchase) => void) {
  const refresh = useRefreshPlanned();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PlannedPurchaseUpdate }) =>
      unwrap(
        api.PATCH("/api/v1/planned-purchases/{plannedId}", {
          params: { path: { plannedId: id } },
          body,
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (p) => {
      await refresh();
      onSaved?.(p);
    },
  });
}

export function useCancelPlanned(onCancelled?: () => void) {
  const refresh = useRefreshPlanned();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/planned-purchases/{plannedId}", {
          params: { path: { plannedId: id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      await refresh();
      onCancelled?.();
    },
  });
}
