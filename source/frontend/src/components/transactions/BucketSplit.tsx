import { ActionIcon, Anchor, Box, Button, Group, Select, Stack, Text, Title } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { AmountInput } from "@/components/AmountInput";
import { isCard } from "@/lib/cards";
import { formatMoney } from "@/lib/money";
import { bucketTotals, newLine, prefillFor, type SplitLine } from "@/lib/transactionForm";

/** What the split shows wrong: the total, and per row key. */
export interface SplitErrors {
  split?: string;
  lines?: Record<number, { bucket?: string; amount?: string }>;
}

/**
 * The split between the account's buckets; the rest isn't tied to a bucket.
 * Locked, it only shows the lines.
 */
export function BucketSplit({
  account,
  accounts,
  own,
  all,
  active,
  amount,
  lines,
  onChange,
  errors,
  locked,
  needsCycle,
  count,
}: {
  account: Account | undefined;
  accounts: Account[];
  /** The buckets it can use: the account's, or on a card, any in its currency. */
  own: Bucket[];
  all: Bucket[];
  active: Cycle | null;
  amount: string | null;
  lines: SplitLine[];
  onChange: (lines: SplitLine[]) => void;
  errors: SplitErrors;
  locked: boolean;
  /** Bucket lines need an active cycle, unlike a schedule's. */
  needsCycle: boolean;
  /** Count in bucket (#264), under the split. */
  count?: ReactNode;
}) {
  const { t } = useTranslation();
  const money = (value: string) => formatMoney(value, account?.currency);
  const card = isCard(account);
  const totals = bucketTotals(amount, lines);
  const free = own.filter((b) => !lines.some((l) => l.bucketId === b.id));
  const summary = (
    <>
      <Box p="sm" bg="var(--mantine-color-default-hover)" style={{ borderRadius: 8 }}>
        <Group justify="space-between">
          <Text size="sm">{t("newTransaction.inBuckets")}</Text>
          <Text size="sm">{money(totals.inBuckets)}</Text>
        </Group>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {t("newTransaction.notTied")}
          </Text>
          <Text size="sm" c={totals.over ? "var(--mantine-color-red-text)" : "dimmed"}>
            {money(totals.notTied)}
          </Text>
        </Group>
      </Box>
      {errors.split && (
        <Text size="sm" c="var(--mantine-color-red-text)" role="alert">
          {errors.split}
        </Text>
      )}
    </>
  );

  let body;
  if (locked) {
    body = (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("transactions.lockedEdit")}
        </Text>
        {lines.map((l) => (
          <Group key={l.key} justify="space-between">
            <Text size="sm">
              {all.find((b) => b.id === l.bucketId)?.name ??
                t("transactions.unknownBucket", { id: l.bucketId })}
            </Text>
            <Text size="sm">{money(l.amount ?? "0")}</Text>
          </Group>
        ))}
        {summary}
      </Stack>
    );
  } else if (!account) {
    body = (
      <Text size="sm" c="dimmed">
        {t("newTransaction.chooseAccountFirst")}
      </Text>
    );
  } else if (!active && needsCycle) {
    body = (
      <Text size="sm" c="dimmed">
        <Trans
          i18nKey="newTransaction.needsCycle"
          components={{ cycles: <Anchor component={Link} to="/cycles" /> }}
        />
      </Text>
    );
  } else if (own.length === 0 && lines.length === 0) {
    body = (
      <Text size="sm" c="dimmed">
        {card
          ? t("cards.debt.noBuckets", { currency: account.currency })
          : t("newTransaction.noAccountBuckets")}
      </Text>
    );
  } else {
    body = (
      <Stack gap="sm">
        {lines.map((l) => {
          const bucket = own.find((b) => b.id === l.bucketId);
          const lineErrors = errors.lines?.[l.key];
          const usable = own.filter(
            (b) => b.id === l.bucketId || !lines.some((o) => o.bucketId === b.id),
          );
          const option = (b: Bucket) => ({
            value: b.id,
            label: t("newTransaction.bucketOption", {
              name: b.name,
              amount: money(b.current_available_funds),
            }),
          });
          // On a card, grouped by the account they're on (#261).
          const options = card
            ? accounts
                .map((a) => ({
                  group: a.name,
                  items: usable.filter((b) => b.source_account_id === a.id).map(option),
                }))
                .filter((g) => g.items.length > 0)
            : usable.map(option);
          const update = (change: Partial<SplitLine>) => {
            onChange(lines.map((o) => (o.key === l.key ? { ...o, ...change } : o)));
          };
          return (
            <Group key={l.key} gap="xs" align="flex-start" wrap="nowrap">
              <Select
                aria-label={t("newTransaction.bucket")}
                placeholder={t("newTransaction.bucket")}
                data={options}
                value={l.bucketId}
                allowDeselect={false}
                onChange={(v) => {
                  update({ bucketId: v });
                }}
                error={lineErrors?.bucket}
                style={{ flex: 1, minWidth: 0 }}
              />
              <AmountInput
                aria-label={
                  bucket
                    ? t("newTransaction.amountFor", { name: bucket.name })
                    : t("newTransaction.amountForBucket")
                }
                currency={account.currency}
                value={l.amount}
                onChange={(v) => {
                  update({ amount: v });
                }}
                error={lineErrors?.amount}
                w={130}
              />
              <ActionIcon
                variant="default"
                size={36}
                aria-label={
                  bucket
                    ? t("newTransaction.removeBucket", { name: bucket.name })
                    : t("newTransaction.removeRow")
                }
                onClick={() => {
                  onChange(lines.filter((o) => o.key !== l.key));
                }}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          );
        })}
        <Button
          variant="subtle"
          leftSection={<IconPlus size={16} />}
          style={{ alignSelf: "flex-start" }}
          disabled={free.length === 0}
          onClick={() => {
            // With one bucket left to pick, pick it.
            const only = free.length === 1 ? (free[0]?.id ?? null) : null;
            onChange([...lines, newLine(only, prefillFor(amount, lines))]);
          }}
        >
          {t("newTransaction.addBucket")}
        </Button>
        {summary}
      </Stack>
    );
  }

  return (
    <Stack
      gap="sm"
      style={{ flex: "1 1 360px", minWidth: 0 }}
      component="section"
      aria-label={t("newTransaction.buckets")}
    >
      <Group justify="space-between" align="baseline">
        <Title order={3} size="h5">
          {t("newTransaction.buckets")}
        </Title>
        {account && (
          <Text size="sm" c="dimmed">
            {card
              ? t("cards.debt.fundedFromAny", { currency: account.currency })
              : t("newTransaction.fundedFrom", { name: account.name })}
          </Text>
        )}
      </Group>
      {body}
      {count}
    </Stack>
  );
}
