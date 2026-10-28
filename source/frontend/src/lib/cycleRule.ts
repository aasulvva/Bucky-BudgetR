// The cycle rule (#72): the server plans cycles from it, from one of its
// dates to the next. The dates come from the server (POST
// /api/v1/cycle-rule/periods), which knows the holidays.

import type { components } from "@/api/schema";

import type { LocalDate } from "./cycles";
import { getLocale } from "./locale";

export type CycleRule = components["schemas"]["CycleRule"];
export type CyclePeriod = components["schemas"]["CyclePeriod"];

/** The API's limit on cycles planned ahead. */
export const MAX_AHEAD = 12;

/**
 * A new rule: payday on the 25th, or the working day before. Norwegian
 * locales (the user's, or the browser's) skip Norwegian holidays.
 */
export function defaultRule(locale = getLocale() ?? navigator.language): CycleRule {
  return { day: 25, shift: "previous", holidays: /-NO$/i.test(locale) ? "NO" : "none", ahead: 3 };
}

/** A day of the month the rule can start on. */
export function validDay(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 31;
}

/** A number of cycles the rule can keep planned. */
export function validAhead(ahead: number): boolean {
  return Number.isInteger(ahead) && ahead >= 1 && ahead <= MAX_AHEAD;
}

/** Whether the API takes the rule. */
export function validRule(rule: CycleRule): boolean {
  return validDay(rule.day) && validAhead(rule.ahead);
}

export function sameRule(a: CycleRule | null, b: CycleRule | null): boolean {
  if (a === null || b === null) return a === b;
  return a.day === b.day && a.shift === b.shift && a.holidays === b.holidays && a.ahead === b.ahead;
}

/** The first of the periods that starts on or after `from`. */
export function periodFrom(periods: CyclePeriod[], from: LocalDate): CyclePeriod | undefined {
  return periods.find((p) => p.start >= from);
}

/** The browser's IANA time zone, e.g. "Europe/Oslo". */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
