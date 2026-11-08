// The period and resolution a graph, widget or report shows (#120): what the
// user picks, as a value the URL and settings can keep, and the local dates
// and UTC moments it covers today. The Stats API (#121) cuts the intervals;
// this counts them beforehand, so the pickers only offer what fits.

import dayjs, { type Dayjs } from "dayjs";

import { now as clockNow } from "./clock";
import { addDays, endAtFor, firstDay, lastDay, startAtFor, today, type LocalDate } from "./cycles";
import { getLocale } from "./locale";

export type LastUnit = "days" | "weeks" | "months" | "cycles" | "years";
export type CalendarUnit = "cycle" | "month" | "quarter" | "half_year" | "year";

export type PeriodChoice =
  | { kind: "last"; unit: LastUnit; count: number }
  | { kind: "current" | "previous"; unit: CalendarUnit }
  | { kind: "custom"; from: LocalDate; to: LocalDate };

export type Resolution = "hour" | "day" | "week" | "month" | "year" | "cycle" | "total";

export const LAST_UNITS: LastUnit[] = ["days", "weeks", "months", "cycles", "years"];
export const CALENDAR_UNITS: CalendarUnit[] = ["cycle", "month", "quarter", "half_year", "year"];
export const RESOLUTIONS: Resolution[] = ["hour", "day", "week", "month", "year", "cycle", "total"];

/** The most a "last N" period can count back. */
export const LAST_MAX: Record<LastUnit, number> = {
  days: 366,
  weeks: 104,
  months: 120,
  cycles: 120,
  years: 20,
};
/** How many a "last N" period starts with. */
export const LAST_DEFAULT: Record<LastUnit, number> = {
  days: 30,
  weeks: 8,
  months: 6,
  cycles: 3,
  years: 3,
};
/** The most bars a bar graph shows. */
export const MAX_BARS = 60;
/** The most intervals the Stats API returns. */
export const MAX_POINTS = 1000;

interface CycleTimes {
  start_at: string;
  end_at: string;
  state: string;
}

/** What a period covers: its local days and the UTC moments [fromAt, toAt). */
export interface Period {
  from: LocalDate;
  /** The last day, inclusive. */
  to: LocalDate;
  fromAt: string;
  toAt: string;
}

interface WeekInfo {
  firstDay?: number;
}

/** The locale's first day of the week, 1 (Monday) to 7 (Sunday); Monday if unknown. */
export function weekStart(locale = getLocale()): number {
  try {
    const l = new Intl.Locale(
      locale ?? new Intl.DateTimeFormat().resolvedOptions().locale,
    ) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    return info?.firstDay ?? 1;
  } catch {
    return 1;
  }
}

const FORMAT = "YYYY-MM-DD";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  return DATE.test(s) && dayjs(s).format(FORMAT) === s;
}

/** The choice as a string for the URL: "last-30-days", "current-month", "custom-2026-01-01-2026-03-31". */
export function formatPeriod(choice: PeriodChoice): string {
  switch (choice.kind) {
    case "last":
      return `last-${choice.count}-${choice.unit}`;
    case "custom":
      return `custom-${choice.from}-${choice.to}`;
    default:
      return `${choice.kind}-${choice.unit}`;
  }
}

/** The choice formatPeriod wrote; null for anything else. */
export function parsePeriod(s: string | null | undefined): PeriodChoice | null {
  if (!s) return null;
  const last = /^last-(\d{1,4})-(days|weeks|months|cycles|years)$/.exec(s);
  if (last) {
    const unit = last[2] as LastUnit;
    const count = Number(last[1]);
    return count >= 1 && count <= LAST_MAX[unit] ? { kind: "last", unit, count } : null;
  }
  const custom = /^custom-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (custom) {
    const [, from = "", to = ""] = custom;
    return validDate(from) && validDate(to) && from <= to ? { kind: "custom", from, to } : null;
  }
  const calendar = /^(current|previous)-(cycle|month|quarter|half_year|year)$/.exec(s);
  if (calendar) {
    return { kind: calendar[1] as "current" | "previous", unit: calendar[2] as CalendarUnit };
  }
  return null;
}

export function formatResolution(resolution: Resolution): string {
  return resolution;
}

export function parseResolution(s: string | null | undefined): Resolution | null {
  return RESOLUTIONS.find((r) => r === s) ?? null;
}

/** The first day of the week, month, quarter, half-year or year holding `d`. */
function startOf(
  d: Dayjs,
  unit: "week" | "month" | "quarter" | "half_year" | "year",
  locale?: string,
): Dayjs {
  switch (unit) {
    case "week": {
      // dayjs: 0 = Sunday; the locale's week: 1 = Monday … 7 = Sunday.
      const weekday = d.day() === 0 ? 7 : d.day();
      return d.startOf("day").subtract((weekday - weekStart(locale) + 7) % 7, "day");
    }
    case "month":
      return d.startOf("month");
    case "quarter":
      return d.startOf("month").subtract(d.month() % 3, "month");
    case "half_year":
      return d.startOf("month").subtract(d.month() % 6, "month");
    case "year":
      return d.startOf("year");
  }
}

const MONTHS = { month: 1, quarter: 3, half_year: 6, year: 12 } as const;

function span(from: Dayjs, to: LocalDate, toAt: string): Period {
  const f = from.format(FORMAT);
  return { from: f, to, fromAt: startAtFor(f), toAt };
}

/**
 * The days and moments a choice covers now. Last N and This … run to now
 * (the last N cycles from the start of the Nth latest started cycle);
 * Previous … is the whole period before; Previous cycle is the latest
 * finished one. A custom period ends today at the latest. Null for This
 * cycle without an active cycle, Previous cycle without a finished one, the
 * last N cycles without a started one, and a
 * custom period that starts in the future.
 */
export function resolvePeriod(
  choice: PeriodChoice,
  cycles: CycleTimes[],
  now = clockNow(),
  locale = getLocale(),
): Period | null {
  const day = today(now);
  const d = dayjs(day);
  const nowAt = now.toISOString();
  switch (choice.kind) {
    case "last": {
      const n = Math.max(1, Math.min(Math.trunc(choice.count), LAST_MAX[choice.unit])) - 1;
      if (choice.unit === "days") return span(dayjs(addDays(day, -n)), day, nowAt);
      if (choice.unit === "weeks")
        return span(startOf(d, "week", locale).subtract(n, "week"), day, nowAt);
      if (choice.unit === "months")
        return span(d.startOf("month").subtract(n, "month"), day, nowAt);
      if (choice.unit === "years") return span(d.startOf("year").subtract(n, "year"), day, nowAt);
      // The latest started cycles: the active one (or the last finished) and the n before it.
      const started = cycles
        .filter((c) => c.state !== "future")
        .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
      const first = started.at(-(n + 1)) ?? started[0];
      return first ? { from: firstDay(first), to: day, fromAt: first.start_at, toAt: nowAt } : null;
    }
    case "current":
      if (choice.unit === "cycle") {
        const active = cycles.find((c) => c.state === "active");
        return active
          ? { from: firstDay(active), to: day, fromAt: active.start_at, toAt: nowAt }
          : null;
      }
      return span(startOf(d, choice.unit), day, nowAt);
    case "previous": {
      if (choice.unit === "cycle") {
        const finished = cycles
          .filter((c) => c.state === "finished")
          .sort((a, b) => Date.parse(a.end_at) - Date.parse(b.end_at))
          .at(-1);
        return finished
          ? {
              from: firstDay(finished),
              to: lastDay(finished),
              fromAt: finished.start_at,
              toAt: finished.end_at,
            }
          : null;
      }
      const start = startOf(d, choice.unit).subtract(MONTHS[choice.unit], "month");
      const end = start.add(MONTHS[choice.unit], "month").subtract(1, "day").format(FORMAT);
      return span(start, end, endAtFor(end));
    }
    case "custom": {
      const to = choice.to < day ? choice.to : day;
      if (choice.from > to) return null;
      return span(dayjs(choice.from), to, to === day ? nowAt : endAtFor(to));
    }
  }
}

/** The period to start with: This cycle, or This month without an active cycle. */
export function defaultPeriod(cycles: CycleTimes[]): PeriodChoice {
  return cycles.some((c) => c.state === "active")
    ? { kind: "current", unit: "cycle" }
    : { kind: "current", unit: "month" };
}

type Step = "hour" | "day" | "week" | "month" | "year";

function stepStart(t: Dayjs, step: Step, locale?: string): Dayjs {
  if (step === "hour") return t.startOf("hour");
  if (step === "day") return t.startOf("day");
  return startOf(t, step, locale);
}

/**
 * How many intervals the Stats API cuts the period into, as it does: by the
 * clock for hours, by local days, weeks, months and years, one per cycle
 * overlapping the period, or one in all. Stops counting past `max`.
 */
export function intervalCount(
  period: Period,
  resolution: Resolution,
  cycles: CycleTimes[],
  locale = getLocale(),
  max = MAX_POINTS,
): number {
  const from = Date.parse(period.fromAt);
  const to = Date.parse(period.toAt);
  if (!(from < to)) return 0;
  if (resolution === "total") return 1;
  if (resolution === "cycle") {
    return cycles.filter((c) => Date.parse(c.end_at) > from && Date.parse(c.start_at) < to).length;
  }
  let edge = stepStart(dayjs(from), resolution, locale);
  let count = 0;
  while (edge.valueOf() < to && count <= max) {
    count++;
    // dayjs adds local days, months and years, as the API does; hours by the clock.
    edge = resolution === "hour" ? edge.add(1, "hour") : edge.add(1, resolution);
  }
  return count;
}

/** The resolutions that cut the period into 1 to `max` intervals, finest first. */
export function fittingResolutions(
  period: Period,
  max: number,
  cycles: CycleTimes[],
  locale = getLocale(),
): Resolution[] {
  return RESOLUTIONS.filter((r) => {
    const n = intervalCount(period, r, cycles, locale, max);
    return n >= 1 && n <= max;
  });
}

/** The next coarser resolution: hour → day → week → month → year; null past year, and for cycle and total. */
export function coarser(resolution: Resolution): Resolution | null {
  const order: Resolution[] = ["hour", "day", "week", "month", "year"];
  const i = order.indexOf(resolution);
  return i >= 0 ? (order[i + 1] ?? null) : null;
}

/**
 * The resolution to start with for a period: hours up to 2 days, days up to
 * about 2 months, weeks up to about 6 months, months up to 3 years, else
 * years; coarser if that gives more than `max` intervals.
 */
export function defaultResolution(
  period: Period,
  max: number = MAX_POINTS,
  cycles: CycleTimes[] = [],
  locale = getLocale(),
): Resolution {
  const days = dayjs(period.to).diff(dayjs(period.from), "day") + 1;
  let r: Resolution =
    days <= 2
      ? "hour"
      : days <= 62
        ? "day"
        : days <= 186
          ? "week"
          : days <= 3 * 366
            ? "month"
            : "year";
  for (
    let next = coarser(r);
    intervalCount(period, r, cycles, locale, max) > max && next;
    next = coarser(r)
  ) {
    r = next;
  }
  return intervalCount(period, r, cycles, locale, max) > max ? "total" : r;
}

/**
 * The resolution to keep when the period changes: the current one if it
 * still fits, else the period's default.
 */
export function keptResolution(
  resolution: Resolution,
  period: Period,
  max: number,
  cycles: CycleTimes[],
  locale = getLocale(),
): Resolution {
  return fittingResolutions(period, max, cycles, locale).includes(resolution)
    ? resolution
    : defaultResolution(period, max, cycles, locale);
}
