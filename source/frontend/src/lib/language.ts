// The app's language (#74), separate from the locale that formats numbers
// and dates (lib/locale.ts). The user's preference wins; without one the
// locale decides, and without that the browser.

import "dayjs/locale/nb";
import "dayjs/locale/nn";

import type { components } from "@/api/schema";
import i18n from "@/i18n";

export type Language = components["schemas"]["Language"];

/** The languages offered in Settings, each in its own words. */
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "nb", label: "Norsk bokmål" },
  { value: "nn", label: "Norsk nynorsk" },
];

/** Remembers the last language, for the login page. */
const STORAGE_KEY = "bucky.language";

/** The language a BCP 47 tag asks for, if it's one of ours. */
function fromTag(tag: string): Language | undefined {
  const lang = tag.toLowerCase().split("-")[0];
  if (lang === "nn") return "nn";
  if (lang === "nb" || lang === "no") return "nb";
  if (lang === "en") return "en";
  return undefined;
}

/**
 * The language to show: the preference; else the locale's language
 * (English for a locale in any other language); else the browser's first
 * language we have; else English.
 */
export function resolveLanguage(
  prefs: { language?: Language | null; locale?: string | null } | undefined,
  browser: readonly string[] = navigator.languages,
): Language {
  if (prefs?.language) return prefs.language;
  if (prefs?.locale) return fromTag(prefs.locale) ?? "en";
  for (const tag of browser) {
    const found = fromTag(tag);
    if (found) return found;
  }
  return "en";
}

/** The language before anyone has logged in: the last one used here, or the browser's. */
export function initialLanguage(): Language {
  try {
    const saved = LANGUAGES.find((l) => l.value === localStorage.getItem(STORAGE_KEY));
    if (saved) return saved.value;
  } catch {
    // Storage can be blocked; the browser's language will do.
  }
  return resolveLanguage(undefined);
}

/** Switches the translations and the page's lang attribute to the language. */
export function applyLanguage(language: Language): void {
  if (i18n.language === language) return;
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Not remembered; the login page then uses the browser's language.
  }
}
