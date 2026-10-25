// Types the translation keys from the English resources: t() with a key
// that doesn't exist fails the typecheck.
import "i18next";

import type en from "./locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
