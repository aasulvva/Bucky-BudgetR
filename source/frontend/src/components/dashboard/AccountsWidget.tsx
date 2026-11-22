import { Anchor, Box, Group, Stack, Text } from "@mantine/core";
import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { accountTypeLabel, type Account, type Bucket } from "@/api/accounts";
import { shownAccounts, type WidgetInstance } from "@/lib/dashboard";
import { addAmounts, compareAmounts, formatMoney } from "@/lib/money";

import { WidgetFrame } from "./frame";
import { BucketsSummary, Gone, MoneyState, NoBuckets, WidgetCard } from "./Widget";

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
          if (shown.mode === "account" && !shown.account) return <Gone what="account" />;
          return shown.mode === "account" && shown.account ? (
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
            {(buckets.some((b) => b.source_account_id === a.id) ||
              compareAmounts(a.reserved, "0") > 0) && (
              <Text size="xs" c="dimmed">
                {t("dashboard.health.unallocated", {
                  amount: formatMoney(a.unallocated, a.currency),
                })}
                {compareAmounts(a.reserved, "0") > 0 &&
                  ` · ${t("accounts.reserved", { amount: formatMoney(a.reserved, a.currency) })}`}
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
  // No need to name the account again under a title that does.
  const titled = useContext(WidgetFrame).title === account.name;
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        {!titled && <AccountLink account={account} />}
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
      {own.length > 0 && <BucketsSummary account={account} buckets={buckets} />}
    </Stack>
  );
}
