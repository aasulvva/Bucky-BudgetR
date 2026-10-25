// The session: who is logged in. GET /me answers 401 without a session, which
// here means "nobody" rather than an error.

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import type { components } from "@/api/schema";

export type User = components["schemas"]["User"];

export const SESSION_KEY = ["me"] as const;

async function fetchSession(): Promise<User | null> {
  try {
    return await unwrap(api.GET("/api/v1/me"));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** The logged-in user, or null without a session. */
export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 5 * 60_000 });
}

let ended = false;

/**
 * Handles an API error that says the session is gone (401) or must change its
 * password first (403 password_change_required), and reports whether it did.
 * The route guard then sends the user to the login or password page.
 */
export function handleSessionError(client: QueryClient, error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 && error.code === "unauthenticated") {
    if (client.getQueryData(SESSION_KEY)) ended = true;
    client.setQueryData(SESSION_KEY, null);
    return true;
  }
  if (error.status === 403 && error.code === "password_change_required") {
    void client.invalidateQueries({ queryKey: SESSION_KEY });
    return true;
  }
  return false;
}

/** Whether the session ended while the user was working. */
export function sessionEnded(): boolean {
  return ended;
}

export function clearSessionEnded(): void {
  ended = false;
}

/** Ends the session and goes to the login page. */
export function useSignOut(): () => void {
  const client = useQueryClient();
  const navigate = useNavigate();
  return () => {
    void api.POST("/api/v1/auth/logout").finally(() => {
      client.clear();
      void navigate("/login", { replace: true });
    });
  };
}
