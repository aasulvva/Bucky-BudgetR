// The Logs screen's filters (#93), kept in the URL, and what they ask the API.

import type { operations } from "@/api/schema";

export type LogQuery = NonNullable<operations["listLogEntries"]["parameters"]["query"]>;

/** What the list shows: everything kept, or one part of it. */
export const LOG_SHOWS = ["all", "warn", "error", "event", "audit"] as const;
export type LogShow = (typeof LOG_SHOWS)[number];

export const LOG_PERIODS = ["day", "week", "month", "all", "custom"] as const;
export type LogPeriod = (typeof LOG_PERIODS)[number];

export interface LogFilters {
  show: LogShow;
  period: LogPeriod;
  /** With the custom period, ISO times; either may be open. */
  from: string | null;
  to: string | null;
  user: string | null;
  /** An error's reference: its request ID. */
  request: string | null;
  q: string;
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  show: "all",
  period: "all",
  from: null,
  to: null,
  user: null,
  request: null,
  q: "",
};

/** The request IDs the API accepts, as in its pattern. */
export const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function oneOf<T extends string>(values: readonly T[], value: string | null, fallback: T): T {
  return values.find((v) => v === value) ?? fallback;
}

export function filtersFromSearch(params: URLSearchParams): LogFilters {
  const request = params.get("request")?.trim() ?? "";
  return {
    show: oneOf(LOG_SHOWS, params.get("show"), "all"),
    period: oneOf(LOG_PERIODS, params.get("period"), "all"),
    from: params.get("from"),
    to: params.get("to"),
    user: params.get("user"),
    request: REFERENCE_PATTERN.test(request) ? request : null,
    q: params.get("q") ?? "",
  };
}

/** The filters as URL parameters, leaving out the defaults. */
export function filtersToSearch(f: LogFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.show !== "all") p.set("show", f.show);
  if (f.period !== "all") p.set("period", f.period);
  if (f.period === "custom") {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.user) p.set("user", f.user);
  if (f.request) p.set("request", f.request);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p;
}

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Partial<Record<LogPeriod, number>> = { day: 1, week: 7, month: 30 };

/** The API query for the filters, with the period ending at now. */
export function logQuery(f: LogFilters, now: Date): LogQuery {
  const q: LogQuery = {};
  if (f.show === "warn" || f.show === "error") q.min_level = f.show;
  if (f.show === "event" || f.show === "audit") q.kind = f.show;
  const days = PERIOD_DAYS[f.period];
  if (days) q.from = new Date(now.getTime() - days * DAY).toISOString();
  if (f.period === "custom") {
    if (f.from) q.from = f.from;
    if (f.to) q.to = f.to;
  }
  if (f.user) q.user_id = f.user;
  if (f.request) q.request_id = f.request;
  if (f.q.trim()) q.q = f.q.trim().slice(0, 200);
  return q;
}

/** How many filters differ from the defaults, for the mobile Filters button. */
export function activeFilters(f: LogFilters): number {
  return [
    f.show !== "all",
    f.period !== "all",
    f.user !== null,
    f.request !== null,
    f.q.trim() !== "",
  ].filter(Boolean).length;
}

/** The events and admin actions the app records, with a label each. */
export const KNOWN_EVENTS = [
  "server.starting",
  "server.listening",
  "server.stopping",
  "server.stopped",
  "migration.applied",
  "admin.initial_created",
  "cycle.started",
  "cycle.ended",
  "schedule.recorded",
  "schedule.queued",
  "user.created",
  "user.activated",
  "user.deactivated",
  "user.admin_granted",
  "user.admin_revoked",
  "user.password_reset",
  "logs.settings_changed",
  "data.exported",
  "data.imported",
] as const;
type KnownEvent = (typeof KNOWN_EVENTS)[number];

/** The i18n key under admin.logs.events of a known event, or null. */
export function eventKey(name: string | undefined): EventKey | null {
  const known = KNOWN_EVENTS.find((e) => e === name);
  return known ? (known.replace(".", "_") as EventKey) : null;
}
type Underscored<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${B}` : S;
export type EventKey = Underscored<KnownEvent>;
