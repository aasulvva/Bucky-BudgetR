import { describe, expect, it } from "vitest";

import { account, bucket } from "@/test/fixtures";

import {
  adjustPreview,
  adjustProblem,
  fundsPreview,
  fundsProblem,
  fundsRoom,
  movePreview,
  moveProblem,
} from "./bucketAdjust";

const fuel = bucket({
  id: "1000000001",
  name: "Fuel",
  source_account_id: "1234",
  refill_amount: "1000",
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "1200.00",
  capacity: "1200.00",
  target_funds: "100.00",
});
const fun = bucket({
  id: "1000000002",
  name: "Fun",
  source_account_id: "1234",
  refill_amount: "200.00",
  target_funds: "50.00",
});

describe("adjustPreview", () => {
  it("sets this cycle only", () => {
    expect(adjustPreview(fuel, "temporary", "400.00")).toEqual({
      ra: { from: "1000.00", to: "1000.00" },
      tf: { from: "100.00", to: "400.00" },
      bua: "300.00",
      capacity: { capacity: "1200.00", raised: false },
    });
  });

  it("changes the refill amount only, raising a fixed capacity", () => {
    expect(adjustPreview(fuel, "future", "1500.00")).toEqual({
      ra: { from: "1000.00", to: "1500.00" },
      tf: { from: "100.00", to: "100.00" },
      bua: "0.00",
      capacity: { capacity: "1500.00", raised: true },
    });
  });

  it("changes this cycle by the refill amount's change, below 0 too", () => {
    expect(adjustPreview(fuel, "both", "1200.00")).toMatchObject({
      tf: { from: "100.00", to: "300.00" },
      bua: "200.00",
    });
    expect(adjustPreview(fuel, "both", "500.00")).toMatchObject({
      tf: { from: "100.00", to: "-400.00" },
      bua: "-500.00",
    });
  });
});

describe("adjustProblem", () => {
  it("needs a different amount of 0 or more", () => {
    expect(adjustProblem(fuel, "temporary", null)).toBe("empty");
    expect(adjustProblem(fuel, "temporary", "-1.00")).toBe("negative");
    expect(adjustProblem(fuel, "temporary", "100.00")).toBe("same");
    expect(adjustProblem(fuel, "future", "1000.00")).toBe("same");
    expect(adjustProblem(fuel, "both", "100.00")).toBeNull();
    expect(adjustProblem(fuel, "temporary", "0.00")).toBeNull();
  });
});

describe("movePreview", () => {
  it("moves what the mode says", () => {
    expect(movePreview(fuel, fun, "temporary", "30.00")).toEqual({
      from: { ra: { from: "1000.00", to: "1000.00" }, tf: { from: "100.00", to: "70.00" } },
      to: { ra: { from: "200.00", to: "200.00" }, tf: { from: "50.00", to: "80.00" } },
      overspends: false,
    });
    expect(movePreview(fuel, fun, "future", "300.00")).toMatchObject({
      from: { ra: { to: "700.00" }, tf: { to: "100.00" } },
      to: { ra: { to: "500.00" }, tf: { to: "50.00" } },
    });
    expect(movePreview(fuel, fun, "both", "300.00")).toMatchObject({
      from: { ra: { to: "700.00" }, tf: { to: "-200.00" } },
      overspends: true,
    });
  });
});

describe("moveProblem", () => {
  it("needs an amount above 0, within the refill amount when that moves", () => {
    expect(moveProblem(fuel, "temporary", null)).toBe("empty");
    expect(moveProblem(fuel, "temporary", "0.00")).toBe("notPositive");
    expect(moveProblem(fuel, "temporary", "5000.00")).toBeNull();
    expect(moveProblem(fuel, "future", "1000.01")).toBe("overRefill");
    expect(moveProblem(fuel, "both", "1000.00")).toBeNull();
  });
});

const holiday = bucket({
  id: "1000000003",
  name: "Holiday",
  source_account_id: "1234",
  refill_mode: "fully_manual",
  keep_funds: true,
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "1000.00",
  capacity: "1000.00",
  target_funds: "700.00",
});
const gifts = bucket({
  id: "1000000004",
  name: "Gifts",
  source_account_id: "1234",
  refill_mode: "fully_manual",
  keep_funds: true,
  cap_mode: "none",
  cap_multiplier: null,
  capacity: null,
});

describe("moveProblem into a Fully manual bucket", () => {
  it("keeps it within its capacity", () => {
    expect(moveProblem(fuel, "temporary", "300", holiday)).toBeNull();
    expect(moveProblem(fuel, "temporary", "300.01", holiday)).toBe("overCapacity");
    expect(moveProblem(fuel, "temporary", "5000", gifts)).toBeNull();
    // Only Fully manual buckets are held to it.
    expect(moveProblem(holiday, "temporary", "5000", fuel)).toBeNull();
  });
});

describe("fundsPreview", () => {
  // Σ positive TF 850 of a 1 000 balance.
  const main = account({ id: "1234", name: "Main", balance: "1000.00", unallocated: "150.00" });
  const all = [fuel, fun, holiday, gifts];

  it("adds and removes TF with a BUA", () => {
    expect(fundsPreview(holiday, main, all, "add", "100")).toEqual({
      tf: { from: "700.00", to: "800.00" },
      bua: "100.00",
      short: "0.00",
    });
    expect(fundsPreview(holiday, main, all, "remove", "700")).toEqual({
      tf: { from: "700.00", to: "0.00" },
      bua: "-700.00",
      short: "0.00",
    });
  });

  it("says how much more the account falls short", () => {
    expect(fundsPreview(gifts, main, all, "add", "400").short).toBe("250.00");
    const short = { ...main, balance: "800.00" };
    expect(fundsPreview(gifts, short, all, "add", "100").short).toBe("100.00");
  });
});

describe("fundsProblem", () => {
  it("adds up to the capacity and removes down to 0", () => {
    expect(fundsProblem(holiday, "add", null)).toBe("empty");
    expect(fundsProblem(holiday, "add", "0")).toBe("notPositive");
    expect(fundsProblem(holiday, "add", "300")).toBeNull();
    expect(fundsProblem(holiday, "add", "300.01")).toBe("overCapacity");
    expect(fundsProblem(gifts, "add", "100000")).toBeNull();
    expect(fundsProblem(holiday, "remove", "700")).toBeNull();
    expect(fundsProblem(holiday, "remove", "700.01")).toBe("overFunds");
  });

  it("knows the room left", () => {
    expect(fundsRoom(holiday)).toBe("300.00");
    expect(fundsRoom({ ...holiday, target_funds: "1200.00" })).toBe("0.00");
    expect(fundsRoom(gifts)).toBeNull();
  });
});
