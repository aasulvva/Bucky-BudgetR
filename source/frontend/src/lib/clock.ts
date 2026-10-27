// The app's clock. It is the device's clock, except in development when the
// server's debug clock (#100) is moved: then it follows the server, so
// "today", overdue cycles and the latest pickable time agree with it.

import { useSyncExternalStore } from "react";

export interface ServerClock {
  /** The server's time (ISO 8601). */
  now: string;
  /** The real time on the server (ISO 8601). */
  real_now: string;
  mode: "real" | "running" | "frozen";
}

let offset = 0;
let frozen: number | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** The current time. */
export function now(): Date {
  return new Date(frozen ?? Date.now() + offset);
}

/**
 * Follows the server's debug clock; null goes back to the device's clock. A
 * change bumps the clock's version (useClockVersion), so screens can redraw.
 */
export function setServerClock(clock: ServerClock | null): void {
  let nextOffset = 0;
  let nextFrozen: number | null = null;
  if (clock?.mode === "frozen") nextFrozen = Date.parse(clock.now);
  if (clock?.mode === "running") nextOffset = Date.parse(clock.now) - Date.parse(clock.real_now);
  // Refetching a running clock gives a slightly different offset; that's
  // not a change.
  if (nextFrozen === frozen && Math.abs(nextOffset - offset) < 5000) return;
  offset = nextOffset;
  frozen = nextFrozen;
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that changes whenever the clock is moved. */
export function useClockVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
