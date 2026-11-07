import type { TFunction } from "i18next";
import { createContext, type ReactNode } from "react";

import type { WidgetType } from "@/lib/dashboard";

const TITLE_KEYS = {
  cycle: "dashboard.cycle.title",
  health: "dashboard.health.title",
  bucket_status: "dashboard.bucketStatus.title",
  accounts: "dashboard.accounts.title",
  recent_transactions: "dashboard.recent.title",
} as const satisfies Record<WidgetType, string>;

/** A widget type's name, which is also its title. */
export function widgetTitle(t: TFunction, type: WidgetType): string {
  return t(TITLE_KEYS[type]);
}

/**
 * How the Dashboard frames a widget: in edit mode its header shows the edit
 * bar instead of its link and settings, and its content can't be used.
 */
export const WidgetFrame = createContext<{ editing: boolean; bar?: ReactNode }>({
  editing: false,
});
