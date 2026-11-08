import { cycle, transaction } from "@/test/fixtures";

import { addDays, today } from "./cycles";
import {
  SYSTEM_TYPES,
  USER_TYPES,
  bucketLinesLocked,
  groupByDay,
  isCorrectable,
  isFiltered,
  listQuery,
  loadShowReversed,
  readFilter,
  rowAmount,
  saveShowReversed,
  shownCycle,
  withFilter,
} from "./transactionList";

const active = cycle();

describe("filters in the URL", () => {
  it("reads and writes them, keeping other parameters", () => {
    const params = new URLSearchParams("account_id=1234&open=x&type=BOGUS&from=2026-10-01&to=nope");
    const filter = readFilter(params);
    expect(filter).toMatchObject({
      accountId: "1234",
      type: null,
      from: "2026-10-01",
      to: null,
      cycleId: null,
      system: false,
    });
    const next = withFilter(params, { accountId: null, tag: "food", system: true });
    expect(next.get("account_id")).toBeNull();
    expect(next.get("tag")).toBe("food");
    expect(next.get("system")).toBe("1");
    expect(next.get("open")).toBe("x");
  });

  it("defaults to the active cycle, and all means every cycle", () => {
    expect(shownCycle(readFilter(new URLSearchParams()), active)).toBe(active.id);
    expect(shownCycle(readFilter(new URLSearchParams()), null)).toBeNull();
    expect(shownCycle(readFilter(new URLSearchParams("cycle_id=all")), active)).toBeNull();
    expect(isFiltered(readFilter(new URLSearchParams()))).toBe(false);
    expect(isFiltered(readFilter(new URLSearchParams("cycle_id=all")))).toBe(true);
  });
});

describe("show reversed (#91)", () => {
  it("comes from the URL, else the browser's last choice", () => {
    expect(readFilter(new URLSearchParams()).reversed).toBe(false);
    expect(readFilter(new URLSearchParams(), { reversed: true }).reversed).toBe(true);
    expect(readFilter(new URLSearchParams("reversed=0"), { reversed: true }).reversed).toBe(false);
    expect(readFilter(new URLSearchParams("reversed=1")).reversed).toBe(true);
  });

  it("is written either way, so the URL keeps it", () => {
    expect(withFilter(new URLSearchParams(), { reversed: false }).get("reversed")).toBe("0");
    expect(withFilter(new URLSearchParams(), { reversed: true }).get("reversed")).toBe("1");
  });

  it("asks for both when on, and doesn't count as narrowing", () => {
    const on = readFilter(new URLSearchParams("reversed=1"));
    expect(listQuery(on, active)).not.toHaveProperty("reversed");
    expect(isFiltered(on)).toBe(false);
  });

  it("is remembered in the browser", () => {
    expect(loadShowReversed()).toBe(false);
    saveShowReversed(true);
    expect(loadShowReversed()).toBe(true);
    saveShowReversed(false);
    expect(loadShowReversed()).toBe(false);
  });
});

describe("listQuery", () => {
  it("hides the system types unless asked, and turns local dates into UTC", () => {
    expect(listQuery(readFilter(new URLSearchParams()), active)).toEqual({
      type: USER_TYPES,
      cycle_id: active.id,
      reversed: false,
    });
    const q = listQuery(
      readFilter(
        new URLSearchParams("system=1&from=2026-10-01&to=2026-10-31&q=%20rema%20&cycle_id=all"),
      ),
      active,
    );
    expect(q.type).toEqual([...USER_TYPES, ...SYSTEM_TYPES]);
    // The tests run in Los Angeles: local midnight is 07:00 UTC in October.
    expect(q.from).toBe("2026-10-01T07:00:00.000Z");
    expect(q.to).toBe("2026-11-01T07:00:00.000Z");
    expect(q.counterparty).toBe("rema");
    expect(q.cycle_id).toBeUndefined();
    expect(listQuery(readFilter(new URLSearchParams("type=REF")), null).type).toEqual(["REF"]);
  });
});

describe("rows", () => {
  const transfer = transaction({
    id: "t1",
    type: "TRF",
    bank_lines: [
      { account_id: "1234", amount: "-300.00" },
      { account_id: "2345", amount: "300.00" },
    ],
  });

  it("signs an amount from the filtered account's side", () => {
    expect(rowAmount(transfer, { accountId: null, bucketId: null })).toEqual({
      amount: "300.00",
      signed: false,
    });
    expect(rowAmount(transfer, { accountId: "2345", bucketId: null })).toEqual({
      amount: "300.00",
      signed: true,
    });
    expect(rowAmount(transfer, { accountId: "1234", bucketId: null })).toEqual({
      amount: "-300.00",
      signed: true,
    });
  });

  it("shows what a reversed transaction amounted to", () => {
    const reversed = transaction({
      id: "t2",
      reversed: true,
      bank_lines: [],
      before_reversal: { bank_lines: [{ account_id: "1234", amount: "-80.00" }], bucket_lines: [] },
    });
    expect(rowAmount(reversed, { accountId: null, bucketId: null }).amount).toBe("-80.00");
    expect(isCorrectable(reversed)).toBe(false);
  });

  it("groups by local day, newest first", () => {
    const groups = groupByDay([
      transaction({ id: "a", at: "2026-10-23T18:00:00Z" }),
      transaction({ id: "b", at: "2026-10-23T08:00:00Z" }),
      // 02:00 UTC on the 23rd is still the 22nd in Los Angeles.
      transaction({ id: "c", at: "2026-10-23T02:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.day, g.items.map((t) => t.id)])).toEqual([
      ["2026-10-23", ["a", "b"]],
      ["2026-10-22", ["c"]],
    ]);
  });

  it("locks bucket lines outside the active cycle", () => {
    const lines = [{ bucket_id: "1000000001", cycle_id: active.id, amount: "-50.00" }];
    const now = transaction({ id: "n", bucket_lines: lines });
    const old = transaction({
      id: "o",
      at: new Date(`${addDays(today(), -40)}T12:00:00`).toISOString(),
      bucket_lines: lines,
    });
    expect(bucketLinesLocked(now, active)).toBe(false);
    expect(bucketLinesLocked(old, active)).toBe(true);
    expect(bucketLinesLocked(transaction({ id: "x", at: old.at }), active)).toBe(false);
    expect(bucketLinesLocked(now, null)).toBe(true);
    expect(isCorrectable(transaction({ id: "r", type: "REF" }))).toBe(false);
  });
});
