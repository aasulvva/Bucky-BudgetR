import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useRefreshMoney, type Account, type Bucket } from "@/api/accounts";
import { api } from "@/api/client";
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
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

/** A signed amount: "+300.00" or "−300.00". */
function signed(amount: string, currency: string): string {
  const negative = compareAmounts(amount, "0") < 0;
  const abs = negative ? subtractAmounts("0", amount) : amount;
  return `${negative ? "−" : "+"}${formatMoney(abs, currency)}`;
}

/**
 * Adjust funds (spec §9, canvas "Bucket setup"): change what's left this
 * cycle (BUA), the refill amount, or both by the same amount, and move funds
 * to another bucket (BAT). Applied at once, apart from the bucket's form.
 */
export function AdjustFunds({
  bucket,
  buckets,
  accounts,
  usable,
}: {
  bucket: Bucket;
  buckets: Bucket[];
  accounts: Account[];
  /** There's an active cycle that isn't overdue, so this cycle can change. */
  usable: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [mode, setMode] = useState<AdjustMode>("temporary");
  const [value, setValue] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
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
        message: t("bucketSetup.adjust.applied", { name: bucket.name }),
      });
      setValue(null);
      await refresh();
    },
  });

  return (
    <Card withBorder component="section" aria-label={t("bucketSetup.adjust.title")}>
      <Stack gap="md">
        <Group justify="space-between" align="baseline" gap="xs" wrap="wrap">
          <Title order={4} size="h5">
            {t("bucketSetup.adjust.title")}
          </Title>
          <Text size="sm" c="dimmed">
            {t("bucketSetup.adjust.current", {
              tf: money(bucket.target_funds),
              ra: money(bucket.refill_amount),
            })}
          </Text>
        </Group>

        <ModeCards
          label={t("bucketSetup.adjust.mode")}
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
          label={t(
            mode === "temporary" ? "bucketSetup.adjust.newTarget" : "bucketSetup.adjust.newRefill",
          )}
          currency={bucket.currency}
          value={value}
          onChange={setValue}
          error={
            value !== null && problem === "negative"
              ? t("common.notNegative")
              : problem === "same"
                ? t("bucketSetup.adjust.same")
                : undefined
          }
          maw={260}
        />

        {preview && (
          <Stack gap={2}>
            {mode !== "temporary" && (
              <Text size="sm">
                {t("bucketSetup.adjust.previewRefill", {
                  from: money(preview.ra.from),
                  to: money(preview.ra.to),
                })}
              </Text>
            )}
            <Text size="sm">
              {compareAmounts(preview.bua, "0") === 0
                ? t("bucketSetup.adjust.previewCycleSame", { amount: money(preview.tf.from) })
                : t("bucketSetup.adjust.previewCycle", {
                    from: money(preview.tf.from),
                    to: money(preview.tf.to),
                    amount: signed(preview.bua, bucket.currency),
                  })}
            </Text>
            {preview.capacity.raised && (
              <Text size="xs" c="dimmed">
                {t("bucketSetup.adjust.capacityRaised", {
                  amount: money(preview.capacity.capacity),
                })}
              </Text>
            )}
            {compareAmounts(preview.tf.to, "0") < 0 && (
              <Text size="sm" c="var(--mantine-color-red-text)">
                {t("bucketSetup.adjust.overspent", {
                  name: bucket.name,
                  amount: money(subtractAmounts("0", preview.tf.to)),
                })}
              </Text>
            )}
          </Stack>
        )}

        {blocked && <Alert color="orange">{t("bucketSetup.adjust.needsCycle")}</Alert>}
        {apply.error && <ErrorAlert error={apply.error} />}

        <Group justify="space-between" gap="sm" wrap="wrap">
          <Button
            variant="outline"
            loading={apply.isPending}
            disabled={!preview || blocked}
            onClick={() => {
              if (value !== null) apply.mutate({ mode, value });
            }}
          >
            {t("bucketSetup.adjust.apply")}
          </Button>
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => {
              setMoving(true);
            }}
          >
            {t("bucketSetup.adjust.move")}
          </Anchor>
        </Group>
      </Stack>

      <ResponsiveModal
        opened={moving}
        onClose={() => {
          setMoving(false);
        }}
        title={t("bucketSetup.adjust.moveTitle", { name: bucket.name })}
      >
        {moving && (
          <MoveFunds
            bucket={bucket}
            buckets={buckets}
            accounts={accounts}
            usable={usable}
            onDone={() => {
              setMoving(false);
            }}
          />
        )}
      </ResponsiveModal>
    </Card>
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
                  {t(`bucketSetup.adjust.modes.${m}`)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`bucketSetup.adjust.${hints}.${m}`)}
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
  const [mode, setMode] = useState<AdjustMode>("temporary");
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

  const blocked = changesThisCycle(mode) && !usable;
  const problem = moveProblem(bucket, mode, amount);
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
        message: t("bucketSetup.adjust.moved", {
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
    return (
      <Text c="dimmed">{t("bucketSetup.adjust.noTargets", { currency: bucket.currency })}</Text>
    );
  }

  const side = (b: Bucket, s: MovePreview["from"]) =>
    t("bucketSetup.adjust.movePreview", {
      name: b.name,
      tfFrom: money(s.tf.from),
      tfTo: money(s.tf.to),
      raFrom: money(s.ra.from),
      raTo: money(s.ra.to),
    });

  return (
    <Stack gap="md">
      <Select
        label={t("bucketSetup.adjust.moveTo")}
        placeholder={t("bucketSetup.adjust.pickBucket")}
        data={groups}
        value={to}
        onChange={setTo}
        searchable
      />
      <ModeCards
        label={t("bucketSetup.adjust.mode")}
        value={mode}
        hints="moveHints"
        onChange={(m) => {
          setMode(m);
          move.reset();
        }}
      />
      <AmountInput
        label={t("bucketSetup.adjust.amount")}
        currency={bucket.currency}
        value={amount}
        onChange={setAmount}
        error={
          problem === "notPositive"
            ? t("bucketSetup.adjust.enterAmount")
            : problem === "overRefill"
              ? t("bucketSetup.adjust.overRefill", {
                  name: bucket.name,
                  amount: money(bucket.refill_amount),
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
              {t("bucketSetup.adjust.overspent", {
                name: bucket.name,
                amount: money(subtractAmounts("0", preview.from.tf.to)),
              })}
            </Text>
          )}
        </Stack>
      )}
      {blocked && <Alert color="orange">{t("bucketSetup.adjust.needsCycle")}</Alert>}
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
          {t("bucketSetup.adjust.moveButton")}
        </Button>
      </Group>
    </Stack>
  );
}
