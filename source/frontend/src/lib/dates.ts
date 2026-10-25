import { LOCALE } from "./locale";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses an API date ("2026-10-25") as a local calendar date. new Date() would
 * read it as UTC midnight, which shows as the previous day west of Greenwich.
 */
export function parseDate(value: string): Date {
  const m = DATE_ONLY.exec(value);
  if (!m) return new Date(value);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Formats a date (API date string, timestamp or Date) as a short date. */
export function formatDate(value: string | Date, locale = LOCALE): string {
  const date = typeof value === "string" ? parseDate(value) : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

/** Formats a timestamp with date and time. */
export function formatDateTime(value: string | Date, locale = LOCALE): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
