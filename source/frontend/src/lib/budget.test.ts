import { describe, expect, it } from "vitest";

import { account, bucket } from "@/test/fixtures";

import {
  EMPTY_DRAFT,
  accountBudget,
  budgetChanges,
  capacityAfter,
  draftIncome,
  draftRefill,
  shareOf,
} from "./budget";

const main = account({ id: "1234", name: "Main", expected_income: "32000" });
const buffer = account({ id: "2345", name: "Buffer" });
const food = bucket({
  id: "1000000001",
  name: "Food",
  source_account_id: main.id,
  refill_amount: "6000.00",
  capacity: "6000.00",
});
const rent = bucket({
  id: "1000000002",
  name: "Rent",
  source_account_id: main.id,
  refill_amount: "12000",
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "13000.00",
  capacity: "13000.00",
});
const other = bucket({
  id: "1000000003",
  name: "Other",
  source_account_id: buffer.id,
  refill_amount: "100.00",
});
const all = [food, rent, other];

describe("draft values", () => {
  it("shows the saved value until edited", () => {
    expect(draftIncome(EMPTY_DRAFT, main)).toBe("32000.00");
    expect(draftIncome(EMPTY_DRAFT, buffer)).toBeNull();
    expect(draftRefill(EMPTY_DRAFT, rent)).toBe("12000.00");
    const draft = { incomes: { [main.id]: null }, ras: { [rent.id]: "100.00" } };
    expect(draftIncome(draft, main)).toBeNull();
    expect(draftRefill(draft, rent)).toBe("100.00");
  });
});

describe("accountBudget", () => {
  it("adds up the account's refill amounts against its income", () => {
    expect(accountBudget(EMPTY_DRAFT, main, all)).toEqual({
      expected: "32000.00",
      allocated: "18000.00",
      percent: 56.2,
      remainder: "14000.00",
      over: false,
    });
  });

  it("follows the draft, and counts an empty field as 0", () => {
    const draft = { incomes: { [main.id]: "15000.00" }, ras: { [food.id]: null } };
    expect(accountBudget(draft, main, all)).toMatchObject({
      allocated: "12000.00",
      percent: 80,
      remainder: "3000.00",
    });
    const over = { incomes: { [main.id]: "10000.00" }, ras: {} };
    expect(accountBudget(over, main, all)).toMatchObject({
      percent: 180,
      remainder: "-8000.00",
      over: true,
    });
  });

  it("has no share without an income", () => {
    expect(accountBudget(EMPTY_DRAFT, buffer, all)).toEqual({
      expected: null,
      allocated: "100.00",
      percent: null,
      remainder: null,
      over: false,
    });
    expect(
      accountBudget({ incomes: { [main.id]: "-5.00" }, ras: {} }, main, all).percent,
    ).toBeNull();
  });
});

describe("shareOf", () => {
  it("rounds down to one decimal", () => {
    expect(shareOf("6000.00", "32000.00")).toBe(18.7);
    expect(shareOf("1.00", "3.00")).toBe(33.3);
    expect(shareOf("1.00", null)).toBeNull();
    expect(shareOf("1.00", "0.00")).toBeNull();
  });
});

describe("capacityAfter", () => {
  it("follows a multiplier, and raises a fixed capacity below the refill amount", () => {
    const fuel = { ...food, cap_multiplier: "1.25" };
    expect(capacityAfter(fuel, "1000.00")).toEqual({ capacity: "1250.00", raised: false });
    expect(capacityAfter(rent, "12500.00")).toEqual({ capacity: "13000.00", raised: false });
    expect(capacityAfter(rent, "14000.00")).toEqual({ capacity: "14000.00", raised: true });
  });
});

describe("budgetChanges", () => {
  it("lists what differs from the saved values", () => {
    const draft = {
      incomes: { [main.id]: "32000.00", [buffer.id]: "5000.00" },
      ras: { [food.id]: "6000.00", [rent.id]: "11000.00" },
    };
    expect(budgetChanges(draft, [main, buffer], all)).toEqual({
      incomes: [{ account_id: buffer.id, expected_income: "5000.00" }],
      ras: [{ bucket_id: rent.id, refill_amount: "11000.00" }],
      count: 2,
      invalid: false,
    });
  });

  it("clears an income, and blocks an empty or negative refill amount", () => {
    expect(budgetChanges({ incomes: { [main.id]: null }, ras: {} }, [main], all)).toMatchObject({
      incomes: [{ account_id: main.id, expected_income: null }],
      count: 1,
      invalid: false,
    });
    for (const ra of [null, "-1.00"]) {
      expect(budgetChanges({ incomes: {}, ras: { [food.id]: ra } }, [main], all)).toMatchObject({
        ras: [],
        count: 1,
        invalid: true,
      });
    }
  });
});
