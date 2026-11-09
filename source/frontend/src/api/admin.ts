// Admins only: user management (the user list, and what to refresh after a
// change) and the Logs screen (#93).

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { LogQuery } from "@/lib/logs";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type AdminUser = components["schemas"]["AdminUser"];
export type Credential = components["schemas"]["Credential"];
export type NewCredential = components["schemas"]["NewCredential"];
export type LogEntry = components["schemas"]["LogEntry"];
export type LogSettings = components["schemas"]["LogSettings"];

export const ADMIN_USERS_KEY = ["admin", "users"] as const;

/** The usernames the API accepts, as in the API's Username schema. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

/** Every user, sorted by username. Off for non-admins, whom the API refuses. */
export function useAdminUsers(enabled: boolean) {
  return useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/admin/users")),
    enabled,
  });
}

/** A setup or reset link's URL. The token is in the fragment, so it isn't sent to servers. */
export function passwordLinkUrl(token: string): string {
  return `${window.location.origin}/set-password#${token}`;
}

export function useRefreshUsers(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
}

export const LOGS_KEY = ["admin", "logs"] as const;
const LOG_SETTINGS_KEY = ["admin", "log-settings"] as const;

/** The kept log entries matching query, newest first, a page at a time. */
export function useLogPages(query: LogQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...LOGS_KEY, query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/admin/logs", {
          params: { query: { ...query, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_before ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** How long log entries are kept. */
export function useLogSettings(enabled = true) {
  return useQuery({
    queryKey: LOG_SETTINGS_KEY,
    queryFn: () => unwrap(api.GET("/api/v1/admin/log-settings")),
    enabled,
  });
}

/** Sets the retention; the change shows in the log as an admin action. */
export function useUpdateLogSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LogSettings) => unwrap(api.PUT("/api/v1/admin/log-settings", { body })),
    onSuccess: (settings) => {
      client.setQueryData(LOG_SETTINGS_KEY, settings);
      void client.invalidateQueries({ queryKey: LOGS_KEY });
    },
  });
}
