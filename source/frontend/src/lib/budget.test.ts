import { describe, expect, it } from "vitest";

import { account, bucket } from "@/test/fixtures";

import {
  EMPTY_DRAFT,
  accountBudget,
  budgetChanges,
  capacityAfter,
  cycleChanges,
  draftIncome,
  draftRefill,
  newCapacity,
  shareOf,
  type BucketCreate,
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
    const draft = {
      incomes: { [main.id]: null },
      ras: { [rent.id]: "100.00" },
      created: [],
      deleted: [],
    };
    expect(draftIncome(draft, main)).toBeNull();
    expect(draftRefill(draft, rent)).toBe("100.00");
  });

  it("takes a missing expected income as not entered", () => {
    const old = { ...main };
    delete (old as Partial<typeof main>).expected_income;
    expect(draftIncome(EMPTY_DRAFT, old)).toBeNull();
    expect(budgetChanges(EMPTY_DRAFT, [old], all).count).toBe(0);
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
    const draft = {
      incomes: { [main.id]: "15000.00" },
      ras: { [food.id]: null },
      created: [],
      deleted: [],
    };
    expect(accountBudget(draft, main, all)).toMatchObject({
      allocated: "12000.00",
      percent: 80,
      remainder: "3000.00",
    });
    const over = { incomes: { [main.id]: "10000.00" }, ras: {}, created: [], deleted: [] };
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
      accountBudget(
        { incomes: { [main.id]: "-5.00" }, ras: {}, created: [], deleted: [] },
        main,
        all,
      ).percent,
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
      created: [],
      deleted: [],
    };
    expect(budgetChanges(draft, [main, buffer], all)).toEqual({
      deleted: [],
      created: [],
      incomes: [{ account_id: buffer.id, expected_income: "5000.00" }],
      ras: [{ bucket_id: rent.id, refill_amount: "11000.00" }],
      count: 2,
      invalid: false,
    });
  });

  it("clears an income, and blocks an empty or negative refill amount", () => {
    expect(
      budgetChanges(
        { incomes: { [main.id]: null }, ras: {}, created: [], deleted: [] },
        [main],
        all,
      ),
    ).toMatchObject({
      incomes: [{ account_id: main.id, expected_income: null }],
      count: 1,
      invalid: false,
    });
    for (const ra of [null, "-1.00"]) {
      expect(
        budgetChanges(
          { incomes: {}, ras: { [food.id]: ra }, created: [], deleted: [] },
          [main],
          all,
        ),
      ).toMatchObject({
        ras: [],
        count: 1,
        invalid: true,
      });
    }
  });
});

describe("cycleChanges", () => {
  const account1 = account({ id: "1234", name: "Main", balance: "1000.00" });
  const refilled = bucket({
    id: "1000000011",
    name: "Refilled",
    source_account_id: account1.id,
    refill_amount: "500.00",
    target_funds: "300.00",
    refilled: true,
  });
  const waiting = bucket({
    id: "1000000012",
    name: "Waiting",
    source_account_id: account1.id,
    refill_amount: "400.00",
    target_funds: "0.00",
  });
  const other = bucket({
    id: "1000000013",
    name: "Other",
    source_account_id: account1.id,
    target_funds: "200.00",
  });
  const all = [refilled, waiting, other];
  const save = (...ras: [string, string][]) =>
    cycleChanges(
      budgetChanges(
        { incomes: {}, ras: Object.fromEntries(ras), created: [], deleted: [] },
        [account1],
        all,
      ),
      [account1],
      all,
    );

  it("moves a refilled bucket's TF by the change, and leaves a waiting one", () => {
    const [main] = save([refilled.id, "900"], [waiting.id, "100"]);
    expect(main?.rows).toEqual([
      {
        bucket: refilled,
        ra: { from: "500.00", to: "900.00" },
        change: "400.00",
        tf: { from: "300.00", to: "700.00" },
      },
      {
        bucket: waiting,
        ra: { from: "400.00", to: "100.00" },
        change: null,
        tf: { from: "0.00", to: "0.00" },
      },
    ]);
    // 700 + 200 of TF against a balance of 1 000.
    expect(main?.short).toBe("0.00");
  });

  it("says what the balance doesn't cover, ignoring overspent buckets", () => {
    expect(save([refilled.id, "1400"])[0]?.short).toBe("400.00");
    // TF below 0 counts as nothing, as on Buckets.
    expect(save([refilled.id, "100"])[0]?.rows[0]?.tf.to).toBe("-100.00");
    expect(save([refilled.id, "100"])[0]?.short).toBe("0.00");
  });

  it("leaves out accounts without changes", () => {
    expect(save()).toEqual([]);
  });
});

describe("new buckets in the draft (#112)", () => {
  const gifts: BucketCreate = {
    name: "Gifts",
    source_account_id: main.id,
    importance: 5,
    refill_amount: "2000.00",
    cap_mode: "multiplier",
    cap_multiplier: "1.5",
  };
  const manual: BucketCreate = {
    name: "Savings",
    source_account_id: main.id,
    importance: 5,
    refill_amount: "0.00",
    refill_mode: "fully_manual",
    cap_mode: "none",
  };
  const draft = {
    incomes: {},
    ras: {},
    deleted: [],
    created: [
      { key: "1", body: gifts },
      { key: "2", body: manual },
      { key: "3", body: { ...gifts, name: "Fuel", source_account_id: buffer.id } },
    ],
  };

  it("counts what they take of their account's income, except Fully manual ones", () => {
    expect(accountBudget(draft, main, all)).toMatchObject({
      allocated: "20000.00",
      percent: 62.5,
      remainder: "12000.00",
    });
  });

  it("creates them on Save, each counted as a change", () => {
    const changes = budgetChanges(draft, [main, buffer], all);
    expect(changes.count).toBe(3);
    expect(changes.created.map((n) => n.body.name)).toEqual(["Gifts", "Savings", "Fuel"]);
    expect(changes.invalid).toBe(false);
  });

  it("works out their capacity as the server does", () => {
    expect(newCapacity(gifts)).toBe("3000.00");
    expect(newCapacity({ ...gifts, cap_mode: "fixed", cap_amount: "1500.00" })).toBe("2000.00");
    expect(newCapacity({ ...gifts, cap_mode: "fixed", cap_amount: "2500" })).toBe("2500.00");
    expect(newCapacity(manual)).toBeNull();
  });
});

describe("deleted buckets in the draft (#174)", () => {
  const draft = {
    incomes: {},
    ras: { [food.id]: "9000.00", [rent.id]: "-1" },
    created: [],
    deleted: [rent.id],
  };

  it("leaves them out of what's allocated", () => {
    expect(accountBudget(draft, main, all).allocated).toBe("9000.00");
  });

  it("deletes them on Save, without their refill amount edits", () => {
    const changes = budgetChanges(draft, [main], all);
    expect(changes.deleted.map((b) => b.id)).toEqual([rent.id]);
    // Food's RA and the delete; Rent's invalid edit doesn't count.
    expect(changes.count).toBe(2);
    expect(changes.invalid).toBe(false);
    expect(changes.ras).toEqual([{ bucket_id: food.id, refill_amount: "9000.00" }]);
  });
});
