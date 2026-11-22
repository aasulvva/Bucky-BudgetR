// The savings budget on the Savings screen (#234, spec §9): this cycle's fixed
// amounts, what each reserved, and Save now for the manual ones.

import { ActionIcon, Anchor, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCalendarDollar, IconSettings } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import type { FixedBudgetEntry, SavingsTarget } from "@/api/savings";
import { isOverdue } from "@/lib/cycles";
import { formatMoney, subtractAmounts } from "@/lib/money";
import { budgetDestination, budgetStatus } from "@/lib/savings";

export function BudgetCard({
  entries,
  targets,
  accounts,
}: {
  entries: FixedBudgetEntry[];
  targets: SavingsTarget[];
  accounts: Account[];
}) {
  const { t } = useTranslation();
  const active = useCurrentCycles().data?.active ?? null;
  const running = active !== null && !isOverdue(active);
  const title = t("savingsSetup.budget.title");

  return (
    <Card withBorder component="section" aria-label={title}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconCalendarDollar size={20} aria-hidden />
            <div style={{ minWidth: 0 }}>
              <Title order={3} size="h4">
                {title}
              </Title>
              <Text size="sm" c="dimmed">
                {t("savings.budget.hint")}
              </Text>
            </div>
          </Group>
          <ActionIcon
            component={Link}
            to="/savings/setup?budget"
            variant="subtle"
            color="gray"
            aria-label={t("savings.budget.setup")}
            title={t("nav.items.savingsSetup")}
          >
            <IconSettings size={18} />
          </ActionIcon>
        </Group>
        {entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            <Trans
              i18nKey="savings.budget.empty"
              components={{ setup: <Anchor component={Link} to="/savings/setup?budget" /> }}
            />
          </Text>
        ) : (
          <Stack gap="xs">
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                targets={targets}
                account={accounts.find((a) => a.id === e.account_id)}
                running={running}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function EntryRow({
  entry,
  targets,
  account,
  running,
}: {
  entry: FixedBudgetEntry;
  targets: SavingsTarget[];
  account: Account | undefined;
  running: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const money = (a: string) => formatMoney(a, account?.currency);
  const name = budgetDestination(entry, targets);
  const status = budgetStatus(entry, running);
  const run = entry.this_cycle;
  const accountName = account?.name ?? `#${entry.account_id}`;

  const saveNow = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/savings/budget/{entryId}/save-now", {
          params: { path: { entryId: entry.id } },
        }),
      ),
    onSuccess: async (saved) => {
      const reserved = saved.this_cycle?.reserved ?? "0";
      notifications.show({
        // Save now is for a Manually entry, so it's a fixed amount.
        color:
          saved.this_cycle && budgetStatus(saved as FixedBudgetEntry, true) === "short"
            ? "orange"
            : "green",
        message: t("savings.budget.savedNow", { amount: money(reserved), name }),
      });
      await refresh();
    },
  });

  const warn = status === "short" || status === "stopped";
  return (
    <Group
      justify="space-between"
      gap="xs"
      wrap="wrap"
      component="article"
      aria-label={t("savingsSetup.budget.editName", { name, amount: money(entry.amount) })}
    >
      <div style={{ minWidth: 0 }}>
        <Text size="sm">
          {t("savings.budget.line", {
            amount: money(entry.amount),
            name,
            account: accountName,
            when: t(`savingsSetup.budget.when.${entry.when}`),
          })}
        </Text>
        <Text size="xs" c={warn ? "var(--mantine-color-orange-text)" : "dimmed"}>
          {t(`savings.budget.status.${status}`, {
            reserved: money(run?.reserved ?? "0"),
            wanted: money(run?.wanted ?? entry.amount),
            short: money(subtractAmounts(run?.wanted ?? "0", run?.reserved ?? "0")),
            account: accountName,
          })}
        </Text>
      </div>
      {status === "saveNow" && (
        <Button
          size="xs"
          loading={saveNow.isPending}
          aria-label={t("savings.budget.saveNowName", { amount: money(entry.amount), name })}
          onClick={() => {
            saveNow.mutate();
          }}
        >
          {t("savings.budget.saveNow")}
        </Button>
      )}
    </Group>
  );
}
