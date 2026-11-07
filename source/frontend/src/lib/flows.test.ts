import { account, cycle } from "@/test/fixtures";

import { endAtFor, startAtFor } from "./cycles";
import { flowLink, flowTotals, periodSpan, weekStart } from "./flows";

// Wednesday 11 November 2026, in the afternoon (local time).
const now = new Date(2026, 10, 11, 15, 30);

describe("periodSpan", () => {
  it("covers the last days, today, the month and the year", () => {
    expect(periodSpan("days", 30, null, now)).toEqual({ from: "2026-10-13", to: "2026-11-11" });
    expect(periodSpan("days", 1, null, now)).toEqual({ from: "2026-11-11", to: "2026-11-11" });
    expect(periodSpan("today", 30, null, now)).toEqual({ from: "2026-11-11", to: "2026-11-11" });
    expect(periodSpan("month", 30, null, now)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodSpan("year", 30, null, now)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodSpan("month", 30, null, new Date(2028, 1, 10))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("starts the week on the locale's first day", () => {
    expect(weekStart("nb-NO")).toBe(1);
    expect(weekStart("en-US")).toBe(7);
    expect(periodSpan("week", 30, null, now, "nb-NO")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(periodSpan("week", 30, null, now, "en-US")).toEqual({
      from: "2026-11-08",
      to: "2026-11-14",
    });
    // A Sunday is the last day of a Monday week.
    expect(periodSpan("week", 30, null, new Date(2026, 10, 15, 12), "nb-NO")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
  });

  it("is the active cycle, or nothing without one", () => {
    const active = cycle({ start_at: startAtFor("2026-10-25"), end_at: endAtFor("2026-11-24") });
    expect(periodSpan("cycle", 30, active, now)).toEqual({ from: "2026-10-25", to: "2026-11-24" });
    expect(periodSpan("cycle", 30, null, now)).toBeNull();
  });
});

describe("flowTotals", () => {
  const main = account({ id: "1234", name: "Main" });
  const savings = account({ id: "2345", name: "Savings" });
  const euro = account({ id: "3456", name: "Euro", currency: "EUR" });
  const flows = [
    {
      account_id: main.id,
      income: "20000.00",
      expenses: "8000.00",
      transfers_in: "500.00",
      transfers_out: "2000.00",
    },
    {
      account_id: savings.id,
      income: "100.00",
      expenses: "0.00",
      transfers_in: "2000.00",
      transfers_out: "500.00",
    },
    {
      account_id: euro.id,
      income: "50.00",
      expenses: "10.00",
      transfers_in: "0.00",
      transfers_out: "0.00",
    },
  ];

  it("sums all accounts in the app's currency, without transfers", () => {
    expect(flowTotals(flows, [main, savings, euro], null)).toEqual({
      currency: "NOK",
      income: "20100.00",
      expenses: "8000.00",
      balance: "12100.00",
      leftOut: 1,
    });
    expect(flowTotals([], [main], null)).toMatchObject({
      income: "0.00",
      balance: "0.00",
      leftOut: 0,
    });
  });

  it("counts transfers as income and expenses for one account, in its currency", () => {
    expect(flowTotals(flows, [main, savings, euro], main.id)).toEqual({
      currency: "NOK",
      income: "20500.00",
      expenses: "10000.00",
      balance: "10500.00",
      leftOut: 0,
    });
    expect(flowTotals(flows, [main, euro], euro.id)).toMatchObject({
      currency: "EUR",
      balance: "40.00",
    });
    // A gone account means all of them.
    expect(flowTotals(flows, [main], "9999")).toMatchObject({ income: "20000.00", leftOut: 0 });
  });
});

describe("flowLink", () => {
  const span = { from: "2026-11-01", to: "2026-11-30" };

  it("opens the figure's transactions in the period and account", () => {
    expect(flowLink("income", "month", span, null, null)).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-30&type=INC",
    );
    expect(flowLink("expenses", "days", span, null, "1234")).toBe(
      "/transactions?cycle_id=all&from=2026-11-01&to=2026-11-30&type=EXP&account_id=1234",
    );
    expect(flowLink("balance", "cycle", span, cycle(), null)).toBe(
      "/transactions?cycle_id=100001000001",
    );
  });
});
