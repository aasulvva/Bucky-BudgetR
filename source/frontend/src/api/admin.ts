// User management (admins only): the user list, and what to refresh after a
// change.

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type AdminUser = components["schemas"]["AdminUser"];

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

export function useRefreshUsers(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
}
