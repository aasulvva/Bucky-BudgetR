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

  it("leaves out what the buckets left take back on an underfunded account (demouser's Regningskonto)", () => {
    const rent = bucket({
      ...base,
      id: "1000000005",
      name: "Rent",
      refill_amount: "12500.00",
      capacity: "12500.00",
      target_funds: "12500.00",
      current_available_funds: "6594.56",
    });
    const insurance = bucket({
      ...base,
      id: "1000000006",
      name: "Insurance",
      keep_funds: true,
      target_funds: "2400.00",
      current_available_funds: "0.00",
    });
    const bills = {
      id: "1234",
      currency: "NOK",
      balance: "6594.56",
      reserved: "0.00",
      unallocated: "0.00",
    };
    // Insurance keeps its TF and takes 2 400 of Rent's 6 594.56.
    expect(endPreview([rent, insurance], false, [bills]).backToUnallocated).toEqual([
      { currency: "NOK", amount: "4194.56" },
    ]);
    // A fully funded account gets all of the funded part back.
    const funded = { ...bills, balance: "8994.56", unallocated: "0.00" };
    const full = { ...insurance, current_available_funds: "2400.00" };
    expect(endPreview([rent, full], false, [funded]).backToUnallocated).toEqual([
      { currency: "NOK", amount: "6594.56" },
    ]);
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
    current_available_funds: "800.00",
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
  const all = [food, saved, elsewhere];
  const main = { id: "1234", balance: "2100.00", reserved: "0.00" };

  it("sweeps what the emptied buckets give back, but not what they send to savings", () => {
    // 2 100 − the 300 the saved bucket's OVF holds for savings − 200 to keep.
    expect(sweepEstimate(all, endPreview(all, false), main, "200.00")).toBe("1600.00");
  });

  it("funds the buckets left first, as an underfunded account does (demouser's Regningskonto)", () => {
    const rent = bucket({
      id: "1000000004",
      name: "Rent",
      source_account_id: "1639",
      target_funds: "12500.00",
      current_available_funds: "6594.56",
    });
    const insurance = bucket({
      id: "1000000005",
      name: "Insurance",
      source_account_id: "1639",
      keep_funds: true,
      target_funds: "2400.00",
      current_available_funds: "0.00",
    });
    const list = [rent, insurance];
    const bills = { id: "1639", balance: "6594.56", reserved: "0.00" };
    // Rent is emptied, Insurance takes 2 400 of it: 6 594.56 − 2 400 − 1 000.
    expect(sweepEstimate(list, endPreview(list, false), bills, "1000.00")).toBe("3194.56");
  });

  it("covers the savings holds before it, and is never below 0", () => {
    const held = { ...main, reserved: "1500.00" };
    expect(sweepEstimate(all, endPreview(all, false), held, "0.00")).toBe("300.00");
    expect(sweepEstimate(all, endPreview(all, false), main, "5000.00")).toBe("0.00");
  });

  it("covers the card debt held on the account first (#261)", () => {
    const holding = {
      ...main,
      card_holds: [
        { card_id: "8000", amount: "700.00" },
        { card_id: "8001", amount: "100.00" },
      ],
    };
    // 2 100 − 800 card debt − 300 for savings − 200 to keep.
    expect(sweepEstimate(all, endPreview(all, false), holding, "200.00")).toBe("800.00");
    // Debt above the money leaves nothing to sweep.
    const owing = { ...main, card_holds: [{ card_id: "8000", amount: "5000.00" }] };
    expect(sweepEstimate(all, endPreview(all, false), owing, "0.00")).toBe("0.00");
  });

  it("counts what the buckets are owed for purchases that wait (#264)", () => {
    const owed = {
      ...main,
      waiting: "400.00",
      card_holds: [{ card_id: "8000", amount: "400.00" }],
    };
    // The advance makes up for the debt it waits on: 2 100 − 300 − 200.
    expect(sweepEstimate(all, endPreview(all, false), owed, "200.00")).toBe("1600.00");
  });
});
