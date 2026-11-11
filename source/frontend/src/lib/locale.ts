// Formatting settings in one place. The user's locale preference (#20) is set
// here when the session loads, and the formatters read it on every call.

/** Currency of all amounts. Multi-currency is a later feature (#33). */
export const CURRENCY = "NOK";

/** Locales offered in Settings, besides the browser's own. */
export const LOCALE_OPTIONS = [
  { value: "nb-NO", label: "Norsk bokmål" },
  { value: "nn-NO", label: "Norsk nynorsk" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-US", label: "English (US)" },
  { value: "sv-SE", label: "Svenska" },
  { value: "da-DK", label: "Dansk" },
  { value: "de-DE", label: "Deutsch" },
] as const;

let current: string | undefined;

/** Locale for numbers and dates; undefined means the browser's locale. */
export function getLocale(): string | undefined {
  return current;
}

/**
 * The locale the formatters use, as a tag: the preference, else the
 * browser's default for formatting (its regional format, which can differ
 * from navigator.language, its first page language; #192).
 */
export function formatLocale(): string {
  return current ?? new Intl.DateTimeFormat().resolvedOptions().locale;
}

/** Sets the locale; null or undefined means the browser's locale. */
export function setLocale(locale: string | null | undefined): void {
  current = locale ?? undefined;
}
