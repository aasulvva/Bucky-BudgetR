import { account, bucket, savingsTarget } from "@/test/fixtures";

import {
  addKind,
  addProblem,
  bucketRoom,
  freeAccounts,
  freeBuckets,
  goalProblem,
  heldProblem,
  pastGoal,
  progress,
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
