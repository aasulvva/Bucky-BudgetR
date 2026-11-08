import { Badge, Box, Group, Text, UnstyledButton } from "@mantine/core";
import { IconRepeat } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Transaction } from "@/api/transactions";
import { formatMoney } from "@/lib/money";
import { firstLine } from "@/lib/transactionForm";
import { rowAmount, type TransactionFilter } from "@/lib/transactionList";

import { signedMoney, transactionSubLine, transactionTitle, type Lookups } from "./lookups";

/**
 * A transaction in a list: its title and sub-line, and the amount, with a
 * mark for an edited, reversed or moved one. The Transactions list and the
 * Dashboard show them.
 */
export function TransactionRow({
  tx,
  names,
  filter,
  to,
  selected,
  badge,
}: {
  tx: Transaction;
  names: Lookups;
  /** Signs the amount from this account's or bucket's side. */
  filter: Pick<TransactionFilter, "accountId" | "bucketId">;
  to: string;
  selected: boolean;
  badge: boolean;
}) {
  const { t } = useTranslation();
  const amount = rowAmount(tx, filter);
  const positive = amount.signed && !amount.amount.startsWith("-") && amount.amount !== "0.00";
  const note = tx.replaced_by
    ? t("transactions.moved")
    : tx.reversed
      ? t("transactions.reversedMark")
      : tx.corrected
        ? t("transactions.edited")
        : "";
  // Filtered to one account: its balance after the transaction (#106).
  const account = filter.accountId;
  const balance = account
    ? tx.balances_after.find((b) => b.account_id === account)?.balance
    : undefined;
  return (
    <UnstyledButton
      component={Link}
      to={to}
      aria-current={selected ? "true" : undefined}
      px="md"
      py={10}
      bg={selected ? "var(--mantine-color-blue-light)" : undefined}
      style={{
        display: "grid",
        gridTemplateColumns: badge ? "48px minmax(0, 1fr) auto" : "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        borderBottom: "1px solid var(--mantine-color-default-border)",
      }}
    >
      {badge && (
        <Badge variant="light" color="gray" radius="sm" size="sm" style={{ justifySelf: "start" }}>
          {tx.type}
        </Badge>
      )}
      <Box style={{ minWidth: 0 }}>
        <Group gap={4} wrap="nowrap">
          {tx.schedule_id && (
            <Box
              component="span"
              title={t("transactions.scheduledMark")}
              style={{ display: "inline-flex", flex: "none" }}
            >
              <IconRepeat
                size={14}
                role="img"
                aria-label={t("transactions.scheduledMark")}
                color="var(--mantine-color-dimmed)"
              />
            </Box>
          )}
          <Text fw={600} truncate>
            {transactionTitle(tx, names)}
          </Text>
        </Group>
        <Text size="sm" c="dimmed" truncate>
          {transactionSubLine(tx, names)}
        </Text>
        {tx.description && (
          <Text size="sm" c="dimmed" fs="italic" truncate>
            {firstLine(tx.description)}
          </Text>
        )}
      </Box>
      <Box ta="right">
        <Text
          fw={600}
          style={{ whiteSpace: "nowrap" }}
          c={tx.reversed ? "dimmed" : positive ? "var(--mantine-color-blue-text)" : undefined}
          td={tx.reversed ? "line-through" : undefined}
        >
          {signedMoney(amount, names.currencyOf(tx))}
        </Text>
        {balance !== undefined && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {t("transactions.balanceAfter", {
              amount: formatMoney(balance, names.accountCurrency(account ?? "")),
            })}
          </Text>
        )}
        {note && (
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        )}
      </Box>
    </UnstyledButton>
  );
}
