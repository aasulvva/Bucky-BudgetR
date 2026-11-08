// Scheduled and recurring transactions (#31, #154): the repeat a schedule
// form edits, what's sent to the API, and the sentence a schedule shows as.
//
// A schedule's start date and time are wall time in its time zone (the
// user's, from the time_zone preference); the times the API returns are UTC
// and shown in local time.

import type { TFunction } from "i18next";

import type { Cycle } from "@/api/cycles";
import type { components } from "@/api/schema";
import type { Transaction } from "@/api/transactions";

import { now as clockNow } from "./clock";
import { browserTimeZone } from "./cycleRule";
import { formatDate, parseDate } from "./dates";
import { getLocale } from "./locale";
import {
  editState,
  insideCycle,
  newLine,
  type EditValues,
  type SplitLine,
} from "./transactionForm";

export type Schedule = components["schemas"]["Schedule"];
export type ScheduleInput = components["schemas"]["ScheduleInput"];
export type ScheduleTransaction = components["schemas"]["ScheduleTransaction"];
export type ScheduleFrequency = components["schemas"]["ScheduleFrequency"];
export type ScheduleMode = components["schemas"]["ScheduleMode"];
export type SchedulePreview = components["schemas"]["SchedulePreview"];
export type Occurrence = components["schemas"]["ScheduledTransaction"];
export type Upcoming = components["schemas"]["UpcomingTransaction"];

export const FREQUENCIES: ScheduleFrequency[] = ["once", "day", "week", "month", "year"];
export const MAX_NAME = 60;
export const MAX_EVERY = 366;
export const MAX_DUE_DAYS = 60;
export const DEFAULT_DUE_DAYS = 3;
/** How many times the form previews. */
export const PREVIEW_COUNT = 5;

export type Ends = "never" | "after" | "on";

/** The repeat part of a schedule form. */
export interface RepeatValues {
  /** YYYY-MM-DD and HH:MM, wall time in timeZone. */
  startDate: string | null;
  time: string | null;
  timeZone: string;
  frequency: ScheduleFrequency;
  every: number | string;
  ends: Ends;
  endCount: number | string;
  endDate: string | null;
  mode: ScheduleMode;
  dueDays: number | string;
  name: string;
  paused: boolean;
}

export interface RepeatErrors {
  startDate?: string;
  time?: string;
  every?: string;
  endCount?: string;
  endDate?: string;
  dueDays?: string;
  name?: string;
}

/** The wall date (YYYY-MM-DD) and time (HH:MM) of an instant in a time zone. */
export function wallTime(at: Date | string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof at === "string" ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** A new repeat: monthly from now, recorded automatically. */
export function defaultRepeat(now: Date, timeZone: string): RepeatValues {
  const { date, time } = wallTime(now, timeZone);
  return {
    startDate: date,
    time,
    timeZone,
    frequency: "month",
    every: 1,
    ends: "never",
    endCount: 3,
    endDate: null,
    mode: "auto",
    dueDays: DEFAULT_DUE_DAYS,
    name: "",
    paused: false,
  };
}

/** A schedule's repeat, to edit it. */
export function repeatFromSchedule(s: Schedule): RepeatValues {
  return {
    startDate: s.start_date,
    time: s.time,
    timeZone: s.time_zone,
    frequency: s.frequency,
    every: s.every,
    ends: s.end_count !== null ? "after" : s.end_date !== null ? "on" : "never",
    endCount: s.end_count ?? 3,
    endDate: s.end_date,
    mode: s.mode,
    dueDays: s.due_days,
    name: s.name,
    paused: s.paused,
  };
}

/** The form's transaction values of a schedule, to edit it. */
export function valuesFromSchedule(
  s: Schedule,
): Omit<EditValues, "triggersRefill"> & { triggersRefill: boolean | null } {
  const t = s.transaction;
  return {
    amount: t.amount,
    accountId: t.account_id,
    toAccountId: t.to_account_id ?? null,
    counterparty: t.counterparty ?? "",
    description: t.description ?? "",
    tags: t.tags ?? [],
    lines: (t.bucket_lines ?? []).map((l): SplitLine => newLine(l.bucket_id, l.amount)),
    triggersRefill: t.triggers_refill ?? null,
  };
}

/**
 * Make recurring: the transaction's values, and a monthly repeat from its
 * time. Its first time is the transaction itself, so the schedule starts with
 * the next.
 */
export function fromTransaction(
  tx: Transaction,
  timeZone: string,
): { values: EditValues; repeat: RepeatValues } {
  const { date, time } = wallTime(tx.at, timeZone);
  return {
    values: editState(tx),
    repeat: { ...defaultRepeat(new Date(tx.at), timeZone), startDate: date, time },
  };
}

/** Whether the type can be scheduled: incomes, expenses and transfers. */
export function isSchedulable(
  tx: Transaction,
): tx is Transaction & { type: "INC" | "EXP" | "TRF" } {
  return (tx.type === "INC" || tx.type === "EXP" || tx.type === "TRF") && !tx.reversed;
}

const whole = (v: number | string, min: number, max: number): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The repeat's problems, keyed by field. Empty when it can be saved. */
export function repeatErrors(r: RepeatValues, t: TFunction): RepeatErrors {
  const e: RepeatErrors = {};
  if (!r.startDate) e.startDate = t("schedules.form.chooseDate");
  if (!r.time || !TIME.test(r.time)) e.time = t("schedules.form.chooseTime");
  if (r.frequency !== "once") {
    if (whole(r.every, 1, MAX_EVERY) === null)
      e.every = t("schedules.form.everyRange", { max: MAX_EVERY });
    if (r.ends === "after" && whole(r.endCount, 1, 1_000_000) === null) {
      e.endCount = t("schedules.form.endCountRange");
    }
    if (r.ends === "on") {
      if (!r.endDate) e.endDate = t("schedules.form.chooseDate");
      else if (r.startDate && r.endDate < r.startDate)
        e.endDate = t("schedules.form.endBeforeStart");
    }
  }
  if (r.mode === "approve" && whole(r.dueDays, 0, MAX_DUE_DAYS) === null) {
    e.dueDays = t("schedules.form.dueDaysRange", { max: MAX_DUE_DAYS });
  }
  if (r.name.trim().length > MAX_NAME) e.name = t("common.maxChars", { count: MAX_NAME });
  return e;
}

/** The repeat fields of the API, or null while they're incomplete. */
function repeatBody(r: RepeatValues) {
  if (!r.startDate || !r.time || !TIME.test(r.time)) return null;
  const every = r.frequency === "once" ? 1 : whole(r.every, 1, MAX_EVERY);
  if (every === null) return null;
  const body = {
    start_date: r.startDate,
    time: r.time,
    time_zone: r.timeZone,
    frequency: r.frequency,
    every,
  };
  if (r.frequency === "once" || r.ends === "never") return body;
  if (r.ends === "after") {
    const count = whole(r.endCount, 1, 1_000_000);
    return count === null ? null : { ...body, end_count: count };
  }
  if (!r.endDate || r.endDate < r.startDate) return null;
  return { ...body, end_date: r.endDate };
}

/** The preview request for the repeat, or null while it's incomplete. */
export function previewBody(r: RepeatValues): SchedulePreview | null {
  const body = repeatBody(r);
  return body && { ...body, count: PREVIEW_COUNT };
}

/** The schedule to save, or null while the repeat is incomplete. */
export function scheduleBody(
  r: RepeatValues,
  transaction: ScheduleTransaction,
): ScheduleInput | null {
  const body = repeatBody(r);
  if (!body) return null;
  const name = r.name.trim();
  return {
    ...body,
    ...(name ? { name } : {}),
    transaction,
    mode: r.mode,
    due_days:
      r.mode === "approve"
        ? (whole(r.dueDays, 0, MAX_DUE_DAYS) ?? DEFAULT_DUE_DAYS)
        : DEFAULT_DUE_DAYS,
    paused: r.paused,
  };
}

/** A saved schedule as input again, e.g. to pause it. */
export function toInput(s: Schedule, change: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    ...(s.name ? { name: s.name } : {}),
    transaction: s.transaction,
    mode: s.mode,
    due_days: s.due_days,
    start_date: s.start_date,
    time: s.time,
    time_zone: s.time_zone,
    frequency: s.frequency,
    every: s.every,
    ...(s.end_count !== null ? { end_count: s.end_count } : {}),
    ...(s.end_date !== null ? { end_date: s.end_date } : {}),
    paused: s.paused,
    ...change,
  };
}

/** Whether the repeat's first time is now or past, so it's recorded on saving. */
export function startsByNow(r: RepeatValues, now: Date): boolean {
  if (!r.startDate || !r.time) return false;
  const w = wallTime(now, r.timeZone);
  return `${r.startDate}T${r.time}` <= `${w.date}T${w.time}`;
}

type Repeat = Pick<
  Schedule,
  "start_date" | "time" | "time_zone" | "frequency" | "every" | "end_count" | "end_date"
>;

/**
 * The repeat in words: "Every month on the 25th at 08:00 · 3 times". Weekdays
 * and months are in the app's language, dates in the locale. The time gets
 * the time zone when it isn't the browser's.
 */
export function repeatSentence(
  s: Repeat,
  t: TFunction,
  language: string,
  locale = getLocale(),
): string {
  const start = parseDate(s.start_date);
  // The locale when it's in the app's language (en-GB: "25 August"), else
  // the language.
  const words = locale?.split("-")[0] === language.split("-")[0] ? locale : language;
  const time = s.time_zone === browserTimeZone() ? s.time : `${s.time} (${s.time_zone})`;
  const count = s.every;
  let text: string;
  switch (s.frequency) {
    case "once":
      text = t("schedules.repeat.once", { date: formatDate(s.start_date, locale), time });
      break;
    case "day":
      text = t("schedules.repeat.day", { count, time });
      break;
    case "week":
      text = t("schedules.repeat.week", {
        count,
        time,
        weekday: new Intl.DateTimeFormat(words, { weekday: "long" }).format(start),
      });
      break;
    case "month":
      text = t("schedules.repeat.month", {
        count,
        time,
        day: t("schedules.repeat.dayOfMonth", { count: start.getDate(), ordinal: true }),
      });
      break;
    case "year":
      text = t("schedules.repeat.year", {
        count,
        time,
        date: new Intl.DateTimeFormat(words, { day: "numeric", month: "long" }).format(start),
      });
      break;
  }
  if (s.frequency === "once") return text;
  if (s.end_count !== null)
    return `${text} · ${t("schedules.repeat.times", { count: s.end_count })}`;
  if (s.end_date !== null) {
    return `${text} · ${t("schedules.repeat.until", { date: formatDate(s.end_date, locale) })}`;
  }
  return text;
}

/** A schedule's title: its name, else the counterparty, else its type. */
export function scheduleTitle(
  s: Schedule,
  t: TFunction,
  accountName: (id: string) => string,
): string {
  if (s.name) return s.name;
  const tx = s.transaction;
  if (tx.type === "TRF" && tx.to_account_id) {
    return t("schedules.transferTitle", {
      from: accountName(tx.account_id),
      to: accountName(tx.to_account_id),
    });
  }
  return tx.counterparty?.trim() ? tx.counterparty : t(`newTransaction.types.${tx.type}`);
}

/** Whether a schedule is running, paused, or has ended (no times left). */
export function scheduleState(
  s: Pick<Schedule, "paused" | "next_at">,
): "active" | "paused" | "ended" {
  if (s.next_at === null) return "ended";
  return s.paused ? "paused" : "active";
}

/** Why a scheduled transaction waits in the queue (#155), in words. */
export function reasonText(o: Pick<Occurrence, "reason" | "detail">, t: TFunction): string {
  switch (o.reason) {
    case "no_active_cycle":
      return t("schedules.reasons.no_active_cycle");
    case "outside_cycle":
      return t("schedules.reasons.outside_cycle");
    case "invalid":
      return o.detail
        ? t("schedules.reasons.invalidDetail", { detail: o.detail })
        : t("schedules.reasons.invalid");
    case "approval":
    case null:
      return t("schedules.reasons.approval");
  }
}

/**
 * The date an approved one gets (#31): its scheduled time when that has
 * passed and the active cycle contains it, else null for now (approved
 * early, before its time, it's dated now).
 */
export function approveDate(
  o: Pick<Occurrence, "scheduled_at">,
  active: Cycle | null,
  now = clockNow(),
) {
  const passed = new Date(o.scheduled_at).getTime() <= now.getTime();
  return passed && insideCycle(o.scheduled_at, active, now) ? o.scheduled_at : null;
}

/** The queue's order: overdue first, then the oldest. */
export function queueOrder(items: Occurrence[]): Occurrence[] {
  return [...items].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  );
}

/** Where Edit and approve opens a queued one. */
export function approvePath(id: string): string {
  return `/transactions/scheduled/queue/${id}/approve`;
}
