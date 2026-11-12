import { account, bucket, bucketFigures } from "@/test/fixtures";

import {
  defaultSettings,
  accountHealth,
  addModuleWidget,
  autoTitle,
  copyLayout,
  customTitle,
  dashboardLayout,
  dashboardLayouts,
  defaultLayout,
  layoutToPreferences,
  layoutsToPreferences,
  mostUsed,
  moveWidget,
  moveWidgetTo,
  moduleWidgetsFor,
  needsAttention,
  newWidget,
  removeWidget,
  replaceWidget,
  settingsComplete,
  shownAccounts,
  shownBucketStatus,
  usedPct,
  type DashboardPreferences,
  type Layout,
  type WidgetInstance,
} from "./dashboard";

const main = account({ id: "1234", name: "Main account", balance: "1000.00" });
const base = { source_account_id: main.id };

const fine = bucket({
  ...base,
  id: "1",
  name: "Fine",
  target_funds: "300.00",
  current_available_funds: "300.00",
});
const short = bucket({
  ...base,
  id: "2",
  name: "Short",
  target_funds: "500.00",
  current_available_funds: "200.00",
});
const shortPriority = { ...short, id: "3", name: "Rent", priority: true };
const overspent = bucket({ ...base, id: "4", name: "Over", target_funds: "-50.00" });
const busy = bucket({
  ...base,
  id: "5",
  name: "Busy",
  target_funds: "50.00",
  current_available_funds: "50.00",
});

const figures = new Map(
  [
    bucketFigures({ bucket_id: "1", budget: "1000.00", used: "700.00" }),
    bucketFigures({ bucket_id: "2", budget: "1000.00", used: "500.00" }),
    bucketFigures({ bucket_id: "3", budget: "1000.00", used: "500.00" }),
    bucketFigures({ bucket_id: "4", budget: "100.00", used: "150.00" }),
    bucketFigures({ bucket_id: "5", budget: "1000.00", used: "950.00" }),
  ].map((f) => [f.bucket_id, f]),
);

describe("dashboardLayout", () => {
  it("is #29's five widgets with their defaults when nothing is saved", () => {
    expect(dashboardLayout({})).toEqual([
      { id: "cycle", type: "cycle", width: "half", title: null, settings: { showNext: true } },
      { id: "health", type: "health", width: "half", title: null, settings: null },
      {
        id: "bucket_status",
        type: "bucket_status",
        width: "half",
        title: null,
        settings: { mode: "attention", accountId: null, bucketId: null, showMode: true },
      },
      {
        id: "accounts",
        type: "accounts",
        width: "half",
        title: null,
        settings: { mode: "all", accountId: null },
      },
      {
        id: "recent_transactions",
        type: "recent_transactions",
        width: "full",
        title: null,
        settings: { count: 5, showReversed: false },
      },
    ]);
    expect(dashboardLayout({ dashboard: null })).toEqual(defaultLayout());
  });

  it("migrates #29's per-type settings into the default layout", () => {
    const layout = dashboardLayout({
      dashboard: {
        cycle: { show_next: false },
        accounts: { mode: "account", account_id: "1234" },
        bucket_status: { mode: "bucket", bucket_id: "1000000001" },
        recent_transactions: { count: 10 },
      },
    });
    expect(layout.map((w) => w.settings)).toEqual([
      { showNext: false },
      null,
      { mode: "bucket", accountId: null, bucketId: "1000000001", showMode: true },
      { mode: "account", accountId: "1234" },
      { count: 10, showReversed: false },
    ]);
    expect(layoutToPreferences(layout)).toEqual({
      widgets: [
        { id: "cycle", type: "cycle", width: "half", cycle: { show_next: false } },
        { id: "health", type: "health", width: "half" },
        {
          id: "bucket_status",
          type: "bucket_status",
          width: "half",
          bucket_status: { mode: "bucket", bucket_id: "1000000001" },
        },
        {
          id: "accounts",
          type: "accounts",
          width: "half",
          accounts: { mode: "account", account_id: "1234" },
        },
        {
          id: "recent_transactions",
          type: "recent_transactions",
          width: "full",
          recent_transactions: { count: 10 },
        },
      ],
    });
  });

  it("reads a saved layout, and saves it back", () => {
    const dashboard = {
      widgets: [
        {
          id: "a",
          type: "bucket_status" as const,
          width: "full" as const,
          bucket_status: { mode: "most_used" as const },
        },
        {
          id: "b",
          type: "bucket_status" as const,
          width: "half" as const,
          bucket_status: { mode: "bucket" as const, bucket_id: "2" },
        },
        { id: "c", type: "health" as const, width: "half" as const },
      ],
      // Left over from #29; the layout wins.
      cycle: { show_next: false },
    };
    const layout = dashboardLayout({ dashboard });
    expect(layout.map((w) => [w.id, w.type, w.width])).toEqual([
      ["a", "bucket_status", "full"],
      ["b", "bucket_status", "half"],
      ["c", "health", "half"],
    ]);
    expect(layoutToPreferences(layout)).toEqual({ widgets: dashboard.widgets });
    // A widget without its settings object uses the defaults.
    expect(
      dashboardLayout({ dashboard: { widgets: [{ id: "x", type: "cycle", width: "half" }] } }),
    ).toEqual([
      { id: "x", type: "cycle", width: "half", title: null, settings: { showNext: true } },
    ]);
    expect(dashboardLayout({ dashboard: { widgets: [] } })).toEqual([]);
  });

  it("only saves the chosen bucket or account in those modes", () => {
    const layout: Layout = [
      {
        id: "a",
        type: "accounts",
        width: "half",
        title: null,
        settings: { mode: "all", accountId: "1234" },
      },
      {
        id: "b",
        type: "bucket_status",
        width: "half",
        title: null,
        settings: { mode: "all", accountId: "1234", bucketId: "2", showMode: true },
      },
      {
        id: "c",
        type: "bucket_status",
        width: "half",
        title: null,
        settings: { mode: "account", accountId: "1234", bucketId: "2", showMode: true },
      },
    ];
    const saved = layoutToPreferences(layout);
    expect(saved.widgets).toEqual([
      { id: "a", type: "accounts", width: "half", accounts: { mode: "all" } },
      { id: "b", type: "bucket_status", width: "half", bucket_status: { mode: "all" } },
      {
        id: "c",
        type: "bucket_status",
        width: "half",
        bucket_status: { mode: "account", account_id: "1234" },
      },
    ]);
    expect(dashboardLayout({ dashboard: saved })[2]).toEqual({
      ...layout[2],
      settings: { mode: "account", accountId: "1234", bucketId: null, showMode: true },
    });
  });
});

describe("the desktop and mobile layouts (#99)", () => {
  const health = { id: "h", type: "health" as const, width: "half" as const };
  const cycleApi = { id: "c", type: "cycle" as const, width: "full" as const };

  it("are both saved ones", () => {
    const layouts = dashboardLayouts({
      dashboard: { widgets: [health], mobile_widgets: [cycleApi] },
    });
    expect(layouts.desktop.map((w) => w.type)).toEqual(["health"]);
    expect(layouts.mobile).toEqual([
      { id: "c", type: "cycle", width: "full", title: null, settings: { showNext: true } },
    ]);
  });

  it("copies the desktop layout into a mobile one that isn't saved", () => {
    const saved = dashboardLayouts({ dashboard: { widgets: [health] } });
    expect(saved.mobile).toEqual(saved.desktop);
    expect(saved.mobile).not.toBe(saved.desktop);
    // Only the settings from before #37: the copy has them too.
    const old = dashboardLayouts({ dashboard: { bucket_status: { mode: "all" } } });
    expect(old.mobile).toEqual(old.desktop);
    expect(old.mobile.find((w) => w.type === "bucket_status")?.settings).toMatchObject({
      mode: "all",
    });
  });

  it("gives the mobile default when nothing is saved", () => {
    const layouts = dashboardLayouts({});
    expect(layouts.desktop).toEqual(defaultLayout());
    expect(layouts.mobile).toEqual(defaultLayout("mobile"));
    expect(layouts.mobile.map((w) => [w.type, w.width])).toEqual([
      ["bucket_status", "full"],
      ["cycle", "full"],
      ["recent_transactions", "full"],
    ]);
    expect(layouts.mobile[0]?.settings).toMatchObject({ mode: "attention" });
    expect(dashboardLayouts({ dashboard: null }).mobile).toEqual(defaultLayout("mobile"));
  });

  it("saves both layouts together", () => {
    const layouts = dashboardLayouts({ dashboard: { widgets: [health], mobile_widgets: [] } });
    expect(layoutsToPreferences(layouts)).toEqual({ widgets: [health], mobile_widgets: [] });
  });

  it("copies a layout without sharing anything with it", () => {
    const [cycle] = defaultLayout();
    const layout: Layout = cycle ? [cycle] : [];
    const copy = copyLayout(layout);
    expect(copy).toEqual(layout);
    expect(copy[0]).not.toBe(layout[0]);
    expect(copy[0]?.settings).not.toBe(layout[0]?.settings);
  });
});

describe("editing the layout", () => {
  const [cycle, , status, accounts, recent] = defaultLayout();
  const layout = defaultLayout();
  const ids = (l: Layout) => l.map((w) => w.id);

  it("moves a widget up or down, but not past the ends", () => {
    expect(ids(moveWidget(layout, "health", 1))).toEqual([
      "cycle",
      "bucket_status",
      "health",
      "accounts",
      "recent_transactions",
    ]);
    expect(ids(moveWidget(layout, "health", -1))[0]).toBe("health");
    expect(moveWidget(layout, "cycle", -1)).toBe(layout);
    expect(moveWidget(layout, "recent_transactions", 1)).toBe(layout);
    expect(ids(moveWidgetTo(layout, 4, 0))).toEqual([
      "recent_transactions",
      "cycle",
      "health",
      "bucket_status",
      "accounts",
    ]);
  });

  it("removes and replaces widgets, adding new ones at the end", () => {
    expect(removeWidget(layout, "health")).toEqual([cycle, status, accounts, recent]);
    const wide: WidgetInstance = {
      id: "health",
      type: "health",
      width: "full",
      title: null,
      settings: null,
    };
    expect(replaceWidget(layout, wide)[1]).toEqual(wide);
    const added = newWidget("bucket_status", layout);
    expect(added).toMatchObject({
      type: "bucket_status",
      width: "half",
      title: null,
      settings: { mode: "attention", accountId: null, bucketId: null, showMode: true },
    });
    expect(added.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(ids(replaceWidget(layout, added)).at(-1)).toBe(added.id);
    expect(newWidget("recent_transactions").width).toBe("full");
  });

  it("needs a bucket or account that exists for One bucket and One account", () => {
    const one = (bucketId: string | null): WidgetInstance => ({
      id: "b",
      type: "bucket_status",
      width: "half",
      title: null,
      settings: { mode: "bucket", accountId: null, bucketId, showMode: true },
    });
    expect(settingsComplete(one(null), [main], [fine])).toBe(false);
    expect(settingsComplete(one("9"), [main], [fine])).toBe(false);
    expect(settingsComplete(one(fine.id), [main], [fine])).toBe(true);
    const account: WidgetInstance = {
      id: "a",
      type: "accounts",
      width: "half",
      title: null,
      settings: { mode: "account", accountId: main.id },
    };
    expect(settingsComplete(account, [main], [])).toBe(true);
    expect(settingsComplete(account, [], [])).toBe(false);
    const buckets = one(null);
    const ofAccount = (accountId: string | null): WidgetInstance =>
      buckets.type === "bucket_status"
        ? { ...buckets, settings: { ...buckets.settings, mode: "account", accountId } }
        : buckets;
    expect(settingsComplete(ofAccount(main.id), [main], [])).toBe(true);
    expect(settingsComplete(ofAccount(null), [main], [])).toBe(false);
    expect(settingsComplete(ofAccount("9"), [main], [])).toBe(false);
    expect(settingsComplete(layout[0] ?? account, [], [])).toBe(true);
  });
});

describe("titles and the mode line", () => {
  const one: WidgetInstance = {
    id: "b",
    type: "bucket_status",
    width: "half",
    title: null,
    settings: { mode: "bucket", accountId: null, bucketId: short.id, showMode: false },
  };

  it("names One bucket and One account after what they show, unless given a title", () => {
    expect(autoTitle(one, [main], [fine, short])).toBe("Short");
    expect(autoTitle({ ...one, title: "Savings" }, [main], [fine, short])).toBe("Savings");
    // Gone, or another mode: the widget's own name.
    expect(autoTitle(one, [main], [fine])).toBeNull();
    expect(
      autoTitle({ ...one, settings: { ...one.settings, mode: "all" } }, [main], [short]),
    ).toBeNull();
    const account: WidgetInstance = {
      id: "a",
      type: "accounts",
      width: "half",
      title: null,
      settings: { mode: "account", accountId: main.id },
    };
    expect(autoTitle(account, [main], [])).toBe("Main account");
    const ofAccount: WidgetInstance = {
      ...one,
      settings: { mode: "account", accountId: main.id, bucketId: null, showMode: true },
    };
    expect(autoTitle(ofAccount, [main], [])).toBe("Main account");
    expect(autoTitle(ofAccount, [], [])).toBeNull();
    expect(autoTitle(defaultLayout()[1] ?? account, [main], [])).toBeNull();
  });

  it("trims a custom title, and empties it to the automatic one", () => {
    expect(customTitle("  Food  ")).toBe("Food");
    expect(customTitle("   ")).toBeNull();
    expect(customTitle("x".repeat(50))).toHaveLength(40);
  });

  it("saves a title and a hidden mode line, and reads them back", () => {
    const saved = layoutToPreferences([{ ...one, title: "Savings" }]);
    expect(saved.widgets).toEqual([
      {
        id: "b",
        type: "bucket_status",
        width: "half",
        title: "Savings",
        bucket_status: { mode: "bucket", bucket_id: short.id, show_mode: false },
      },
    ]);
    expect(dashboardLayout({ dashboard: saved })).toEqual([{ ...one, title: "Savings" }]);
  });
});

describe("the In/out widget", () => {
  it("saves its settings, leaving out what its mode doesn't use", () => {
    const widget = newWidget("in_out");
    expect(widget.settings).toEqual({
      figures: ["income", "expenses", "balance"],
      period: "month",
      days: 30,
      accountId: null,
    });
    expect(layoutToPreferences([{ ...widget, id: "w" }]).widgets).toEqual([
      {
        id: "w",
        type: "in_out",
        width: "half",
        in_out: { figures: ["income", "expenses", "balance"], period: "month" },
      },
    ]);
    const days: WidgetInstance<"in_out"> = {
      id: "d",
      type: "in_out",
      width: "half",
      title: null,
      settings: { figures: ["balance"], period: "days", days: 7, accountId: main.id },
    };
    const saved = layoutToPreferences([days]);
    expect(saved.widgets?.[0]?.in_out).toEqual({
      figures: ["balance"],
      period: "days",
      days: 7,
      account_id: main.id,
    });
    expect(dashboardLayout({ dashboard: saved })).toEqual([days]);
  });

  it("needs a figure, a sensible number of days and an account that exists", () => {
    const widget = newWidget("in_out");
    const withSettings = (settings: object) =>
      ({ ...widget, settings: { ...widget.settings, ...settings } }) as WidgetInstance;
    expect(settingsComplete(widget, [main], [])).toBe(true);
    expect(settingsComplete(withSettings({ figures: [] }), [main], [])).toBe(false);
    expect(settingsComplete(withSettings({ period: "days", days: 0 }), [main], [])).toBe(false);
    expect(settingsComplete(withSettings({ period: "days", days: 367 }), [main], [])).toBe(false);
    expect(settingsComplete(withSettings({ period: "days", days: 366 }), [main], [])).toBe(true);
    expect(settingsComplete(withSettings({ accountId: main.id }), [main], [])).toBe(true);
    expect(settingsComplete(withSettings({ accountId: "9999" }), [main], [])).toBe(false);
  });
});

describe("shownAccounts", () => {
  const settings = { mode: "account" as const, accountId: main.id };

  it("shows the chosen account", () => {
    expect(shownAccounts(settings, [main])).toEqual({ mode: "account", account: main });
  });

  it("says when it's gone (#135)", () => {
    expect(shownAccounts(settings, [])).toEqual({ mode: "account", account: null });
  });

  it("shows them all otherwise", () => {
    expect(shownAccounts({ mode: "all", accountId: main.id }, [main])).toEqual({ mode: "all" });
  });
});

describe("shownBucketStatus", () => {
  const settings = { mode: "bucket" as const, accountId: null, bucketId: "2", showMode: true };

  it("shows the chosen bucket", () => {
    expect(shownBucketStatus(settings, [main], [fine, short])).toEqual({
      mode: "bucket",
      bucket: short,
    });
  });

  it("says when the bucket is gone (#135)", () => {
    expect(shownBucketStatus(settings, [main], [fine])).toEqual({ mode: "bucket", bucket: null });
  });

  it("shows the chosen account, or says it's gone", () => {
    const account = { ...settings, mode: "account" as const, accountId: main.id };
    expect(shownBucketStatus(account, [main], [fine])).toEqual({ mode: "account", account: main });
    expect(shownBucketStatus(account, [], [fine])).toEqual({ mode: "account", account: null });
  });
});

describe("accountHealth", () => {
  it("sums up what the account backs", () => {
    expect(accountHealth(main, [fine, short, overspent, busy])).toEqual({
      needed: "850.00",
      covered: "550.00",
      pct: 64,
      short: "0.00",
      unallocated: "0.00",
      uncovered: 1,
      overspent: 1,
      tone: "warn",
    });
  });

  it("is short when the balance doesn't reach the targets", () => {
    const poor = { ...main, balance: "600.00" };
    const health = accountHealth(poor, [fine, shortPriority]);
    expect(health.short).toBe("200.00");
    expect(health.tone).toBe("alert");
  });

  it("is fully covered without targets", () => {
    expect(accountHealth({ ...main, unallocated: "1000.00" }, [])).toMatchObject({
      pct: 100,
      unallocated: "1000.00",
      uncovered: 0,
    });
  });
});

describe("usedPct", () => {
  it("needs a budget", () => {
    expect(usedPct(undefined)).toBeNull();
    expect(usedPct(bucketFigures({ bucket_id: "1", used: "10.00" }))).toBeNull();
    expect(usedPct(figures.get("1"))).toBe(70);
  });
});

describe("needsAttention", () => {
  it("lists the worst first and leaves out the fine ones", () => {
    const list = needsAttention([fine, short, busy, shortPriority, overspent], figures);
    expect(list.map((a) => [a.bucket.name, a.reason])).toEqual([
      ["Over", "overspent"],
      ["Rent", "uncovered"],
      ["Short", "uncovered"],
      ["Busy", "mostlyUsed"],
    ]);
  });

  it("is empty when all is well", () => {
    expect(needsAttention([fine], figures)).toEqual([]);
  });
});

describe("mostUsed", () => {
  it("takes the most used first", () => {
    expect(mostUsed([fine, short, busy, overspent], figures, 3)).toEqual([
      { bucket: overspent, pct: 150 },
      { bucket: busy, pct: 95 },
      { bucket: fine, pct: 70 },
    ]);
  });

  it("skips buckets without figures", () => {
    expect(mostUsed([fine], new Map())).toEqual([]);
  });
});

describe("the module widget (#201; the graph widget before, #124)", () => {
  const saved = [{ id: "g-1", name: "Monthly spending" }];
  const shows = (
    savedModuleId: string | null,
    view: "compact" | "full" = "compact",
  ): WidgetInstance<"module"> => ({
    id: "gw",
    type: "module",
    width: "full",
    title: null,
    settings: { ...defaultSettings("module"), savedModuleId, view },
  });

  it("saves the saved module it shows, and reads it back", () => {
    const prefs = layoutToPreferences([shows("g-1"), shows(null)]);
    expect(prefs.widgets).toEqual([
      { id: "gw", type: "module", width: "full", module: { saved_module_id: "g-1" } },
      { id: "gw", type: "module", width: "full" },
    ]);
    const back = dashboardLayout({ dashboard: prefs });
    expect(back[0]).toEqual(shows("g-1"));
    expect(back[1]).toEqual(shows(null));
    expect(newWidget("module")).toMatchObject({
      width: "full",
      settings: { savedModuleId: null, view: "compact" },
    });
  });

  it("is compact unless it's set to Full, which alone is saved (#203)", () => {
    const prefs = layoutToPreferences([shows("g-1", "full"), shows("g-2", "compact")]);
    expect(prefs.widgets?.map((w) => w.module)).toEqual([
      { saved_module_id: "g-1", view: "full" },
      { saved_module_id: "g-2" },
    ]);
    const back = dashboardLayout({ dashboard: prefs });
    expect(back[0]).toEqual(shows("g-1", "full"));
    expect(back[1]).toEqual(shows("g-2"));
  });

  it("saves only the compact options that differ from the defaults (#203)", () => {
    const w = shows("g-1");
    const set = (settings: Partial<WidgetInstance<"module">["settings"]>) =>
      layoutToPreferences([{ ...w, settings: { ...w.settings, ...settings } }]).widgets?.[0]
        ?.module;
    expect(set({})).toEqual({ saved_module_id: "g-1" });
    const changed: Partial<WidgetInstance<"module">["settings"]> = {
      showPeriod: false,
      graphHeight: "large",
      transactions: { rows: 10, summary: "in_out" },
      flows: { figures: ["net"], top: 3, topOf: "accounts" },
      budget: { rows: 0, order: "name", attention: true, total: false },
    };
    const api = set(changed);
    expect(api).toEqual({
      saved_module_id: "g-1",
      show_period: false,
      graph_height: "large",
      transactions: { rows: 10, summary: "in_out" },
      flows: { figures: ["net"], top_of: "accounts" },
      budget: { rows: 0, order: "name", attention: true },
    });
    // Following the module stores nothing.
    expect(set({ flows: { ...w.settings.flows, topOf: "module" } })).toEqual({
      saved_module_id: "g-1",
    });
    const back = dashboardLayout({
      dashboard: { widgets: [{ id: "gw", type: "module", width: "full", module: api }] },
    });
    expect(back[0]?.settings).toEqual({ ...w.settings, ...changed });
  });

  it("leaves out widgets of a type the app doesn't know", () => {
    const widgets = [
      { id: "a", type: "graph", width: "full", graph: { saved_graph_id: "g-1" } },
      { id: "b", type: "health", width: "half" },
    ] as unknown as NonNullable<DashboardPreferences["widgets"]>;
    expect(dashboardLayout({ dashboard: { widgets } }).map((w) => w.id)).toEqual(["b"]);
  });

  it("is named after its saved module, and needs one that exists", () => {
    expect(autoTitle(shows("g-1"), [], [], saved)).toBe("Monthly spending");
    expect(autoTitle(shows("g-9"), [], [], saved)).toBeNull();
    expect(autoTitle({ ...shows("g-1"), title: "Spending" }, [], [], saved)).toBe("Spending");
    expect(settingsComplete(shows("g-1"), [], [], saved)).toBe(true);
    expect(settingsComplete(shows("g-9"), [], [], saved)).toBe(false);
    expect(settingsComplete(shows(null), [], [], saved)).toBe(false);
  });

  it("is added from Stats to one layout or both, and counted", () => {
    const layouts = { desktop: defaultLayout("desktop"), mobile: defaultLayout("mobile") };
    const desktop = addModuleWidget(layouts, "g-1", "desktop");
    expect(desktop.mobile).toBe(layouts.mobile);
    expect(desktop.desktop).toHaveLength(layouts.desktop.length + 1);
    expect(desktop.desktop.at(-1)).toMatchObject({
      type: "module",
      width: "full",
      title: null,
      settings: { savedModuleId: "g-1" },
    });
    const mobile = addModuleWidget(layouts, "g-1", "mobile");
    expect(mobile.desktop).toBe(layouts.desktop);
    expect(mobile.mobile.at(-1)).toMatchObject({
      type: "module",
      settings: { savedModuleId: "g-1" },
    });
    const both = addModuleWidget(addModuleWidget(layouts, "g-1", "both"), "g-2", "desktop");
    expect(moduleWidgetsFor(both, "g-1")).toBe(2);
    expect(moduleWidgetsFor(both, "g-2")).toBe(1);
    expect(moduleWidgetsFor(layouts, "g-1")).toBe(0);
    // New ids don't clash with the layout's.
    const ids = both.desktop.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the Scheduled widget (#155)", () => {
  it("starts with both parts and 5 rows, half width, and saves its settings back", () => {
    const fresh = newWidget("scheduled");
    expect(fresh).toMatchObject({ width: "half", settings: { show: "both", count: 5 } });
    const widget: WidgetInstance<"scheduled"> = {
      id: "sw",
      type: "scheduled",
      width: "half",
      title: null,
      settings: { show: "queue", count: 10 },
    };
    const prefs = layoutToPreferences([widget]);
    expect(prefs.widgets).toEqual([
      { id: "sw", type: "scheduled", width: "half", scheduled: { show: "queue", count: 10 } },
    ]);
    expect(dashboardLayout({ dashboard: prefs })).toEqual([widget]);
  });
});
