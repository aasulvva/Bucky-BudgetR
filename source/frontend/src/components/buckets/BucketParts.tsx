// The parts of a bucket's figures that Buckets and the Dashboard share: its
// name with its warning, what's left, and the cycle's spending.

import { Anchor, Badge, Group, Progress, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Bucket, BucketFigures } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { TONE_COLOR, breakdownText, coverage, toneText, usageColor } from "@/lib/buckets";
import { compareAmounts, formatMoney, percentOf } from "@/lib/money";

export interface BucketProps {
  bucket: Bucket;
  figures: BucketFigures | undefined;
  active: Cycle | null;
}

export function BucketName({ bucket }: { bucket: Bucket }) {
  const { t } = useTranslation();
  const { overspent, tone } = coverage(bucket);
  const label = overspent
    ? t("buckets.overspentLabel")
    : t(tone === "alert" ? "buckets.alertLabel" : "buckets.warnLabel");
  return (
    <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
      {tone !== "ok" && (
        <IconAlertTriangle size={18} role="img" aria-label={label} color={toneText(tone)} />
      )}
      <Anchor
        component={Link}
        to={`/transactions?bucket_id=${bucket.id}`}
        fw={600}
        c="var(--mantine-color-text)"
      >
        {bucket.name}
      </Anchor>
      {bucket.priority && (
        <Badge size="sm" variant="light" radius="sm">
          {t("buckets.priority")}
        </Badge>
      )}
    </Group>
  );
}

/**
 * What's left: what the account backs (CAF). While that's less than TF, TF
 * is struck through beside it, with a bar of how much is covered. An
 * overspent bucket shows its negative TF.
 */
export function LeftFunds({ bucket, large }: { bucket: Bucket; large?: boolean }) {
  const { t } = useTranslation();
  const { gap, coveredPct, overspent, tone } = coverage(bucket);
  const money = (amount: string) => formatMoney(amount, bucket.currency);
  const fz = large ? 22 : "sm";
  if (overspent) {
    return (
      <div>
        <Text fz={fz} fw={600} c={toneText(tone)} style={{ whiteSpace: "nowrap" }}>
          {money(bucket.target_funds)}
        </Text>
        <Text size="xs" c={toneText(tone)}>
          {t("buckets.overspentLabel")}
        </Text>
      </div>
    );
  }
  const short = compareAmounts(gap, "0") > 0;
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="wrap" align="baseline">
        <Text fz={fz} fw={600} style={{ whiteSpace: "nowrap" }}>
          {money(bucket.current_available_funds)}
        </Text>
        {short && (
          <Text
            component="del"
            size="sm"
            c="dimmed"
            title={t("buckets.target", { amount: money(bucket.target_funds) })}
            style={{ whiteSpace: "nowrap" }}
          >
            {money(bucket.target_funds)}
          </Text>
        )}
      </Group>
      {short && (
        <Progress
          value={coveredPct}
          color={TONE_COLOR[tone]}
          size="sm"
          aria-label={t("buckets.coveredOf", {
            covered: money(bucket.current_available_funds),
            target: money(bucket.target_funds),
          })}
        />
      )}
      {short ? (
        <Text size="xs" c={toneText(tone)}>
          {t("buckets.notCovered", { amount: money(gap) })}
        </Text>
      ) : (
        compareAmounts(bucket.target_funds, "0") > 0 && (
          <Text size="xs" c="dimmed">
            {t("buckets.fullyCovered")}
          </Text>
        )
      )}
    </Stack>
  );
}

/** The cycle's spending out of the budget, with the bar and the breakdown. */
export function UsedThisCycle({ bucket, figures, active, long }: BucketProps & { long?: boolean }) {
  const { t } = useTranslation();
  if (!active || !figures) {
    return (
      <Text size="sm" c="dimmed">
        {active ? "…" : t("buckets.noCycleFigures")}
      </Text>
    );
  }
  const money = (amount: string) => formatMoney(amount, bucket.currency);
  const pct = percentOf(figures.used, figures.budget);
  const values = { used: money(figures.used), budget: money(figures.budget) };
  return (
    <Stack gap={4}>
      {!long && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm">{t("buckets.usedOf", values)}</Text>
          <Text size="xs" c="dimmed">
            {pct}%
          </Text>
        </Group>
      )}
      <Progress
        value={Math.min(pct, 100)}
        color={usageColor(pct)}
        aria-label={t("buckets.usedOfLong", values)}
      />
      {long && <Text size="sm">{t("buckets.usedOfLong", values)}</Text>}
      <Text size="xs" c="dimmed">
        {breakdownText(figures, bucket.currency)}
      </Text>
    </Stack>
  );
}
