import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Radio,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  ADJUST_MODES,
  adjustPreview,
  adjustProblem,
  changesThisCycle,
  movePreview,
  moveProblem,
  type AdjustMode,
  type MovePreview,
} from "@/lib/bucketAdjust";
import { isFullyManual } from "@/lib/buckets";
import { isOverdue } from "@/lib/cycles";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import { autofocusField } from "@/lib/device";

/** A signed amount: "+300.00" or "−300.00". */
function signed(amount: string, currency: string): string {
  const negative = compareAmounts(amount, "0") < 0;
  const abs = negative ? subtractAmounts("0", amount) : amount;
  return `${negative ? "−" : "+"}${formatMoney(abs, currency)}`;
}

/**
 * Adjust funds (spec §9): a bucket's button on the Buckets screen, opening a
 * dialog that changes what's left this cycle (BUA), the refill amount, or
 * both by the same amount, or moves funds to another bucket (BAT). A Fully
 * manual bucket (#76) has Add and Remove funds for the first, and no refill
 * amount, so it only moves funds.
 */
export function AdjustButton({ bucket, size }: { bucket: Bucket; size: number }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const close = () => {
    setOpened(false);
  };
  return (
    <>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={size}
        aria-label={t("buckets.adjust.adjustName", { name: bucket.name })}
        title={t("buckets.adjust.title")}
        onClick={() => {
          setOpened(true);
        }}
      >
        <IconAdjustmentsHorizontal size={18} />
      </ActionIcon>
      <ResponsiveModal
        opened={opened}
        onClose={close}
        title={t("buckets.adjust.dialogTitle", { name: bucket.name })}
      >
        {opened && <AdjustDialog bucket={bucket} onDone={close} />}
      </ResponsiveModal>
    </>
  );
}

type Tab = "adjust" | "move";

function AdjustDialog({ bucket, onDone }: { bucket: Bucket; onDone: () => void }) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const active = useCurrentCycles().data?.active ?? null;
  // An active cycle that isn't overdue, so this cycle can change.
  const usable = active !== null && !isOverdue(active);
  const manual = isFullyManual(bucket);
  const [chosen, setTab] = useState<Tab>("adjust");
  const tab = manual ? "move" : chosen;

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {manual
          ? t("buckets.adjust.currentManual", {
              tf: formatMoney(bucket.target_funds, bucket.currency),
            })
          : t("buckets.adjust.current", {
              tf: formatMoney(bucket.target_funds, bucket.currency),
              ra: formatMoney(bucket.refill_amount, bucket.currency),
            })}
      </Text>
      {manual ? (
        <Title order={3} size="h5">
          {t("buckets.adjust.tabs.move")}
        </Title>
      ) : (
        <SegmentedControl
          fullWidth
          aria-label={t("buckets.adjust.title")}
          value={tab}
          onChange={(v) => {
            setTab(v === "move" ? "move" : "adjust");
          }}
          data={[
            { value: "adjust", label: t("buckets.adjust.tabs.adjust") },
            { value: "move", label: t("buckets.adjust.tabs.move") },
          ]}
        />
      )}
      {tab === "adjust" ? (
        <AdjustForm bucket={bucket} usable={usable} onDone={onDone} />
      ) : (
        <MoveFunds
          bucket={bucket}
          buckets={buckets}
          accounts={accounts}
          usable={usable}
          onDone={onDone}
        />
      )}
    </Stack>
  );
}

/** Sets this cycle's amount, the refill amount, or both. */
function AdjustForm({
  bucket,
  usable,
  onDone,
}: {
  bucket: Bucket;
  usable: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [mode, setMode] = useState<AdjustMode>("temporary");
  const [value, setValue] = useState<string | null>(null);
  const money = (amount: string) => formatMoney(amount, bucket.currency);

  const blocked = changesThisCycle(mode) && !usable;
  const problem = adjustProblem(bucket, mode, value);
  const preview = value !== null && problem === null && adjustPreview(bucket, mode, value);

  const apply = useMutation({
    mutationFn: (body: { mode: AdjustMode; value: string }) =>
      unwrap(
        api.POST("/api/v1/buckets/{bucketId}/adjustment", {
          params: { path: { bucketId: bucket.id } },
          body:
            body.mode === "temporary"
              ? { mode: body.mode, target_funds: body.value }
              : { mode: body.mode, refill_amount: body.value },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("buckets.adjust.applied", { name: bucket.name }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <ModeCards
        label={t("buckets.adjust.mode")}
        value={mode}
        hints="hints"
        onChange={(m) => {
          setMode(m);
          setValue(null);
          apply.reset();
        }}
      />

      <AmountInput
        key={mode}
        label={t(mode === "temporary" ? "buckets.adjust.newTarget" : "buckets.adjust.newRefill")}
        currency={bucket.currency}
        value={value}
        onChange={setValue}
        error={
          value !== null && problem === "negative"
            ? t("common.notNegative")
            : problem === "same"
              ? t("buckets.adjust.same")
              : undefined
        }
        maw={260}
        {...autofocusField()}
      />

      {preview && (
        <Stack gap={2}>
          {mode !== "temporary" && (
            <Text size="sm">
              {t("buckets.adjust.previewRefill", {
                from: money(preview.ra.from),
                to: money(preview.ra.to),
              })}
            </Text>
          )}
          <Text size="sm">
            {compareAmounts(preview.bua, "0") === 0
              ? t("buckets.adjust.previewCycleSame", { amount: money(preview.tf.from) })
              : t("buckets.adjust.previewCycle", {
                  from: money(preview.tf.from),
                  to: money(preview.tf.to),
                  amount: signed(preview.bua, bucket.currency),
                })}
          </Text>
          {preview.capacity.raised && (
            <Text size="xs" c="dimmed">
              {t("buckets.adjust.capacityRaised", {
                amount: money(preview.capacity.capacity),
              })}
            </Text>
          )}
          {compareAmounts(preview.tf.to, "0") < 0 && (
            <Text size="sm" c="var(--mantine-color-red-text)">
              {t("buckets.adjust.overspent", {
                name: bucket.name,
                amount: money(subtractAmounts("0", preview.tf.to)),
              })}
            </Text>
          )}
        </Stack>
      )}

      {blocked && <Alert color="orange">{t("buckets.adjust.needsCycle")}</Alert>}
      {apply.error && <ErrorAlert error={apply.error} />}

      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={apply.isPending}
          disabled={!preview || blocked}
          onClick={() => {
            if (value !== null) apply.mutate({ mode, value });
          }}
        >
          {t("buckets.adjust.apply")}
        </Button>
      </Group>
    </Stack>
  );
}

/** The three modes as radio cards, with a hint each. */
function ModeCards({
  label,
  value,
  hints,
  onChange,
}: {
  label: string;
  value: AdjustMode;
  hints: "hints" | "moveHints";
  onChange: (mode: AdjustMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Radio.Group
      label={label}
      value={value}
      onChange={(v) => {
        const next = ADJUST_MODES.find((m) => m === v);
        if (next) onChange(next);
      }}
    >
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm" mt="xs">
        {ADJUST_MODES.map((m) => (
          <Radio.Card key={m} value={m} p="sm" radius="md">
            <Group wrap="nowrap" align="flex-start" gap="sm">
              <Radio.Indicator mt={2} />
              <div>
                <Text fw={600} size="sm">
                  {t(`buckets.adjust.modes.${m}`)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`buckets.adjust.${hints}.${m}`)}
                </Text>
              </div>
            </Group>
          </Radio.Card>
        ))}
      </SimpleGrid>
    </Radio.Group>
  );
}

/** Moves funds from bucket to another bucket in the same currency. */
function MoveFunds({
  bucket,
  buckets,
  accounts,
  usable,
  onDone,
}: {
  bucket: Bucket;
  buckets: Bucket[];
  accounts: Account[];
  usable: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [to, setTo] = useState<string | null>(null);
  const [chosen, setMode] = useState<AdjustMode>("temporary");
  const [amount, setAmount] = useState<string | null>(null);
  const money = (a: string) => formatMoney(a, bucket.currency);

  const targets = buckets.filter((b) => b.id !== bucket.id && b.currency === bucket.currency);
  const groups = accounts
    .map((a) => ({
      group: a.name,
      items: targets
        .filter((b) => b.source_account_id === a.id)
        .map((b) => ({ value: b.id, label: b.name })),
    }))
    .filter((g) => g.items.length > 0);
  const target = targets.find((b) => b.id === to);
  // A Fully manual bucket has no refill amount to move (#76).
  const onlyTemporary = isFullyManual(bucket) || (target !== undefined && isFullyManual(target));
  const mode = onlyTemporary ? "temporary" : chosen;

  const blocked = changesThisCycle(mode) && !usable;
  const problem = moveProblem(bucket, mode, amount, target);
  const preview =
    target && amount !== null && problem === null && movePreview(bucket, target, mode, amount);

  const move = useMutation({
    mutationFn: (body: { to: string; mode: AdjustMode; amount: string }) =>
      unwrap(
        api.POST("/api/v1/buckets/{bucketId}/transfer", {
          params: { path: { bucketId: bucket.id } },
          body: { to_bucket_id: body.to, mode: body.mode, amount: body.amount },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (_, body) => {
      notifications.show({
        color: "green",
        message: t("buckets.adjust.moved", {
          amount: money(body.amount),
          from: bucket.name,
          to: target?.name ?? "",
        }),
      });
      onDone();
      await refresh();
    },
  });

  if (targets.length === 0) {
    return <Text c="dimmed">{t("buckets.adjust.noTargets", { currency: bucket.currency })}</Text>;
  }

  const side = (b: Bucket, s: MovePreview["from"]) =>
    t("buckets.adjust.movePreview", {
      name: b.name,
      tfFrom: money(s.tf.from),
      tfTo: money(s.tf.to),
      raFrom: money(s.ra.from),
      raTo: money(s.ra.to),
    });

  return (
    <Stack gap="md">
      <Select
        label={t("buckets.adjust.moveTo")}
        placeholder={t("buckets.adjust.pickBucket")}
        data={groups}
        value={to}
        onChange={setTo}
        searchable
      />
      {onlyTemporary ? (
        <Text size="sm" c="dimmed">
          {t("buckets.adjust.fullyManualMove")}
        </Text>
      ) : (
        <ModeCards
          label={t("buckets.adjust.mode")}
          value={mode}
          hints="moveHints"
          onChange={(m) => {
            setMode(m);
            move.reset();
          }}
        />
      )}
      <AmountInput
        label={t("buckets.adjust.amount")}
        currency={bucket.currency}
        value={amount}
        onChange={setAmount}
        error={
          problem === "notPositive"
            ? t("buckets.adjust.enterAmount")
            : problem === "overRefill"
              ? t("buckets.adjust.overRefill", {
                  name: bucket.name,
                  amount: money(bucket.refill_amount),
                })
              : problem === "overCapacity" && target
                ? t("buckets.adjust.overCapacity", {
                    name: target.name,
                    amount: money(target.capacity ?? "0"),
                  })
                : undefined
        }
        maw={260}
      />
      {preview && (
        <Stack gap={2}>
          <Text size="sm">{side(bucket, preview.from)}</Text>
          <Text size="sm">{side(target, preview.to)}</Text>
          {preview.overspends && (
            <Text size="sm" c="var(--mantine-color-red-text)">
              {t("buckets.adjust.overspent", {
                name: bucket.name,
                amount: money(subtractAmounts("0", preview.from.tf.to)),
              })}
            </Text>
          )}
        </Stack>
      )}
      {blocked && <Alert color="orange">{t("buckets.adjust.needsCycle")}</Alert>}
      {move.error && <ErrorAlert error={move.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={move.isPending}
          disabled={!preview || blocked}
          onClick={() => {
            if (to !== null && amount !== null) move.mutate({ to, mode, amount });
          }}
        >
          {t("buckets.adjust.moveButton")}
        </Button>
      </Group>
    </Stack>
  );
}
