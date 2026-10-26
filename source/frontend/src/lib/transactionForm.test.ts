import type { CounterpartySuggestion } from "@/api/transactions";
import { account, bucket, cycle } from "@/test/fixtures";

import {
  bucketTotals,
  fromLastTime,
  initialAccount,
  insideCycle,
  newLine,
  prefillFor,
  ruleMatches,
  waitingOnIncome,
  type FormState,
} from "./transactionForm";

const main = account({ id: "1234", name: "Main account" });
const buffer = account({ id: "2345", name: "Buffer account" });
const groceries = bucket({ id: "1000000001", name: "Groceries", source_account_id: main.id });
const household = bucket({ id: "1000000002", name: "Household", source_account_id: main.id });
const car = bucket({ id: "1000000003", name: "Car", source_account_id: buffer.id });

describe("bucketTotals and prefillFor", () => {
  it("adds up the rows and what's left", () => {
    const lines = [newLine(groceries.id, "200.40"), newLine(null, null)];
    expect(bucketTotals("250.40", lines)).toEqual({
      inBuckets: "200.40",
      notTied: "50.00",
      over: false,
    });
    expect(prefillFor("250.40", lines)).toBe("50.00");
    expect(prefillFor("200.40", lines)).toBeNull();
    expect(prefillFor(null, [])).toBeNull();
    expect(bucketTotals("100.00", [newLine(groceries.id, "150.00")])).toEqual({
      inBuckets: "150.00",
      notTied: "-50.00",
      over: true,
    });
  });
});

describe("waitingOnIncome and ruleMatches", () => {
  it("finds the account's On income buckets that aren't refilled", () => {
    const food = { ...groceries, refill_mode: "on_income" as const };
    const done = { ...household, refill_mode: "on_income" as const, refilled: true };
    expect(waitingOnIncome([food, done, car], main.id)).toEqual([food]);
    expect(waitingOnIncome([food], buffer.id)).toEqual([]);
  });

  it("matches a rule like the backend: same name ignoring case, at least the minimum", () => {
    const rules = [{ counterparty: "Employer AS", min_amount: "20000" }];
    expect(ruleMatches(rules, " employer as ", "20000.00")).toBe(true);
    expect(ruleMatches(rules, "Employer AS", "19999.99")).toBe(false);
    expect(ruleMatches(rules, "Employer", "30000.00")).toBe(false);
    expect(ruleMatches(rules, "Employer AS", null)).toBe(false);
  });
});

describe("insideCycle", () => {
  it("checks the time, or now, against the cycle", () => {
    const c = cycle();
    expect(insideCycle(null, c)).toBe(true);
    expect(insideCycle(c.start_at, c)).toBe(true);
    expect(insideCycle(c.end_at, c)).toBe(false);
    expect(insideCycle(new Date(new Date(c.start_at).getTime() - 1).toISOString(), c)).toBe(false);
    expect(insideCycle(null, null)).toBe(false);
  });
});

describe("fromLastTime", () => {
  const rema: CounterpartySuggestion = {
    counterparty: "Rema 1000",
    type: "EXP",
    at: "2026-10-20T10:00:00Z",
    account_id: main.id,
    tags: ["food"],
    bucket_ids: [groceries.id, household.id, "1000009999"],
  };
  const empty: FormState = {
    amount: "250.40",
    accountId: buffer.id,
    accountTouched: false,
    tags: [],
    lines: [],
    bucketsAllowed: true,
  };
  const all = [main, buffer];
  const buckets = [groceries, household, car];

  it("fills in the account, tags and buckets, the first with the whole amount", () => {
    const out = fromLastTime(rema, empty, all, buckets);
    expect(out.accountId).toBe(main.id);
    expect(out.tags).toEqual(["food"]);
    expect(out.lines?.map((l) => [l.bucketId, l.amount])).toEqual([
      [groceries.id, "250.40"],
      [household.id, null],
    ]);
  });

  it("keeps what the user entered", () => {
    const out = fromLastTime(
      rema,
      { ...empty, accountTouched: true, tags: ["party"], lines: [newLine(car.id, "10.00")] },
      all,
      buckets,
    );
    expect(out).toEqual({});
  });

  it("only offers buckets still funded from the account", () => {
    const out = fromLastTime(rema, { ...empty, accountTouched: true }, all, buckets);
    expect(out.accountId).toBeUndefined();
    expect(out.lines).toBeUndefined();
  });

  it("adds no buckets without an active cycle, nor a deleted account", () => {
    expect(
      fromLastTime(rema, { ...empty, bucketsAllowed: false }, all, buckets).lines,
    ).toBeUndefined();
    expect(fromLastTime(rema, empty, [buffer], buckets).accountId).toBeUndefined();
  });
});

describe("initialAccount", () => {
  it("uses the last account if it still exists, or the only one", () => {
    expect(initialAccount([main, buffer], buffer.id)).toBe(buffer.id);
    expect(initialAccount([main, buffer], "9999")).toBeNull();
    expect(initialAccount([main], null)).toBe(main.id);
  });
});
