import { endAtFor, startAtFor } from "./cycles";
import { parsePeriod, resolvePeriod } from "./periods";
import {
  cleanReport,
  moduleGraph,
  moduleTransactions,
  previousPeriod,
  readTemplates,
  sameReport,
  starter,
  subPeriods,
  transactionsLink,
  transactionsQuery,
  type ReportSettings,
} from "./reports";
import { SYSTEM_TYPES, USER_TYPES } from "./transactionList";

const now = new Date(2026, 10, 9, 12, 0); // 9 Nov 2026, noon local

const cycleOf = (id: string, first: string, last: string, state = "finished") => ({
  id,
  start_at: startAtFor(first),
  end_at: endAtFor(last),
  state,
});
const cycles = [
  cycleOf("100001000001", "2026-08-25", "2026-09-24"),
  cycleOf("100001000002", "2026-09-25", "2026-10-24"),
  cycleOf("100001000003", "2026-10-25", "2026-11-24", "active"),
];

function previous(period: string, compareTo: "previous" | "last_year" = "previous") {
  const choice = parsePeriod(period);
  if (!choice) throw new Error(`${period} doesn't parse`);
  const resolved = resolvePeriod(choice, cycles, now);
  if (!resolved) throw new Error(`${period} doesn't resolve`);
  const p = previousPeriod(choice, resolved, compareTo, cycles, now);
  return p && { from: p.period.from, to: p.period.to, choice: p.choice };
}

describe("previousPeriod", () => {
  it("is the period right before", () => {
    expect(previous("previous-year")).toMatchObject({ from: "2024-01-01", to: "2024-12-31" });
    expect(previous("quarter-2026-q2")).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
    expect(previous("half_year-2026-h1")).toMatchObject({ from: "2025-07-01", to: "2025-12-31" });
    expect(previous("previous-month")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("or the same period a year earlier", () => {
    expect(previous("quarter-2026-q2", "last_year")).toMatchObject({
      from: "2025-04-01",
      to: "2025-06-30",
    });
    expect(previous("previous-month", "last_year")).toMatchObject({
      from: "2025-10-01",
      to: "2025-10-31",
    });
  });

  it("cuts the previous period to as long as this one has run", () => {
    expect(previous("current-month")).toMatchObject({ from: "2026-10-01", to: "2026-10-09" });
    expect(previous("current-year", "last_year")).toMatchObject({
      from: "2025-01-01",
      to: "2025-11-09",
    });
  });

  it("compares a cycle with the cycle before, whatever the setting", () => {
    expect(previous("previous-cycle")).toMatchObject({
      choice: { unit: "cycle", at: "100001000001" },
      from: "2026-08-25",
      to: "2026-09-24",
    });
    expect(previous("cycle-100001000002", "last_year")).toMatchObject({
      choice: { at: "100001000001" },
    });
    // The active cycle has run 16 days of its 31.
    expect(previous("current-cycle")).toMatchObject({ from: "2026-09-25", to: "2026-10-10" });
    // The first cycle has none before it.
    expect(previous("cycle-100001000001")).toBeNull();
  });

  it("doesn't compare custom dates", () => {
    expect(previous("custom-2026-01-01-2026-03-31")).toBeNull();
  });
});

function parts(period: string, by: "month" | "cycle") {
  const choice = parsePeriod(period);
  if (!choice) throw new Error(`${period} doesn't parse`);
  const resolved = resolvePeriod(choice, cycles, now);
  if (!resolved) throw new Error(`${period} doesn't resolve`);
  const result = subPeriods(choice, resolved, by, cycles, now);
  return result.ok
    ? result.parts.map((p) => `${p.period.from}..${p.period.to}${p.partial ? " partial" : ""}`)
    : result.reason;
}

describe("subPeriods", () => {
  it("cuts a period into months, clipped to it", () => {
    expect(parts("custom-2026-01-15-2026-03-31", "month")).toEqual([
      "2026-01-15..2026-01-31 partial",
      "2026-02-01..2026-02-28",
      "2026-03-01..2026-03-31",
    ]);
    // This year runs to today: November is partial.
    expect((parts("current-year", "month") as string[]).at(-1)).toBe(
      "2026-11-01..2026-11-09 partial",
    );
  });

  it("cuts a period into the cycles overlapping it, clipped", () => {
    expect(parts("custom-2026-09-01-2026-11-05", "cycle")).toEqual([
      "2026-09-01..2026-09-24 partial",
      "2026-09-25..2026-10-24",
      "2026-10-25..2026-11-05 partial",
    ]);
    expect(parts("custom-2026-01-01-2026-03-31", "cycle")).toBe("none");
  });

  it("needs 60 days, counting the whole period, and at most 24 parts", () => {
    expect(parts("previous-month", "month")).toBe("short");
    expect(parts("quarter-2026-q1", "month")).toHaveLength(3);
    // This year counts as the whole year, even in its first days.
    expect(parts("current-year", "cycle")).toHaveLength(3);
    expect(parts("custom-2024-01-01-2026-02-28", "month")).toBe("many");
  });
});

describe("moduleGraph", () => {
  const report: ReportSettings = {
    period: "previous-year",
    account_ids: ["1234"],
    tags: ["food"],
    counterparty: "Rema",
    modules: [],
  };

  it("uses the report's period and filters", () => {
    expect(
      moduleGraph(report, {
        id: "m-1",
        type: "graph",
        graph: { kind: "bar", metric: "spending", resolution: "month" },
      }),
    ).toEqual({
      kind: "bar",
      metric: "spending",
      period: "previous-year",
      resolution: "month",
      account_ids: ["1234"],
      tags: ["food"],
      counterparty: "Rema",
    });
  });

  it("with the module's own filters where it sets them", () => {
    const g = moduleGraph(report, {
      id: "m-1",
      type: "graph",
      graph: {
        kind: "pie",
        metric: "spending",
        resolution: "month",
        group_by: "bucket",
        bucket_ids: ["1000000001"],
        tags: ["fun"],
      },
    });
    expect(g.account_ids).toEqual(["1234"]);
    expect(g.bucket_ids).toEqual(["1000000001"]);
    expect(g.tags).toEqual(["fun"]);
  });
});

describe("cleanReport", () => {
  it("drops defaults, so a starter equals its clean copy", () => {
    const yearly = starter("yearly");
    const changed: ReportSettings = {
      ...yearly,
      compare_to: "previous",
      tags: [],
      modules: yearly.modules.map((m) =>
        m.type === "graph" ? { ...m, compare: m.compare ?? "off", title: " " } : m,
      ),
    };
    expect(sameReport(changed, yearly)).toBe(true);
    expect(cleanReport(changed).modules[0]).toEqual({
      id: "m-1",
      type: "graph",
      graph: { kind: "pie", metric: "spending", resolution: "month", group_by: "bucket" },
    });
    expect(sameReport({ ...yearly, compare_to: "last_year" }, yearly)).toBe(false);
  });
});

describe("transactions modules (#126)", () => {
  const report: ReportSettings = {
    period: "previous-month",
    account_ids: ["1234"],
    tags: ["food"],
    counterparty: "rema",
    modules: [],
  };
  const period = {
    from: "2026-10-01",
    to: "2026-10-31",
    fromAt: startAtFor("2026-10-01"),
    toAt: endAtFor("2026-10-31"),
  };

  it("use the report's filters where they set none", () => {
    const t = moduleTransactions(report, {
      id: "m-1",
      type: "transactions",
      transactions: { bucket_ids: ["1000000001", "1000000002"], tags: [], types: ["EXP"] },
    });
    expect(t).toMatchObject({
      account_ids: ["1234"],
      bucket_ids: ["1000000001", "1000000002"],
      tags: ["food"],
      counterparty: "rema",
      types: ["EXP"],
    });
  });

  it("ask the list API for the period, without system types or reversed ones by default", () => {
    expect(transactionsQuery({ bucket_ids: ["1000000001", "1000000002"] }, period)).toEqual({
      type: USER_TYPES,
      from: period.fromAt,
      to: period.toAt,
      bucket_id: ["1000000001", "1000000002"],
      reversed: false,
      limit: 50,
    });
    const q = transactionsQuery({ types: ["EXP"], system: true, reversed: true }, period);
    expect(q.type).toEqual(["EXP", ...SYSTEM_TYPES]);
    expect(q).not.toHaveProperty("reversed");
  });

  it("link to the Transactions screen while each filter has one value", () => {
    const link = transactionsLink(
      { account_ids: ["1234"], tags: ["food"], types: ["EXP"], counterparty: " rema " },
      period,
    );
    expect(link).not.toBeNull();
    const params = new URL(link ?? "", "http://x").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      cycle_id: "all",
      from: "2026-10-01",
      to: "2026-10-31",
      account_id: "1234",
      tag: "food",
      type: "EXP",
      q: "rema",
      reversed: "0",
    });
    // Two buckets aren't one of that screen's filters yet (#162).
    expect(transactionsLink({ bucket_ids: ["1000000001", "1000000002"] }, period)).toBeNull();
    // A row still opens there, over the period.
    const row = transactionsLink({ bucket_ids: ["1000000001", "1000000002"] }, period, "t1");
    expect(row).toBe("/transactions?cycle_id=all&from=2026-10-01&to=2026-10-31&open=t1");
  });

  it("are saved without defaults, and read back by type", () => {
    const r: ReportSettings = {
      period: "previous-month",
      modules: [
        {
          id: "m-1",
          type: "transactions",
          title: " ",
          transactions: { tags: [], types: [], system: false, reversed: true, counterparty: " " },
        },
      ],
    };
    expect(cleanReport(r).modules).toEqual([
      { id: "m-1", type: "transactions", transactions: { reversed: true } },
    ]);
    const [read] = readTemplates([
      {
        id: "r-1",
        name: "Mine",
        report: {
          period: "previous-month",
          modules: [
            { id: "m-1", type: "transactions", transactions: {} },
            // Without its type's settings, which the server refuses.
            { id: "m-2", type: "graph" },
          ],
        },
      },
    ]);
    expect(read?.report.modules).toEqual([{ id: "m-1", type: "transactions", transactions: {} }]);
  });
});
