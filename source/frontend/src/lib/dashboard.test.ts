import { account, bucket, bucketFigures } from "@/test/fixtures";

import {
  accountHealth,
  autoTitle,
  customTitle,
  dashboardLayout,
  defaultLayout,
  layoutToPreferences,
  mostUsed,
  moveWidget,
  moveWidgetTo,
  needsAttention,
  newWidget,
  removeWidget,
  replaceWidget,
  settingsComplete,
  shownAccounts,
  shownBucketStatus,
  usedPct,
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
        settings: { mode: "attention", bucketId: null, showMode: true },
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
        settings: { count: 5 },
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
      { mode: "bucket", bucketId: "1000000001", showMode: true },
      { mode: "account", accountId: "1234" },
      { count: 10 },
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
        settings: { mode: "all", bucketId: "2", showMode: true },
      },
    ];
    expect(layoutToPreferences(layout).widgets).toEqual([
      { id: "a", type: "accounts", width: "half", accounts: { mode: "all" } },
      { id: "b", type: "bucket_status", width: "half", bucket_status: { mode: "all" } },
    ]);
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
      settings: { mode: "attention", bucketId: null, showMode: true },
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
      settings: { mode: "bucket", bucketId, showMode: true },
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
    expect(settingsComplete(layout[0] ?? account, [], [])).toBe(true);
  });
});

describe("titles and the mode line", () => {
  const one: WidgetInstance = {
    id: "b",
    type: "bucket_status",
    width: "half",
    title: null,
    settings: { mode: "bucket", bucketId: short.id, showMode: false },
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

  it("shows them all when it's gone", () => {
    expect(shownAccounts(settings, [])).toEqual({ mode: "all" });
  });
});

describe("shownBucketStatus", () => {
  const settings = { mode: "bucket" as const, bucketId: "2", showMode: true };

  it("shows the chosen bucket", () => {
    expect(shownBucketStatus(settings, [fine, short])).toEqual({ mode: "bucket", bucket: short });
  });

  it("falls back to Needs attention when the bucket is gone", () => {
    expect(shownBucketStatus(settings, [fine])).toEqual({ mode: "attention" });
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
