import { account, bucket, bucketFigures } from "@/test/fixtures";

import {
  accountHealth,
  dashboardSettings,
  mostUsed,
  needsAttention,
  shownBucketStatus,
  toPreferences,
  usedPct,
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

describe("dashboardSettings", () => {
  it("uses the defaults", () => {
    expect(dashboardSettings({})).toEqual({
      bucketStatus: { mode: "attention", bucketId: null },
      recentCount: 5,
    });
  });

  it("reads what's saved, and saves it back", () => {
    const dashboard = {
      bucket_status: { mode: "bucket" as const, bucket_id: "1000000001" },
      recent_transactions: { count: 10 },
    };
    const settings = dashboardSettings({ dashboard });
    expect(settings).toEqual({
      bucketStatus: { mode: "bucket", bucketId: "1000000001" },
      recentCount: 10,
    });
    expect(toPreferences(settings)).toEqual(dashboard);
    expect(
      toPreferences({ ...settings, bucketStatus: { mode: "all", bucketId: "1000000001" } }),
    ).toEqual({ bucket_status: { mode: "all" }, recent_transactions: { count: 10 } });
  });
});

describe("shownBucketStatus", () => {
  const settings = dashboardSettings({
    dashboard: { bucket_status: { mode: "bucket", bucket_id: "2" } },
  });

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
