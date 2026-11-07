import { account, bucket, bucketFigures } from "@/test/fixtures";

import {
  accountHealth,
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
      { id: "cycle", type: "cycle", width: "half", settings: { showNext: true } },
      { id: "health", type: "health", width: "half", settings: null },
      {
        id: "bucket_status",
        type: "bucket_status",
        width: "half",
        settings: { mode: "attention", bucketId: null },
      },
      {
        id: "accounts",
        type: "accounts",
        width: "half",
        settings: { mode: "all", accountId: null },
      },
      {
        id: "recent_transactions",
        type: "recent_transactions",
        width: "full",
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
      { mode: "bucket", bucketId: "1000000001" },
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
    ).toEqual([{ id: "x", type: "cycle", width: "half", settings: { showNext: true } }]);
    expect(dashboardLayout({ dashboard: { widgets: [] } })).toEqual([]);
  });

  it("only saves the chosen bucket or account in those modes", () => {
    const layout: Layout = [
      { id: "a", type: "accounts", width: "half", settings: { mode: "all", accountId: "1234" } },
      {
        id: "b",
        type: "bucket_status",
        width: "half",
        settings: { mode: "all", bucketId: "2" },
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
    const wide: WidgetInstance = { id: "health", type: "health", width: "full", settings: null };
    expect(replaceWidget(layout, wide)[1]).toEqual(wide);
    const added = newWidget("bucket_status", layout);
    expect(added).toMatchObject({
      type: "bucket_status",
      width: "half",
      settings: { mode: "attention", bucketId: null },
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
      settings: { mode: "bucket", bucketId },
    });
    expect(settingsComplete(one(null), [main], [fine])).toBe(false);
    expect(settingsComplete(one("9"), [main], [fine])).toBe(false);
    expect(settingsComplete(one(fine.id), [main], [fine])).toBe(true);
    const account: WidgetInstance = {
      id: "a",
      type: "accounts",
      width: "half",
      settings: { mode: "account", accountId: main.id },
    };
    expect(settingsComplete(account, [main], [])).toBe(true);
    expect(settingsComplete(account, [], [])).toBe(false);
    expect(settingsComplete(layout[0] ?? account, [], [])).toBe(true);
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
  const settings = { mode: "bucket" as const, bucketId: "2" };

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
