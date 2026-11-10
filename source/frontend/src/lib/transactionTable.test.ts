import type { Lookups } from "@/components/transactions/lookups";
import { transaction } from "@/test/fixtures";

import { formatMoney } from "./money";
import {
  cellText,
  DEFAULT_COLUMNS,
  tableColumns,
  tableRows,
  tableTotals,
} from "./transactionTable";

const accounts: Record<string, { name: string; currency: string }> = {
  "1234": { name: "Main", currency: "NOK" },
  "2345": { name: "Savings", currency: "NOK" },
  "3456": { name: "Euro", currency: "EUR" },
};
const buckets: Record<string, string> = { b1: "Food", b2: "Household" };
const names: Lookups = {
  accountName: (id) => accounts[id]?.name ?? id,
  bucketName: (id) => buckets[id] ?? id,
  accountCurrency: (id) => accounts[id]?.currency,
  currencyOf: (tx) => accounts[tx.bank_lines[0]?.account_id ?? "1234"]?.currency,
};
const none = { accountId: null, bucketId: null };

const split = transaction({
  id: "t1",
  counterparty: "Rema 1000",
  bank_lines: [{ account_id: "1234", amount: "-250.00" }],
  bucket_lines: [
    { bucket_id: "b1", cycle_id: "100001000001", amount: "-200.00" },
    { bucket_id: "b2", cycle_id: "100001000001", amount: "-50.00" },
  ],
  tags: ["food", "home"],
  balances_after: [{ account_id: "1234", balance: "750.00" }],
});
const transfer = transaction({
  id: "t2",
  type: "TRF",
  bank_lines: [
    { account_id: "1234", amount: "-100.00" },
    { account_id: "2345", amount: "100.00" },
  ],
});
const income = transaction({
  id: "t3",
  type: "INC",
  counterparty: "Work",
  bank_lines: [{ account_id: "1234", amount: "1000.00" }],
});
const euro = transaction({
  id: "t4",
  counterparty: "Café",
  bank_lines: [{ account_id: "3456", amount: "-5.00" }],
});

describe("tableColumns", () => {
  it("defaults, and shows the balance after only with one account", () => {
    expect(tableColumns(undefined, none)).toEqual(DEFAULT_COLUMNS);
    expect(tableColumns(["date", "balance", "amount"], none)).toEqual(["date", "amount"]);
    expect(tableColumns(["date", "balance"], { accountId: "1234", bucketId: null })).toEqual([
      "date",
      "balance",
    ]);
  });
});

describe("tableRows", () => {
  it("gives a row per transaction, or per bucket line", () => {
    expect(tableRows([split, transfer], "transaction", names, none).map((r) => r.key)).toEqual([
      "t1",
      "t2",
    ]);
    const lines = tableRows([split, transfer], "bucket_line", names, none);
    expect(lines.map((r) => [r.key, r.amount.amount])).toEqual([
      ["t1/0", "-200.00"],
      ["t1/1", "-50.00"],
      // No bucket lines: one row, with its own amount.
      ["t2", "100.00"],
    ]);
    const second = lines[1];
    if (!second) throw new Error("no second row");
    expect(cellText("buckets", second, names, none)).toBe("Household");
  });

  it("writes the cells", () => {
    const [row] = tableRows([split], "transaction", names, none);
    if (!row) throw new Error("no row");
    expect(cellText("counterparty", row, names, none)).toBe("Rema 1000");
    expect(cellText("account", row, names, none)).toBe("Main");
    expect(cellText("buckets", row, names, none)).toBe(
      `Food ${formatMoney("-200.00", "NOK")} · Household ${formatMoney("-50.00", "NOK")}`,
    );
    expect(cellText("tags", row, names, none)).toBe("food, home");
    expect(cellText("balance", row, names, { accountId: "1234", bucketId: null })).toBe(
      formatMoney("750.00", "NOK"),
    );
    const [trf] = tableRows([transfer], "transaction", names, none);
    if (!trf) throw new Error("no row");
    expect(cellText("account", trf, names, none)).toBe("Main → Savings");
    expect(cellText("type", trf, names, none)).toBe("Transfer");
  });
});

describe("tableTotals", () => {
  it("sums signed amounts per currency, without reversed or moved ones", () => {
    const reversed = transaction({ id: "t5", reversed: true });
    const moved = transaction({ id: "t6", replaced_by: "t7" });
    const rows = tableRows(
      [split, transfer, income, euro, reversed, moved],
      "transaction",
      names,
      none,
    );
    // The transfer between two accounts is unsigned, so it doesn't count.
    expect(tableTotals(rows)).toEqual([
      { currency: "NOK", amount: "750.00" },
      { currency: "EUR", amount: "-5.00" },
    ]);
    // From one account's side, the transfer counts.
    const focused = tableRows([transfer], "transaction", names, {
      accountId: "1234",
      bucketId: null,
    });
    expect(tableTotals(focused)).toEqual([{ currency: "NOK", amount: "-100.00" }]);
  });
});
