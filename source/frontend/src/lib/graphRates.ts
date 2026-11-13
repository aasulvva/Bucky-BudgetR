// Amounts per day, week, month or cycle, and the average line (#182): how
// long an interval is, whether the period cut it, and what a graph's
// values become as a rate.

import dayjs from "dayjs";

import type { components } from "@/api/schema";
import i18n from "@/i18n";

import { addAmounts } from "./money";
import type { Period, Resolution } from "./periods";

export type ShowAs = components["schemas"]["GraphShowAs"];
export const SHOW_AS: ShowAs[] = ["total", "day", "week", "month", "cycle"];

/** The average month, in days. */
export const MONTH_DAYS = 365.25 / 12;

interface Interval {
  start: string;
  end: string;
}

interface CycleTimes {
  start_at: string;
  end_at: string;
  state: string;
}

/**
 * The local calendar days an interval [start, end) touches, a started day
 * counting whole: today so far is a day, and a day with a change to or
 * from summer time is one day.
 */
export function intervalDays(interval: Interval): number {
  const first = dayjs(interval.start).startOf("day");
  const last = dayjs(interval.end).subtract(1, "millisecond").startOf("day");
  return Math.max(1, Math.round(last.diff(first, "day", true)) + 1);
}

/**
 * How many days the unit is: a week 7, a month the average month, a cycle
 * the average length of the cycles that overlap the period (all of the
 * user's when none does). Null for Total, and for a cycle without cycles.
 */
export function unitDays(
  showAs: ShowAs | undefined,
  period: Period | null,
  cycles: readonly CycleTimes[],
): number | null {
  switch (showAs ?? "total") {
    case "total":
      return null;
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return MONTH_DAYS;
    case "cycle": {
      const from = period ? Date.parse(period.fromAt) : NaN;
      const to = period ? Date.parse(period.toAt) : NaN;
      const overlapping = cycles.filter(
        (c) => Date.parse(c.end_at) > from && Date.parse(c.start_at) < to,
      );
      const used = overlapping.length > 0 ? overlapping : cycles;
      if (used.length === 0) return null;
      const days = used.map((c) => intervalDays({ start: c.start_at, end: c.end_at }));
      return days.reduce((a, b) => a + b, 0) / days.length;
    }
  }
}

/**
 * Whether an interval is a whole one of its resolution: not cut by the
 * period's edges, nor still going. A cycle is whole when it is one of the
 * user's cycles from start to end.
 */
export function wholeInterval(
  interval: Interval,
  resolution: Resolution,
  cycles: readonly CycleTimes[],
): boolean {
  const start = dayjs(interval.start);
  const end = Date.parse(interval.end);
  switch (resolution) {
    case "total":
      return false;
    case "cycle":
      return cycles.some(
        (c) => Date.parse(c.start_at) === start.valueOf() && Date.parse(c.end_at) === end,
      );
    case "hour":
      return start.add(1, "hour").valueOf() === end;
    case "week":
      return (
        start.startOf("day").valueOf() === start.valueOf() && start.add(7, "day").valueOf() === end
      );
    case "day":
    case "month":
    case "year":
      return (
        start.startOf(resolution).valueOf() === start.valueOf() &&
        start.add(1, resolution).valueOf() === end
      );
  }
}

/**
 * Amounts as a rate: each ÷ its interval's days × the unit's days; as a
 * running total, the sum so far ÷ the days so far × the unit (a running
 * average). Rounded to cents.
 */
export function rateAmounts(
  amounts: readonly string[],
  days: readonly number[],
  unit: number,
  cumulative: boolean,
): string[] {
  let sum = "0";
  let daysSoFar = 0;
  return amounts.map((a, i) => {
    const d = days[i] ?? 1;
    if (!cumulative) return ((Number(a) / d) * unit).toFixed(2);
    sum = addAmounts(sum, a);
    daysSoFar += d;
    return ((Number(sum) / daysSoFar) * unit).toFixed(2);
  });
}

/** An average line's value, and how many intervals it averages of how many. */
export interface AverageOf {
  value: number;
  whole: number;
  of: number;
}

/**
 * The average of a series' shown values. A balance averages every
 * interval's; a rate weighs each by its days, so partial ones count for
 * what they cover; a total averages the whole intervals only (all of
 * them when none is whole). Null without values.
 */
export function averageOf(
  values: readonly number[],
  days: readonly number[],
  whole: readonly boolean[],
  how: "balance" | "rate" | "total",
): AverageOf | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  if (how === "balance") return { value: mean([...values]), whole: n, of: n };
  if (how === "rate") {
    const d = values.map((_, i) => days[i] ?? 1);
    const total = d.reduce((a, b) => a + b, 0);
    return { value: values.reduce((a, v, i) => a + v * (d[i] ?? 1), 0) / total, whole: n, of: n };
  }
  const kept = values.filter((_, i) => whole[i]);
  return kept.length > 0
    ? { value: mean(kept), whole: kept.length, of: n }
    : { value: mean([...values]), whole: n, of: n };
}

/** An amount with its unit, "kr 312 / day"; as it is for totals. */
export function perUnit(amount: string, unit: ShowAs | null | undefined): string {
  return unit && unit !== "total" ? i18n.t(`stats.graphs.perUnit.${unit}`, { amount }) : amount;
}
