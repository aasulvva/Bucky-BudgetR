import { Alert, Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMinus, IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useBuckets, useRefreshMoney, type Bucket } from "@/api/accounts";
import { api } from "@/api/client";
import type { Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { signedMoney } from "@/components/transactions/lookups";
import { fundsPreview, fundsProblem, fundsRoom, type FundsKind } from "@/lib/bucketAdjust";
import { isFullyManual } from "@/lib/buckets";
import { isOverdue } from "@/lib/cycles";
import { autofocusField } from "@/lib/device";
import { compareAmounts, formatMoney } from "@/lib/money";

/**
 * Add funds and Remove funds for a Fully manual bucket (#76), in the place
 * other buckets have Refill: a temporary adjustment (BUA) from or to the
 * account's unallocated money, while a cycle runs.
 */
export function FundsButtons({
  bucket,
  active,
  full,
}: {
  bucket: Bucket;
  active: Cycle | null;
  full?: boolean;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<FundsKind | null>(null);
  const close = () => {
    setKind(null);
  };
  if (!isFullyManual(bucket) || !active || isOverdue(active)) return null;

  const button = (k: FundsKind) => (
    <Button
      variant="outline"
      size={full ? "md" : "xs"}
      fullWidth={full}
      leftSection={k === "add" ? <IconPlus size={14} /> : <IconMinus size={14} />}
      // Nothing to remove from an empty or overspent bucket.
      disabled={k === "remove" && compareAmounts(bucket.target_funds, "0") <= 0}
      aria-label={t(k === "add" ? "buckets.funds.addName" : "buckets.funds.removeName", {
        name: bucket.name,
      })}
      onClick={() => {
        setKind(k);
      }}
    >
      {t(k === "add" ? "buckets.funds.add" : "buckets.funds.remove")}
    </Button>
  );
  const buttons = (
    <>
      {button("add")}
      {button("remove")}
    </>
  );

  return (
    <>
      {full ? (
        <SimpleGrid cols={2} spacing="xs">
          {buttons}
        </SimpleGrid>
      ) : (
        <Group gap="xs" wrap="nowrap">
          {buttons}
        </Group>
      )}
      <ResponsiveModal
        opened={kind !== null}
        onClose={close}
        title={t(kind === "remove" ? "buckets.funds.removeTitle" : "buckets.funds.addTitle", {
          name: bucket.name,
        })}
      >
        {kind && <FundsForm key={kind} bucket={bucket} kind={kind} onDone={close} />}
      </ResponsiveModal>
    </>
  );
}

function FundsForm({
  bucket,
  kind,
  onDone,
}: {
  bucket: Bucket;
  kind: FundsKind;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const account = (useAccounts().data ?? []).find((a) => a.id === bucket.source_account_id);
  const buckets = useBuckets().data ?? [];
  const [amount, setAmount] = useState<string | null>(null);
  const money = (a: string) => formatMoney(a, bucket.currency);

  const room = fundsRoom(bucket);
  const problem = fundsProblem(bucket, kind, amount);
  const preview =
    amount !== null && problem === null && fundsPreview(bucket, account, buckets, kind, amount);

  const apply = useMutation({
    mutationFn: (target: string) =>
      unwrap(
        api.POST("/api/v1/buckets/{bucketId}/adjustment", {
          params: { path: { bucketId: bucket.id } },
          body: { mode: "temporary", target_funds: target },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t(kind === "add" ? "buckets.funds.added" : "buckets.funds.removed", {
          name: bucket.name,
          amount: money(amount ?? "0"),
        }),
      });
      onDone();
      await refresh();
    },
  });

  const full = kind === "add" && room !== null && compareAmounts(room, "0") <= 0;
  const error =
    problem === "notPositive"
      ? t("buckets.adjust.enterAmount")
      : problem === "overCapacity" && room !== null
        ? t("buckets.funds.overCapacity", {
            capacity: money(bucket.capacity ?? "0"),
            amount: money(room),
          })
        : problem === "overFunds"
          ? t("buckets.funds.overFunds", { name: bucket.name, amount: money(bucket.target_funds) })
          : undefined;

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {kind === "add"
          ? t("buckets.funds.addHint", {
              account: account?.name ?? "",
              amount: money(account?.unallocated ?? "0"),
            })
          : t("buckets.funds.removeHint", { account: account?.name ?? "" })}
      </Text>
      {full ? (
        <Alert color="orange">
          {t("buckets.funds.full", { name: bucket.name, amount: money(bucket.capacity ?? "0") })}
        </Alert>
      ) : (
        <AmountInput
          label={t("buckets.funds.amount")}
          currency={bucket.currency}
          value={amount}
          onChange={setAmount}
          error={error}
          maw={260}
          {...autofocusField()}
        />
      )}

      {preview && (
        <Stack gap={2}>
          <Text size="sm">
            {t("buckets.funds.preview", {
              name: bucket.name,
              from: money(preview.tf.from),
              to: money(preview.tf.to),
              amount: signedMoney({ amount: preview.bua, signed: true }, bucket.currency),
            })}
          </Text>
          {compareAmounts(preview.short, "0") > 0 && (
            <Text size="sm" c="var(--mantine-color-orange-text)">
              {t("buckets.funds.short", {
                account: account?.name ?? "",
                amount: money(preview.short),
              })}
            </Text>
          )}
        </Stack>
      )}

      {apply.error && <ErrorAlert error={apply.error} />}

      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={apply.isPending}
          disabled={!preview}
          onClick={() => {
            if (preview) apply.mutate(preview.tf.to);
          }}
        >
          {t(kind === "add" ? "buckets.funds.add" : "buckets.funds.remove")}
        </Button>
      </Group>
    </Stack>
  );
}
