import { defaultRule, periodFrom, sameRule, validRule } from "./cycleRule";

describe("cycle rules", () => {
  it("skips Norwegian holidays by default in Norwegian locales", () => {
    expect(defaultRule("nb-NO")).toEqual({ day: 25, shift: "previous", holidays: "NO", ahead: 3 });
    expect(defaultRule("nn-no").holidays).toBe("NO");
    expect(defaultRule("en-GB").holidays).toBe("none");
  });

  it("checks the day and the cycles ahead", () => {
    const rule = defaultRule("nb-NO");
    expect(validRule(rule)).toBe(true);
    expect(validRule({ ...rule, day: 0 })).toBe(false);
    expect(validRule({ ...rule, day: 31 })).toBe(true);
    expect(validRule({ ...rule, day: 32 })).toBe(false);
    expect(validRule({ ...rule, day: NaN })).toBe(false);
    expect(validRule({ ...rule, ahead: 12 })).toBe(true);
    expect(validRule({ ...rule, ahead: 13 })).toBe(false);
  });

  it("compares rules", () => {
    const rule = defaultRule("nb-NO");
    expect(sameRule(rule, { ...rule })).toBe(true);
    expect(sameRule(rule, { ...rule, day: 1 })).toBe(false);
    expect(sameRule(null, null)).toBe(true);
    expect(sameRule(rule, null)).toBe(false);
  });

  it("finds the first period from a date", () => {
    const periods = [
      { start: "2026-10-23", end: "2026-11-24" },
      { start: "2026-11-25", end: "2026-12-22" },
    ];
    expect(periodFrom(periods, "2026-10-23")).toBe(periods[0]);
    expect(periodFrom(periods, "2026-11-01")).toBe(periods[1]);
    expect(periodFrom(periods, "2026-12-01")).toBeUndefined();
  });
});
