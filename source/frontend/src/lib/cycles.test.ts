// The tests run in America/Los_Angeles (vite.config.ts), west of UTC and with
// daylight saving time, so midnight conversions are really exercised.

import {
  cycleRange,
  daysLeft,
  daysLeftLabel,
  daysLeftShort,
  endAtFor,
  firstDay,
  isOverdue,
  lastDay,
  monthFrom,
  rangeProblem,
  startAtAfter,
  startAtFor,
} from "./cycles";

const november = { start_at: "2026-11-01T07:00:00.000Z", end_at: "2026-12-01T08:00:00.000Z" };

describe("cycle dates", () => {
  it("sends local midnights in UTC, with an exclusive end", () => {
    // PDT (UTC−7) on 1 November until 2 am; PST (UTC−8) by 1 December.
    expect(startAtFor("2026-11-01")).toBe("2026-11-01T07:00:00.000Z");
    expect(endAtFor("2026-11-30")).toBe("2026-12-01T08:00:00.000Z");
  });

  it("reads them back as local dates", () => {
    expect(firstDay(november)).toBe("2026-11-01");
    expect(lastDay(november)).toBe("2026-11-30");
    // A cycle ended early ends mid-day; that day is its last.
    expect(lastDay({ ...november, end_at: "2026-11-20T22:15:00.000Z" })).toBe("2026-11-20");
  });

  it("formats the range for the locale", () => {
    // ICU versions differ in the spaces around the dash.
    expect(cycleRange(november, "en-GB")).toMatch(/^1\s?–\s?30 Nov 2026$/);
    const twoMonths = { start_at: november.start_at, end_at: "2027-01-01T08:00:00.000Z" };
    expect(cycleRange(twoMonths, "en-GB")).toMatch(/^1 Nov\s?–\s?31 Dec 2026$/);
  });

  it("counts the days left to the last day", () => {
    const at = (local: string) => new Date(local);
    expect(daysLeft(november, at("2026-11-24T09:00:00"))).toBe(6);
    expect(daysLeftLabel(november, at("2026-11-24T09:00:00"))).toBe("6 days left");
    expect(daysLeftShort(november, at("2026-11-24T09:00:00"))).toBe("6 d left");
    expect(daysLeftLabel(november, at("2026-11-29T23:59:00"))).toBe("1 day left");
    expect(daysLeftLabel(november, at("2026-11-30T23:59:00"))).toBe("Last day");
    // Across the DST change: 1 to 30 November is 29 days.
    expect(daysLeft(november, at("2026-11-01T00:30:00"))).toBe(29);
  });

  it("is overdue once the planned end has passed", () => {
    expect(isOverdue(november, new Date("2026-11-30T23:59:59"))).toBe(false);
    expect(isOverdue(november, new Date("2026-12-01T00:00:00"))).toBe(true);
    expect(daysLeftLabel(november, new Date("2026-12-03T10:00:00"))).toBe("Overdue");
  });

  it("makes a month from a start date", () => {
    expect(monthFrom("2026-11-25")).toEqual({ start: "2026-11-25", end: "2026-12-24" });
    expect(monthFrom("2027-01-31")).toEqual({ start: "2027-01-31", end: "2027-02-27" });
  });
});

describe("new cycles", () => {
  it("start after a cycle that ended early the same day", () => {
    const ended = {
      state: "finished",
      start_at: november.start_at,
      end_at: "2026-11-20T22:15:00.000Z",
    };
    expect(startAtAfter("2026-11-20", [ended])).toBe("2026-11-20T22:15:00.000Z");
    expect(startAtAfter("2026-11-21", [ended])).toBe("2026-11-21T08:00:00.000Z");
    expect(startAtAfter("2026-12-01", [{ ...november, state: "finished" }])).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });

  it("must end in the future and not before they start", () => {
    const now = new Date("2026-11-24T09:00:00");
    expect(rangeProblem({ start: "2026-11-24", end: "2026-11-24" }, now)).toBeUndefined();
    expect(rangeProblem({ start: "2026-11-24", end: "2026-11-23" }, now)).toMatch(
      /before the start/,
    );
    expect(rangeProblem({ start: "2026-11-01", end: "2026-11-23" }, now)).toMatch(/future/);
  });
});
