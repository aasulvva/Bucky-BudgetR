import { cycle } from "@/test/fixtures";

import { endAtFor, startAtFor } from "./cycles";
import {
  coarser,
  defaultPeriod,
  defaultResolution,
  fittingResolutions,
  formatPeriod,
  intervalCount,
  keptResolution,
  MAX_BARS,
  MAX_POINTS,
  parsePeriod,
  parseResolution,
  resolvePeriod,
  specificAt,
  stepSpecific,
  type Period,
  type PeriodChoice,
  type SpecificUnit,
} from "./periods";

// Wednesday 11 November 2026, in the afternoon (local time: the tests run in
// America/Los_Angeles, where summer time ended on 1 November).
const now = new Date(2026, 10, 11, 15, 30);

function resolved(choice: PeriodChoice, at = now, locale?: string, cycles = []): Period {
  const p = resolvePeriod(choice, cycles, at, locale);
  if (!p) throw new Error(`${formatPeriod(choice)} didn't resolve`);
  return p;
}

const dates = (p: Period | null) => p && { from: p.from, to: p.to };

describe("formatPeriod and parsePeriod", () => {
  it("round-trip every kind", () => {
    const choices: PeriodChoice[] = [
      { kind: "last", unit: "days", count: 30 },
      { kind: "last", unit: "weeks", count: 104 },
      { kind: "last", unit: "months", count: 1 },
      { kind: "last", unit: "cycles", count: 3 },
      { kind: "last", unit: "years", count: 20 },
      { kind: "current", unit: "cycle" },
      { kind: "current", unit: "half_year" },
      { kind: "previous", unit: "year" },
      { kind: "custom", from: "2026-01-01", to: "2026-03-31" },
      { kind: "specific", unit: "day", at: "2026-11-08" },
      { kind: "specific", unit: "week", at: "2026-11-02" },
      { kind: "specific", unit: "cycle", at: "100001000001" },
      { kind: "specific", unit: "month", at: "2026-11-01" },
      { kind: "specific", unit: "quarter", at: "2026-10-01" },
      { kind: "specific", unit: "half_year", at: "2026-07-01" },
      { kind: "specific", unit: "year", at: "2026-01-01" },
    ];
    for (const c of choices) expect(parsePeriod(formatPeriod(c))).toEqual(c);
    expect(formatPeriod({ kind: "last", unit: "days", count: 30 })).toBe("last-30-days");
    expect(formatPeriod({ kind: "specific", unit: "month", at: "2026-11-01" })).toBe(
      "month-2026-11",
    );
    expect(formatPeriod({ kind: "specific", unit: "quarter", at: "2026-10-01" })).toBe(
      "quarter-2026-q4",
    );
    expect(formatPeriod({ kind: "specific", unit: "half_year", at: "2026-01-01" })).toBe(
      "half_year-2026-h1",
    );
    expect(formatPeriod({ kind: "specific", unit: "year", at: "2026-01-01" })).toBe("year-2026");
    expect(formatPeriod({ kind: "custom", from: "2026-01-01", to: "2026-03-31" })).toBe(
      "custom-2026-01-01-2026-03-31",
    );
  });

  it("give null for anything else", () => {
    for (const s of [
      null,
      "",
      "last-0-days",
      "last-367-days",
      "last-105-weeks",
      "last-21-years",
      "last-3-decades",
      "current-week",
      "previous-",
      "custom-2026-02-30-2026-03-01",
      "custom-2026-03-02-2026-03-01",
      "custom-2026-1-1-2026-03-01",
      "day-2026-02-30",
      "month-2026-13",
      "quarter-2026-q5",
      "quarter-2026-h1",
      "half_year-2026-q1",
      "cycle-12",
      "year-26",
    ]) {
      expect(parsePeriod(s)).toBeNull();
    }
    expect(parseResolution("week")).toBe("week");
    expect(parseResolution("quarter")).toBeNull();
    expect(parseResolution(null)).toBeNull();
  });
});

describe("resolvePeriod", () => {
  it("counts the last days, weeks and months back from today, up to now", () => {
    expect(resolved({ kind: "last", unit: "days", count: 30 })).toEqual({
      from: "2026-10-13",
      to: "2026-11-11",
      fromAt: startAtFor("2026-10-13"),
      toAt: now.toISOString(),
    });
    expect(dates(resolved({ kind: "last", unit: "days", count: 1 }))).toEqual({
      from: "2026-11-11",
      to: "2026-11-11",
    });
    expect(dates(resolved({ kind: "last", unit: "months", count: 3 }))).toEqual({
      from: "2026-09-01",
      to: "2026-11-11",
    });
  });

  it("counts the last years and the latest started cycles back", () => {
    expect(dates(resolved({ kind: "last", unit: "years", count: 3 }))).toEqual({
      from: "2024-01-01",
      to: "2026-11-11",
    });
    const c = (id: string, from: string, to: string, state: string) =>
      cycle({ id, start_at: startAtFor(from), end_at: endAtFor(to), state: state as "active" });
    const cycles = [
      c("4", "2026-12-01", "2026-12-31", "future"),
      c("3", "2026-11-01", "2026-11-30", "active"),
      c("1", "2026-09-01", "2026-09-30", "finished"),
      c("2", "2026-10-01", "2026-10-31", "finished"),
    ];
    const last = (count: number) =>
      resolvePeriod({ kind: "last", unit: "cycles", count }, cycles, now);
    expect(last(1)).toEqual({
      from: "2026-11-01",
      to: "2026-11-11",
      fromAt: startAtFor("2026-11-01"),
      toAt: now.toISOString(),
    });
    expect(last(2)?.from).toBe("2026-10-01");
    // More than there are: from the first one.
    expect(last(10)?.from).toBe("2026-09-01");
    expect(resolvePeriod({ kind: "last", unit: "cycles", count: 3 }, [], now)).toBeNull();
  });

  it("starts weeks on the locale's first day", () => {
    expect(resolved({ kind: "last", unit: "weeks", count: 2 }, now, "nb-NO").from).toBe(
      "2026-11-02",
    );
    expect(resolved({ kind: "last", unit: "weeks", count: 2 }, now, "en-US").from).toBe(
      "2026-11-01",
    );
  });

  it("runs this month, quarter, half-year and year to now", () => {
    const from = (unit: "month" | "quarter" | "half_year" | "year") =>
      resolved({ kind: "current", unit }).from;
    expect(from("month")).toBe("2026-11-01");
    expect(from("quarter")).toBe("2026-10-01");
    expect(from("half_year")).toBe("2026-07-01");
    expect(from("year")).toBe("2026-01-01");
    expect(resolved({ kind: "current", unit: "year" }).toAt).toBe(now.toISOString());
  });

  it("gives the whole previous period", () => {
    const prev = (unit: "month" | "quarter" | "half_year" | "year", at = now) =>
      dates(resolved({ kind: "previous", unit }, at));
    expect(prev("month")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(prev("quarter")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(prev("half_year")).toEqual({ from: "2026-01-01", to: "2026-06-30" });
    expect(prev("year")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    // Across the turn of the year.
    expect(prev("quarter", new Date(2027, 0, 15))).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(prev("month", new Date(2027, 0, 15))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("puts the edges at local midnight, also across a change of summer time", () => {
    const october = resolved({ kind: "previous", unit: "month" });
    expect(october.fromAt).toBe("2026-10-01T07:00:00.000Z");
    // Summer time ended on 1 November: midnight is an hour later in UTC.
    expect(october.toAt).toBe("2026-11-01T07:00:00.000Z");
    expect(resolved({ kind: "current", unit: "month" }).fromAt).toBe("2026-11-01T07:00:00.000Z");
    expect(resolved({ kind: "previous", unit: "year" }).toAt).toBe(endAtFor("2025-12-31"));
  });

  it("uses the active cycle and the latest finished one", () => {
    const sep = cycle({
      id: "1",
      state: "finished",
      start_at: startAtFor("2026-09-01"),
      end_at: endAtFor("2026-09-30"),
    });
    // Ended early, in the afternoon; then a gap before the active one.
    const oct = cycle({
      id: "2",
      state: "finished",
      start_at: startAtFor("2026-10-01"),
      end_at: "2026-10-15T22:00:00.000Z",
    });
    const active = cycle({
      id: "3",
      state: "active",
      start_at: startAtFor("2026-11-01"),
      end_at: endAtFor("2026-11-30"),
    });
    const future = cycle({
      id: "4",
      state: "future",
      start_at: startAtFor("2026-12-01"),
      end_at: endAtFor("2026-12-31"),
    });
    const cycles = [oct, future, active, sep];
    expect(resolvePeriod({ kind: "current", unit: "cycle" }, cycles, now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-11",
      fromAt: active.start_at,
      toAt: now.toISOString(),
    });
    expect(resolvePeriod({ kind: "previous", unit: "cycle" }, cycles, now)).toEqual({
      from: "2026-10-01",
      to: "2026-10-15",
      fromAt: oct.start_at,
      toAt: oct.end_at,
    });
    expect(defaultPeriod(cycles)).toEqual({ kind: "current", unit: "cycle" });
  });

  it("gives null without an active or finished cycle", () => {
    expect(resolvePeriod({ kind: "current", unit: "cycle" }, [], now)).toBeNull();
    expect(resolvePeriod({ kind: "previous", unit: "cycle" }, [], now)).toBeNull();
    expect(defaultPeriod([])).toEqual({ kind: "current", unit: "month" });
    expect(defaultPeriod([cycle({ state: "finished" })])).toEqual({
      kind: "current",
      unit: "month",
    });
  });

  it("ends a custom period today at the latest", () => {
    expect(resolved({ kind: "custom", from: "2026-11-01", to: "2026-12-31" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-11",
      fromAt: startAtFor("2026-11-01"),
      toAt: now.toISOString(),
    });
    expect(resolved({ kind: "custom", from: "2026-01-01", to: "2026-03-31" }).toAt).toBe(
      endAtFor("2026-03-31"),
    );
    expect(
      resolvePeriod({ kind: "custom", from: "2026-11-12", to: "2026-11-20" }, [], now),
    ).toBeNull();
  });
});

describe("specific periods", () => {
  const sep = cycle({
    id: "100001000001",
    state: "finished",
    start_at: startAtFor("2026-09-01"),
    end_at: endAtFor("2026-09-30"),
  });
  const nov = cycle({
    id: "100001000002",
    state: "active",
    start_at: startAtFor("2026-11-01"),
    end_at: endAtFor("2026-11-30"),
  });
  const dec = cycle({
    id: "100001000003",
    state: "future",
    start_at: startAtFor("2026-12-01"),
    end_at: endAtFor("2026-12-31"),
  });
  const cycles = [nov, dec, sep];
  const specific = (unit: SpecificUnit, at: string) => ({ kind: "specific" as const, unit, at });

  it("cover their whole period, up to now for the current one", () => {
    expect(dates(resolvePeriod(specific("day", "2026-11-08"), [], now))).toEqual({
      from: "2026-11-08",
      to: "2026-11-08",
    });
    expect(resolvePeriod(specific("week", "2026-11-02"), [], now)?.toAt).toBe(
      endAtFor("2026-11-08"),
    );
    expect(dates(resolvePeriod(specific("quarter", "2026-07-01"), [], now))).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(resolvePeriod(specific("month", "2026-11-01"), [], now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-11",
      fromAt: startAtFor("2026-11-01"),
      toAt: now.toISOString(),
    });
    expect(resolvePeriod(specific("year", "2027-01-01"), [], now)).toBeNull();
  });

  it("cover a cycle by its ID, the active one up to now", () => {
    expect(resolvePeriod(specific("cycle", sep.id), cycles, now)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      fromAt: sep.start_at,
      toAt: sep.end_at,
    });
    expect(resolvePeriod(specific("cycle", nov.id), cycles, now)?.toAt).toBe(now.toISOString());
    expect(resolvePeriod(specific("cycle", dec.id), cycles, now)).toBeNull();
    expect(resolvePeriod(specific("cycle", "999999999999"), cycles, now)).toBeNull();
  });

  it("find the one holding a date", () => {
    expect(specificAt("week", "2026-11-11", [], "nb-NO")).toEqual(specific("week", "2026-11-09"));
    expect(specificAt("week", "2026-11-11", [], "en-US")).toEqual(specific("week", "2026-11-08"));
    expect(specificAt("half_year", "2026-11-11", [])).toEqual(specific("half_year", "2026-07-01"));
    expect(specificAt("cycle", "2026-10-15", cycles)).toEqual(specific("cycle", sep.id));
    expect(specificAt("cycle", "2026-11-11", cycles)).toEqual(specific("cycle", nov.id));
    expect(specificAt("cycle", "2026-11-11", [])).toBeNull();
  });

  it("step to the one before or after, not past today or the started cycles", () => {
    expect(stepSpecific(specific("month", "2026-10-01"), 1, [], now)).toEqual(
      specific("month", "2026-11-01"),
    );
    expect(stepSpecific(specific("month", "2026-11-01"), 1, [], now)).toBeNull();
    expect(stepSpecific(specific("week", "2026-11-02"), -1, [], now)).toEqual(
      specific("week", "2026-10-26"),
    );
    expect(stepSpecific(specific("quarter", "2026-01-01"), -1, [], now)).toEqual(
      specific("quarter", "2025-10-01"),
    );
    expect(stepSpecific(specific("cycle", sep.id), 1, cycles, now)).toEqual(
      specific("cycle", nov.id),
    );
    expect(stepSpecific(specific("cycle", nov.id), 1, cycles, now)).toBeNull();
    expect(stepSpecific(specific("cycle", sep.id), -1, cycles, now)).toBeNull();
  });
});

describe("intervalCount", () => {
  const october = resolved({ kind: "previous", unit: "month" });
  const year2025 = resolved({ kind: "previous", unit: "year" });

  it("counts days, months, years and the total", () => {
    expect(intervalCount(october, "day", [])).toBe(31);
    expect(intervalCount(october, "month", [])).toBe(1);
    expect(intervalCount(year2025, "month", [])).toBe(12);
    expect(intervalCount(year2025, "year", [])).toBe(1);
    expect(intervalCount(year2025, "total", [])).toBe(1);
  });

  it("counts hours by the clock, 25 on the day summer time ends", () => {
    const day = resolved({ kind: "custom", from: "2026-11-01", to: "2026-11-01" });
    expect(intervalCount(day, "hour", [])).toBe(25);
    expect(intervalCount(day, "day", [])).toBe(1);
    // Today, up to 15:30: 16 hours, the last one cut.
    expect(intervalCount(resolved({ kind: "last", unit: "days", count: 1 }), "hour", [])).toBe(16);
  });

  it("counts weeks from the locale's first day", () => {
    // November 2026 starts on a Sunday.
    const november = resolved({ kind: "previous", unit: "month" }, new Date(2026, 11, 15));
    expect(intervalCount(november, "week", [], "en-US")).toBe(5);
    expect(intervalCount(november, "week", [], "nb-NO")).toBe(6);
  });

  it("counts the cycles overlapping the period", () => {
    const cycles = [
      cycle({ start_at: startAtFor("2026-09-15"), end_at: endAtFor("2026-10-14") }),
      cycle({ start_at: startAtFor("2026-10-15"), end_at: endAtFor("2026-11-14") }),
      cycle({ start_at: startAtFor("2026-11-15"), end_at: endAtFor("2026-12-14") }),
    ];
    expect(intervalCount(october, "cycle", cycles)).toBe(2);
    expect(intervalCount(october, "cycle", [])).toBe(0);
  });

  it("stops counting past the most", () => {
    const year = resolved({ kind: "last", unit: "days", count: 366 });
    expect(intervalCount(year, "hour", [], undefined, MAX_BARS)).toBe(MAX_BARS + 1);
    expect(intervalCount(year, "hour", [])).toBe(MAX_POINTS + 1);
  });
});

describe("resolutions", () => {
  const year2025 = resolved({ kind: "previous", unit: "year" });

  it("offer only those that fit", () => {
    expect(fittingResolutions(year2025, MAX_BARS, [], "nb-NO")).toEqual([
      "week",
      "month",
      "year",
      "total",
    ]);
    expect(fittingResolutions(year2025, MAX_POINTS, [cycle()], "nb-NO")).toEqual([
      "day",
      "week",
      "month",
      "year",
      "total",
    ]);
    const thisCycle = [
      cycle({ start_at: startAtFor("2025-12-15"), end_at: endAtFor("2026-01-14") }),
    ];
    expect(fittingResolutions(year2025, MAX_BARS, thisCycle, "nb-NO")).toContain("cycle");
  });

  it("start from the period's length", () => {
    expect(defaultResolution(resolved({ kind: "last", unit: "days", count: 2 }))).toBe("hour");
    expect(defaultResolution(resolved({ kind: "last", unit: "days", count: 30 }))).toBe("day");
    expect(defaultResolution(resolved({ kind: "previous", unit: "quarter" }))).toBe("week");
    expect(defaultResolution(year2025)).toBe("month");
    expect(
      defaultResolution(resolved({ kind: "custom", from: "2020-01-01", to: "2026-11-11" })),
    ).toBe("year");
    // Today has 16 hours so far: they don't fit in 10 bars.
    expect(defaultResolution(resolved({ kind: "last", unit: "days", count: 1 }), 10)).toBe("day");
  });

  it("go coarser one step at a time", () => {
    expect(coarser("hour")).toBe("day");
    expect(coarser("day")).toBe("week");
    expect(coarser("month")).toBe("year");
    expect(coarser("year")).toBeNull();
    expect(coarser("cycle")).toBeNull();
    expect(coarser("total")).toBeNull();
  });

  it("keep the current one while it fits", () => {
    const month = resolved({ kind: "last", unit: "days", count: 30 });
    expect(keptResolution("week", month, MAX_BARS, [])).toBe("week");
    expect(keptResolution("day", year2025, MAX_BARS, [])).toBe("month");
    expect(keptResolution("cycle", year2025, MAX_BARS, [])).toBe("month");
  });
});
