import { transaction } from "@/test/fixtures";

import { historyRows, ofKind } from "./bucketHistory";

const bucket = "1000000001";
const other = "1000000002";
const cycle = "100001000001";
const line = (amount: string, bucket_id = bucket, cycle_id = cycle) => ({
  bucket_id,
  cycle_id,
  amount,
});

// Newest first, as the API lists them.
const transactions = [
  transaction({ id: "6", type: "BAT", bucket_lines: [line("-200.00"), line("200.00", other)] }),
  transaction({ id: "5", type: "EXP", reversed: true, bucket_lines: [] }),
  transaction({ id: "4", type: "EXP", bucket_lines: [line("-300.00"), line("-50.00", other)] }),
  transaction({ id: "3", type: "EXP", bucket_lines: [line("-100.00"), line("100.00")] }),
  transaction({ id: "2", type: "INC", bucket_lines: [line("250.00", bucket, "100001000000")] }),
  transaction({ id: "1", type: "REF", bucket_lines: [line("1500.00")] }),
];

describe("a bucket's history", () => {
  it("counts the TF back from the end, newest first", () => {
    // Start 500 + 1 500 − 300 − 200 = 1 500.
    const rows = historyRows(transactions, bucket, cycle, "1500.00");
    expect(rows.map((r) => [r.tx.id, r.amount, r.tf])).toEqual([
      ["6", "-200.00", "1500.00"],
      ["4", "-300.00", "1700.00"],
      ["1", "1500.00", "2000.00"],
    ]);
    // What's left before the oldest is the start.
  });

  it("names the other bucket of a transfer", () => {
    const [bat] = historyRows(transactions, bucket, cycle, "1500.00");
    expect(bat?.otherBucketId).toBe(other);
    expect(historyRows(transactions, other, cycle, "150.00")[0]?.otherBucketId).toBe(bucket);
  });

  it("filters by kind", () => {
    const rows = historyRows(transactions, bucket, cycle, "1500.00");
    expect(rows.filter((r) => ofKind(r, "all"))).toHaveLength(3);
    expect(rows.filter((r) => ofKind(r, "bucket")).map((r) => r.tx.id)).toEqual(["6", "1"]);
    expect(rows.filter((r) => ofKind(r, "EXP")).map((r) => r.tx.id)).toEqual(["4"]);
  });
});
