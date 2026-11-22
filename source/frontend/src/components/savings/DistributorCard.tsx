// The savings distributor on the Savings screen (#232, spec §9): its hold
// mode, what it holds per account, and Add to savings, Distribute now and
// Clear.

import { ActionIcon, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowsSplit, IconPlus, IconSettings } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Account } from "@/api/accounts";
import type { SavingsDistributor, SavingsRule, SavingsTarget } from "@/api/savings";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

import { DistributorDialog, type DistributorAction } from "./DistributorDialog";

export function DistributorCard({
  distributor,
  targets,
  rules,
  accounts,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  rules: SavingsRule[];
  accounts: Account[];
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<DistributorAction | null>(null);
  const title = t("savingsSetup.distributor.title");
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const currencyOf = (id: string) => accounts.find((a) => a.id === id)?.currency;

  return (
    <Card withBorder component="section" aria-label={title}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <IconArrowsSplit size={20} aria-hidden />
            <div style={{ minWidth: 0 }}>
              <Title order={3} size="h4">
                {title}
              </Title>
              <Text size="sm" c="dimmed">
                {t(`savings.distributor.mode.${distributor.hold_mode}`, {
                  amount: formatMoney(distributor.min_amount ?? "0", targets[0]?.currency),
                })}
              </Text>
            </div>
          </Group>
          <ActionIcon
            component={Link}
            to="/savings/setup?distributor"
            variant="subtle"
            color="gray"
            aria-label={t("savings.distributor.setup")}
            title={t("nav.items.savingsSetup")}
          >
            <IconSettings size={18} />
          </ActionIcon>
        </Group>

        {targets.length > 0 && rules.length === 0 && (
          <Text size="sm" c="var(--mantine-color-orange-text)">
            {t("savings.distributor.noRules")}
          </Text>
        )}

        {distributor.held.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t("savings.distributor.empty")}
          </Text>
        ) : (
          <Stack gap="xs" component="section" aria-label={t("savings.distributor.held")}>
            {distributor.held.map((h) => {
              const money = (a: string) => formatMoney(a, currencyOf(h.account_id));
              const uncovered = subtractAmounts(h.amount, h.covered);
              return (
                <Group key={h.account_id} justify="space-between" gap="xs" wrap="wrap">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm">
                      {t("savings.distributor.waiting", {
                        amount: money(h.amount),
                        account: name(h.account_id),
                      })}
                    </Text>
                    {compareAmounts(uncovered, "0") > 0 && (
                      <Text size="xs" c="var(--mantine-color-orange-text)">
                        {t("savings.notCovered", { amount: money(uncovered) })}
                      </Text>
                    )}
                  </div>
                  <Group gap="xs" wrap="nowrap">
                    <Button
                      size="xs"
                      aria-label={t("savings.distributor.distribute.name", {
                        account: name(h.account_id),
                      })}
                      onClick={() => {
                        setAction({ kind: "distribute", accountId: h.account_id });
                      }}
                    >
                      {t("savings.distributor.distribute.submit")}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      aria-label={t("savings.distributor.clear.name", {
                        account: name(h.account_id),
                      })}
                      onClick={() => {
                        setAction({ kind: "clear", accountId: h.account_id });
                      }}
                    >
                      {t("savings.clear.submit")}
                    </Button>
                  </Group>
                </Group>
              );
            })}
          </Stack>
        )}

        <Group gap="xs">
          <Button
            variant="outline"
            leftSection={<IconPlus size={16} />}
            aria-label={t("savings.distributor.add.name")}
            onClick={() => {
              setAction({ kind: "add" });
            }}
          >
            {t("savings.add.submit")}
          </Button>
          {distributor.held.length > 1 && (
            <Button
              variant="default"
              onClick={() => {
                setAction({ kind: "distribute", accountId: null });
              }}
            >
              {t("savings.distributor.distribute.all")}
            </Button>
          )}
        </Group>
      </Stack>
      <DistributorDialog
        distributor={distributor}
        targets={targets}
        action={action}
        onClose={() => {
          setAction(null);
        }}
      />
    </Card>
  );
}
