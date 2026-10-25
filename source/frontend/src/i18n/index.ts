// Translations (#74): English, Norwegian bokmål and nynorsk, bundled with the
// app. lib/language.ts picks the language; see README.md for adding text.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import nb from "./locales/nb.json";
import nn from "./locales/nn.json";

export const resources = {
  en: { translation: en },
  nb: { translation: nb },
  nn: { translation: nn },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  // Nynorsk falls back to bokmål before English; the parity test keeps
  // that from happening.
  fallbackLng: { nn: ["nb", "en"], default: ["en"] },
  initAsync: false,
  // React escapes what it renders.
  interpolation: { escapeValue: false },
  // The session guard remounts the screens when the language changes (as it
  // does for the locale), so components needn't re-render on the event.
  react: { bindI18n: false, useSuspense: false },
});

export default i18n;
