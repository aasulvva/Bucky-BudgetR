import type { TFunction } from "i18next";
import { createContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { autoTitle, type WidgetInstance, type WidgetType } from "@/lib/dashboard";

const TITLE_KEYS = {
  cycle: "dashboard.cycle.title",
  health: "dashboard.health.title",
  bucket_status: "dashboard.bucketStatus.title",
  accounts: "dashboard.accounts.title",
  recent_transactions: "dashboard.recent.title",
  in_out: "dashboard.inOut.title",
} as const satisfies Record<WidgetType, string>;

/** A widget type's name, and its title when it has no other. */
export function widgetTitle(t: TFunction, type: WidgetType): string {
  return t(TITLE_KEYS[type]);
}

/** A widget's title: custom, the bucket's or account's name, or its type's name. */
export function titleFor(
  t: TFunction,
  widget: WidgetInstance,
  accounts: Account[],
  buckets: Bucket[],
): string {
  return autoTitle(widget, accounts, buckets) ?? widgetTitle(t, widget.type);
}

export function useWidgetTitle(widget: WidgetInstance): string {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  return titleFor(t, widget, accounts, buckets);
}

/**
 * How the Dashboard frames a widget: its title, and in edit mode its header
 * shows the edit bar instead of its link and settings, and its content can't
 * be used. `openSettings` lets the content open the widget's settings.
 */
export const WidgetFrame = createContext<{
  title?: string;
  editing: boolean;
  bar?: ReactNode;
  openSettings?: () => void;
}>({
  editing: false,
});
