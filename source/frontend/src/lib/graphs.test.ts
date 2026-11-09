import type { StatsSeries } from "@/api/stats";
import { account, bucket } from "@/test/fixtures";

import { endAtFor, formatDateRange, startAtFor } from "./cycles";
import {
  cleanGraph,
  compareGraphData,
  defaultGraph,
  fitResolution,
  graphData,
  graphFromSearch,
  graphSummary,
  graphToSearch,
  groupBy,
  intervalLabel,
  intervalLink,
  newGraphId,
  periodLabel,
  pieData,
  pieSlicing,
  queryResolution,
  seriesColor,
  sameGraph,
  shownCurrency,
  showDots,
  statsLink,
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
        "kind=donut&metric=spending&period=next-year&res=decade&group=tag&top=99&account=12+34",
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

  it("name specific periods", () => {
    const at = (unit: "day" | "month" | "half_year" | "year" | "cycle", value: string) =>
      periodLabel({ kind: "specific", unit, at: value }, [], "en-GB");
    expect(at("day", "2026-11-08")).toBe("Sun, 8 Nov 2026");
    expect(at("month", "2026-11-01")).toBe("November 2026");
    expect(at("half_year", "2026-07-01")).toBe("H2 2026");
    expect(at("year", "2026-01-01")).toBe("2026");
    expect(at("cycle", "100001000001")).toBe("A deleted cycle");
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
      coarsened: null,
    });
    // 366 days × 2 px don't fit in 300 px; 53 weeks do.
    expect(fitResolution(year, "day", "line", 300, [])).toEqual({
      resolution: "week",
      coarsened: "width",
    });
    // Bars need more room: 53 weeks × 6 px don't fit in 300 px.
    expect(fitResolution(year, "week", "bar", 300, [])).toEqual({
      resolution: "month",
      coarsened: "width",
    });
    // Not measured yet.
    expect(fitResolution(year, "day", "line", 0, [])).toEqual({
      resolution: "day",
      coarsened: null,
    });
  });

  it("goes coarser when there are more intervals than the graph draws, measured or not", () => {
    // 8 784 hours are more than 1 000 points.
    expect(fitResolution(year, "hour", "line", 0, [])).toEqual({
      resolution: "day",
      coarsened: "count",
    });
    // 366 days are more than 60 bars, however wide.
    expect(fitResolution(year, "day", "bar", 5000, [])).toEqual({
      resolution: "week",
      coarsened: "count",
    });
    // Too many first, then too narrow: the first reason counts.
    expect(fitResolution(year, "hour", "line", 300, [])).toEqual({
      resolution: "week",
      coarsened: "count",
    });
  });

  it("draws dots while there's room for them", () => {
    expect(showDots(30, 600)).toBe(true);
    expect(showDots(366, 600)).toBe(false);
    expect(showDots(0, 600)).toBe(false);
  });
});

describe("per counterparty (#170)", () => {
  const intervals = days(1);
  const result: StatsSeries = {
    intervals,
    series: [
      { counterparty: "Rema 1000", currency: "NOK", values: ["300.00"] },
      { counterparty: "Coop Extra A.S.", currency: "NOK", values: ["50.00"] },
      { counterparty: null, currency: "NOK", values: ["7.00"] },
      { transfers: true, currency: "NOK", values: ["900.00"] },
    ],
  };
  const settings: GraphSettings = { ...base, group_by: "counterparty" };
  const [day] = intervals;
  if (!day) throw new Error("no day");

  it("names the series by counterparty, safe as chart keys, with the rest last", () => {
    const data = graphData(result, settings, "day", "NOK", [main], [], "en-GB");
    expect(data.series.map((x) => [x.name, x.label])).toEqual([
      ["c-Coop%20Extra%20A%2ES%2E", "Coop Extra A.S."],
      ["c-Rema%201000", "Rema 1000"],
      ["nc", "No counterparty"],
      ["trf", "Transfers"],
    ]);
    expect(data.series.every((x) => !x.name.includes("."))).toBe(true);
    expect(data.rows[0]?.["c-Rema%201000"]).toBe(300);
  });

  it("opens exactly that counterparty's transactions, or the transfers", () => {
    expect(intervalLink(settings, "c-Coop%20Extra%20A%2ES%2E", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=EXP&counterparty=Coop+Extra+A.S.",
    );
    expect(intervalLink(settings, "trf", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=TRF",
    );
    expect(intervalLink(settings, "nc", day)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-01&type=EXP",
    );
  });

  it("is kept in the URL for spending and income, but a balance is overall", () => {
    expect(graphFromSearch(graphToSearch(cleanGraph(settings)), base)).toEqual(
      cleanGraph(settings),
    );
    expect(groupBy({ ...settings, metric: "income" })).toBe("counterparty");
    expect(groupBy({ ...settings, metric: "balance" })).toBe("none");
    expect(groupBy({ ...settings, metric: "balance", kind: "pie" })).toBe("account");
    expect(pieSlicing({ ...settings, kind: "pie" })).toBe("counterparty");
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

describe("pies", () => {
  const pie: GraphSettings = { ...base, kind: "pie", group_by: "bucket" };
  const whole = [{ start: startAtFor("2026-11-01"), end: startAtFor("2026-12-01") }];
  const food = bucket({ id: "b1", name: "Food", source_account_id: "1234" });
  const fun = bucket({ id: "b2", name: "Fun", source_account_id: "1234" });
  const rent = bucket({ id: "b3", name: "Rent", source_account_id: "1234" });
  const refund = bucket({ id: "b4", name: "Refunds", source_account_id: "1234" });
  const buckets = [food, fun, rent, refund];
  const line = (bucket_id: string | null, value: string) => ({
    account_id: "1234",
    bucket_id,
    currency: "NOK",
    values: [value],
  });

  it("keep their labels setting in the URL, and drop what only bars and lines have", () => {
    const s = cleanGraph({ ...pie, pie_labels: "both", fit_y_axis: true, stepped: true });
    expect(s).toEqual({ ...pie, pie_labels: "both" });
    expect(graphToSearch(s).toString()).toBe(
      "kind=pie&metric=spending&period=current-month&res=day&group=bucket&labels=both",
    );
    expect(graphFromSearch(graphToSearch(s), base)).toEqual(s);
    // A list is the default, and bars have no labels setting.
    expect(cleanGraph({ ...pie, pie_labels: "list" }).pie_labels).toBeUndefined();
    expect(cleanGraph({ ...base, pie_labels: "both" }).pie_labels).toBeUndefined();
    expect(graphFromSearch(new URLSearchParams("kind=pie&labels=inside"), base).pie_labels).toBe(
      undefined,
    );
  });

  it("never give two slices the same name, even for lines that don't fit (#167)", () => {
    // Bucket lines (no account) read as a balance pie, which is per account.
    const result: StatsSeries = {
      intervals: whole,
      series: ["b1", "b2", "b3", "b4"].map((id) => ({
        bucket_id: id,
        currency: "NOK",
        values: ["100.00"],
      })),
    };
    const balance: GraphSettings = { ...pie, metric: "balance" };
    const names = pieData(result, balance, "total", "NOK", [main], buckets).slices.map(
      (x) => x.name,
    );
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    const series = graphData(
      result,
      { ...balance, kind: "bar" },
      "total",
      "NOK",
      [main],
      buckets,
    ).series;
    expect(new Set(series.map((x) => x.name)).size).toBe(4);
  });

  it("slice per bucket or account over the whole period, or per interval when not split", () => {
    expect(pieSlicing(pie)).toBe("bucket");
    expect(pieSlicing({ ...pie, group_by: "account" })).toBe("account");
    expect(pieSlicing({ ...pie, group_by: "none" })).toBe("interval");
    // A balance pie is always per account.
    expect(pieSlicing({ ...pie, metric: "balance", group_by: "none" })).toBe("account");
    expect(cleanGraph({ ...pie, metric: "balance", group_by: "none" }).group_by).toBe("account");
    expect(queryResolution(pie, "day")).toBe("total");
    expect(queryResolution({ ...pie, group_by: "none" }, "month")).toBe("month");
    expect(queryResolution(base, "day")).toBe("day");
  });

  it("summarise in one line", () => {
    expect(graphSummary({ ...pie, period: "current-year", resolution: "month" })).toBe(
      "Spending · This year · Per bucket",
    );
    expect(
      graphSummary({ ...pie, group_by: "none", period: "current-year", resolution: "month" }),
    ).toBe("Spending · This year · Month");
  });

  it("have a slice per bucket with its share: the largest, in name order, and the rest as Other", () => {
    const result: StatsSeries = {
      intervals: whole,
      series: [
        line("b1", "300.00"),
        line("b2", "100.00"),
        line("b3", "500.00"),
        line(null, "100.00"),
        { ...line("b1", "50.00"), currency: "EUR" },
      ],
    };
    const data = pieData(result, { ...pie, top: 3 }, "total", "NOK", [main], buckets);
    expect(data.slices.map((x) => [x.name, x.label, x.color, x.amount, x.share])).toEqual([
      // The largest three (No bucket ties with Fun and comes after it), in name order.
      ["b-b1", "Food", "var(--graph-1)", "300.00", 0.3],
      ["b-b2", "Fun", "var(--graph-2)", "100.00", 0.1],
      ["b-b3", "Rent", "var(--graph-3)", "500.00", 0.5],
      ["other", "Other", "var(--graph-other)", "100.00", 0.1],
    ]);
    expect(data.total).toBe("1000.00");
    expect(data.other).toBe(1);
    expect(data.belowZero).toBe(0);
    expect(data.slices.every((x) => x.index === 0)).toBe(true);
  });

  it("give expenses on no bucket a slice, and leave out what's at or below 0", () => {
    const result: StatsSeries = {
      intervals: whole,
      series: [
        line("b1", "300.00"),
        line("b2", "0.00"),
        line("b4", "-40.00"),
        line(null, "100.00"),
      ],
    };
    const data = pieData(result, pie, "total", "NOK", [main], buckets);
    expect(data.slices.map((x) => [x.name, x.label])).toEqual([
      ["b-b1", "Food"],
      ["none", "No bucket"],
    ]);
    expect(data.belowZero).toBe(1);
    expect(data.slices.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1);
  });

  it("show balances at the period's end, per account, without the negative ones", () => {
    const card = account({ id: "4567", name: "Card" });
    const result: StatsSeries = {
      intervals: whole,
      series: [
        { account_id: "1234", currency: "NOK", values: ["750.00"] },
        { account_id: "2345", currency: "NOK", values: ["250.00"] },
        { account_id: "4567", currency: "NOK", values: ["-500.00"] },
      ],
    };
    const s: GraphSettings = { ...pie, metric: "balance", group_by: "none" };
    const data = pieData(result, s, "total", "NOK", [main, savings, card], []);
    expect(data.slices.map((x) => [x.name, x.label, x.share])).toEqual([
      ["a-1234", "Main", 0.75],
      ["a-2345", "Savings", 0.25],
    ]);
    expect(data.belowZero).toBe(1);
  });

  it("have a slice per interval in time order, up to 12 colours", () => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      start: startAtFor(`2026-${String(i + 1).padStart(2, "0")}-01`),
      end: startAtFor(i === 11 ? "2027-01-01" : `2026-${String(i + 2).padStart(2, "0")}-01`),
    }));
    const values = months.map((_, i) => (i === 3 ? "0.00" : i === 5 ? "-10.00" : "100.00"));
    const result: StatsSeries = { intervals: months, series: [{ currency: "NOK", values }] };
    const s: GraphSettings = {
      ...pie,
      group_by: "none",
      period: "current-year",
      resolution: "month",
    };
    const data = pieData(result, s, "month", "NOK", [main], [], "en-GB");
    expect(data.slices).toHaveLength(10);
    expect(data.slices.slice(0, 4).map((x) => [x.name, x.label, x.color, x.index])).toEqual([
      ["i-0", "January 2026", "var(--graph-1)", 0],
      ["i-1", "February 2026", "var(--graph-2)", 1],
      ["i-2", "March 2026", "var(--graph-3)", 2],
      // April is 0 and June below 0: left out, and the colours run on.
      ["i-4", "May 2026", "var(--graph-4)", 4],
    ]);
    expect(data.slices.at(-1)?.color).toBe("var(--graph-10)");
    expect(data.belowZero).toBe(1);
    expect(data.total).toBe("1000.00");
  });

  it("don't put slot 7 next to slot 1 in a pie of 7 slices", () => {
    const week = days(7);
    const result: StatsSeries = {
      intervals: week,
      series: [{ currency: "NOK", values: week.map(() => "10.00") }],
    };
    const s: GraphSettings = { ...pie, group_by: "none", period: "current-week" };
    const colors = pieData(result, s, "day", "NOK", [main], []).slices.map((x) => x.color);
    expect(colors.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5].map((i) => seriesColor(i)));
    expect(colors[6]).toBe("var(--graph-10)");
    expect(seriesColor(11)).toBe("var(--graph-12)");
  });

  it("go coarser when there are more than 12 intervals", () => {
    const month = period({ kind: "last", unit: "days", count: 30 });
    expect(fitResolution(month, "day", "pie", 300, [])).toEqual({
      resolution: "week",
      coarsened: "count",
    });
    expect(fitResolution(month, "week", "pie", 100, [])).toEqual({
      resolution: "week",
      coarsened: null,
    });
  });
});

describe("statsLink", () => {
  it("opens a saved graph on Stats, picked", () => {
    expect(
      statsLink({ id: "g-3", name: "Pie", graph: { ...base, kind: "pie", group_by: "account" } }),
    ).toBe("/stats?kind=pie&metric=spending&period=current-month&res=day&group=account&saved=g-3");
  });
});

describe("compareGraphData", () => {
  const food = bucket({ id: "b1", name: "Food", source_account_id: "1234" });
  const fun = bucket({ id: "b2", name: "Fun", source_account_id: "1234" });
  const pets = bucket({ id: "b3", name: "Pets", source_account_id: "1234" });
  const buckets = [food, fun, pets];
  const october = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      start: startAtFor(`2026-10-${String(i + 1).padStart(2, "0")}`),
      end: endAtFor(`2026-10-${String(i + 1).padStart(2, "0")}`),
    }));
  const perBucket: GraphSettings = { ...base, group_by: "bucket", top: 1 };
  const now: StatsSeries = {
    intervals: days(2),
    series: [
      { currency: "NOK", bucket_id: "b1", values: ["10.00", "20.00"] },
      { currency: "NOK", bucket_id: "b2", values: ["1.00", "2.00"] },
    ],
  };
  // The previous period has a day more, and a bucket this one hasn't.
  const before: StatsSeries = {
    intervals: october(3),
    series: [
      { currency: "NOK", bucket_id: "b1", values: ["4.00", "5.00", "6.00"] },
      { currency: "NOK", bucket_id: "b3", values: ["7.00", "0.00", "0.00"] },
    ],
  };

  it("puts the previous period beside this one, by position", () => {
    const data = compareGraphData(
      now,
      { result: before, mode: "both" },
      perBucket,
      "day",
      "NOK",
      [main],
      buckets,
      "en-GB",
    );
    // The largest of this period keeps its colour; the rest is Other, the
    // previous period's Pets included.
    expect(data.series.map((x) => [x.name, x.amounts, x.previous ?? false])).toEqual([
      ["b-b1", ["10.00", "20.00", "0"], false],
      ["b-b1-prev", ["4.00", "5.00", "6.00"], true],
      ["other", ["1.00", "2.00", "0.00"], false],
      ["other-prev", ["7.00", "0.00", "0.00"], true],
    ]);
    expect(data.series[1]).toMatchObject({ label: "Food (previous)", color: "var(--graph-1)" });
    expect(data.rows).toHaveLength(3);
    expect(data.rows[0]).toMatchObject({ label: "1 Nov", "b-b1": 10, "b-b1-prev": 4 });
    expect(data.rows[0]?.title).toBe("Sun, 1 Nov 2026 vs Thu, 1 Oct 2026");
    // Past this period's end, the previous one's day names the row.
    expect(data.rows[2]).toMatchObject({ label: "3 Oct", "b-b1": 0, "b-b1-prev": 6 });
    expect(data.other).toBe(1);
  });

  it("or shows this period minus the previous one", () => {
    const data = compareGraphData(
      now,
      { result: before, mode: "difference" },
      { ...perBucket, kind: "line", cumulative: true },
      "day",
      "NOK",
      [main],
      buckets,
      "en-GB",
    );
    expect(data.series.map((x) => [x.name, x.amounts])).toEqual([
      // Running totals 10, 30, 30 against 4, 9, 15.
      ["b-b1", ["6.00", "21.00", "15.00"]],
      ["other", ["-6.00", "-4.00", "-4.00"]],
    ]);
  });
});
