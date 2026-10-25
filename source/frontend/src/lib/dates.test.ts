import { formatDate, parseDate } from "./dates";

describe("parseDate", () => {
  it("reads API dates as local calendar dates", () => {
    const d = parseDate("2026-01-01");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 0, 1, 0]);
  });
});

describe("formatDate", () => {
  it("shows the same calendar day as the API date", () => {
    expect(formatDate("2026-01-01", "en-GB")).toBe("1 Jan 2026");
    expect(formatDate("2026-12-31", "nb-NO")).toBe("31. des. 2026");
  });
});
