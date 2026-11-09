import { Anchor, Group, Progress, Stack, Text } from "@mantine/core";
import { useContext, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useBucketFigures, type Account, type Bucket, type BucketFigures } from "@/api/accounts";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { BucketName, LeftFunds, UsedThisCycle } from "@/components/buckets/BucketParts";
import { coverage, toneText, usageColor } from "@/lib/buckets";
import {
  mostUsed,
  needsAttention,
  shownBucketStatus,
  usedPct,
  type WidgetInstance,
} from "@/lib/dashboard";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

import { WidgetFrame } from "./frame";
import { BucketsSummary, Gone, MoneyState, NoBuckets, WidgetCard } from "./Widget";

/**
 * The buckets that need attention, all of them, the most used, those of one
 * account, or one bucket.
 */
export function BucketStatusWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"bucket_status">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const active = useCurrentCycles().data?.active ?? null;
  const figures = useBucketFigures(active?.id);
  const byId = new Map(figures.data?.map((f) => [f.bucket_id, f]));
  return (
    <WidgetCard
      title={t("dashboard.bucketStatus.title")}
      link={{ to: "/buckets", label: t("nav.items.buckets") }}
      action={action}
    >
      <MoneyState>
        {(accounts, buckets) => {
          const shown = shownBucketStatus(widget.settings, accounts, buckets);
          if (shown.mode === "account" && !shown.account) return <Gone what="account" />;
          if (shown.mode === "bucket" && !shown.bucket) return <Gone what="bucket" />;
          if (buckets.length === 0) return <NoBuckets accounts={accounts} />;
          return (
            <>
              {widget.settings.showMode && (
                <Text size="xs" c="dimmed">
                  {t(`dashboard.bucketStatus.modes.${shown.mode}`)}
                </Text>
              )}
              {shown.mode === "attention" && <Attention buckets={buckets} figures={byId} />}
              {shown.mode === "all" && (
                <AllBuckets accounts={accounts} buckets={buckets} figures={byId} />
              )}
              {shown.mode === "account" && shown.account && (
                <OneAccount account={shown.account} buckets={buckets} figures={byId} />
              )}
              {shown.mode === "most_used" && (
                <MostUsed buckets={buckets} figures={byId} active={active} />
              )}
              {shown.mode === "bucket" && shown.bucket && (
                <OneBucket
                  bucket={shown.bucket}
                  figures={byId.get(shown.bucket.id)}
                  active={active}
                />
              )}
            </>
          );
        }}
      </MoneyState>
    </WidgetCard>
  );
}

interface FiguresProps {
  buckets: Bucket[];
  figures: Map<string, BucketFigures>;
}

function Attention({ buckets, figures }: FiguresProps) {
  const { t } = useTranslation();
  const list = needsAttention(buckets, figures);
  if (list.length === 0) {
    return <Text size="sm">{t("dashboard.bucketStatus.allFine")}</Text>;
  }
  return (
    <Stack gap="xs">
      {list.map(({ bucket, reason }) => {
        const money = (amount: string) => formatMoney(amount, bucket.currency);
        const { gap, tone } = coverage(bucket);
        const text =
          reason === "overspent"
            ? t("dashboard.bucketStatus.overspentBy", {
                amount: money(subtractAmounts("0", bucket.target_funds)),
              })
            : reason === "uncovered"
              ? t("buckets.notCovered", { amount: money(gap) })
              : t("dashboard.bucketStatus.used", { pct: usedPct(figures.get(bucket.id)) ?? 0 });
        return (
          <Group key={bucket.id} justify="space-between" gap="xs" wrap="nowrap">
            <BucketName bucket={bucket} />
            <Text
              size="sm"
              c={reason === "mostlyUsed" ? "var(--mantine-color-yellow-text)" : toneText(tone)}
              style={{ whiteSpace: "nowrap" }}
            >
              {text}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

/** A bucket on one line, with what's left and its usage bar below. */
function CompactBucket({
  bucket,
  pct,
  right,
}: {
  bucket: Bucket;
  pct: number | null;
  right: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <BucketName bucket={bucket} />
        {right}
      </Group>
      {pct !== null && (
        <Progress
          size="sm"
          value={Math.min(pct, 100)}
          color={usageColor(pct)}
          aria-label={t("dashboard.bucketStatus.usedOf", { name: bucket.name, pct })}
        />
      )}
    </Stack>
  );
}

function AllBuckets({ accounts, buckets, figures }: FiguresProps & { accounts: Account[] }) {
  return (
    <Stack gap="md">
      {accounts
        .filter((a) => buckets.some((b) => b.source_account_id === a.id))
        .map((a) => (
          <AccountBuckets key={a.id} account={a} buckets={buckets} figures={figures} named />
        ))}
    </Stack>
  );
}

/** An account's buckets, in the Buckets screen's order, under its name if `named`. */
function AccountBuckets({
  account,
  buckets,
  figures,
  named,
}: FiguresProps & { account: Account; named: boolean }) {
  return (
    <Stack gap="xs" component="article" aria-label={account.name}>
      {named && (
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          {account.name}
        </Text>
      )}
      {buckets
        .filter((b) => b.source_account_id === account.id)
        .map((b) => (
          <CompactBucket
            key={b.id}
            bucket={b}
            pct={usedPct(figures.get(b.id))}
            right={<LeftAmount bucket={b} />}
          />
        ))}
    </Stack>
  );
}

/** One account (#89): what its buckets have left, then each of them. */
function OneAccount({ account, buckets, figures }: FiguresProps & { account: Account }) {
  // No need to name the account again under a title that does.
  const titled = useContext(WidgetFrame).title === account.name;
  if (!buckets.some((b) => b.source_account_id === account.id)) {
    return (
      <Text size="sm" c="dimmed">
        <Trans
          i18nKey="dashboard.bucketStatus.noAccountBuckets"
          values={{ name: account.name }}
          components={{ setup: <Anchor component={Link} to="/buckets/setup" /> }}
        />
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      <BucketsSummary account={account} buckets={buckets} />
      <AccountBuckets account={account} buckets={buckets} figures={figures} named={!titled} />
    </Stack>
  );
}

/** What's left in a bucket: what the account backs, or its negative TF. */
function LeftAmount({ bucket }: { bucket: Bucket }) {
  const { tone, overspent, gap } = coverage(bucket);
  const shown = overspent ? bucket.target_funds : bucket.current_available_funds;
  return (
    <Text
      size="sm"
      fw={600}
      c={overspent || compareAmounts(gap, "0") > 0 ? toneText(tone) : undefined}
      style={{ whiteSpace: "nowrap" }}
    >
      {formatMoney(shown, bucket.currency)}
    </Text>
  );
}

function MostUsed({ buckets, figures, active }: FiguresProps & { active: Cycle | null }) {
  const { t } = useTranslation();
  const list = mostUsed(buckets, figures);
  if (list.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {active ? t("dashboard.bucketStatus.noneUsed") : t("buckets.noCycleFigures")}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {list.map(({ bucket, pct }) => (
        <CompactBucket
          key={bucket.id}
          bucket={bucket}
          pct={pct}
          right={
            <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {pct}%
            </Text>
          }
        />
      ))}
    </Stack>
  );
}

function OneBucket({
  bucket,
  figures,
  active,
}: {
  bucket: Bucket;
  figures: BucketFigures | undefined;
  active: Cycle | null;
}) {
  const { t } = useTranslation();
  // No need to name the bucket again under a title that does.
  const titled = useContext(WidgetFrame).title === bucket.name;
  return (
    <Stack gap="xs">
      <BucketName bucket={bucket} hideName={titled} />
      <div>
        <Text size="xs" c="dimmed">
          {t("buckets.leftThisCycle")}
        </Text>
        <LeftFunds bucket={bucket} large />
      </div>
      <UsedThisCycle bucket={bucket} figures={figures} active={active} long />
    </Stack>
  );
}
