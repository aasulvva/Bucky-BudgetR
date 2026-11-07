// The Dashboard's logic (spec §9), kept apart from the page: its layout of
// widgets (#37) and their settings, the budget's health per account, and
// which buckets to show.

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { components } from "@/api/schema";

import { accountSummary, coverage, type Tone } from "./buckets";
import { addAmounts, compareAmounts, percentOf } from "./money";

type Preferences = components["schemas"]["Preferences"];
type Schemas = components["schemas"];
export type DashboardPreferences = Schemas["DashboardSettings"];
type ApiWidget = Schemas["DashboardWidget"];
export type WidgetType = ApiWidget["type"];
export type WidgetWidth = ApiWidget["width"];
export type BucketStatusMode = Schemas["BucketStatusWidgetSettings"]["mode"];
export type AccountsMode = Schemas["AccountsWidgetSettings"]["mode"];

export const WIDGET_TYPES: WidgetType[] = [
  "cycle",
  "health",
  "bucket_status",
  "accounts",
  "recent_transactions",
];
export const ACCOUNTS_MODES: AccountsMode[] = ["all", "account"];
export const BUCKET_STATUS_MODES: BucketStatusMode[] = ["attention", "all", "most_used", "bucket"];
export const TRANSACTION_COUNTS = [3, 5, 10, 15, 20];
/** The most widgets a layout holds (the API's limit). */
export const MAX_WIDGETS = 30;

/** How many buckets Most used shows. */
export const MOST_USED = 5;

export interface CycleSettings {
  showNext: boolean;
}
export interface AccountsSettings {
  mode: AccountsMode;
  accountId: string | null;
}
export interface BucketStatusSettings {
  mode: BucketStatusMode;
  bucketId: string | null;
}
export interface RecentSettings {
  count: number;
}

interface SettingsOf {
  cycle: CycleSettings;
  health: null;
  bucket_status: BucketStatusSettings;
  accounts: AccountsSettings;
  recent_transactions: RecentSettings;
}

/** One widget on the Dashboard, with its own settings. */
export type WidgetInstance<T extends WidgetType = WidgetType> = {
  [K in T]: { id: string; type: K; width: WidgetWidth; settings: SettingsOf[K] };
}[T];

export type Layout = WidgetInstance[];

/** Saves a widget's changed settings; a promise when it goes to the server. */
export type SaveWidget = (widget: WidgetInstance) => unknown;

const fromApi = {
  cycle: (s?: Schemas["CycleWidgetSettings"]): CycleSettings => ({
    showNext: s?.show_next ?? true,
  }),
  accounts: (s?: Schemas["AccountsWidgetSettings"]): AccountsSettings => ({
    mode: s?.mode ?? "all",
    accountId: s?.account_id ?? null,
  }),
  bucketStatus: (s?: Schemas["BucketStatusWidgetSettings"]): BucketStatusSettings => ({
    mode: s?.mode ?? "attention",
    bucketId: s?.bucket_id ?? null,
  }),
  recent: (s?: Schemas["RecentWidgetSettings"]): RecentSettings => ({ count: s?.count ?? 5 }),
};

/** A widget type's default settings. */
export function defaultSettings<T extends WidgetType>(type: T): SettingsOf[T];
export function defaultSettings(type: WidgetType): SettingsOf[WidgetType] {
  switch (type) {
    case "cycle":
      return fromApi.cycle();
    case "health":
      return null;
    case "bucket_status":
      return fromApi.bucketStatus();
    case "accounts":
      return fromApi.accounts();
    case "recent_transactions":
      return fromApi.recent();
  }
}

/** The width a new widget of the type gets. */
export function defaultWidth(type: WidgetType): WidgetWidth {
  return type === "recent_transactions" ? "full" : "half";
}

function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A new widget with its defaults, and an id the layout doesn't have yet. */
export function newWidget(type: WidgetType, layout: Layout = []): WidgetInstance {
  let id = newId();
  while (layout.some((w) => w.id === id)) id = newId();
  return { id, type, width: defaultWidth(type), settings: defaultSettings(type) } as WidgetInstance;
}

/** The five widgets of #29's fixed Dashboard, in its order, with the given settings. */
export function defaultLayout(saved?: DashboardPreferences | null): Layout {
  return [
    { id: "cycle", type: "cycle", width: "half", settings: fromApi.cycle(saved?.cycle) },
    { id: "health", type: "health", width: "half", settings: null },
    {
      id: "bucket_status",
      type: "bucket_status",
      width: "half",
      settings: fromApi.bucketStatus(saved?.bucket_status),
    },
    {
      id: "accounts",
      type: "accounts",
      width: "half",
      settings: fromApi.accounts(saved?.accounts),
    },
    {
      id: "recent_transactions",
      type: "recent_transactions",
      width: "full",
      settings: fromApi.recent(saved?.recent_transactions),
    },
  ];
}

function widgetFromApi(w: ApiWidget): WidgetInstance {
  const base = { id: w.id, width: w.width };
  switch (w.type) {
    case "cycle":
      return { ...base, type: w.type, settings: fromApi.cycle(w.cycle) };
    case "health":
      return { ...base, type: w.type, settings: null };
    case "bucket_status":
      return { ...base, type: w.type, settings: fromApi.bucketStatus(w.bucket_status) };
    case "accounts":
      return { ...base, type: w.type, settings: fromApi.accounts(w.accounts) };
    case "recent_transactions":
      return { ...base, type: w.type, settings: fromApi.recent(w.recent_transactions) };
  }
}

/**
 * The saved layout. Without one (before #37, or never edited) it's the
 * default layout, using the per-type settings saved by #29.
 */
export function dashboardLayout(preferences: Preferences): Layout {
  const saved = preferences.dashboard;
  return saved?.widgets ? saved.widgets.map(widgetFromApi) : defaultLayout(saved);
}

function widgetToApi(w: WidgetInstance): ApiWidget {
  const base = { id: w.id, type: w.type, width: w.width };
  switch (w.type) {
    case "cycle":
      return { ...base, cycle: { show_next: w.settings.showNext } };
    case "health":
      return base;
    case "bucket_status": {
      const { mode, bucketId } = w.settings;
      return {
        ...base,
        bucket_status: mode === "bucket" ? { mode, bucket_id: bucketId } : { mode },
      };
    }
    case "accounts": {
      const { mode, accountId } = w.settings;
      return {
        ...base,
        accounts: mode === "account" ? { mode, account_id: accountId } : { mode },
      };
    }
    case "recent_transactions":
      return { ...base, recent_transactions: { count: w.settings.count } };
  }
}

/** What saving the layout sends; the API replaces `dashboard` as a whole. */
export function layoutToPreferences(layout: Layout): DashboardPreferences {
  return { widgets: layout.map(widgetToApi) };
}

/** Moves a widget one place up (-1) or down (+1). */
export function moveWidget(layout: Layout, id: string, by: -1 | 1): Layout {
  const from = layout.findIndex((w) => w.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= layout.length) return layout;
  return moveWidgetTo(layout, from, to);
}

/** Moves the widget at `from` to `to`, as dragging does. */
export function moveWidgetTo(layout: Layout, from: number, to: number): Layout {
  const next = [...layout];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

export function removeWidget(layout: Layout, id: string): Layout {
  return layout.filter((w) => w.id !== id);
}

/** The layout with the widget (by its id) replaced, or added at the end. */
export function replaceWidget(layout: Layout, widget: WidgetInstance): Layout {
  return layout.some((w) => w.id === widget.id)
    ? layout.map((w) => (w.id === widget.id ? widget : w))
    : [...layout, widget];
}

/**
 * Whether a widget's settings can be saved: One bucket and One account need
 * a bucket or account that exists.
 */
export function settingsComplete(
  widget: WidgetInstance,
  accounts: Account[],
  buckets: Bucket[],
): boolean {
  if (widget.type === "bucket_status" && widget.settings.mode === "bucket") {
    return buckets.some((b) => b.id === widget.settings.bucketId);
  }
  if (widget.type === "accounts" && widget.settings.mode === "account") {
    return accounts.some((a) => a.id === widget.settings.accountId);
  }
  return true;
}

/**
 * The bucket One bucket shows. Without it (none chosen, or it was deleted)
 * the widget falls back to Needs attention.
 */
export function shownBucketStatus(
  settings: BucketStatusSettings,
  buckets: Bucket[],
): { mode: Exclude<BucketStatusMode, "bucket"> } | { mode: "bucket"; bucket: Bucket } {
  const { mode, bucketId } = settings;
  if (mode !== "bucket") return { mode };
  const bucket = buckets.find((b) => b.id === bucketId);
  return bucket ? { mode, bucket } : { mode: "attention" };
}

/**
 * The accounts Account balances shows: all of them, or the chosen one.
 * Without it (none chosen, or it was deleted) the widget shows them all.
 */
export function shownAccounts(
  settings: AccountsSettings,
  accounts: Account[],
): { mode: "all" } | { mode: "account"; account: Account } {
  const { mode, accountId } = settings;
  const account = accounts.find((a) => a.id === accountId);
  return mode === "account" && account ? { mode, account } : { mode: "all" };
}

export interface AccountHealth {
  /** Σ TF of the account's buckets that aren't overspent. */
  needed: string;
  /** How much of it the account backs (Σ CAF). */
  covered: string;
  /** covered as a % of needed; 100 when nothing is needed. */
  pct: number;
  short: string;
  unallocated: string;
  uncovered: number;
  overspent: number;
  tone: Tone;
}

/** How well an account backs its buckets, as the Buckets header sums it up. */
export function accountHealth(account: Account, buckets: Bucket[]): AccountHealth {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const funded = own.filter((b) => compareAmounts(b.target_funds, "0") > 0);
  const needed = addAmounts(...funded.map((b) => b.target_funds));
  const covered = addAmounts(...funded.map((b) => b.current_available_funds));
  const { short, unallocated, tone } = accountSummary(account, buckets);
  return {
    needed,
    covered,
    pct: compareAmounts(needed, "0") > 0 ? Math.min(percentOf(covered, needed), 100) : 100,
    short,
    unallocated,
    uncovered: own.filter((b) => compareAmounts(coverage(b).gap, "0") > 0).length,
    overspent: own.filter((b) => coverage(b).overspent).length,
    tone,
  };
}

/** How much of its budget a bucket has used this cycle; null without figures. */
export function usedPct(figures: BucketFigures | undefined): number | null {
  if (!figures || compareAmounts(figures.budget, "0") <= 0) return null;
  return percentOf(figures.used, figures.budget);
}

export type AttentionReason = "overspent" | "uncovered" | "mostlyUsed";

export interface Attention {
  bucket: Bucket;
  reason: AttentionReason;
}

/**
 * The buckets that need attention, worst first: overspent, not fully
 * covered (priority ones first), then more than 90 % used, the most used
 * first.
 */
export function needsAttention(
  buckets: Bucket[],
  figures: Map<string, BucketFigures>,
): Attention[] {
  const rank = (a: Attention) =>
    a.reason === "overspent" ? 0 : a.reason === "uncovered" ? (a.bucket.priority ? 1 : 2) : 3;
  const pct = (b: Bucket) => usedPct(figures.get(b.id)) ?? 0;
  return buckets
    .flatMap((bucket): Attention[] => {
      const { overspent, gap } = coverage(bucket);
      if (overspent) return [{ bucket, reason: "overspent" }];
      if (compareAmounts(gap, "0") > 0) return [{ bucket, reason: "uncovered" }];
      return pct(bucket) > 90 ? [{ bucket, reason: "mostlyUsed" }] : [];
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        pct(b.bucket) - pct(a.bucket) ||
        a.bucket.name.localeCompare(b.bucket.name),
    );
}

/** The n buckets that have used the most of their budget this cycle. */
export function mostUsed(
  buckets: Bucket[],
  figures: Map<string, BucketFigures>,
  n = MOST_USED,
): { bucket: Bucket; pct: number }[] {
  return buckets
    .flatMap((bucket) => {
      const pct = usedPct(figures.get(bucket.id));
      return pct === null ? [] : [{ bucket, pct }];
    })
    .sort((a, b) => b.pct - a.pct || a.bucket.name.localeCompare(b.bucket.name))
    .slice(0, n);
}
