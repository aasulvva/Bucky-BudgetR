import { bucket } from "@/test/fixtures";

import { endPreview, sweepEstimate } from "./cycleEnd";

const base = { source_account_id: "1234" };

describe("endPreview", () => {
  const groceries = bucket({
    ...base,
    id: "1000000001",
    name: "Groceries",
    refill_amount: "4000.00",
    capacity: "4000.00",
    target_funds: "800.00",
    current_available_funds: "500.00",
  });
  const overdrawn = bucket({
    ...base,
    id: "1000000002",
    name: "Transport",
    refill_amount: "2000.00",
    capacity: "2000.00",
    target_funds: "-150.00",
  });
  const car = bucket({
    ...base,
    id: "1000000003",
    name: "Car",
    keep_funds: true,
    refill_amount: "1000.00",
    capacity: "5000.00",
    target_funds: "4500.00",
    current_available_funds: "4500.00",
  });
  const hobby = bucket({
    ...base,
    id: "1000000004",
    name: "Hobby",
    refill_mode: "manual",
    refill_amount: "1000.00",
    capacity: "1000.00",
    target_funds: "299.50",
    current_available_funds: "299.50",
  });

  it("empties Keep funds off buckets and refills the Auto ones", () => {
    const p = endPreview([groceries, overdrawn, car, hobby], true);
    expect(p.emptied.map((e) => [e.bucket.name, e.amount, e.funded])).toEqual([
      ["Groceries", "800.00", "500.00"],
      ["Hobby", "299.50", "299.50"],
    ]);
    expect(p.backToUnallocated).toEqual([{ currency: "NOK", amount: "799.50" }]);
    expect(p.toSavings).toEqual([]);
    expect(p.refilled.map((r) => [r.bucket.name, r.amount, r.overflow])).toEqual([
      // Emptied to 0, then set to RA.
      ["Groceries", "4000.00", "0.00"],
      // A negative TF stays at the end and is cleared by the refill.
      ["Transport", "2150.00", "0.00"],
      // Keep funds on: RA is added, the excess above BC overflows.
      ["Car", "1000.00", "500.00"],
    ]);
  });

  it("refills nothing when no cycle starts", () => {
    const p = endPreview([groceries, car], false);
    expect(p.emptied).toHaveLength(1);
    expect(p.refilled).toEqual([]);
  });

  it("leaves out refills of 0", () => {
    const full = bucket({ ...base, id: "1000000005", name: "Zero", refill_amount: "0.00" });
    expect(endPreview([full], true).refilled).toEqual([]);
  });

  it("counts what goes to savings apart from what goes back to unallocated (#233)", () => {
    const saved = { ...hobby, overflow_destination: "savings_distribution" as const };
    const p = endPreview([groceries, saved], false);
    expect(p.backToUnallocated).toEqual([{ currency: "NOK", amount: "500.00" }]);
    expect(p.toSavings).toEqual([{ currency: "NOK", amount: "299.50" }]);
  });
});

describe("sweepEstimate (#235)", () => {
  const food = bucket({
    id: "1000000001",
    name: "Food",
    source_account_id: "1234",
    target_funds: "800.00",
    current_available_funds: "500.00",
  });
  const saved = bucket({
    id: "1000000002",
    name: "Saved",
    source_account_id: "1234",
    target_funds: "300.00",
    current_available_funds: "300.00",
    overflow_destination: "savings_distribution",
  });
  const elsewhere = bucket({
    id: "1000000003",
    name: "Elsewhere",
    source_account_id: "2345",
    target_funds: "900.00",
    current_available_funds: "900.00",
  });
  const preview = endPreview([food, saved, elsewhere], false);
  const main = { id: "1234", unallocated: "1000.00" };

  it("adds what the account's emptied buckets give back to unallocated, less keep", () => {
    // Only Food's funded 500: the saved one's goes to savings, the other's to its account.
    expect(sweepEstimate(preview, main, "200.00")).toBe("1300.00");
  });

  it("is never below 0", () => {
    expect(sweepEstimate(preview, main, "5000.00")).toBe("0.00");
  });
});
