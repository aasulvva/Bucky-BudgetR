import { Table, Text } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import type { Transaction } from "@/api/transactions";
import { signedMoney, type Lookups } from "@/components/transactions/lookups";
import { formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";
import { usePrintMode } from "@/lib/print";
import { groupTransactions, transactionsLink, type ReportTransactions } from "@/lib/reports";
import {
  cellText,
  NUMERIC_COLUMNS,
  tableColumns,
  tableRows,
  tableTotals,
  type TableRow,
  type TransactionColumn,
} from "@/lib/transactionTable";

import { ReportLink } from "./ReportLink";

interface Focus {
  accountId: string | null;
  bucketId: string | null;
}

/**
 * A transactions module as a table (#185): the chosen columns, a heading
 * and a subtotal per group, and a total. On screen it scrolls sideways with
 * the first column in place; in a PDF the cells wrap instead.
 */
export function TransactionsTable({
  items,
  settings,
  period,
  cycles,
  names,
  focus,
}: {
  items: Transaction[];
  settings: ReportTransactions;
  period: Period;
  cycles: Cycle[];
  names: Lookups;
  focus: Focus;
}) {
  const { t } = useTranslation();
  const print = usePrintMode();
  const columns = tableColumns(settings.columns, focus);
  const rowsMode = settings.rows ?? "transaction";
  const groups = groupTransactions(items, settings.group_by ?? "day", cycles).map((g) => ({
    ...g,
    rows: tableRows(g.items, rowsMode, names, focus),
  }));
  const all = groups.flatMap((g) => g.rows);
  const withTotals = columns.includes("amount");
  // The cell that opens the transaction: the counterparty, else the first.
  const linked: TransactionColumn = columns.includes("counterparty")
    ? "counterparty"
    : (columns[0] ?? "date");

  // The first column stays in place while the rest scroll (not on paper).
  const sticky = (i: number, background = "var(--mantine-color-body)"): CSSProperties =>
    i === 0 && !print ? { position: "sticky", left: 0, zIndex: 1, background } : {};
  const align = (c: TransactionColumn) => (NUMERIC_COLUMNS.has(c) ? "right" : undefined);
  const wrap = (c: TransactionColumn): CSSProperties =>
    NUMERIC_COLUMNS.has(c) || c === "date" || c === "time" || c === "type"
      ? { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }
      : {};

  const cell = (c: TransactionColumn, i: number, row: TableRow): ReactNode => {
    let content: ReactNode = cellText(c, row, names, focus);
    if (c === "amount") {
      const { tx, amount } = row;
      const positive = amount.signed && !amount.amount.startsWith("-") && amount.amount !== "0.00";
      content = (
        <Text
          span
          inherit
          c={tx.reversed ? "dimmed" : positive ? "var(--mantine-color-blue-text)" : undefined}
          td={tx.reversed ? "line-through" : undefined}
        >
          {signedMoney(amount, row.currency)}
        </Text>
      );
    } else if (c === linked) {
      content = (
        <ReportLink to={transactionsLink(settings, period, row.tx.id) ?? "/transactions"}>
          {content}
        </ReportLink>
      );
    }
    return (
      <Table.Td key={c} ta={align(c)} style={{ ...wrap(c), ...sticky(i) }}>
        {content}
      </Table.Td>
    );
  };

  /** Subtotal or total rows, one per currency. */
  const sums = (list: TableRow[], kind: "subtotal" | "total") => {
    const totals = tableTotals(list);
    const several = totals.length > 1;
    const label = (currency: string) =>
      kind === "total"
        ? several
          ? t("stats.reports.transactions.table.totalIn", { currency })
          : t("stats.reports.transactions.table.total")
        : several
          ? t("stats.reports.transactions.table.subtotalIn", { currency })
          : t("stats.reports.transactions.table.subtotal");
    return totals.map((x) => (
      <Table.Tr key={x.currency} fw={kind === "total" ? 600 : 500}>
        {columns.map((c, i) => (
          <Table.Td key={c} ta={align(c)} style={{ ...wrap(c), ...sticky(i) }}>
            {c === "amount"
              ? formatMoney(x.amount, x.currency || undefined)
              : i === 0
                ? label(x.currency)
                : null}
          </Table.Td>
        ))}
      </Table.Tr>
    ));
  };

  const table = (
    <Table
      verticalSpacing={4}
      fz={print ? "xs" : "sm"}
      aria-label={t("stats.reports.transactions.table.label")}
      data-transactions-table
    >
      <Table.Thead>
        <Table.Tr>
          {columns.map((c, i) => (
            <Table.Th key={c} ta={align(c)} style={{ whiteSpace: "nowrap", ...sticky(i) }}>
              {t(`stats.reports.transactions.table.columns.${c}`)}
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      {groups.map((g) => (
        <Table.Tbody key={g.key} aria-label={g.label}>
          <Table.Tr data-group-heading bg="var(--mantine-color-default-hover)">
            <Table.Td colSpan={columns.length} c="dimmed" fw={600}>
              {/* In place while the row scrolls sideways. */}
              <span style={print ? undefined : { position: "sticky", left: 8 }}>{g.label}</span>
            </Table.Td>
          </Table.Tr>
          {g.rows.map((r) => (
            <Table.Tr key={r.key}>{columns.map((c, i) => cell(c, i, r))}</Table.Tr>
          ))}
          {withTotals && sums(g.rows, "subtotal")}
        </Table.Tbody>
      ))}
      {withTotals && <Table.Tfoot>{sums(all, "total")}</Table.Tfoot>}
    </Table>
  );
  if (print) return table;
  return (
    <Table.ScrollContainer minWidth={Math.max(320, columns.length * 110)} type="native">
      {table}
    </Table.ScrollContainer>
  );
}
