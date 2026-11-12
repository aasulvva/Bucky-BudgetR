import { endAtFor, startAtFor } from "./cycles";
import {
  averageOf,
  intervalDays,
  MONTH_DAYS,
  perUnit,
  rateAmounts,
  unitDays,
  wholeInterval,
} from "./graphRates";
import type { Period } from "./periods";

// Tests run in America/Los_Angeles: summer time ends on 1 November 2026.
const day = (d: string) => ({ start: startAtFor(d), end: endAtFor(d) });
const span = (from: string, to: string) => ({ start: startAtFor(from), end: endAtFor(to) });

const cycle = (start: string, last: string, state = "closed") => ({
  start_at: startAtFor(start),
  end_at: endAtFor(last),
  state,
});
// 31, 30 and 28 days.
const cycles = [
  cycle("2026-08-25", "2026-09-24"),
  cycle("2026-09-25", "2026-10-24"),
  cycle("2026-10-25", "2026-11-21", "active"),
];

const period = (from: string, to: string): Period => ({
  from,
  to,
  fromAt: startAtFor(from),
  toAt: endAtFor(to),
});

describe("intervalDays", () => {
  it("counts local calendar days, a day with a clock change as one", () => {
    expect(intervalDays(day("2026-11-01"))).toBe(1);
    expect(intervalDays(span("2026-10-26", "2026-11-01"))).toBe(7);
    expect(intervalDays(span("2026-02-01", "2026-02-28"))).toBe(28);
  });

  it("counts a started day whole", () => {
    // 11 November so far, from 1 November.
    const soFar = { start: startAtFor("2026-11-01"), end: new Date(2026, 10, 11, 9).toISOString() };
    expect(intervalDays(soFar)).toBe(11);
    expect(
      intervalDays({
        start: startAtFor("2026-11-11"),
        end: new Date(2026, 10, 11, 0, 5).toISOString(),
      }),
    ).toBe(1);
  });
});

describe("unitDays", () => {
  it("is fixed for days, weeks and months", () => {
    const p = period("2026-11-01", "2026-11-30");
    expect(unitDays(undefined, p, cycles)).toBeNull();
    expect(unitDays("total", p, cycles)).toBeNull();
    expect(unitDays("day", p, cycles)).toBe(1);
    expect(unitDays("week", p, cycles)).toBe(7);
    expect(unitDays("month", p, cycles)).toBeCloseTo(30.4375);
    expect(MONTH_DAYS).toBeCloseTo(30.4375);
  });

  it("is the average length of the cycles in the period, else of all", () => {
    // September to November overlaps all three: (31 + 30 + 28) / 3.
    expect(unitDays("cycle", period("2026-09-01", "2026-11-30"), cycles)).toBeCloseTo(89 / 3);
    // Only the last.
    expect(unitDays("cycle", period("2026-11-01", "2026-11-10"), cycles)).toBe(28);
    // None in 2025: all of them.
    expect(unitDays("cycle", period("2025-01-01", "2025-12-31"), cycles)).toBeCloseTo(89 / 3);
    expect(unitDays("cycle", period("2025-01-01", "2025-12-31"), [])).toBeNull();
  });
});

describe("wholeInterval", () => {
  it("is false for an interval the period cuts or that is still going", () => {
    expect(wholeInterval(span("2026-10-01", "2026-10-31"), "month", [])).toBe(true);
    expect(wholeInterval(span("2026-10-15", "2026-10-31"), "month", [])).toBe(false);
    expect(
      wholeInterval(
        { start: startAtFor("2026-11-01"), end: new Date(2026, 10, 11, 9).toISOString() },
        "month",
        [],
      ),
    ).toBe(false);
    expect(wholeInterval(day("2026-11-01"), "day", [])).toBe(true);
    expect(wholeInterval(span("2026-10-26", "2026-11-01"), "week", [])).toBe(true);
    expect(wholeInterval(span("2026-10-28", "2026-11-01"), "week", [])).toBe(false);
    expect(wholeInterval(span("2025-01-01", "2025-12-31"), "year", [])).toBe(true);
    expect(wholeInterval(span("2026-01-01", "2026-12-31"), "total", [])).toBe(false);
  });

  it("is true for a cycle from start to end", () => {
    expect(wholeInterval(span("2026-09-25", "2026-10-24"), "cycle", cycles)).toBe(true);
    // The active cycle so far.
    const running = { start: startAtFor("2026-10-25"), end: new Date(2026, 10, 11).toISOString() };
    expect(wholeInterval(running, "cycle", cycles)).toBe(false);
  });
});

describe("rateAmounts", () => {
  it("divides each by its days, times the unit", () => {
    expect(rateAmounts(["310.00", "70.00"], [31, 7], 1, false)).toEqual(["10.00", "10.00"]);
    expect(rateAmounts(["310.00"], [31], 7, false)).toEqual(["70.00"]);
  });

  it("is a running average as a running total", () => {
    // 10 on day 1, 30 on day 2: 10 / 1, then 40 / 2.
    expect(rateAmounts(["10.00", "30.00"], [1, 1], 1, true)).toEqual(["10.00", "20.00"]);
    // Weeks of 7 and 3 days, per week: 70 / 7 × 7, then 100 / 10 × 7.
    expect(rateAmounts(["70.00", "30.00"], [7, 3], 7, true)).toEqual(["70.00", "70.00"]);
  });
});

describe("averageOf", () => {
  it("averages the whole intervals of totals, all when none is whole", () => {
    expect(averageOf([100, 300, 50], [31, 30, 11], [true, true, false], "total")).toEqual({
      value: 200,
      whole: 2,
      of: 3,
    });
    expect(averageOf([50], [11], [false], "total")).toEqual({ value: 50, whole: 1, of: 1 });
    expect(averageOf([], [], [], "total")).toBeNull();
  });

  it("weighs a rate by its days, and averages every balance", () => {
    // 10 a day over 30 days and 20 a day over 10: 400 / 40.
    expect(averageOf([10, 20], [30, 10], [true, false], "rate")?.value).toBe(12.5);
    expect(averageOf([1000, 2000], [30, 10], [true, false], "balance")?.value).toBe(1500);
  });
});

describe("perUnit", () => {
  it("adds the unit to an amount, not to totals", () => {
    expect(perUnit("kr 312.00", "day")).toBe("kr 312.00 / day");
    expect(perUnit("kr 312.00", "cycle")).toBe("kr 312.00 / cycle");
    expect(perUnit("kr 312.00", "total")).toBe("kr 312.00");
    expect(perUnit("kr 312.00", null)).toBe("kr 312.00");
  });
});
