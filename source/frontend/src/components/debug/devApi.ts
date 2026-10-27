// The development-only debug routes (/api/dev/, #100). They're not in the
// OpenAPI spec, so they're called with plain fetch rather than the typed client.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { csrfHeader } from "@/api/client";
import { ApiError, toProblem } from "@/api/errors";
import { setServerClock, type ServerClock } from "@/lib/clock";

export interface Snapshot {
  id: string;
  name: string;
  user_id: string;
  /** Empty if the user isn't in this database (an imported snapshot). */
  username: string;
  /** The current user's own snapshot; restoring another's makes a copy. */
  own: boolean;
  taken_at: string;
  created_at: string;
  schema_version: number;
  /** Taken at the current schema version, so it can be restored. */
  restorable: boolean;
  size: number;
}

export const DEV_CLOCK_KEY = ["dev", "clock"] as const;
export const DEV_SNAPSHOTS_KEY = ["dev", "snapshots"] as const;

async function dev<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (method !== "GET") headers.set(csrfHeader, "1");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(new Request(`${window.location.origin}/api/dev${path}`, init));
  if (!res.ok) {
    const problem: unknown = await res.json().catch(() => undefined);
    throw new ApiError(toProblem(problem, res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The server's debug clock; null when there's none (production). */
export function useDevClock() {
  return useQuery({
    queryKey: DEV_CLOCK_KEY,
    queryFn: async () => {
      try {
        return await dev<ServerClock>("GET", "/clock");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** After the clock moved or the data was replaced: follow it and reload everything. */
function useApplyClock() {
  const queryClient = useQueryClient();
  return (clock: ServerClock) => {
    queryClient.setQueryData(DEV_CLOCK_KEY, clock);
    setServerClock(clock);
    void queryClient.invalidateQueries();
  };
}

/** Sets the clock: a time (null for the real time), running or frozen. */
export function useSetDevClock() {
  const apply = useApplyClock();
  return useMutation({
    mutationFn: (body: { at: string | null; frozen: boolean }) =>
      dev<ServerClock>("PUT", "/clock", body),
    onSuccess: apply,
  });
}

export function useSnapshots(enabled: boolean) {
  return useQuery({
    queryKey: DEV_SNAPSHOTS_KEY,
    queryFn: () => dev<Snapshot[]>("GET", "/snapshots"),
    enabled,
  });
}

function useSnapshotMutation<V>(fn: (vars: V) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEV_SNAPSHOTS_KEY }),
  });
}

export function useSaveSnapshot() {
  return useSnapshotMutation((name: string) => dev<Snapshot>("POST", "/snapshots", { name }));
}

export function useRenameSnapshot() {
  return useSnapshotMutation(({ id, name }: { id: string; name: string }) =>
    dev("PATCH", `/snapshots/${id}`, { name }),
  );
}

export function useDeleteSnapshot() {
  return useSnapshotMutation((id: string) => dev("DELETE", `/snapshots/${id}`));
}

/** Imports an exported snapshot file. */
export function useImportSnapshot() {
  return useSnapshotMutation(async (file: File) =>
    dev<Snapshot>("POST", "/snapshots/import", await file.text()),
  );
}

/** Replaces the user's data with a snapshot's, optionally moving the clock to its time. */
export function useRestoreSnapshot() {
  const apply = useApplyClock();
  return useMutation({
    mutationFn: ({ id, setClock }: { id: string; setClock: boolean }) =>
      dev<ServerClock>("POST", `/snapshots/${id}/restore`, { set_clock: setClock }),
    onSuccess: apply,
  });
}

/** Where a snapshot downloads as a file. */
export function exportUrl(id: string): string {
  return `/api/dev/snapshots/${id}/export`;
}
