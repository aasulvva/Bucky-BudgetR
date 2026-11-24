// Scheduled and recurring transactions (#154): the user's schedules, saving
// them, and the preview of a repeat.

import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Schedule, ScheduleInput, SchedulePreview } from "@/lib/schedules";

import type { TransactionCreate } from "./transactions";

import { useRefreshMoney } from "./accounts";
import { api } from "./client";
import { unwrap } from "./errors";

export const SCHEDULES_KEY = ["schedules"] as const;

/** The user's schedules, the next due first, then the ended ones. */
export function useSchedules() {
  return useQuery({
    queryKey: [...SCHEDULES_KEY, "list"],
    queryFn: () => unwrap(api.GET("/api/v1/schedules")),
  });
}

export function useSchedule(id: string) {
  return useQuery({
    queryKey: [...SCHEDULES_KEY, "detail", id],
    queryFn: () =>
      unwrap(api.GET("/api/v1/schedules/{scheduleId}", { params: { path: { scheduleId: id } } })),
  });
}

/**
 * The next times of a repeat that needn't be saved, or nothing while body is
 * null. The body is debounced; the last preview stays while the next loads.
 */
export function useSchedulePreview(body: SchedulePreview | null) {
  // As text, so a new object with the same repeat doesn't restart the wait.
  const [debounced] = useDebouncedValue(body && JSON.stringify(body), 300);
  return useQuery({
    queryKey: [...SCHEDULES_KEY, "preview", debounced],
    queryFn: () => {
      if (debounced === null) throw new Error("no repeat to preview");
      const repeat = JSON.parse(debounced) as SchedulePreview;
      return unwrap(api.POST("/api/v1/schedules/preview", { body: repeat }));
    },
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
    meta: { silentError: true },
  });
}

/** After a change: the schedules, and the money a recorded one moved. */
export function useRefreshSchedules() {
  const client = useQueryClient();
  const refresh = useRefreshMoney();
  return async () => {
    await Promise.all([client.invalidateQueries({ queryKey: SCHEDULES_KEY }), refresh()]);
  };
}

export interface SaveSchedule {
  /** Updates this schedule; otherwise creates one. */
  id?: string;
  body: ScheduleInput;
  /** Records a first time that's now or past (New transaction set to repeat). */
  recordFirst?: boolean;
}

export function useSaveSchedule(
  onSaved?: (s: Schedule, vars: SaveSchedule) => void | Promise<void>,
) {
  const refresh = useRefreshSchedules();
  return useMutation({
    mutationFn: ({ id, body, recordFirst }: SaveSchedule) =>
      id
        ? unwrap(
            api.PUT("/api/v1/schedules/{scheduleId}", {
              params: { path: { scheduleId: id } },
              body,
            }),
          )
        : unwrap(
            api.POST("/api/v1/schedules", {
              params: { query: recordFirst ? { record_first: true } : {} },
              body,
            }),
          ),
    meta: { silentError: true },
    onSuccess: async (s, vars) => {
      await refresh();
      await onSaved?.(s, vars);
    },
  });
}

export function useDeleteSchedule(onDeleted?: () => void) {
  const refresh = useRefreshSchedules();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/schedules/{scheduleId}", { params: { path: { scheduleId: id } } }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      await refresh();
      onDeleted?.();
    },
  });
}

const QUEUE_KEY = [...SCHEDULES_KEY, "queue"] as const;

/**
 * The approval queue: every queued scheduled transaction, newest first.
 * Refetched every minute, since the scheduler adds to it.
 */
export function useQueue() {
  return useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/scheduled-transactions", {
          params: { query: { state: "queued", limit: 200 } },
        }),
      ).then((page) => page.items),
    refetchInterval: 60_000,
  });
}

/** How many are queued, and whether any is overdue. */
export function useQueueCount(): { count: number; overdue: boolean } {
  const items = useQueue().data ?? [];
  return { count: items.length, overdue: items.some((o) => o.overdue) };
}

export function useOccurrence(id: string) {
  return useQuery({
    queryKey: [...SCHEDULES_KEY, "occurrence", id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/scheduled-transactions/{scheduledTransactionId}", {
          params: { path: { scheduledTransactionId: id } },
        }),
      ),
  });
}

/** What the schedules record next, earliest first. */
export function useUpcoming(count: number, enabled = true) {
  return useQuery({
    queryKey: [...SCHEDULES_KEY, "upcoming", count],
    queryFn: () =>
      unwrap(api.GET("/api/v1/upcoming-transactions", { params: { query: { count } } })),
    enabled,
  });
}

export interface Approve {
  id: string;
  /** The edited transaction; without it, the schedule's as it is. */
  body?: TransactionCreate;
}

/** Approves a queued one: records it and marks it applied. */
export function useApprove(onApproved?: (vars: Approve) => void | Promise<void>) {
  const refresh = useRefreshSchedules();
  return useMutation({
    mutationFn: ({ id, body }: Approve) =>
      unwrap(
        api.POST("/api/v1/scheduled-transactions/{scheduledTransactionId}/approve", {
          params: { path: { scheduledTransactionId: id } },
          ...(body ? { body } : {}),
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (_, vars) => {
      await refresh();
      await onApproved?.(vars);
    },
  });
}

/** Skips a queued one: it's never recorded. */
export function useSkip(onSkipped?: (id: string) => void) {
  const refresh = useRefreshSchedules();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST("/api/v1/scheduled-transactions/{scheduledTransactionId}/skip", {
          params: { path: { scheduledTransactionId: id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (_, id) => {
      await refresh();
      onSkipped?.(id);
    },
  });
}

export type BulkAction = "approve" | "skip";

/** What approving or skipping several did: the ones done and the ones that failed. */
export interface BulkResult {
  done: string[];
  failed: { id: string; error: unknown }[];
}

function resolveOne(action: BulkAction, id: string) {
  const params = { path: { scheduledTransactionId: id } };
  return action === "approve"
    ? unwrap(
        api.POST("/api/v1/scheduled-transactions/{scheduledTransactionId}/approve", { params }),
      )
    : unwrap(api.POST("/api/v1/scheduled-transactions/{scheduledTransactionId}/skip", { params }));
}

/**
 * Approves or skips several as they are, one at a time so they're recorded
 * in order, and refreshes once at the end. A failure doesn't stop the rest.
 */
export function useResolveMany() {
  const refresh = useRefreshSchedules();
  return useMutation({
    mutationFn: async ({ action, ids }: { action: BulkAction; ids: string[] }) => {
      const result: BulkResult = { done: [], failed: [] };
      for (const id of ids) {
        try {
          await resolveOne(action, id);
          result.done.push(id);
        } catch (error) {
          result.failed.push({ id, error });
        }
      }
      return result;
    },
    meta: { silentError: true },
    onSettled: () => refresh(),
  });
}
