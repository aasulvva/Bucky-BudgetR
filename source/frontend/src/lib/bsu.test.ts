import type { BsuHistory } from "@/api/bsu";

import { fieldProblem, overTotal, overYear, ruleFor, setupPlan, setupRows } from "./bsu";

const rules = [
  {
    from_year: 2016,
    yearly_limit: "25000.00",
    total_limit: "300000.00",
    modified_at: "2026-01-01T00:00:00Z",
  },
  {
    from_year: 2021,
    yearly_limit: "27500.00",
    total_limit: "300000.00",
    modified_at: "2026-01-01T00:00:00Z",
  },
];

const zero = { deposits: "0.00", interest: "0.00", withdrawals: "0.00" };
const none = { deposits: 0, interest: 0, withdrawals: 0 };

// The app has an opening balance of 5 000 and, in 2025 and 2026, a deposit
// each and some interest: 17 100 now.
const history: BsuHistory = {
  latest_opened_year: 2025,
  years: [
    {
      year: 2025,
      recorded: { ...zero, deposits: "10000.00" },
      recorded_count: { ...none, deposits: 1 },
    },
    {
      year: 2026,
      recorded: { deposits: "2000.00", interest: "100.00", withdrawals: "0.00" },
      recorded_count: { deposits: 1, interest: 1, withdrawals: 0 },
    },
  ],
  opening: "5000.00",
  balance: "17100.00",
  set_up_at: null,
  rules,
};

describe("ruleFor", () => {
  it("uses the latest rule at or before the year, or the first", () => {
    expect(ruleFor(rules, 2010)?.from_year).toBe(2016);
    expect(ruleFor(rules, 2020)?.from_year).toBe(2016);
    expect(ruleFor(rules, 2021)?.from_year).toBe(2021);
    expect(ruleFor(rules, 2030)?.from_year).toBe(2021);
  });
});

describe("setupRows", () => {
  it("runs from the year opened to this year, with what's recorded", () => {
    const rows = setupRows(history, 2023);
    expect(rows.map((r) => r.year)).toEqual([2023, 2024, 2025, 2026]);
    expect(rows[0]).toMatchObject({ ...zero, min: zero });
    expect(rows[2]).toMatchObject({
      deposits: "10000.00",
      min: { deposits: "10000.00" },
      count: { deposits: 1, interest: 0 },
    });
    expect(rows[0]?.count).toEqual({ deposits: 0, interest: 0, withdrawals: 0 });
  });

  it("keeps what was entered when the year opened changes", () => {
    const rows = setupRows(history, 2024).map((r) =>
      r.year === 2024 ? { ...r, deposits: "27500.00" } : r,
    );
    const again = setupRows(history, 2023, rows);
    expect(again.find((r) => r.year === 2024)?.deposits).toBe("27500.00");
    expect(again).toHaveLength(4);
  });
});

describe("checks", () => {
  it("needs an amount, at least what's recorded", () => {
    const [, , y2025] = setupRows(history, 2023);
    if (!y2025) throw new Error("2025");
    expect(fieldProblem(y2025, "deposits")).toBeUndefined();
    expect(fieldProblem({ ...y2025, deposits: "9000.00" }, "deposits")).toBe("belowRecorded");
    expect(fieldProblem({ ...y2025, interest: null }, "interest")).toBe("empty");
  });

  it("warns of a year over its limit, and of all over the total", () => {
    const [y2020] = setupRows(history, 2020);
    if (!y2020) throw new Error("2020");
    expect(overYear({ ...y2020, deposits: "26000.00" }, rules)).toBe("1000.00");
    expect(overYear({ ...y2020, deposits: "25000.00" }, rules)).toBeUndefined();
    const rows = setupRows(history, 2015).map((r) => ({ ...r, deposits: "27500.00" }));
    expect(overTotal(history, rows)).toBe("30000.00");
  });
});

describe("setupPlan", () => {
  it("adds what's missing per year and adjusts to the bank's balance", () => {
    const rows = setupRows(history, 2023).map((r) => {
      switch (r.year) {
        case 2023:
          return { ...r, deposits: "10000.00", interest: "50.00" };
        case 2024:
          return { ...r, deposits: "27500.00", interest: "200.00", withdrawals: "1000.00" };
        case 2025:
          return { ...r, deposits: "15000.00", interest: "300.00" };
        default:
          return r;
      }
    });
    expect(setupPlan(history, rows, "54000.00")).toEqual({
      opening: "-5000.00",
      years: [
        { year: 2023, deposits: "10000.00", interest: "50.00", withdrawals: "0.00" },
        { year: 2024, deposits: "27500.00", interest: "200.00", withdrawals: "1000.00" },
        { year: 2025, deposits: "5000.00", interest: "300.00", withdrawals: "0.00" },
      ],
      adjustment: "-150.00",
    });
  });

  it("records nothing for a new BSU with nothing in it", () => {
    const fresh: BsuHistory = {
      ...history,
      latest_opened_year: 2026,
      years: [{ year: 2026, recorded: zero, recorded_count: none }],
      opening: "0.00",
      balance: "0.00",
    };
    expect(setupPlan(fresh, setupRows(fresh, 2026), "0.00")).toEqual({
      opening: null,
      years: [],
      adjustment: null,
    });
  });
});
