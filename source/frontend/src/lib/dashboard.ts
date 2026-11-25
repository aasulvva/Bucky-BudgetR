// The Dashboard's logic (spec §9), kept apart from the page: its layouts of
// widgets (#37), one for desktop and one for mobile (#99), and their
// settings, the budget's health per account, which buckets to show, and the
// module widgets that show saved modules (#201; graph widgets with saved
// graphs before, #124).

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { components } from "@/api/schema";

import { accountSummary, coverage, type Tone } from "./buckets";
import { MAX_DAYS, type FlowFigure, type FlowPeriod } from "./flows";
import { addAmounts, compareAmounts, percentOf } from "./money";
import { setAside } from "./planned";

type Preferences = components["schemas"]["Preferences"];
/** A saved module as a widget names it (#201). */
interface SavedName {
  id: string;
  name: string;
}
type Schemas = components["schemas"];
export type DashboardPreferences = Schemas["DashboardSettings"];
type ApiWidget = Schemas["DashboardWidget"];
export type WidgetType = ApiWidget["type"];
export type WidgetWidth = ApiWidget["width"];
export type BucketStatusMode = Schemas["BucketStatusWidgetSettings"]["mode"];
export type AccountsMode = Schemas["AccountsWidgetSettings"]["mode"];
export type ScheduledShow = Schemas["ScheduledWidgetSettings"]["show"];
/** Which savings targets a savings widget shows (#237). */
export type SavingsTargetsMode = Schemas["SavingsWidgetTargets"];

export const WIDGET_TYPES: WidgetType[] = [
  "cycle",
  "health",
  "bucket_status",
  "accounts",
  "recent_transactions",
  "in_out",
  "module",
  "scheduled",
  "savings",
  "savings_transfer",
];
export const ACCOUNTS_MODES: AccountsMode[] = ["all", "account"];
export const BUCKET_STATUS_MODES: BucketStatusMode[] = [
  "attention",
  "all",
  "most_used",
  "account",
  "bucket",
];
export const TRANSACTION_COUNTS = [3, 5, 10, 15, 20];
export const SCHEDULED_SHOWS: ScheduledShow[] = ["both", "queue", "upcoming"];
export const SAVINGS_TARGETS_MODES: SavingsTargetsMode[] = ["all", "chosen", "target"];
/** The most targets Chosen targets holds (the API's limit). */
export const MAX_CHOSEN_TARGETS = 50;
/** How a module widget shows its module (#203). */
export type ModuleWidgetView = Schemas["ModuleWidgetView"];
export const MODULE_VIEWS: ModuleWidgetView[] = ["compact", "full"];
/** A compact graph's height (#203), and its pixels on half and full width. */
export type GraphHeight = NonNullable<Schemas["ModuleWidgetSettings"]["graph_height"]>;
export const GRAPH_HEIGHTS: GraphHeight[] = ["small", "medium", "large"];
export const GRAPH_PX: Record<GraphHeight, { half: number; full: number }> = {
  small: { half: 150, full: 200 },
  medium: { half: 200, full: 260 },
  large: { half: 280, full: 360 },
};
export type CompactSummary = NonNullable<Schemas["ModuleWidgetTransactions"]["summary"]>;
export const COMPACT_SUMMARIES: CompactSummary[] = ["net", "in_out", "off"];
/** A compact transactions module's rows; 0 for none. */
export type CompactRows = NonNullable<Schemas["ModuleWidgetTransactions"]["rows"]>;
export const COMPACT_ROWS: CompactRows[] = [0, 3, 5, 10, 15, 20];
export type CompactFigure = NonNullable<Schemas["ModuleWidgetFlows"]["figures"]>[number];
export const COMPACT_FIGURES: CompactFigure[] = ["in", "out", "net"];
/** A compact In/out/balance module's top rows; 0 for none. */
export type CompactTop = NonNullable<Schemas["ModuleWidgetFlows"]["top"]>;
export const COMPACT_TOPS: CompactTop[] = [0, 3, 5, 10];
/** What the top rows are: as the module shows (`module`), buckets or accounts. */
export type CompactTopOf = "module" | NonNullable<Schemas["ModuleWidgetFlows"]["top_of"]>;
export const COMPACT_TOP_OF: CompactTopOf[] = ["module", "buckets", "accounts"];
/** A compact budget module's buckets; 0 for all. */
export type CompactBudgetRows = NonNullable<Schemas["ModuleWidgetBudget"]["rows"]>;
export const COMPACT_BUDGET_ROWS: CompactBudgetRows[] = [3, 6, 10, 0];
export type CompactBudgetOrder = NonNullable<Schemas["ModuleWidgetBudget"]["order"]>;
export const COMPACT_BUDGET_ORDERS: CompactBudgetOrder[] = ["share", "used", "name"];
/** The most widgets a layout holds (the API's limit). */
export const MAX_WIDGETS = 30;
/** The longest custom title. */
export const MAX_TITLE = 40;

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
  /** For One account (#89). */
  accountId: string | null;
  bucketId: string | null;
  /** Show the mode above the buckets. */
  showMode: boolean;
}
export interface RecentSettings {
  count: number;
  /** Also list reversed transactions and moved originals (#91). */
  showReversed: boolean;
}
export interface InOutSettings {
  figures: FlowFigure[];
  period: FlowPeriod;
  /** For the last `days` days. */
  days: number;
  /** One account, or null for all of them. */
  accountId: string | null;
}

/** The Scheduled widget (#155): the approval queue, what's coming up, or both. */
export interface ScheduledSettings {
  show: ScheduledShow;
  /** The most rows in each part. */
  count: number;
}

/** Which targets a savings widget shows (#237). */
export interface SavingsTargetsSettings {
  mode: SavingsTargetsMode;
  /** For Chosen targets. */
  targetIds: string[];
  /** For One target. */
  targetId: string | null;
  /** The most rows. */
  count: number;
}

/** The Savings widget (#237): the targets' progress, and the distributor. */
export interface SavingsWidgetSettings extends SavingsTargetsSettings {
  /** Also what the distributor holds, with Distribute now. */
  showDistributor: boolean;
}

export interface ModuleWidgetSettings {
  /** The saved module it shows; null until one is picked. */
  savedModuleId: string | null;
  /** Compact, the Dashboard's short form (#203), or the module in full. */
  view: ModuleWidgetView;
  /** A line with the module's period and dates under the title. */
  showPeriod: boolean;
  /** A compact graph's. */
  graphHeight: GraphHeight;
  /** The compact forms' options; each applies while the module is of its type. */
  transactions: { rows: CompactRows; summary: CompactSummary };
  flows: { figures: CompactFigure[]; top: CompactTop; topOf: CompactTopOf };
  budget: {
    rows: CompactBudgetRows;
    order: CompactBudgetOrder;
    attention: boolean;
    total: boolean;
  };
}

interface SettingsOf {
  cycle: CycleSettings;
  health: null;
  bucket_status: BucketStatusSettings;
  accounts: AccountsSettings;
  recent_transactions: RecentSettings;
  in_out: InOutSettings;
  module: ModuleWidgetSettings;
  scheduled: ScheduledSettings;
  savings: SavingsWidgetSettings;
  savings_transfer: SavingsTargetsSettings;
}

/** One widget on the Dashboard, with its own settings. */
export type WidgetInstance<T extends WidgetType = WidgetType> = {
  [K in T]: {
    id: string;
    type: K;
    width: WidgetWidth;
    /** A custom title; null for the automatic one (`autoTitle`). */
    title: string | null;
    settings: SettingsOf[K];
  };
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
    accountId: s?.account_id ?? null,
    bucketId: s?.bucket_id ?? null,
    showMode: s?.show_mode ?? true,
  }),
  recent: (s?: Schemas["RecentWidgetSettings"]): RecentSettings => ({
    count: s?.count ?? 5,
    showReversed: s?.show_reversed ?? false,
  }),
  inOut: (s?: Schemas["InOutWidgetSettings"]): InOutSettings => ({
    figures: s?.figures ?? ["income", "expenses", "balance"],
    period: s?.period ?? "month",
    days: s?.days ?? 30,
    accountId: s?.account_id ?? null,
  }),
  module: (s?: Schemas["ModuleWidgetSettings"]): ModuleWidgetSettings => ({
    savedModuleId: s?.saved_module_id ?? null,
    view: s?.view ?? "compact",
    showPeriod: s?.show_period ?? true,
    graphHeight: s?.graph_height ?? "medium",
    transactions: {
      rows: s?.transactions?.rows ?? 3,
      summary: s?.transactions?.summary ?? "net",
    },
    flows: {
      figures: s?.flows?.figures ?? [...COMPACT_FIGURES],
      top: s?.flows?.top ?? 3,
      topOf: s?.flows?.top_of ?? "module",
    },
    budget: {
      rows: s?.budget?.rows ?? 6,
      order: s?.budget?.order ?? "share",
      attention: s?.budget?.attention ?? false,
      total: s?.budget?.total ?? false,
    },
  }),
  scheduled: (s?: Schemas["ScheduledWidgetSettings"]): ScheduledSettings => ({
    show: s?.show ?? "both",
    count: s?.count ?? 5,
  }),
  savingsTransfer: (s?: Schemas["SavingsTransferWidgetSettings"]): SavingsTargetsSettings => ({
    mode: s?.mode ?? "all",
    targetIds: s?.target_ids ?? [],
    targetId: s?.target_id ?? null,
    count: s?.count ?? 5,
  }),
  savings: (s?: Schemas["SavingsWidgetSettings"]): SavingsWidgetSettings => ({
    mode: s?.mode ?? "all",
    targetIds: s?.target_ids ?? [],
    targetId: s?.target_id ?? null,
    count: s?.count ?? 5,
    showDistributor: s?.show_distributor ?? true,
  }),
};

/** Which targets as stored: only the mode's own field. */
function targetsToApi(s: SavingsTargetsSettings): Schemas["SavingsTransferWidgetSettings"] {
  return {
    mode: s.mode,
    count: s.count,
    ...(s.mode === "chosen" ? { target_ids: s.targetIds } : {}),
    ...(s.mode === "target" ? { target_id: s.targetId } : {}),
  };
}

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
    case "in_out":
      return fromApi.inOut();
    case "module":
      return fromApi.module();
    case "scheduled":
      return fromApi.scheduled();
    case "savings":
      return fromApi.savings();
    case "savings_transfer":
      return fromApi.savingsTransfer();
  }
}

/** The width a new widget of the type gets. */
export function defaultWidth(type: WidgetType): WidgetWidth {
  return type === "recent_transactions" || type === "module" ? "full" : "half";
}

function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A new widget with its defaults, and an id the layout doesn't have yet. */
export function newWidget(type: WidgetType, layout: Layout = []): WidgetInstance {
  let id = newId();
  while (layout.some((w) => w.id === id)) id = newId();
  return {
    id,
    type,
    width: defaultWidth(type),
    title: null,
    settings: defaultSettings(type),
  } as WidgetInstance;
}

/**
 * The default layout. Desktop: the five widgets of #29's fixed Dashboard, in
 * its order. Mobile (#99): Needs attention, the cycle and the latest
 * transactions. Both use the given per-type settings from before #37.
 */
export function defaultLayout(
  kind: LayoutKind = "desktop",
  saved?: DashboardPreferences | null,
): Layout {
  if (kind === "mobile") {
    return [
      {
        id: "bucket_status",
        type: "bucket_status",
        width: "full",
        title: null,
        settings: fromApi.bucketStatus(saved?.bucket_status),
      },
      {
        id: "cycle",
        type: "cycle",
        width: "full",
        title: null,
        settings: fromApi.cycle(saved?.cycle),
      },
      {
        id: "recent_transactions",
        type: "recent_transactions",
        width: "full",
        title: null,
        settings: fromApi.recent(saved?.recent_transactions),
      },
    ];
  }
  return [
    {
      id: "cycle",
      type: "cycle",
      width: "half",
      title: null,
      settings: fromApi.cycle(saved?.cycle),
    },
    { id: "health", type: "health", width: "half", title: null, settings: null },
    {
      id: "bucket_status",
      type: "bucket_status",
      width: "half",
      title: null,
      settings: fromApi.bucketStatus(saved?.bucket_status),
    },
    {
      id: "accounts",
      type: "accounts",
      width: "half",
      title: null,
      settings: fromApi.accounts(saved?.accounts),
    },
    {
      id: "recent_transactions",
      type: "recent_transactions",
      width: "full",
      title: null,
      settings: fromApi.recent(saved?.recent_transactions),
    },
  ];
}

function widgetFromApi(w: ApiWidget): WidgetInstance | null {
  const base = { id: w.id, width: w.width, title: w.title ?? null };
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
    case "in_out":
      return { ...base, type: w.type, settings: fromApi.inOut(w.in_out) };
    case "module":
      return { ...base, type: w.type, settings: fromApi.module(w.module) };
    case "scheduled":
      return { ...base, type: w.type, settings: fromApi.scheduled(w.scheduled) };
    case "savings":
      return { ...base, type: w.type, settings: fromApi.savings(w.savings) };
    case "savings_transfer":
      return { ...base, type: w.type, settings: fromApi.savingsTransfer(w.savings_transfer) };
    default:
      // A type this app doesn't know (or no longer has) isn't shown.
      return null;
  }
}

/** A saved layout's widgets, those of unknown types left out. */
function readWidgets(list: ApiWidget[]): Layout {
  return list.flatMap((w) => widgetFromApi(w) ?? []);
}

/**
 * The saved layout. Without one (before #37, or never edited) it's the
 * default layout, using the per-type settings saved by #29.
 */
/** The desktop layout: the saved one, else the default with the per-type settings. */
export function dashboardLayout(preferences: Preferences): Layout {
  const saved = preferences.dashboard;
  return saved?.widgets ? readWidgets(saved.widgets) : defaultLayout("desktop", saved);
}

/** The two layouts (#99): one for wide screens, one for phones. */
export type LayoutKind = "desktop" | "mobile";
export const LAYOUT_KINDS: LayoutKind[] = ["desktop", "mobile"];
export type Layouts = Record<LayoutKind, Layout>;

/**
 * Both layouts. Until the mobile layout is saved it's a copy of the desktop
 * one, so nothing changes for whoever had a Dashboard before #99; with
 * nothing saved at all it's the mobile default.
 */
export function dashboardLayouts(preferences: Preferences): Layouts {
  const saved = preferences.dashboard;
  const desktop = dashboardLayout(preferences);
  const mobile = saved?.mobile_widgets
    ? readWidgets(saved.mobile_widgets)
    : saved
      ? copyLayout(desktop)
      : defaultLayout("mobile");
  return { desktop, mobile };
}

/** A copy that shares nothing with the layout, for the other layout to start from. */
export function copyLayout(layout: Layout): Layout {
  return structuredClone(layout);
}

function widgetToApi(w: WidgetInstance): ApiWidget {
  const base = {
    id: w.id,
    type: w.type,
    width: w.width,
    ...(w.title === null ? {} : { title: w.title }),
  };
  switch (w.type) {
    case "cycle":
      return { ...base, cycle: { show_next: w.settings.showNext } };
    case "health":
      return base;
    case "bucket_status": {
      const { mode, accountId, bucketId, showMode } = w.settings;
      return {
        ...base,
        bucket_status: {
          mode,
          ...(mode === "account" ? { account_id: accountId } : {}),
          ...(mode === "bucket" ? { bucket_id: bucketId } : {}),
          ...(showMode ? {} : { show_mode: false }),
        },
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
      return {
        ...base,
        recent_transactions: {
          count: w.settings.count,
          ...(w.settings.showReversed ? { show_reversed: true } : {}),
        },
      };
    case "in_out": {
      const { figures, period, days, accountId } = w.settings;
      return {
        ...base,
        in_out: {
          figures,
          period,
          ...(period === "days" ? { days } : {}),
          ...(accountId === null ? {} : { account_id: accountId }),
        },
      };
    }
    case "module": {
      return w.settings.savedModuleId === null
        ? base
        : { ...base, module: moduleToApi(w.settings, w.settings.savedModuleId) };
    }
    case "scheduled":
      return { ...base, scheduled: { show: w.settings.show, count: w.settings.count } };
    case "savings":
      return {
        ...base,
        savings: {
          ...targetsToApi(w.settings),
          ...(w.settings.showDistributor ? {} : { show_distributor: false }),
        },
      };
    case "savings_transfer":
      return { ...base, savings_transfer: targetsToApi(w.settings) };
  }
}

/** A module widget's settings as stored: only what differs from the defaults. */
function moduleToApi(s: ModuleWidgetSettings, id: string): Schemas["ModuleWidgetSettings"] {
  const d = fromApi.module();
  /** The entries of `o` that differ from `def`, or nothing when none do. */
  const changed = <T extends object>(o: T, def: T): Partial<T> | undefined => {
    const out = Object.fromEntries(
      Object.entries(o).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(def[k as keyof T])),
    ) as Partial<T>;
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const { topOf, ...flows } = changed(s.flows, d.flows) ?? {};
  const flowsOut = { ...flows, ...(topOf && topOf !== "module" ? { top_of: topOf } : {}) };
  const transactions = changed(s.transactions, d.transactions);
  const budget = changed(s.budget, d.budget);
  return {
    saved_module_id: id,
    ...(s.view === "full" ? { view: s.view } : {}),
    ...(s.showPeriod ? {} : { show_period: false }),
    ...(s.graphHeight === "medium" ? {} : { graph_height: s.graphHeight }),
    ...(transactions ? { transactions } : {}),
    ...(Object.keys(flowsOut).length > 0 ? { flows: flowsOut } : {}),
    ...(budget ? { budget } : {}),
  };
}

/** One layout as the API stores it. */
export function layoutToPreferences(layout: Layout): DashboardPreferences {
  return { widgets: layout.map(widgetToApi) };
}

/**
 * What saving sends: both layouts, since the API replaces `dashboard` as a
 * whole and the one not being changed has to stay as it is.
 */
export function layoutsToPreferences(layouts: Layouts): DashboardPreferences {
  return {
    widgets: layouts.desktop.map(widgetToApi),
    mobile_widgets: layouts.mobile.map(widgetToApi),
  };
}

/** Where Add to dashboard puts a saved module (#124, #201). */
export type ModuleWidgetPlace = LayoutKind | "both";

/**
 * Both layouts with a full-width module widget showing the saved module
 * added at the end of one of them, or of both.
 */
export function addModuleWidget(
  layouts: Layouts,
  savedModuleId: string,
  where: ModuleWidgetPlace,
): Layouts {
  const add = (layout: Layout): Layout => [
    ...layout,
    {
      ...(newWidget("module", layout) as WidgetInstance<"module">),
      settings: { ...fromApi.module(), savedModuleId },
    },
  ];
  return {
    desktop: where === "mobile" ? layouts.desktop : add(layouts.desktop),
    mobile: where === "desktop" ? layouts.mobile : add(layouts.mobile),
  };
}

/** How many widgets, in both layouts, show the saved module. */
export function moduleWidgetsFor(layouts: Layouts, savedModuleId: string): number {
  return [...layouts.desktop, ...layouts.mobile].filter(
    (w) => w.type === "module" && w.settings.savedModuleId === savedModuleId,
  ).length;
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

/** A custom title as saved: trimmed, and null when it's empty. */
export function customTitle(title: string): string | null {
  const trimmed = title.trim().slice(0, MAX_TITLE);
  return trimmed === "" ? null : trimmed;
}

/**
 * A widget's title, unless it's the widget's name: its custom title, the
 * name of the bucket or account it shows (One bucket, One account), or of
 * its saved module.
 */
export function autoTitle(
  widget: WidgetInstance,
  accounts: Account[],
  buckets: Bucket[],
  saved: SavedName[] = [],
  targets: SavedName[] = [],
): string | null {
  if (widget.title !== null) return widget.title;
  if (
    (widget.type === "savings" || widget.type === "savings_transfer") &&
    widget.settings.mode === "target"
  ) {
    const { targetId } = widget.settings;
    return targets.find((g) => g.id === targetId)?.name ?? null;
  }
  if (widget.type === "module") {
    return saved.find((g) => g.id === widget.settings.savedModuleId)?.name ?? null;
  }
  if (widget.type === "bucket_status" && widget.settings.mode === "bucket") {
    const { bucketId } = widget.settings;
    return buckets.find((b) => b.id === bucketId)?.name ?? null;
  }
  if (
    (widget.type === "bucket_status" || widget.type === "accounts") &&
    widget.settings.mode === "account"
  ) {
    const { accountId } = widget.settings;
    return accounts.find((a) => a.id === accountId)?.name ?? null;
  }
  return null;
}

/**
 * Whether a widget's settings can be saved: One bucket and One account need
 * a bucket or account that exists, and a module widget a saved module.
 */
export function settingsComplete(
  widget: WidgetInstance,
  accounts: Account[],
  buckets: Bucket[],
  saved: SavedName[] = [],
  targets: SavedName[] = [],
): boolean {
  if (widget.type === "savings" || widget.type === "savings_transfer") {
    const { mode, targetId, targetIds } = widget.settings;
    if (mode === "target") return targets.some((g) => g.id === targetId);
    if (mode === "chosen") return targetIds.some((id) => targets.some((g) => g.id === id));
    return true;
  }
  if (widget.type === "module") {
    return (
      saved.some((g) => g.id === widget.settings.savedModuleId) &&
      widget.settings.flows.figures.length > 0
    );
  }
  if (widget.type === "bucket_status" && widget.settings.mode === "bucket") {
    return buckets.some((b) => b.id === widget.settings.bucketId);
  }
  if (
    (widget.type === "bucket_status" || widget.type === "accounts") &&
    widget.settings.mode === "account"
  ) {
    return accounts.some((a) => a.id === widget.settings.accountId);
  }
  if (widget.type === "in_out") {
    const { figures, period, days, accountId } = widget.settings;
    return (
      figures.length > 0 &&
      (period !== "days" || (Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) &&
      (accountId === null || accounts.some((a) => a.id === accountId))
    );
  }
  return true;
}

/**
 * What Bucket status shows. One bucket without its bucket (none chosen, or
 * it was deleted) falls back to Needs attention; One account without its
 * account has `account: null`, for the widget to say it's gone (#89).
 */
export function shownBucketStatus(
  settings: BucketStatusSettings,
  accounts: Account[],
  buckets: Bucket[],
):
  | { mode: Exclude<BucketStatusMode, "bucket" | "account"> }
  | { mode: "account"; account: Account | null }
  | { mode: "bucket"; bucket: Bucket | null } {
  const { mode, accountId, bucketId } = settings;
  if (mode === "account") {
    return { mode, account: accounts.find((a) => a.id === accountId) ?? null };
  }
  if (mode !== "bucket") return { mode };
  // A deleted bucket is null, for the widget to say it's gone (#135).
  return { mode, bucket: buckets.find((b) => b.id === bucketId) ?? null };
}

/**
 * The accounts Account balances shows: all of them, or the chosen one. A
 * deleted account is null, for the widget to say it's gone (#135).
 */
export function shownAccounts(
  settings: AccountsSettings,
  accounts: Account[],
): { mode: "all" } | { mode: "account"; account: Account | null } {
  const { mode, accountId } = settings;
  if (mode !== "account") return { mode: "all" };
  return { mode, account: accounts.find((a) => a.id === accountId) ?? null };
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

export type AttentionReason = "overspent" | "uncovered" | "plannedShort" | "mostlyUsed";

export interface Attention {
  bucket: Bucket;
  reason: AttentionReason;
}

/**
 * The buckets that need attention, worst first: overspent, not fully
 * covered (priority ones first), short of what planned purchases set aside
 * this cycle (#265), then more than 90 % used, the most used first.
 */
export function needsAttention(
  buckets: Bucket[],
  figures: Map<string, BucketFigures>,
): Attention[] {
  const rank = (a: Attention) =>
    a.reason === "overspent"
      ? 0
      : a.reason === "uncovered"
        ? a.bucket.priority
          ? 1
          : 2
        : a.reason === "plannedShort"
          ? 3
          : 4;
  const pct = (b: Bucket) => usedPct(figures.get(b.id)) ?? 0;
  return buckets
    .flatMap((bucket): Attention[] => {
      const { overspent, gap } = coverage(bucket);
      if (overspent) return [{ bucket, reason: "overspent" }];
      if (compareAmounts(gap, "0") > 0) return [{ bucket, reason: "uncovered" }];
      if (setAside(bucket, figures.get(bucket.id))?.short)
        return [{ bucket, reason: "plannedShort" }];
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

/**
 * The targets a savings widget shows (#237), in the Savings screen's order,
 * without deleted ones; `gone` is a One target whose target was deleted.
 */
export function pickTargets<T extends { id: string }>(
  settings: SavingsTargetsSettings,
  targets: T[],
): { shown: T[]; gone: boolean } {
  switch (settings.mode) {
    case "all":
      return { shown: targets, gone: false };
    case "chosen":
      return { shown: targets.filter((t) => settings.targetIds.includes(t.id)), gone: false };
    case "target": {
      const shown = targets.filter((t) => t.id === settings.targetId);
      return { shown, gone: shown.length === 0 };
    }
  }
}
