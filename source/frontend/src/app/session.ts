// The session: who is logged in. GET /me answers 401 without a session, which
// here means "nobody" rather than an error.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import type { components } from "@/api/schema";
import { browserTimeZone } from "@/lib/cycleRule";

export type User = components["schemas"]["User"];
export type Preferences = components["schemas"]["Preferences"];

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

/** PATCHes preferences and puts the result into the session user. */
export function useUpdatePreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Preferences) => unwrap(api.PATCH("/api/v1/me/preferences", { body })),
    onSuccess: (preferences) => {
      client.setQueryData<User | null>(SESSION_KEY, (user) => user && { ...user, preferences });
    },
  });
}

/**
 * Sets the time_zone preference to the browser's zone once, when it isn't
 * set: the server plans cycles from the cycle rule in it (#72).
 */
export function useDefaultTimeZone(user: User | null | undefined) {
  const client = useQueryClient();
  const tried = useRef(false);
  const missing = user != null && user.preferences.time_zone == null;
  useEffect(() => {
    if (!missing || tried.current) return;
    tried.current = true;
    api
      .PATCH("/api/v1/me/preferences", { body: { time_zone: browserTimeZone() } })
      .then(({ data }) => {
        if (data)
          client.setQueryData<User | null>(SESSION_KEY, (u) => u && { ...u, preferences: data });
      })
      .catch(() => undefined); // tried again on the next visit
  }, [missing, client]);
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
