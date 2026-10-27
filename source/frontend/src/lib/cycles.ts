// Cycle dates (spec §3). Users pick local calendar dates; the API stores the
// UTC moments of local midnight, and a cycle's end is exclusive: a cycle
// from 1 to 30 November ends at local midnight starting 1 December.

import dayjs from "dayjs";

import i18n from "@/i18n";

import { now as clockNow } from "./clock";
import { parseDate } from "./dates";
import { getLocale } from "./locale";

/** A local calendar date, "YYYY-MM-DD", as the date pickers use. */
export type LocalDate = string;

interface CycleTimes {
  start_at: string;
  end_at: string;
}

const FORMAT = "YYYY-MM-DD";

/** Today's local date. */
export function today(now = clockNow()): LocalDate {
  return dayjs(now).format(FORMAT);
}

/** The local date a timestamp falls on. */
export function localDate(at: string | Date): LocalDate {
  return dayjs(at).format(FORMAT);
}

/** The UTC moment a cycle starting on this date starts: its local midnight. */
export function startAtFor(date: LocalDate): string {
  return dayjs(date).startOf("day").toISOString();
}

/** The UTC moment a cycle whose last day is this date ends: the next local midnight. */
export function endAtFor(lastDay: LocalDate): string {
  return dayjs(lastDay).add(1, "day").startOf("day").toISOString();
}

/** The cycle's first local date. */
export function firstDay(cycle: CycleTimes): LocalDate {
  return localDate(cycle.start_at);
}

/** The cycle's last local date: the day before its (exclusive) end. */
export function lastDay(cycle: CycleTimes): LocalDate {
  return dayjs(cycle.end_at).subtract(1, "millisecond").format(FORMAT);
}

/** "1 Oct – 31 Oct 2026", as the locale writes a date range. */
export function cycleRange(cycle: CycleTimes, locale = getLocale()): string {
  return formatDateRange(firstDay(cycle), lastDay(cycle), locale);
}

export function formatDateRange(from: LocalDate, to: LocalDate, locale = getLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).formatRange(
    parseDate(from),
    parseDate(to),
  );
}

/** Days from today to the cycle's last day: 0 on the last day, negative when overdue. */
export function daysLeft(cycle: CycleTimes, now = clockNow()): number {
  return dayjs(lastDay(cycle)).diff(dayjs(now).startOf("day"), "day");
}

/** The active cycle's planned end has passed: bucket transactions are refused. */
export function isOverdue(cycle: CycleTimes, now = clockNow()): boolean {
  return new Date(cycle.end_at).getTime() <= now.getTime();
}

/** "6 days left", "Last day" or "Overdue". */
export function daysLeftLabel(cycle: CycleTimes, now = clockNow()): string {
  if (isOverdue(cycle, now)) return i18n.t("cycles.overdue");
  const days = daysLeft(cycle, now);
  return days <= 0 ? i18n.t("cycles.lastDay") : i18n.t("cycles.daysLeft", { count: days });
}

/** The same, short for the mobile header: "6 d left". */
export function daysLeftShort(cycle: CycleTimes, now = clockNow()): string {
  if (isOverdue(cycle, now)) return i18n.t("cycles.overdue");
  const days = daysLeft(cycle, now);
  return days <= 0 ? i18n.t("cycles.lastDay") : i18n.t("cycles.daysLeftShort", { count: days });
}

/** A month from `start`: from that date to the day before the same date next month. */
export function monthFrom(start: LocalDate): { start: LocalDate; end: LocalDate } {
  return { start, end: dayjs(start).add(1, "month").subtract(1, "day").format(FORMAT) };
}

/** The local date `days` after `date`. */
export function addDays(date: LocalDate, days: number): LocalDate {
  return dayjs(date).add(days, "day").format(FORMAT);
}

/** A cycle's first and last day. */
export interface DateRange {
  start: LocalDate;
  end: LocalDate;
}

/** What's wrong with the dates of a cycle that must still lie ahead, if anything. */
export function rangeProblem(range: DateRange, now = clockNow()): string | undefined {
  if (range.end < range.start) return i18n.t("cycles.endBeforeStart");
  if (range.end < today(now)) return i18n.t("cycles.endInFuture");
  return undefined;
}

/** The local date the latest of these cycles ends on. */
export function latestEnd(cycles: CycleTimes[]): LocalDate | undefined {
  const ends = cycles.map((c) => new Date(c.end_at).getTime());
  return ends.length > 0 ? localDate(new Date(Math.max(...ends))) : undefined;
}

/**
 * When a new cycle starting on `date` starts: its local midnight, or where
 * the latest started cycle ended if that was later the same day (it ended
 * early), so the two don't overlap.
 */
export function startAtAfter(date: LocalDate, cycles: (CycleTimes & { state: string })[]): string {
  const midnight = startAtFor(date);
  const ended = cycles.filter((c) => c.state !== "future").map((c) => new Date(c.end_at).getTime());
  const last = ended.length > 0 ? Math.max(...ended) : 0;
  return last > new Date(midnight).getTime() && localDate(new Date(last)) === date
    ? new Date(last).toISOString()
    : midnight;
}
