import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconAdjustments, IconPlus, IconSettings } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import {
  useFixedBudget,
  useSavingsDistributor,
  useSavingsRules,
  useSavingsTargets,
  type SavingsTarget,
} from "@/api/savings";
import { QueryState } from "@/components/QueryState";
import { BudgetCard } from "@/components/savings/BudgetCard";
import { DistributorCard } from "@/components/savings/DistributorCard";
import { SavingsDialog, type SavingsAction } from "@/components/savings/SavingsDialog";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import { progress, targetKindText } from "@/lib/savings";

/**
 * Savings (spec §9, #231): the savings distributor (#232), and each savings
 * target's progress towards its goal, the money held for it per source
 * account with Done and Clear, and Add to savings.
 */
export default function Savings() {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const buckets = useBuckets();
  const targets = useSavingsTargets();
  const distributor = useSavingsDistributor();
  const rules = useSavingsRules();
  const budget = useFixedBudget();
  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.savings")}</Title>
        <Button
          variant="default"
          component={Link}
          to="/savings/setup"
          leftSection={<IconAdjustments size={16} />}
        >
          {t("nav.items.savingsSetup")}
        </Button>
      </Group>
      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => (
              <QueryState query={targets}>
                {(targetList) => (
                  <Stack gap="md">
                    <QueryState query={distributor}>
                      {(dist) => (
                        <QueryState query={rules}>
                          {(ruleList) => (
                            <DistributorCard
                              distributor={dist}
                              targets={targetList}
                              rules={ruleList}
                              accounts={accountList}
                            />
                          )}
                        </QueryState>
                      )}
                    </QueryState>
                    <QueryState query={budget}>
                      {(entries) => (
                        <BudgetCard entries={entries} targets={targetList} accounts={accountList} />
                      )}
                    </QueryState>
                    {targetList.length === 0 ? (
                      <Card withBorder>
                        <Stack gap="sm" align="flex-start">
                          <Text fw={600}>{t("savings.empty")}</Text>
                          <Text size="sm" c="dimmed">
                            {t("savings.emptyHint")}
                          </Text>
                          <Button
                            component={Link}
                            to="/savings/setup?new"
                            leftSection={<IconPlus size={16} />}
                          >
                            {t("savingsSetup.newTarget")}
                          </Button>
                        </Stack>
                      </Card>
                    ) : (
                      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                        {targetList.map((x) => (
                          <TargetCard
                            key={x.id}
                            target={x}
                            accounts={accountList}
                            buckets={bucketList}
                          />
                        ))}
                      </SimpleGrid>
                    )}
                  </Stack>
                )}
              </QueryState>
            )}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

function TargetCard({
  target,
  accounts,
  buckets,
}: {
  target: SavingsTarget;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<SavingsAction | null>(null);
  const p = progress(target);
  const money = (a: string) => formatMoney(a, target.currency);
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <Card withBorder component="section" aria-label={target.name}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <div style={{ minWidth: 0 }}>
            <Title order={3} size="h4">
              {target.name}
            </Title>
            <Text size="sm" c="dimmed">
              {targetKindText(target, accounts, buckets)}
            </Text>
          </div>
          <ActionIcon
            component={Link}
            to={`/savings/setup?edit=${target.id}`}
            variant="subtle"
            color="gray"
            aria-label={t("savings.setupFor", { name: target.name })}
            title={t("nav.items.savingsSetup")}
          >
            <IconSettings size={18} />
          </ActionIcon>
        </Group>

        <Stack gap={4}>
          <Group justify="space-between" gap="xs" align="baseline">
            <Text fw={600}>
              {t("savings.progress", { saved: money(p.saved), goal: money(target.goal) })}
            </Text>
            {p.reached ? (
              <Badge color="green" variant="light">
                {t("savings.reached")}
              </Badge>
            ) : (
              <Text size="sm" c="dimmed">
                {t("savings.left", { amount: money(p.left) })}
              </Text>
            )}
          </Group>
          <Progress.Root size="lg" aria-label={t("savings.progressLabel", { pct: p.pct })}>
            <Progress.Section value={p.currentPct} color={p.reached ? "green" : "blue"} />
            <Progress.Section value={p.heldPct} color={p.reached ? "green" : "blue"} striped />
          </Progress.Root>
          <Text size="xs" c="dimmed">
            {t(target.bucket_id !== null ? "savings.inBucket" : "savings.inAccount", {
              amount: money(target.current),
            })}
            {compareAmounts(target.held_total, "0") > 0 &&
              ` · ${t("savings.heldTotal", { amount: money(target.held_total) })}`}
          </Text>
        </Stack>

        {target.held.length > 0 && (
          <Stack gap="xs" component="section" aria-label={t("savings.held")}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.04em" }}>
              {t("savings.held")}
            </Text>
            {target.held.map((h) => {
              const uncovered = subtractAmounts(h.amount, h.covered);
              return (
                <Group key={h.account_id} justify="space-between" gap="xs" wrap="wrap">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm">
                      {t("savings.heldOn", {
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
                      aria-label={t("savings.done.name", {
                        name: target.name,
                        account: name(h.account_id),
                      })}
                      onClick={() => {
                        setAction({ kind: "done", accountId: h.account_id });
                      }}
                    >
                      {t("savings.done.submit")}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      aria-label={t("savings.clear.name", {
                        name: target.name,
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
            <Text size="xs" c="dimmed">
              {t(target.account_id !== null ? "savings.heldHintAccount" : "savings.heldHintBucket")}
            </Text>
          </Stack>
        )}

        {target.note && (
          <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {target.note}
          </Text>
        )}

        <Group>
          <Button
            variant="outline"
            leftSection={<IconPlus size={16} />}
            aria-label={t("savings.add.name", { name: target.name })}
            onClick={() => {
              setAction({ kind: "add" });
            }}
          >
            {t("savings.add.submit")}
          </Button>
        </Group>
      </Stack>
      <SavingsDialog
        target={target}
        action={action}
        onClose={() => {
          setAction(null);
        }}
      />
    </Card>
  );
}
