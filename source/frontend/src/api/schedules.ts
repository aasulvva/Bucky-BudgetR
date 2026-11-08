// Scheduled and recurring transactions (#154): the user's schedules, saving
// them, and the preview of a repeat.

import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Schedule, ScheduleInput, SchedulePreview } from "@/lib/schedules";

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
function useRefreshSchedules() {
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
