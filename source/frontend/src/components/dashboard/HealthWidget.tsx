import { Group, Progress, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import { TONE_COLOR, toneText } from "@/lib/buckets";
import { accountHealth } from "@/lib/dashboard";
import { compareAmounts, formatMoney } from "@/lib/money";

import { MoneyState, NoBuckets, WidgetCard } from "./Widget";

/** How well each account backs its buckets. Its only setting is its title. */
export function HealthWidget({ action }: { action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <WidgetCard
      title={t("dashboard.health.title")}
      link={{ to: "/buckets", label: t("nav.items.buckets") }}
      action={action}
    >
      <MoneyState>
        {(accounts, buckets) => {
          const sources = accounts.filter((a) => buckets.some((b) => b.source_account_id === a.id));
          if (sources.length === 0) return <NoBuckets accounts={accounts} />;
          return (
            <Stack gap="md">
              {sources.map((a) => (
                <AccountHealthRow key={a.id} account={a} buckets={buckets} />
              ))}
            </Stack>
          );
        }}
      </MoneyState>
    </WidgetCard>
  );
}

function AccountHealthRow({ account, buckets }: { account: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const health = accountHealth(account, buckets);
  const money = (amount: string) => formatMoney(amount, account.currency);
  const isShort = compareAmounts(health.short, "0") > 0;
  const problems = [
    health.uncovered > 0 && t("dashboard.health.uncovered", { count: health.uncovered }),
    health.overspent > 0 && t("dashboard.health.overspent", { count: health.overspent }),
  ].filter(Boolean);
  return (
    <Stack gap={4} component="article" aria-label={account.name}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text fw={600}>{account.name}</Text>
        <Text size="sm" c={isShort ? toneText(health.tone) : "dimmed"}>
          {isShort
            ? t("dashboard.health.short", { amount: money(health.short) })
            : t("dashboard.health.unallocated", { amount: money(health.unallocated) })}
        </Text>
      </Group>
      <Progress
        value={health.pct}
        color={TONE_COLOR[health.tone]}
        aria-label={t("buckets.coveredOf", {
          covered: money(health.covered),
          target: money(health.needed),
        })}
      />
      <Text size="xs" c="dimmed">
        {t("dashboard.health.covered", {
          pct: health.pct,
          covered: money(health.covered),
          needed: money(health.needed),
        })}
        {problems.length > 0 && ` · ${problems.join(" · ")}`}
      </Text>
    </Stack>
  );
}
