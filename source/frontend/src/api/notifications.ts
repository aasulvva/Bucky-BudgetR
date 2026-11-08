// Notifications (#57): reminders and to-dos the server works out from the
// user's data. Fetched again every minute, and after anything that moves
// money (useRefreshMoney) or changes the settings.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { components } from "./schema";

import { api } from "./client";
import { unwrap } from "./errors";

export type Notification = components["schemas"]["Notification"];
export type NotificationKind = components["schemas"]["NotificationKind"];
export type NotificationSettings = components["schemas"]["NotificationSettings"];

export const NOTIFICATIONS_KEY = ["notifications"] as const;

export function useNotifications() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: async () => (await unwrap(api.GET("/api/v1/notifications"))).items,
    refetchInterval: 60_000,
  });
}

/** How many are open, and whether one is an alert. */
export function useNotificationCount(): { count: number; alert: boolean } {
  const items = useNotifications().data ?? [];
  return { count: items.length, alert: items.some((n) => n.severity === "alert") };
}

/** Dismisses a notification, or marks it done: the same to the server. */
export function useDismiss() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      unwrap(api.POST("/api/v1/notifications/dismiss", { body: { key } })),
    // Shown under the notification instead.
    meta: { silentError: true },
    onSuccess: (_, key) => {
      client.setQueryData<Notification[]>(NOTIFICATIONS_KEY, (list) =>
        list?.filter((n) => n.key !== key),
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
