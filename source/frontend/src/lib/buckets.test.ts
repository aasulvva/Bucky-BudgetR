import { account, bucket, bucketFigures } from "@/test/fixtures";

import {
  accountSummary,
  breakdown,
  breakdownText,
  coverage,
  refillOf,
  usageColor,
} from "./buckets";
import { formatMoney } from "./money";

const main = account({ id: "1234", name: "Main account", balance: "1000.00" });
const base = { source_account_id: main.id };

describe("coverage", () => {
  it("is ok when the account backs all of TF", () => {
    const b = bucket({ ...base, id: "1", name: "A", target_funds: "500.00" });
    expect(coverage({ ...b, current_available_funds: "500.00" })).toEqual({
      gap: "0.00",
      coveredPct: 100,
      overspent: false,
      tone: "ok",
    });
    expect(coverage({ ...b, target_funds: "0.00" }).tone).toBe("ok");
  });

  it("is red when the bucket is overspent", () => {
    const b = bucket({ ...base, id: "1", name: "A", target_funds: "-50.00" });
    expect(coverage(b)).toEqual({ gap: "0.00", coveredPct: 100, overspent: true, tone: "alert" });
  });

  it("warns about the gap, in red for a priority bucket", () => {
    const b = bucket({
      ...base,
      id: "1",
      name: "A",
      target_funds: "500.00",
      current_available_funds: "200.00",
    });
    expect(coverage(b)).toEqual({ gap: "300.00", coveredPct: 40, overspent: false, tone: "warn" });
    expect(coverage({ ...b, priority: true }).tone).toBe("alert");
  });
});

describe("accountSummary", () => {
  const rent = bucket({
    ...base,
    id: "1",
    name: "Rent",
    priority: true,
    target_funds: "800.00",
    current_available_funds: "800.00",
  });
  const fun = bucket({
    ...base,
    id: "2",
    name: "Fun",
    target_funds: "400.00",
    current_available_funds: "200.00",
  });
  const other = bucket({
    id: "3",
    name: "Other",
    source_account_id: "9999",
    target_funds: "50.00",
  });

  it("sums the account's buckets and what the balance lacks", () => {
    expect(accountSummary(main, [rent, fun, other])).toEqual({
      left: "1200.00",
      short: "200.00",
      unallocated: "0.00",
      tone: "warn",
    });
  });

  it("is red when a priority bucket isn't covered", () => {
    expect(accountSummary(main, [{ ...rent, current_available_funds: "600.00" }, fun]).tone).toBe(
      "alert",
    );
  });

  it("isn't short when the balance covers them; overspent buckets don't add", () => {
    const rich = { ...main, balance: "2000.00", unallocated: "1100.00" };
    // An overspent bucket is red, but the account isn't short.
    const overspent = {
      ...fun,
      priority: true,
      target_funds: "-300.00",
      current_available_funds: "0.00",
    };
    expect(accountSummary(rich, [rent, overspent])).toEqual({
      left: "500.00",
      short: "0.00",
      unallocated: "1100.00",
      tone: "ok",
    });
  });
});

describe("usageColor", () => {
  it("is yellow above 90 % and red above 100 %", () => {
    expect(usageColor(90)).toBeUndefined();
    expect(usageColor(91)).toBe("yellow");
    expect(usageColor(100)).toBe("yellow");
    expect(usageColor(101)).toBe("red");
  });
});

describe("breakdown", () => {
  const figures = bucketFigures({
    bucket_id: "1",
    start: "500.00",
    refills: "1500.00",
    transfers: "-200.00",
    budget: "1800.00",
  });

  it("lists the parts that aren't 0", () => {
    expect(breakdown(figures)).toEqual([
      { part: "start", amount: "500.00" },
      { part: "refills", amount: "1500.00" },
      { part: "transfers", amount: "-200.00" },
    ]);
  });

  it("reads as a sum", () => {
    const m = (a: string) => formatMoney(a, "NOK");
    expect(breakdownText(figures, "NOK")).toBe(
      `Start ${m("500.00")} + refill ${m("1500.00")} − moved ${m("200.00")}`,
    );
    // A negative first part keeps its sign.
    expect(breakdownText(bucketFigures({ bucket_id: "1", start: "-50.00" }), "NOK")).toBe(
      `Start ${m("-50.00")}`,
    );
  });
});

describe("refillOf", () => {
  const hobby = bucket({
    ...base,
    id: "1",
    name: "Hobby",
    refill_amount: "1000.00",
    capacity: "1500.00",
    target_funds: "300.00",
  });

  it("tops up to RA without keep funds", () => {
    expect(refillOf(hobby)).toEqual({ amount: "700.00", overflow: "0.00" });
    expect(refillOf(hobby, "-200.00")).toEqual({ amount: "1200.00", overflow: "0.00" });
  });

  it("adds RA with keep funds, and what's above BC overflows", () => {
    const keep = { ...hobby, keep_funds: true };
    expect(refillOf(keep)).toEqual({ amount: "1000.00", overflow: "0.00" });
    expect(refillOf(keep, "800.00")).toEqual({ amount: "1000.00", overflow: "300.00" });
  });

  it("pays back a negative TF with keep funds, unless the bucket clears it", () => {
    const keep = { ...hobby, keep_funds: true };
    expect(refillOf(keep, "-200.00")).toEqual({ amount: "1000.00", overflow: "0.00" });
    const clear = { ...keep, negative_tf: "clear" as const };
    expect(refillOf(clear, "-200.00")).toEqual({ amount: "1200.00", overflow: "0.00" });
    expect(refillOf(clear, "800.00")).toEqual({ amount: "1000.00", overflow: "300.00" });
  });
});
