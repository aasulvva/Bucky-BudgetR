import { cycle, transaction } from "@/test/fixtures";

import { historyRows, ofKind } from "./bucketHistory";
import { correctionBody, editState } from "./transactionForm";
import {
  choiceOf,
  countLaterOf,
  monthChoices,
  plannedCycles,
  purchaseOf,
  sameChoice,
  waitingLeft,
} from "./waiting";

const charge = {
  id: "100000000112345678901234",
  bucket_id: "1000000001",
  when: "cycle" as const,
  cycle_id: "100001000002",
  take_on: "2027-03-01",
  amount: "800.00",
  left: "800.00",
  bucket_deleted: false,
};

const trip = transaction({
  id: "2026102300000005",
  bank_lines: [{ account_id: "1234", amount: "-1000.00" }],
  waiting_lines: [{ purchase_id: "2026102300000005", bucket_id: "1000000001", amount: "800.00" }],
  waiting: [charge],
});

describe("counting later (#264)", () => {
  it("reads a purchase's choice from its charges", () => {
    expect(choiceOf(transaction({ id: "1" }))).toEqual({ when: "now", cycleId: null, month: null });
    expect(choiceOf(trip)).toEqual({ when: "cycle", cycleId: "100001000002", month: null });
    // A deleted cycle falls back to the month of its start.
    const gone = { ...trip, waiting: [{ ...charge, cycle_id: null }] };
    expect(choiceOf(gone)).toEqual({ when: "month", cycleId: null, month: "2027-03" });
    expect(choiceOf({ ...trip, waiting: [{ ...charge, when: "paid", take_on: null }] }).when).toBe(
      "paid",
    );
  });

  it("makes the API's count_later only when filled in", () => {
    expect(countLaterOf({ when: "now", cycleId: null, month: null })).toBeUndefined();
    expect(countLaterOf({ when: "paid", cycleId: null, month: null })).toEqual({ when: "paid" });
    expect(countLaterOf({ when: "cycle", cycleId: null, month: null })).toBeUndefined();
    expect(countLaterOf({ when: "month", cycleId: null, month: "2027-05" })).toEqual({
      when: "month",
      month: "2027-05",
    });
    expect(
      sameChoice(
        { when: "month", cycleId: null, month: "2027-05" },
        { when: "month", cycleId: "x", month: "2027-05" },
      ),
    ).toBe(true);
  });

  it("offers the months after the active cycle's start month", () => {
    const active = cycle({ start_at: "2027-01-15T00:00:00Z", end_at: "2027-02-15T00:00:00Z" });
    expect(monthChoices(active, 3)).toEqual(["2027-02", "2027-03", "2027-04"]);
    expect(monthChoices(null, 2, new Date(2027, 5, 10))).toEqual(["2027-06", "2027-07"]);
  });

  it("offers only planned cycles that haven't started", () => {
    const now = new Date("2027-01-20T00:00:00Z");
    const planned = cycle({ id: "2", state: "future", start_at: "2027-02-01T00:00:00Z" });
    expect(plannedCycles([cycle(), planned], now)).toEqual([planned]);
  });

  it("edits a waiting purchase's parts as its split, and sends a new choice", () => {
    const start = editState(trip);
    expect(start.lines.map((l) => [l.bucketId, l.amount])).toEqual([["1000000001", "800.00"]]);
    expect(correctionBody(trip, start, false)).toBeNull();
    expect(
      correctionBody(
        trip,
        { ...start, count: { when: "month", cycleId: null, month: "2027-05" } },
        false,
      ),
    ).toEqual({ count_later: { when: "month", month: "2027-05" } });
  });

  it("sums what's left, and finds a DBC's purchase", () => {
    expect(
      waitingLeft({ waiting: [charge, { ...charge, left: "1.00", bucket_deleted: true }] }),
    ).toBe("800.00");
    const dbc = transaction({
      id: "9",
      type: "DBC",
      waiting_lines: [{ purchase_id: trip.id, bucket_id: "1000000001", amount: "-800.00" }],
    });
    expect(purchaseOf(dbc)).toBe(trip.id);
    expect(purchaseOf(trip)).toBeNull();
  });

  it("counts a DBC as spending in a bucket's history", () => {
    const dbc = transaction({
      id: "9",
      type: "DBC",
      bank_lines: [],
      bucket_lines: [{ bucket_id: "1000000001", cycle_id: "c", amount: "-800.00" }],
    });
    const [row] = historyRows([dbc], "1000000001", "c", "200.00");
    expect(row && ofKind(row, "EXP")).toBe(true);
  });
});
