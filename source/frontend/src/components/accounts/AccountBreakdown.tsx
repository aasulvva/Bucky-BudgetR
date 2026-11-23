// Where an account's money goes, on Accounts: its buckets, card debt set
// aside (#261), savings (#231) and what's unallocated, a row each; and where
// a card's debt is set aside.

import { Box, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import { positiveHolds } from "@/lib/cards";
import { addAmounts, compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

const ORANGE = "var(--mantine-color-orange-text)";

interface Row {
  label: string;
  amount: string;
  /** Under the label, in orange: what's short or not covered. */
  warning?: string;
}

/** Rows of label and amount, the amounts lined up on the right. */
function Rows({ label, rows, currency }: { label: string; rows: Row[]; currency: string }) {
  return (
    <Stack
      gap={4}
      pt="xs"
      component="dl"
      aria-label={label}
      m={0}
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
    >
      {rows.map((r) => (
        <Group key={r.label} justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
          <Box component="dt" style={{ minWidth: 0 }}>
            <Text size="sm" c="dimmed">
              {r.label}
            </Text>
            {r.warning && (
              <Text size="xs" c={ORANGE}>
                {r.warning}
              </Text>
            )}
          </Box>
          <Text component="dd" size="sm" m={0} style={{ whiteSpace: "nowrap" }}>
            {formatMoney(r.amount, currency)}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * The account's money, part by part: in its buckets (with what they're
 * short), set aside for each card, reserved for savings (each with what isn't
 * covered) and unallocated. Just "No buckets" when there's nothing but
 * unallocated money.
 */
export function AccountBreakdown({
  account,
  accounts,
  buckets,
}: {
  account: Account;
  accounts: Account[];
  buckets: Bucket[];
}): ReactNode {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, account.currency);
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const holds = positiveHolds(account);
  const reserved = compareAmounts(account.reserved, "0") > 0;
  if (own.length === 0 && holds.length === 0 && !reserved) {
    return (
      <Text size="sm" c="dimmed">
        {t("accounts.noBuckets")}
      </Text>
    );
  }

  const rows: Row[] = [];
  if (own.length > 0) {
    const short = addAmounts(
      ...own.map((b) =>
        compareAmounts(b.target_funds, "0") > 0
          ? subtractAmounts(b.target_funds, b.current_available_funds)
          : "0",
      ),
    );
    rows.push({
      label: t("accounts.bucketCount", { count: own.length }),
      amount: addAmounts(...own.map((b) => b.current_available_funds)),
      warning:
        compareAmounts(short, "0") > 0
          ? t("accounts.breakdown.short", { amount: money(short) })
          : undefined,
    });
  }
  holds.forEach((h, i) => {
    const uncovered = compareAmounts(account.card_debt_uncovered, "0") > 0;
    rows.push({
      label: t("accounts.breakdown.setAsideFor", {
        card: accounts.find((a) => a.id === h.card_id)?.name ?? h.card_id,
      }),
      amount: h.amount,
      // What the balance doesn't cover, after the last card.
      warning:
        uncovered && i === holds.length - 1
          ? t("accounts.breakdown.notCovered", { amount: money(account.card_debt_uncovered) })
          : undefined,
    });
  });
  if (reserved) {
    rows.push({
      label: t("accounts.breakdown.reserved"),
      amount: account.reserved,
      warning:
        compareAmounts(account.reserved_uncovered, "0") > 0
          ? t("accounts.breakdown.notCovered", { amount: money(account.reserved_uncovered) })
          : undefined,
    });
  }
  rows.push({ label: t("accounts.breakdown.unallocated"), amount: account.unallocated });
  return (
    <Rows
      label={t("accounts.breakdown.label", { name: account.name })}
      rows={rows}
      currency={account.currency}
    />
  );
}

/** Where a card's debt is set aside, account by account, and what isn't. */
export function CardBreakdown({ card, accounts }: { card: Account; accounts: Account[] }) {
  const { t } = useTranslation();
  const c = card.credit_card;
  if (!c) return null;
  const held = c.held_on.filter((h) => compareAmounts(h.amount, "0") !== 0);
  if (held.length === 0 && compareAmounts(c.not_set_aside, "0") === 0) return null;
  const rows: Row[] = held.map((h) => ({
    label: t("accounts.breakdown.setAsideOn", {
      name: accounts.find((a) => a.id === h.account_id)?.name ?? h.account_id,
    }),
    amount: h.amount,
  }));
  if (compareAmounts(c.not_set_aside, "0") !== 0) {
    rows.push({ label: t("accounts.breakdown.notSetAside"), amount: c.not_set_aside });
  }
  return (
    <Rows
      label={t("accounts.breakdown.cardLabel", { name: card.name })}
      rows={rows}
      currency={card.currency}
    />
  );
}
