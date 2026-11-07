import { Anchor, Box, Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { accountTypeLabel, type Account, type Bucket } from "@/api/accounts";
import { accountSummary, toneText } from "@/lib/buckets";
import { shownAccounts, type WidgetInstance } from "@/lib/dashboard";
import { addAmounts, compareAmounts, formatMoney } from "@/lib/money";

import { MoneyState, NoBuckets, WidgetCard } from "./Widget";

/** The account balances: all of them with a total, or one account. */
export function AccountsWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"accounts">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <WidgetCard
      title={t("dashboard.accounts.title")}
      link={{ to: "/accounts", label: t("nav.items.accounts") }}
      action={action}
    >
      <MoneyState>
        {(accounts, buckets) => {
          if (accounts.length === 0) return <NoBuckets accounts={accounts} />;
          const shown = shownAccounts(widget.settings, accounts);
          return shown.mode === "account" ? (
            <OneAccount account={shown.account} buckets={buckets} />
          ) : (
            <AllAccounts accounts={accounts} buckets={buckets} />
          );
        }}
      </MoneyState>
    </WidgetCard>
  );
}

function AccountLink({ account }: { account: Account }) {
  return (
    <Anchor
      component={Link}
      to={`/transactions?account_id=${account.id}`}
      fw={600}
      c="var(--mantine-color-text)"
    >
      {account.name}
    </Anchor>
  );
}

function AllAccounts({ accounts, buckets }: { accounts: Account[]; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const currencies = [...new Set(accounts.map((a) => a.currency))];
  return (
    <Stack gap="xs">
      {accounts.map((a) => (
        <Group key={a.id} justify="space-between" gap="xs" wrap="nowrap">
          <Box style={{ minWidth: 0 }}>
            <AccountLink account={a} />
            {buckets.some((b) => b.source_account_id === a.id) && (
              <Text size="xs" c="dimmed">
                {t("dashboard.health.unallocated", {
                  amount: formatMoney(a.unallocated, a.currency),
                })}
              </Text>
            )}
          </Box>
          <Text fw={600} style={{ whiteSpace: "nowrap" }}>
            {formatMoney(a.balance, a.currency)}
          </Text>
        </Group>
      ))}
      <Group
        justify="space-between"
        gap="xs"
        pt="xs"
        style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      >
        <Text size="sm" c="dimmed">
          {t("accounts.total")}
        </Text>
        <Stack gap={0} align="flex-end">
          {currencies.map((currency) => (
            <Text key={currency} fw={700}>
              {formatMoney(
                addAmounts(
                  ...accounts.filter((a) => a.currency === currency).map((a) => a.balance),
                ),
                currency,
              )}
            </Text>
          ))}
        </Stack>
      </Group>
    </Stack>
  );
}

/** One account: its balance, and what its buckets hold of it. */
function OneAccount({ account, buckets }: { account: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const money = (amount: string) => formatMoney(amount, account.currency);
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const summary = accountSummary(account, buckets);
  const isShort = compareAmounts(summary.short, "0") > 0;
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        <AccountLink account={account} />
        <Text size="sm" c="dimmed">
          {accountTypeLabel(account.type)}
        </Text>
      </Group>
      <div>
        <Text size="xs" c="dimmed">
          {t("buckets.balance")}
        </Text>
        <Text fz={22} fw={700}>
          {money(account.balance)}
        </Text>
      </div>
      {own.length > 0 && (
        <Group gap="lg" wrap="wrap">
          <Text size="sm" c="dimmed">
            {t("buckets.leftInBuckets")}{" "}
            <Text span fw={700} c="var(--mantine-color-text)">
              {money(summary.left)}
            </Text>
          </Text>
          <Text size="sm" c={isShort ? toneText(summary.tone) : "dimmed"}>
            {isShort ? t("buckets.short") : t("buckets.unallocated")}{" "}
            <Text span fw={700} c={isShort ? undefined : "var(--mantine-color-text)"}>
              {money(isShort ? summary.short : summary.unallocated)}
            </Text>
          </Text>
        </Group>
      )}
    </Stack>
  );
}
