import i18n from "@/i18n";

import { parsePeriod } from "./periods";
import { periodsOf, type ReportSettings } from "./reports";
import {
  fromReportModule,
  graphAsSaved,
  newSavedModuleId,
  readSavedModules,
  sameSavedModule,
  savedGraph,
  savedModuleLink,
  savedModuleOptions,
  toReportModule,
  type SavedModule,
} from "./savedModules";

const graph = { kind: "bar", metric: "spending", resolution: "day" } as const;
const transactions = (over: Partial<SavedModule> = {}): SavedModule => ({
  id: "g-2",
  name: "List",
  period: "last-3-months",
  module: { id: "m-1", type: "transactions", transactions: { view: "table" } },
  ...over,
});
const pay: SavedModule = {
  id: "g-1",
  name: "Pay",
  period: "previous-month",
  compare_to: "last_year",
  module: { id: "m-1", type: "graph", compare: "both", breakdown: "none", graph },
};

describe("saved modules (#201)", () => {
  it("reads them from the preferences, without sections or those missing settings", () => {
    expect(
      readSavedModules([
        {
          id: "g-1",
          name: "A",
          period: "current-month",
          module: { id: "m-1", type: "graph", graph },
        },
        {
          id: "g-2",
          name: "B",
          period: "current-month",
          module: { id: "m-1", type: "section", section: { unit: "month", modules: [] } },
        },
        { id: "g-3", name: "C", period: "current-month", module: { id: "m-1", type: "flows" } },
      ]).map((s) => s.id),
    ).toEqual(["g-1"]);
    expect(readSavedModules(null)).toEqual([]);
  });

  it("saves a report's module with the report's period, compare-to and filters", () => {
    const report: ReportSettings = {
      period: "quarter-2026-q3",
      compare_to: "last_year",
      account_ids: ["1234"],
      bucket_ids: ["1000000001"],
      tags: ["food"],
      counterparty: "Rema",
      modules: [],
    };
    expect(
      fromReportModule(report, { id: "m-4", type: "graph", title: "Food", graph }, "g-3", " Food "),
    ).toEqual({
      id: "g-3",
      name: "Food",
      period: "quarter-2026-q3",
      compare_to: "last_year",
      module: {
        id: "m-1",
        type: "graph",
        title: "Food",
        graph: {
          ...graph,
          account_ids: ["1234"],
          bucket_ids: ["1000000001"],
          tags: ["food"],
          counterparty: "Rema",
        },
      },
    });
    // Its own filters win; in/out/balance and budget take only accounts and buckets.
    expect(
      fromReportModule(
        report,
        { id: "m-5", type: "transactions", transactions: { bucket_ids: ["1000000002"] } },
        "g-4",
        "List",
      ).module,
    ).toEqual({
      id: "m-1",
      type: "transactions",
      transactions: {
        account_ids: ["1234"],
        bucket_ids: ["1000000002"],
        tags: ["food"],
        counterparty: "Rema",
      },
    });
    expect(
      fromReportModule(
        { ...report, compare_to: "previous" },
        { id: "m-6", type: "flows", flows: {} },
        "g-5",
        "F",
      ),
    ).toEqual({
      id: "g-5",
      name: "F",
      period: "quarter-2026-q3",
      module: {
        id: "m-1",
        type: "flows",
        flows: { account_ids: ["1234"], bucket_ids: ["1000000001"] },
      },
    });
    expect(
      fromReportModule(report, { id: "m-7", type: "budget", budget: {} }, "g-6", "B").module,
    ).toEqual({
      id: "m-1",
      type: "budget",
      budget: { account_ids: ["1234"], bucket_ids: ["1000000001"] },
    });
  });

  it("copies one into a report with an id it doesn't have, named as saved", () => {
    const report: ReportSettings = {
      period: "previous-year",
      modules: [
        { id: "m-1", type: "budget", budget: {} },
        {
          id: "m-2",
          type: "section",
          section: { unit: "month", modules: [{ id: "m-3", type: "flows", flows: {} }] },
        },
      ],
    };
    expect(toReportModule(transactions(), report)).toEqual({
      id: "m-4",
      type: "transactions",
      title: "List",
      transactions: { view: "table" },
    });
    expect(toReportModule(pay, report)).toMatchObject({ id: "m-4", title: "Pay", compare: "both" });
  });

  it("keeps a graph module's comparison when Stats saves its graph again", () => {
    const next = graphAsSaved({ ...graph, kind: "line", period: "last-30-days" }, pay);
    expect(next).toEqual({
      id: "g-1",
      name: "Pay",
      period: "last-30-days",
      compare_to: "last_year",
      module: { id: "m-1", type: "graph", compare: "both", graph: { ...graph, kind: "line" } },
    });
    expect(sameSavedModule(graphAsSaved(savedGraph(pay as never), pay), pay)).toBe(true);
    expect(sameSavedModule(next, pay)).toBe(false);
    expect(graphAsSaved({ ...graph, period: "current-week" }, null)).toEqual({
      id: "",
      name: "",
      period: "current-week",
      module: { id: "m-1", type: "graph", graph },
    });
  });

  it("links to Stats with it picked, and continues g-N ids", () => {
    expect(savedModuleLink(pay)).toBe(
      "/stats?kind=bar&metric=spending&period=previous-month&res=day&saved=g-1",
    );
    expect(savedModuleLink(transactions())).toBe("/stats?saved=g-2");
    expect(newSavedModuleId([])).toBe("g-1");
    expect(newSavedModuleId([pay, transactions({ id: "g-3" })])).toBe("g-4");
  });

  it("lists them grouped by type, in the user's order", () => {
    const t = i18n.getFixedT("en");
    expect(
      savedModuleOptions([transactions(), pay, transactions({ id: "g-3", name: "More" })], t),
    ).toEqual([
      { group: "Graph", items: [{ value: "g-1", label: "Pay" }] },
      {
        group: "Transactions",
        items: [
          { value: "g-2", label: "List" },
          { value: "g-3", label: "More" },
        ],
      },
    ]);
  });
});

describe("periodsOf (#201)", () => {
  const of = (period: string) => {
    const choice = parsePeriod(period);
    if (!choice) throw new Error(period);
    return periodsOf(choice, "previous", []);
  };

  it("compares the last N with the N before (#204), but not custom dates", () => {
    for (const p of ["last-30-days", "last-3-months"]) {
      const r = of(p);
      expect(r.period).not.toBeNull();
      expect(Date.parse(r.compare?.period.toAt ?? "")).toBeLessThanOrEqual(
        Date.parse(r.period?.fromAt ?? ""),
      );
    }
    expect(of("custom-2026-01-01-2026-03-31").compare).toBeNull();
  });

  it("compares this week with the one before", () => {
    const r = of("current-week");
    expect(r.compare).not.toBeNull();
    expect(Date.parse(r.compare?.period.toAt ?? "")).toBeLessThanOrEqual(
      Date.parse(r.period?.fromAt ?? ""),
    );
  });
});
