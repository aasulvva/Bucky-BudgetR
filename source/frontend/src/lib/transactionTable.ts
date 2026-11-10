// A transactions module as a table (#185): its columns, its rows (one per
// transaction or per bucket line) and its totals per currency.

import type { components } from "@/api/schema";
import type { Transaction } from "@/api/transactions";
import { transactionTitle, type Lookups } from "@/components/transactions/lookups";
import i18n from "@/i18n";

import { formatDate } from "./dates";
import { getLocale } from "./locale";
import { addAmounts, formatMoney } from "./money";
import { firstLine } from "./transactionForm";
import {
  linesAmount,
  rowAmount,
  shownLines,
  transferAccounts,
  type TransactionFilter,
} from "./transactionList";

export type TransactionColumn = components["schemas"]["TransactionColumn"];
type Settings = components["schemas"]["ReportTransactions"];
export type TransactionsView = NonNullable<Settings["view"]>;
export type TransactionsRows = NonNullable<Settings["rows"]>;

export const TRANSACTIONS_VIEWS: TransactionsView[] = ["list", "table"];
export const TRANSACTIONS_ROWS: TransactionsRows[] = ["transaction", "bucket_line"];

/** Every column, in the order the editor lists them first. */
export const TRANSACTION_COLUMNS: TransactionColumn[] = [
  "date",
  "time",
  "type",
  "counterparty",
  "account",
  "buckets",
  "tags",
  "description",
  "amount",
  "balance",
  "notes",
];

/** The columns of a table that chooses none. */
export const DEFAULT_COLUMNS: TransactionColumn[] = [
  "date",
  "counterparty",
  "account",
  "buckets",
  "tags",
  "amount",
];

/** Right-aligned, unwrapped columns. */
export const NUMERIC_COLUMNS = new Set<TransactionColumn>(["amount", "balance"]);

type Focus = Pick<TransactionFilter, "accountId" | "bucketId">;

/**
 * The columns the table shows: the module's, or the defaults. The balance
 * after (#106) is an account's, so it shows only with exactly one account.
 */
export function tableColumns(
  columns: TransactionColumn[] | undefined,
  focus: Focus,
): TransactionColumn[] {
  const list = columns?.length ? columns : DEFAULT_COLUMNS;
  return list.filter((c) => c !== "balance" || focus.accountId !== null);
}

type BucketLine = Transaction["bucket_lines"][number];

/** One row of the table. */
export interface TableRow {
  key: string;
  tx: Transaction;
  /** The bucket line the row is for, when the table has a row per bucket line. */
  line?: BucketLine;
  amount: { amount: string; signed: boolean };
  currency: string | undefined;
}

/**
 * The table's rows: one per transaction, or one per bucket line (a
 * transaction without bucket lines still gets one row, with its amount).
 */
export function tableRows(
  items: Transaction[],
  rows: TransactionsRows,
  names: Lookups,
  focus: Focus,
): TableRow[] {
  return items.flatMap((tx): TableRow[] => {
    const currency = names.currencyOf(tx);
    const lines = shownLines(tx).bucket_lines;
    if (rows === "bucket_line" && lines.length > 0) {
      return lines.map((line, i) => ({
        key: `${tx.id}/${String(i)}`,
        tx,
        line,
        amount: linesAmount({ bank_lines: [], bucket_lines: [line] }),
        currency,
      }));
    }
    return [{ key: tx.id, tx, amount: rowAmount(tx, focus), currency }];
  });
}

/** Whether a row's amount adds to the totals: signed, and neither reversed nor moved. */
export function counts(row: TableRow): boolean {
  return row.amount.signed && !row.tx.reversed && !row.tx.replaced_by;
}

/** The rows' totals per currency, in the order the currencies first appear. */
export function tableTotals(rows: TableRow[]): { currency: string; amount: string }[] {
  const sums = new Map<string, string>();
  for (const r of rows) {
    if (!counts(r)) continue;
    const currency = r.currency ?? "";
    sums.set(currency, addAmounts(sums.get(currency) ?? "0.00", r.amount.amount));
  }
  return [...sums].map(([currency, amount]) => ({ currency, amount }));
}

/** A transaction's marks: edited, reversed, moved and scheduled. */
function notes(tx: Transaction): string {
  const out: string[] = [];
  if (tx.replaced_by) out.push(i18n.t("transactions.moved"));
  else if (tx.reversed) out.push(i18n.t("transactions.reversedMark"));
  else if (tx.corrected) out.push(i18n.t("transactions.edited"));
  if (tx.schedule_id) out.push(i18n.t("stats.reports.transactions.table.scheduled"));
  return out.join(", ");
}

/** A cell's text, except the amount, which the table styles. */
export function cellText(
  column: TransactionColumn,
  row: TableRow,
  names: Lookups,
  focus: Focus,
): string {
  const { tx } = row;
  const lines = shownLines(tx);
  switch (column) {
    case "date":
      return formatDate(tx.at);
    case "time":
      return new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" }).format(new Date(tx.at));
    case "type":
      return i18n.t(`transactionTypes.${tx.type}`);
    case "counterparty":
      return transactionTitle(tx, names);
    case "account": {
      if (tx.type === "TRF") {
        const { from, to } = transferAccounts(lines);
        if (from && to) return `${names.accountName(from)} → ${names.accountName(to)}`;
      }
      return [...new Set(lines.bank_lines.map((l) => names.accountName(l.account_id)))].join(", ");
    }
    case "buckets": {
      if (row.line) return names.bucketName(row.line.bucket_id);
      // With several, each with its amount: "Food −200,00 · Household −50,00".
      if (lines.bucket_lines.length === 1) {
        return names.bucketName(lines.bucket_lines[0]?.bucket_id ?? "");
      }
      return lines.bucket_lines
        .map((l) => `${names.bucketName(l.bucket_id)} ${formatMoney(l.amount, row.currency)}`)
        .join(" · ");
    }
    case "tags":
      return tx.tags.join(", ");
    case "description":
      return tx.description ? firstLine(tx.description) : "";
    case "amount":
      return formatMoney(row.amount.amount, row.currency);
    case "balance": {
      const account = focus.accountId;
      const balance = account
        ? tx.balances_after.find((b) => b.account_id === account)?.balance
        : undefined;
      // Once per transaction: on its first bucket line's row.
      return balance === undefined || (row.line && !row.key.endsWith("/0"))
        ? ""
        : formatMoney(balance, names.accountCurrency(account ?? ""));
    }
    case "notes":
      return notes(tx);
  }
}
