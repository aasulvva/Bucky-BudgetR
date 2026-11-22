import type { SavingsBudgetEntry, SavingsDistributor, SavingsRule } from "@/api/savings";
import { account, budgetEntry, bucket, savingsTarget } from "@/test/fixtures";

import { formatMoney } from "./money";

import {
  addKind,
  addOutcome,
  addProblem,
  bucketRoom,
  budgetStatus,
  budgetTargets,
  budgetTotal,
  freeAccounts,
  freeBuckets,
  gapsOf,
  goalProblem,
  heldProblem,
  pastGoal,
  progress,
  rangeProblem,
  rangeText,
  rulesEnd,
  rulesOf,
  sourceAccounts,
} from "./savings";

const main = account({ id: "1234", name: "Main", unallocated: "500.00" });
const other = account({ id: "3456", name: "Other", unallocated: "2000.00" });
const buffer = account({ id: "2345", name: "Buffer", type: "savings" });
const bsu = account({ id: "4567", name: "BSU", type: "bsu" });
const euro = account({ id: "5678", name: "Euro", currency: "EUR" });
const holiday = bucket({
  id: "1000000001",
  name: "Holiday",
  source_account_id: main.id,
  refill_mode: "fully_manual",
  cap_mode: "fixed",
  capacity: "3000.00",
  target_funds: "2800.00",
});
const gifts = bucket({
  id: "1000000002",
  name: "Gifts",
  source_account_id: main.id,
  refill_mode: "fully_manual",
  cap_mode: "none",
  capacity: null,
});
const food = bucket({ id: "1000000003", name: "Food", source_account_id: main.id });
const onBuffer = savingsTarget({ id: "1000001001", name: "Buffer", account_id: buffer.id });
const onHoliday = savingsTarget({
  id: "1000001002",
  name: "Holiday",
  account_id: null,
  bucket_id: holiday.id,
  goal: "3000.00",
  current: "2800.00",
});

describe("choosing a target", () => {
  it("offers Fully manual buckets and savings-type accounts that aren't targets yet", () => {
    expect(freeBuckets([holiday, gifts, food], [onHoliday]).map((b) => b.name)).toEqual(["Gifts"]);
    expect(freeAccounts([main, buffer, bsu], [onBuffer]).map((a) => a.name)).toEqual(["BSU"]);
  });

  it("keeps a bucket's goal within its fixed capacity", () => {
    expect(goalProblem(null, undefined)).toBe("notPositive");
    expect(goalProblem("0.00", gifts)).toBe("notPositive");
    expect(goalProblem("3000.01", holiday)).toBe("aboveCapacity");
    expect(goalProblem("3000.00", holiday)).toBeNull();
    expect(goalProblem("999999.00", gifts)).toBeNull();
  });
});

describe("progress", () => {
  it("counts the current funds and what's held", () => {
    const p = progress({ ...onBuffer, current: "2500.00", held_total: "1500.00" });
    expect(p).toEqual({
      saved: "4000.00",
      pct: 40,
      currentPct: 25,
      heldPct: 15,
      left: "6000.00",
      reached: false,
    });
  });

  it("stops at the goal, and doesn't count a negative balance", () => {
    expect(progress({ ...onBuffer, current: "12000.00" })).toMatchObject({
      pct: 100,
      left: "0.00",
      reached: true,
    });
    expect(progress({ ...onBuffer, current: "-50.00", held_total: "100.00" }).saved).toBe("100.00");
  });
});

describe("Add to savings", () => {
  it("adds from accounts in the target's currency, not the target account", () => {
    expect(sourceAccounts(onBuffer, [main, buffer, euro]).map((a) => a.name)).toEqual(["Main"]);
  });

  it("goes straight into a bucket target from its own account, else is held", () => {
    expect(addKind(onHoliday, main.id, [holiday])).toBe("direct");
    expect(addKind(onHoliday, other.id, [holiday])).toBe("hold");
    expect(addKind(onBuffer, main.id, [holiday])).toBe("hold");
  });

  it("takes at most what's unallocated, and what a capped bucket has room for", () => {
    expect(bucketRoom(holiday)).toBe("200.00");
    expect(bucketRoom(gifts)).toBeNull();
    expect(addProblem(onBuffer, main, "500.01", [])).toBe("overUnallocated");
    expect(addProblem(onBuffer, main, "500.00", [])).toBeNull();
    expect(addProblem(onHoliday, main, "200.01", [holiday])).toBe("overCapacity");
    // Held on another account, the bucket's room doesn't matter yet.
    expect(addProblem(onHoliday, other, "1000.00", [holiday])).toBeNull();
    expect(addProblem(onBuffer, main, null, [])).toBe("notPositive");
  });

  it("notes when it goes past the goal", () => {
    expect(pastGoal(onHoliday, "200.00")).toBe(false);
    expect(pastGoal(onHoliday, "200.01")).toBe(true);
  });
});

describe("Done and Clear", () => {
  const held = {
    ...onHoliday,
    held: [{ account_id: other.id, amount: "500.00", covered: "500.00" }],
    held_total: "500.00",
  };

  it("takes at most what's held, and Done stays within the bucket's room", () => {
    expect(heldProblem(held, other.id, "500.01", [holiday], false)).toBe("overHeld");
    expect(heldProblem(held, other.id, "500.00", [holiday], false)).toBeNull();
    expect(heldProblem(held, other.id, "300.00", [holiday], true)).toBe("overCapacity");
    expect(heldProblem(held, other.id, "200.00", [holiday], true)).toBeNull();
    expect(heldProblem(held, main.id, "1.00", [holiday], false)).toBe("overHeld");
  });
});

describe("the distributor's rules (#232)", () => {
  const rule = (
    id: string,
    from: string,
    to: string | null,
    target = "1000001001",
  ): SavingsRule => ({
    id,
    target_id: target,
    from,
    to,
    priority: 3,
    past_goal: false,
  });
  const low = rule("100000100101", "0.00", "30000.00");
  const high = rule("100000100102", "40000.00", null);
  const other = rule("100000100201", "0.00", null, "1000001002");

  it("lists a target's rules by where they start", () => {
    expect(rulesOf([high, other, low], "1000001001")).toEqual([low, high]);
  });

  it("refuses overlaps but lets ranges touch", () => {
    expect(rangeProblem({ from: "30000.00", to: "40000.00" }, [low, high])).toBeNull();
    expect(rangeProblem({ from: "29999.99", to: "35000.00" }, [low, high])).toEqual({
      problem: "overlap",
      with: low,
    });
    expect(rangeProblem({ from: "35000.00", to: null }, [low, high])).toEqual({
      problem: "overlap",
      with: high,
    });
    // The rule being edited doesn't overlap itself.
    expect(rangeProblem({ from: "0.00", to: "35000.00" }, [low, high], low.id)).toBeNull();
    expect(rangeProblem({ from: "500.00", to: "500.00" }, [])).toEqual({ problem: "toNotAbove" });
    expect(rangeProblem({ from: null, to: null }, [])).toEqual({ problem: "noFrom" });
  });

  it("finds the stretches no rule covers", () => {
    expect(gapsOf([high, low])).toEqual([{ from: "30000.00", to: "40000.00" }]);
    expect(gapsOf([high])).toEqual([{ from: "0.00", to: "40000.00" }]);
    expect(gapsOf([low])).toEqual([]);
    expect(rulesEnd([low])).toBe("30000.00");
    expect(rulesEnd([low, high])).toBeNull();
    expect(rulesEnd([])).toBe("0.00");
  });

  it("writes a range", () => {
    expect(rangeText(low, "NOK")).toBe(`${formatMoney("0.00")} – ${formatMoney("30000.00")}`);
    expect(rangeText(high, "NOK")).toBe(`${formatMoney("40000.00")} and up`);
  });

  it("says what adding does by the hold mode", () => {
    const dist = (over: Partial<SavingsDistributor>): SavingsDistributor => ({
      id: "1000009999",
      hold_mode: "immediate",
      min_amount: null,
      held: [{ account_id: main.id, amount: "600.00", covered: "600.00" }],
      ...over,
    });
    expect(addOutcome(dist({}), main.id, "100.00")).toBe("split");
    expect(addOutcome(dist({ hold_mode: "manual" }), main.id, "100.00")).toBe("waits");
    const minimum = dist({ hold_mode: "minimum", min_amount: "1000.00" });
    expect(addOutcome(minimum, main.id, "399.99")).toBe("belowMinimum");
    expect(addOutcome(minimum, main.id, "400.00")).toBe("reachesMinimum");
    // Per account: nothing is held on Other.
    expect(addOutcome(minimum, other.id, "400.00")).toBe("belowMinimum");
  });
});

describe("the savings budget (#234)", () => {
  const entry = (over: Partial<SavingsBudgetEntry>) => budgetEntry({ id: "1234000001", ...over });
  const run = (wanted: string, reserved: string) => ({ wanted, reserved, at: null });

  it("says where each entry is this cycle", () => {
    expect(budgetStatus(entry({ stopped: true, this_cycle: run("5.00", "5.00") }), true)).toBe(
      "stopped",
    );
    expect(budgetStatus(entry({ this_cycle: run("500.00", "500.00") }), true)).toBe("saved");
    expect(budgetStatus(entry({ this_cycle: run("500.00", "120.00") }), true)).toBe("short");
    // Set up mid-cycle to start next cycle.
    expect(budgetStatus(entry({ this_cycle: run("0.00", "0.00") }), true)).toBe("nextCycle");
    expect(budgetStatus(entry({ when: "cycle_start" }), true)).toBe("nextCycle");
    expect(budgetStatus(entry({ when: "on_income" }), true)).toBe("waitingIncome");
    expect(budgetStatus(entry({ when: "manual" }), true)).toBe("saveNow");
    expect(budgetStatus(entry({ when: "manual" }), false)).toBe("noCycle");
  });

  it("adds up what runs per account, and offers targets in its currency but not itself", () => {
    const main = account({ id: "1234", name: "Main" });
    const entries = [
      entry({ amount: "500.00" }),
      entry({ id: "1234000002", amount: "250.00" }),
      entry({ id: "1234000003", amount: "999.00", stopped: true }),
      entry({ id: "2345000001", account_id: "2345", amount: "100.00" }),
    ];
    expect(budgetTotal(entries, main.id)).toBe("750.00");
    const own = savingsTarget({ id: "1000001001", name: "Own", account_id: main.id });
    const euro = savingsTarget({ id: "1000001002", name: "Euro", currency: "EUR" });
    const ok = savingsTarget({ id: "1000001003", name: "Ok" });
    expect(budgetTargets([own, euro, ok], main).map((x) => x.name)).toEqual(["Ok"]);
    expect(budgetTargets([ok], undefined)).toEqual([]);
  });
});
