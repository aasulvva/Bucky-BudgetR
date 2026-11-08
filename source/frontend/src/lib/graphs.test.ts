import type { StatsSeries } from "@/api/stats";
import { account, bucket } from "@/test/fixtures";

import { endAtFor, formatDateRange, startAtFor } from "./cycles";
import {
  cleanGraph,
  defaultGraph,
  fitResolution,
  graphData,
  graphFromSearch,
  graphSummary,
  graphToSearch,
  intervalLabel,
  intervalLink,
  newGraphId,
  sameGraph,
  shownCurrency,
  showDots,
  statsQuery,
  yDomain,
  type GraphSettings,
} from "./graphs";
import { resolvePeriod, type Period } from "./periods";

// Wednesday 11 November 2026, in the afternoon (local time).
const now = new Date(2026, 10, 11, 15, 30);

const base: GraphSettings = {
  kind: "bar",
  metric: "spending",
  period: "current-month",
  resolution: "day",
};

function period(choice: Parameters<typeof resolvePeriod>[0]): Period {
  const p = resolvePeriod(choice, [], now);
  if (!p) throw new Error("no period");
  return p;
}

/** Days from 1 November, at local midnight. */
function days(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    start: startAtFor(`2026-11-${String(i + 1).padStart(2, "0")}`),
    end: endAtFor(`2026-11-${String(i + 1).padStart(2, "0")}`),
  }));
}

const main = account({ id: "1234", name: "Main" });
const savings = account({ id: "2345", name: "Savings" });
const euro = account({ id: "3456", name: "Euro", currency: "EUR" });

describe("URL settings", () => {
  it("round-trip, leaving out defaults and what doesn't apply", () => {
    const s: GraphSettings = {
      kind: "line",
      metric: "spending",
      period: "last-30-days",
      resolution: "week",
      group_by: "bucket",
      account_ids: ["1234"],
      bucket_ids: ["b1", "b2"],
      tags: ["food", "Mat og drikke"],
      counterparty: "Rema",
      cumulative: true,
      side_by_side: true,
      top: 3,
    };
    const search = graphToSearch(s);
    expect(search.toString()).toBe(
      "kind=line&metric=spending&period=last-30-days&res=week&group=bucket&account=1234&bucket=b1&bucket=b2&tag=food&tag=Mat+og+drikke&q=Rema&cum=1&top=3",
    );
    // side_by_side is for bars only.
    expect(graphFromSearch(search, base)).toEqual(cleanGraph(s));
    expect(cleanGraph(s).side_by_side).toBeUndefined();
    expect(graphToSearch(base).toString()).toBe(
      "kind=bar&metric=spending&period=current-month&res=day",
    );
  });

  it("fall back to the default per field", () => {
    const s = graphFromSearch(
      new URLSearchParams(
        "kind=pie&metric=spending&period=next-year&res=decade&group=tag&top=99&account=12+34",
      ),
      base,
    );
    expect(s).toEqual(base);
    expect(graphFromSearch(new URLSearchParams(), base)).toEqual(base);
  });

  it("drop the filters a balance ignores, and per bucket becomes per account", () => {
    const s = cleanGraph({
      ...base,
      kind: "line",
      metric: "balance",
      group_by: "bucket",
      bucket_ids: ["b1"],
      tags: ["x"],
      counterparty: "y",
      cumulative: true,
    });
    expect(s).toEqual({ ...base, kind: "line", metric: "balance", group_by: "account" });
  });

  it("keep stepped for lines and a fitted axis for any graph", () => {
    const s: GraphSettings = { ...base, kind: "line", stepped: true, fit_y_axis: true };
    expect(graphToSearch(s).toString()).toBe(
      "kind=line&metric=spending&period=current-month&res=day&step=1&fit=1",
    );
    expect(graphFromSearch(graphToSearch(s), base)).toEqual(s);
    expect(cleanGraph({ ...s, kind: "bar" })).toEqual({ ...base, fit_y_axis: true });
  });

  it("compare graphs by their clean form", () => {
    expect(sameGraph(base, { ...base, top: 5, tags: [], counterparty: " " })).toBe(true);
    expect(sameGraph(base, { ...base, top: 4 })).toBe(false);
  });

  it("start with spending this cycle, or this month, as bars", () => {
    expect(defaultGraph([], now)).toEqual({ ...base, period: "current-month", resolution: "day" });
    const active = {
      start_at: startAtFor("2026-11-01"),
      end_at: endAtFor("2026-11-30"),
      state: "active",
    };
    expect(defaultGraph([active], now).period).toBe("current-cycle");
  });

  it("summarise in one line", () => {
    expect(graphSummary({ ...base, group_by: "bucket" })).toBe(
      "Spending · This month · Day · Per bucket",
    );
    expect(graphSummary({ ...base, period: "last-30-days" })).toBe("Spending · Last 30 days · Day");
  });

  it("give new ids that aren't taken", () => {
    expect(newGraphId([])).toBe("g-1");
    expect(newGraphId([{ id: "g-2", name: "A", graph: base }])).toBe("g-3");
    expect(
      newGraphId([
        { id: "g-3", name: "A", graph: base },
        { id: "g-1", name: "B", graph: base },
      ]),
    ).toBe("g-4");
  });
});

describe("statsQuery", () => {
  const month = period({ kind: "current", unit: "month" });

  it("asks for the period at the drawn resolution, with the filters", () => {
    expect(
      statsQuery(
        { ...base, group_by: "bucket", bucket_ids: ["b1"], tags: ["food"], counterparty: "Rema" },
        month,
        "week",
      ),
    ).toEqual({
      metric: "spending",
      from: month.fromAt,
      to: month.toAt,
      resolution: "week",
      group_by: "bucket",
      bucket_id: ["b1"],
      tag: ["food"],
      counterparty: "Rema",
    });
  });

  it("counts one account's transfers, but not several accounts'", () => {
    expect(statsQuery({ ...base, account_ids: ["1234"] }, month, "day")).toMatchObject({
      account_id: ["1234"],
      transfers: true,
    });
    expect(
      statsQuery({ ...base, account_ids: ["1234", "2345"] }, month, "day").transfers,
    ).toBeUndefined();
    expect(
      statsQuery({ ...base, metric: "balance", account_ids: ["1234"] }, month, "day").transfers,
    ).toBeUndefined();
  });

  it("leaves out what a balance can't filter on", () => {
    const q = statsQuery(
      { ...base, metric: "balance", group_by: "bucket", bucket_ids: ["b1"], tags: ["x"] },
      month,
      "day",
    );
    expect(q).toEqual({
      metric: "balance",
      from: month.fromAt,
      to: month.toAt,
      resolution: "day",
      group_by: "account",
    });
  });
});

describe("shownCurrency", () => {
  it("is the app's currency for all accounts, noting the others", () => {
    expect(shownCurrency(base, [main, savings, euro])).toEqual({ currency: "NOK", leftOut: 1 });
  });

  it("is the chosen accounts' currency when they share one", () => {
    expect(shownCurrency({ ...base, account_ids: ["3456"] }, [main, euro])).toEqual({
      currency: "EUR",
      leftOut: 0,
    });
    expect(shownCurrency({ ...base, account_ids: ["1234", "3456"] }, [main, euro])).toEqual({
      currency: "NOK",
      leftOut: 1,
    });
  });
});

describe("graphData", () => {
  const intervals = days(3);
  const food = bucket({ id: "b1", name: "Food", source_account_id: "1234" });
  const fun = bucket({ id: "b2", name: "Fun", source_account_id: "1234" });
  const food2 = bucket({ id: "b3", name: "Food", source_account_id: "2345" });
  const buckets = [food, fun, food2];

  it("names the series and keeps the shown currency only", () => {
    const result: StatsSeries = {
      intervals,
      series: [
        { currency: "EUR", values: ["1.00", "2.00", "3.00"] },
        { currency: "NOK", values: ["10.00", "0.00", "5.50"] },
      ],
    };
    const data = graphData(result, base, "day", "NOK", [main], buckets, "en-GB");
    expect(data.series).toEqual([
      {
        name: "total",
        label: "Total",
        color: "var(--graph-1)",
        amounts: ["10.00", "0.00", "5.50"],
      },
    ]);
    expect(data.rows.map((r) => r.total)).toEqual([10, 0, 5.5]);
    expect(data.rows[0]).toMatchObject({ index: 0, label: "1 Nov" });
    expect(data.other).toBe(0);
  });

  it("tells buckets with the same name apart, and puts No bucket last", () => {
    const result: StatsSeries = {
      intervals,
      series: [
        { account_id: "1234", bucket_id: "b1", currency: "NOK", values: ["1.00", "0.00", "0.00"] },
        { account_id: "1234", bucket_id: "b2", currency: "NOK", values: ["2.00", "0.00", "0.00"] },
        { account_id: "2345", bucket_id: "b3", currency: "NOK", values: ["3.00", "0.00", "0.00"] },
        { account_id: "1234", bucket_id: null, currency: "NOK", values: ["9.00", "0.00", "0.00"] },
      ],
    };
    const data = graphData(
      result,
      { ...base, group_by: "bucket" },
      "day",
      "NOK",
      [main, savings],
      buckets,
    );
    expect(data.series.map((x) => [x.name, x.label, x.color])).toEqual([
      ["b-b1", "Food (Main)", "var(--graph-1)"],
      ["b-b3", "Food (Savings)", "var(--graph-2)"],
      ["b-b2", "Fun", "var(--graph-3)"],
      ["none", "No bucket", "var(--graph-4)"],
    ]);
  });

  it("keeps the largest series and adds up the rest as Other", () => {
    const result: StatsSeries = {
      intervals,
      series: ["1", "2", "3", "4"].map((n) => ({
        account_id: `${n}000`,
        currency: "NOK",
        values: [`${n}.00`, "-1.00", "0.00"],
      })),
    };
    const accounts = ["1", "2", "3", "4"].map((n) =>
      account({ id: `${n}000`, name: `Account ${n}` }),
    );
    const data = graphData(
      result,
      { ...base, group_by: "account", top: 2 },
      "day",
      "NOK",
      accounts,
      [],
    );
    expect(data.series.map((x) => x.label)).toEqual(["Account 3", "Account 4", "Other"]);
    expect(data.series[2]).toEqual({
      name: "other",
      label: "Other",
      color: "var(--graph-other)",
      amounts: ["3.00", "-2.00", "0.00"],
    });
    expect(data.other).toBe(2);
  });

  it("ranks balances by their latest value", () => {
    const result: StatsSeries = {
      intervals,
      series: [
        { account_id: "1234", currency: "NOK", values: ["900.00", "900.00", "10.00"] },
        { account_id: "2345", currency: "NOK", values: ["0.00", "0.00", "-50.00"] },
      ],
    };
    const data = graphData(
      result,
      { ...base, kind: "line", metric: "balance", group_by: "account", top: 1 },
      "day",
      "NOK",
      [main, savings],
      [],
    );
    expect(data.series.map((x) => x.label)).toEqual(["Savings", "Other"]);
  });

  it("adds up running totals for a cumulative line", () => {
    const result: StatsSeries = {
      intervals,
      series: [{ currency: "NOK", values: ["10.00", "2.50", "-1.00"] }],
    };
    const data = graphData(
      result,
      { ...base, kind: "line", cumulative: true },
      "day",
      "NOK",
      [],
      [],
    );
    expect(data.series[0]?.amounts).toEqual(["10.00", "12.50", "11.50"]);
    expect(data.rows.map((r) => r.total)).toEqual([10, 12.5, 11.5]);
  });
});

describe("intervalLabel", () => {
  const [day] = days(1);
  if (!day) throw new Error("no day");

  it("labels days, months and weeks in the locale", () => {
    expect(intervalLabel(day, "day", [day], "en-GB")).toEqual({
      label: "1 Nov",
      title: "Sun, 1 Nov 2026",
    });
    expect(intervalLabel(day, "day", [day], "nb-NO").label).toBe("1. nov.");
    const month = { start: startAtFor("2026-11-01"), end: endAtFor("2026-11-30") };
    expect(intervalLabel(month, "month", [month], "en-GB")).toEqual({
      label: "Nov",
      title: "November 2026",
    });
    const january = { start: startAtFor("2027-01-01"), end: endAtFor("2027-01-31") };
    expect(intervalLabel(january, "month", [month, january], "en-GB").label).toBe("Jan 27");
    const week = { start: startAtFor("2026-11-02"), end: endAtFor("2026-11-08") };
    expect(intervalLabel(week, "week", [week], "en-GB")).toEqual({
      label: "2 Nov",
      title: formatDateRange("2026-11-02", "2026-11-08", "en-GB"),
    });
  });
});

describe("yDomain", () => {
  const rows = (values: number[][]) => ({
    rows: values.map((v, index) => ({ label: "", title: "", index, a: v[0] ?? 0, b: v[1] ?? 0 })),
    series: [
      { name: "a", label: "A", color: "", amounts: [] },
      { name: "b", label: "B", color: "", amounts: [] },
    ],
    other: 0,
  });

  it("includes 0 unless fitted", () => {
    expect(yDomain(rows([[30000, 50000]]), { ...base, kind: "line" })).toBeUndefined();
  });

  it("pads the values' range and rounds it out", () => {
    const line = { ...base, kind: "line" as const, fit_y_axis: true };
    expect(
      yDomain(
        rows([
          [30000, 40000],
          [50000, 45000],
        ]),
        line,
      ),
    ).toEqual([25000, 55000]);
    expect(yDomain(rows([[-120, 80]]), line)).toEqual([-150, 100]);
    // A flat line still gets a range.
    expect(yDomain(rows([[500, 500]]), line)).toEqual([400, 600]);
  });

  it("fits stacked bars by their totals", () => {
    const bars = { ...base, fit_y_axis: true };
    expect(
      yDomain(
        rows([
          [30000, 20000],
          [40000, 15000],
        ]),
        bars,
      ),
    ).toEqual([48000, 56000]);
    expect(
      yDomain(
        rows([
          [30000, 20000],
          [40000, 15000],
        ]),
        { ...bars, side_by_side: true },
      ),
    ).toEqual([10000, 50000]);
  });
});

describe("fitting the width", () => {
  const year = period({ kind: "last", unit: "days", count: 366 });

  it("keeps the resolution while it fits, and goes coarser when it doesn't", () => {
    expect(fitResolution(year, "day", "line", 1200, [])).toEqual({
      resolution: "day",
      coarsened: false,
    });
    // 366 days × 2 px don't fit in 300 px; 53 weeks do.
    expect(fitResolution(year, "day", "line", 300, [])).toEqual({
      resolution: "week",
      coarsened: true,
    });
    // Bars need more room: 53 weeks × 6 px don't fit in 300 px.
    expect(fitResolution(year, "week", "bar", 300, [])).toEqual({
      resolution: "month",
      coarsened: true,
    });
    // Not measured yet.
    expect(fitResolution(year, "day", "line", 0, [])).toEqual({
      resolution: "day",
      coarsened: false,
    });
  });

  it("draws dots while there's room for them", () => {
    expect(showDots(30, 600)).toBe(true);
    expect(showDots(366, 600)).toBe(false);
    expect(showDots(0, 600)).toBe(false);
  });
});

describe("intervalLink", () => {
  const [day] = days(1);
  if (!day) throw new Error("no day");

  it("opens the interval's transactions, with the series and filters", () => {
    expect(
      intervalLink(
        { ...base, group_by: "bucket", tags: ["food"], counterparty: "Rema" },
        "b-b1",
        day,
      ),
    ).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=EXP&bucket_id=b1&tag=food&q=Rema",
    );
    expect(intervalLink({ ...base, metric: "income", account_ids: ["1234"] }, "total", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=INC&account_id=1234",
    );
    expect(intervalLink({ ...base, metric: "balance", group_by: "account" }, "a-2345", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&account_id=2345",
    );
    // Several tags can't be one filter.
    expect(intervalLink({ ...base, tags: ["a", "b"] }, "other", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=EXP",
    );
  });
});
