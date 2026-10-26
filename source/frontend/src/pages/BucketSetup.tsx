import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  NavLink,
  Radio,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  refillModeLabel,
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
  type RefillMode,
} from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { ApiError, unwrap } from "@/api/errors";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { AdjustFunds } from "@/components/buckets/AdjustFunds";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { isOverdue } from "@/lib/cycles";
import { compareAmounts, formatMoney, multiplyAmount, subtractAmounts } from "@/lib/money";
import { checkName } from "@/lib/names";

type BucketCreate = components["schemas"]["BucketCreate"];
type BucketUpdate = components["schemas"]["BucketUpdate"];
type CapMode = components["schemas"]["CapMode"];
type OverflowDestination = components["schemas"]["OverflowDestination"];

const REFILL_MODES: RefillMode[] = ["auto", "manual", "on_income"];

/** The selected bucket in the URL: a bucket ID (`?edit=<id>`), "new" (`?new`), or null. */
type Selection = string | null;

/**
 * Bucket setup (spec §9, canvas "Bucket setup"): the buckets by source
 * account, and the selected one's form beside them (full screen on mobile).
 * `?edit=<id>` opens a bucket, as the cog on the Buckets screen does.
 */
export default function BucketSetup() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const [params, setParams] = useSearchParams();
  const selection: Selection = params.has("new") ? "new" : params.get("edit");

  const select = (next: Selection) => {
    setParams(
      () => {
        const p = new URLSearchParams();
        if (next === "new") p.set("new", "");
        else if (next !== null) p.set("edit", next);
        return p;
      },
      { replace: next === null },
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.bucketSetup")}</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          disabled={accounts.data?.length === 0}
          onClick={() => {
            select("new");
          }}
        >
          {t("bucketSetup.newBucket")}
        </Button>
      </Group>
      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => {
              if (accountList.length === 0) {
                return (
                  <Text c="dimmed">
                    <Trans
                      i18nKey="bucketSetup.needAccount"
                      components={{ setup: <Anchor component={Link} to="/accounts/setup" /> }}
                    />
                  </Text>
                );
              }
              const editing =
                selection && selection !== "new"
                  ? bucketList.find((b) => b.id === selection)
                  : undefined;
              const open = selection === "new" || editing !== undefined;
              const form = open && (
                <BucketForm
                  // Remounted when an adjustment changes RA or the capacity,
                  // so the form starts from the new values.
                  key={
                    editing
                      ? `${editing.id}:${editing.refill_amount}:${editing.cap_amount ?? ""}`
                      : "new"
                  }
                  bucket={editing}
                  accounts={accountList}
                  buckets={bucketList}
                  onDone={(saved) => {
                    select(isDesktop ? saved : null);
                  }}
                />
              );
              const list = (
                <BucketList
                  accounts={accountList}
                  buckets={bucketList}
                  selected={editing?.id ?? null}
                  onSelect={select}
                />
              );

              if (!isDesktop) {
                return (
                  <>
                    {list}
                    <ResponsiveModal
                      opened={open}
                      title={<FormTitle bucket={editing} />}
                      onClose={() => {
                        select(null);
                      }}
                    >
                      {form}
                    </ResponsiveModal>
                  </>
                );
              }
              return (
                <Group align="flex-start" gap="lg" wrap="nowrap">
                  <Box w={320} style={{ flexShrink: 0 }}>
                    {list}
                  </Box>
                  <Card withBorder style={{ flex: 1, minWidth: 0 }}>
                    {form ? (
                      <Stack gap="md">
                        <Title order={3} size="h4">
                          <FormTitle bucket={editing} />
                        </Title>
                        {form}
                      </Stack>
                    ) : (
                      <Text c="dimmed">{t("bucketSetup.pick")}</Text>
                    )}
                  </Card>
                </Group>
              );
            }}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

/** "Groceries (#1000000001)", or "New bucket". */
function FormTitle({ bucket }: { bucket: Bucket | undefined }) {
  const { t } = useTranslation();
  if (!bucket) return t("bucketSetup.newBucket");
  return (
    <>
      {bucket.name}{" "}
      <Text span inherit c="dimmed" fw={400}>
        (#{bucket.id})
      </Text>
    </>
  );
}

function BucketList({
  accounts,
  buckets,
  selected,
  onSelect,
}: {
  accounts: Account[];
  buckets: Bucket[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (buckets.length === 0) {
    return (
      <Card withBorder>
        <Text c="dimmed">{t("bucketSetup.empty")}</Text>
      </Card>
    );
  }
  return (
    <Card withBorder padding="xs">
      <Stack gap="sm">
        {accounts
          .filter((a) => buckets.some((b) => b.source_account_id === a.id))
          .map((a) => (
            <nav key={a.id} aria-label={a.name}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" py={4}>
                {a.name}
              </Text>
              {buckets
                .filter((b) => b.source_account_id === a.id)
                .map((b) => (
                  <NavLink
                    key={b.id}
                    component="button"
                    type="button"
                    label={
                      <>
                        {b.name}{" "}
                        <Text span size="sm" c="dimmed">
                          (#{b.id})
                        </Text>
                      </>
                    }
                    active={b.id === selected}
                    aria-current={b.id === selected ? "true" : undefined}
                    rightSection={
                      <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        {formatMoney(b.refill_amount, b.currency)}
                      </Text>
                    }
                    onClick={() => {
                      onSelect(b.id);
                    }}
                  />
                ))}
            </nav>
          ))}
      </Stack>
    </Card>
  );
}

/** A problem that belongs on the name field, or undefined. */
function nameProblem(error: unknown): string | undefined {
  if (error instanceof ApiError && error.code === "name_taken") {
    return i18n.t("bucketSetup.nameTaken");
  }
  return undefined;
}

/** A capacity multiplier as the API takes it ("1.50"), or null: at least 1, at most 2 decimals. */
function parseMultiplier(text: string): string | null {
  const s = text.trim().replace(",", ".");
  if (!/^[0-9]{1,4}(\.[0-9]{1,2})?$/.test(s)) return null;
  return compareAmounts(s, "1") >= 0 ? s : null;
}

/** Whether the capacity mode, or its multiplier or amount (`value`), differs from the bucket's. */
function capacityChanged(bucket: Bucket, mode: CapMode, value: string | null): boolean {
  if (mode !== bucket.cap_mode) return true;
  const was = mode === "multiplier" ? bucket.cap_multiplier : bucket.cap_amount;
  return value !== null && (was === null || compareAmounts(value, was) !== 0);
}

interface FormErrors {
  name?: string;
  source?: string;
  refillAmount?: string;
  multiplier?: string;
  capAmount?: string;
  opening?: string;
}

/**
 * How a bucket created in a running cycle starts: refilled now, with opening
 * funds, or at 0. The first two count as its refill in the cycle (spec §6).
 */
type Start = "refill" | "amount" | "zero";
const STARTS: Start[] = ["refill", "amount", "zero"];

/**
 * Creates a bucket, or edits one and sends only what changed. How it starts
 * (a refill or opening funds) is for a new bucket only; later changes to
 * its money are adjustments.
 */
function BucketForm({
  bucket,
  accounts,
  buckets,
  onDone,
}: {
  bucket: Bucket | undefined;
  accounts: Account[];
  /** All buckets, to move funds to. */
  buckets: Bucket[];
  /** After saving (with the bucket's ID), deleting or cancelling (null). */
  onDone: (saved: string | null) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const preferences = useSession().data?.preferences;
  const active = useCurrentCycles().data?.active ?? null;
  const usable = active !== null && !isOverdue(active);
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState(bucket?.name ?? "");
  const [source, setSource] = useState<string | null>(
    bucket?.source_account_id ?? (accounts.length === 1 ? (accounts[0]?.id ?? null) : null),
  );
  const [priority, setPriority] = useState(bucket?.priority ?? false);
  const [importance, setImportance] = useState(bucket?.importance ?? 5);
  const [refillAmount, setRefillAmount] = useState<string | null>(bucket?.refill_amount ?? "0.00");
  const [capMode, setCapMode] = useState<CapMode>(bucket?.cap_mode ?? "multiplier");
  const [multiplier, setMultiplier] = useState(bucket?.cap_multiplier ?? "1.00");
  const [capAmount, setCapAmount] = useState<string | null>(bucket?.cap_amount ?? null);
  const [refillMode, setRefillMode] = useState<RefillMode>(
    bucket?.refill_mode ?? preferences?.default_refill_mode ?? "auto",
  );
  const [keepFunds, setKeepFunds] = useState(bucket?.keep_funds ?? false);
  const [overflow, setOverflow] = useState<OverflowDestination>(
    bucket?.overflow_destination ?? "unallocated",
  );
  const [start, setStart] = useState<Start>("refill");
  const [opening, setOpening] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});

  const sourceAccount = accounts.find((a) => a.id === source);
  const currency = bucket?.currency ?? sourceAccount?.currency;
  const sources = accounts
    .filter((a) => !bucket || a.currency === bucket.currency)
    .map((a) => ({ value: a.id, label: a.name }));

  const ra = refillAmount ?? "0.00";
  const mult = parseMultiplier(multiplier);
  const fixed = capMode === "fixed" ? capAmount : null;
  const capacity =
    capMode === "multiplier"
      ? mult && multiplyAmount(ra, mult)
      : fixed && (compareAmounts(fixed, ra) < 0 ? ra : fixed);
  const raised = fixed !== null && compareAmounts(fixed, ra) < 0;

  const capChanged =
    !bucket || capacityChanged(bucket, capMode, capMode === "multiplier" ? mult : fixed);
  const capFields =
    capMode === "multiplier"
      ? { cap_mode: capMode, cap_multiplier: mult ?? "" }
      : { cap_mode: capMode, cap_amount: fixed ?? "" };

  const changes: BucketUpdate = bucket
    ? {
        ...(name.trim() !== bucket.name ? { name: name.trim() } : {}),
        ...(source && source !== bucket.source_account_id ? { source_account_id: source } : {}),
        ...(priority !== bucket.priority ? { priority } : {}),
        ...(importance !== bucket.importance ? { importance } : {}),
        ...(compareAmounts(ra, bucket.refill_amount) !== 0 ? { refill_amount: ra } : {}),
        ...(capChanged ? capFields : {}),
        ...(refillMode !== bucket.refill_mode ? { refill_mode: refillMode } : {}),
        ...(keepFunds !== bucket.keep_funds ? { keep_funds: keepFunds } : {}),
        ...(overflow !== bucket.overflow_destination ? { overflow_destination: overflow } : {}),
      }
    : {};
  const changed = !bucket || Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => {
      if (bucket) {
        return unwrap(
          api.PATCH("/api/v1/buckets/{bucketId}", {
            params: { path: { bucketId: bucket.id } },
            body: changes,
          }),
        );
      }
      const body: BucketCreate = {
        name: name.trim(),
        source_account_id: source ?? "",
        priority,
        importance,
        refill_amount: ra,
        ...capFields,
        refill_mode: refillMode,
        keep_funds: keepFunds,
        overflow_destination: overflow,
        ...(usable && start === "refill" ? { refill: true } : {}),
        ...(usable && start === "amount" && opening !== null ? { opening_funds: opening } : {}),
      };
      return unwrap(api.POST("/api/v1/buckets", { body }));
    },
    meta: { silentError: true },
    onSuccess: async (saved) => {
      notifications.show({
        color: "green",
        message: t(bucket ? "bucketSetup.saved" : "bucketSetup.created", { name: saved.name }),
      });
      await refresh();
      onDone(saved.id);
    },
    onError: (err) => {
      setErrors({ name: nameProblem(err) });
    },
  });

  const validate = (): FormErrors => ({
    name: checkName(name),
    source: source ? undefined : t("common.chooseAccount"),
    refillAmount:
      refillAmount === null
        ? t("common.invalidAmount")
        : compareAmounts(refillAmount, "0") < 0
          ? t("common.notNegative")
          : undefined,
    multiplier: capMode === "multiplier" && !mult ? t("bucketSetup.invalidMultiplier") : undefined,
    capAmount:
      capMode !== "fixed"
        ? undefined
        : capAmount === null
          ? t("bucketSetup.enterCapacity")
          : compareAmounts(capAmount, "0") < 0
            ? t("common.notNegative")
            : undefined,
    opening:
      !bucket &&
      usable &&
      start === "amount" &&
      (opening === null || compareAmounts(opening, "0") <= 0)
        ? t("bucketSetup.enterStartingFunds")
        : undefined,
  });

  if (bucket && deleting) {
    return (
      <DeleteBucket
        bucket={bucket}
        account={accounts.find((a) => a.id === bucket.source_account_id)}
        usable={usable}
        onCancel={() => {
          setDeleting(false);
        }}
        onDone={() => {
          onDone(null);
        }}
      />
    );
  }

  return (
    <Stack gap="lg">
      <form
        noValidate
        aria-label={bucket ? bucket.name : t("bucketSetup.newBucket")}
        onSubmit={(e) => {
          e.preventDefault();
          const found = validate();
          setErrors(found);
          if (Object.values(found).every((v) => v === undefined)) save.mutate();
        }}
      >
        <Stack gap="lg">
          <Stack gap="md">
            <Title order={3} size="h5">
              {t("bucketSetup.details")}
            </Title>
            <TextInput
              label={t("bucketSetup.name")}
              placeholder={t("bucketSetup.namePlaceholder")}
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
              error={errors.name}
              required
              data-autofocus
            />
            <Select
              label={t("bucketSetup.source")}
              description={
                bucket && source !== bucket.source_account_id
                  ? t("bucketSetup.sourceChanged")
                  : t("bucketSetup.sourceHint")
              }
              data={sources}
              value={source}
              allowDeselect={false}
              onChange={(v) => {
                if (v) setSource(v);
              }}
              error={errors.source}
              required
            />
            <Checkbox
              label={t("bucketSetup.priority")}
              description={t("bucketSetup.priorityHint")}
              checked={priority}
              onChange={(e) => {
                setPriority(e.currentTarget.checked);
              }}
            />
            <div>
              <Text size="sm" fw={500} id="importance-label">
                {t("bucketSetup.importance", { value: importance })}
              </Text>
              <Text size="xs" c="dimmed" mb="xs">
                {t("bucketSetup.importanceHint")}
              </Text>
              <Slider
                min={1}
                max={10}
                step={1}
                value={importance}
                onChange={setImportance}
                thumbProps={{ "aria-labelledby": "importance-label" }}
                marks={[{ value: 1 }, { value: 5 }, { value: 10 }]}
              />
            </div>
          </Stack>

          <Stack gap="md">
            <Title order={3} size="h5">
              {t("bucketSetup.refill")}
            </Title>
            <AmountInput
              label={t("bucketSetup.refillAmount")}
              currency={currency}
              value={refillAmount}
              onChange={setRefillAmount}
              error={errors.refillAmount}
              required
            />
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                {t("bucketSetup.capacity")}
              </Text>
              <SegmentedControl
                aria-label={t("bucketSetup.capacity")}
                value={capMode}
                onChange={(v) => {
                  setCapMode(v === "fixed" ? "fixed" : "multiplier");
                }}
                data={[
                  { value: "multiplier", label: t("bucketSetup.multiplier") },
                  { value: "fixed", label: t("bucketSetup.fixed") },
                ]}
              />
              {capMode === "multiplier" ? (
                <TextInput
                  label={t("bucketSetup.multiplier")}
                  inputMode="decimal"
                  autoComplete="off"
                  value={multiplier}
                  onChange={(e) => {
                    setMultiplier(e.currentTarget.value);
                  }}
                  error={errors.multiplier}
                  rightSection={
                    <Text size="sm" c="dimmed">
                      ×
                    </Text>
                  }
                />
              ) : (
                <AmountInput
                  label={t("bucketSetup.capacityAmount")}
                  currency={currency}
                  value={capAmount}
                  onChange={setCapAmount}
                  error={errors.capAmount}
                />
              )}
              <Text size="xs" c="dimmed">
                {capacity && (
                  <>
                    <Text span fw={600} inherit>
                      {t("bucketSetup.capacityIs", { amount: formatMoney(capacity, currency) })}
                    </Text>
                    {" · "}
                  </>
                )}
                {raised ? t("bucketSetup.capacityRaised") : t("bucketSetup.capacityHint")}
              </Text>
            </Stack>
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                {t("bucketSetup.refillMode")}
              </Text>
              <SegmentedControl
                aria-label={t("bucketSetup.refillMode")}
                value={refillMode}
                onChange={(v) => {
                  const mode = REFILL_MODES.find((m) => m === v);
                  if (mode) setRefillMode(mode);
                }}
                data={REFILL_MODES.map((m) => ({ value: m, label: refillModeLabel(m) }))}
              />
            </Stack>
            <Checkbox
              label={t("bucketSetup.keepFunds")}
              description={t("bucketSetup.keepFundsHint")}
              checked={keepFunds}
              onChange={(e) => {
                setKeepFunds(e.currentTarget.checked);
              }}
            />
            <Select
              label={t("bucketSetup.overflow")}
              data={[
                { value: "unallocated", label: t("bucketSetup.overflowUnallocated") },
                {
                  value: "savings_distribution",
                  label: t("bucketSetup.overflowDistribution"),
                  disabled: true,
                },
                { value: "savings_target", label: t("bucketSetup.overflowTarget"), disabled: true },
              ]}
              value={overflow}
              allowDeselect={false}
              onChange={(v) => {
                if (v === "unallocated") setOverflow(v);
              }}
            />
            {!bucket &&
              (usable ? (
                <Radio.Group
                  label={t("bucketSetup.start")}
                  value={start}
                  onChange={(v) => {
                    const next = STARTS.find((s) => s === v);
                    if (next) setStart(next);
                  }}
                >
                  <Stack gap="sm" mt="xs">
                    <Radio
                      value="refill"
                      label={t("bucketSetup.startRefill", { amount: formatMoney(ra, currency) })}
                      description={t("bucketSetup.startRefillHint")}
                    />
                    <Radio value="amount" label={t("bucketSetup.startAmount")} />
                    {start === "amount" && (
                      <AmountInput
                        label={t("bucketSetup.openingFunds")}
                        description={t("bucketSetup.openingHint")}
                        currency={currency}
                        value={opening}
                        onChange={setOpening}
                        error={errors.opening}
                        ml="xl"
                      />
                    )}
                    <Radio
                      value="zero"
                      label={t("bucketSetup.startZero")}
                      description={t("bucketSetup.startZeroHint")}
                    />
                  </Stack>
                </Radio.Group>
              ) : (
                <div>
                  <Text size="sm" fw={500}>
                    {t("bucketSetup.start")}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t("bucketSetup.openingNeedsCycle")}
                  </Text>
                </div>
              ))}
          </Stack>

          {save.error && !nameProblem(save.error) && <ErrorAlert error={save.error} />}
          <Group justify={bucket ? "space-between" : "flex-end"} gap="xs">
            {bucket && (
              <Button
                variant="subtle"
                color="red"
                onClick={() => {
                  setDeleting(true);
                }}
              >
                {t("common.delete")}
              </Button>
            )}
            <Group gap="xs">
              <Button
                variant="default"
                onClick={() => {
                  onDone(null);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!changed}>
                {bucket ? t("common.save") : t("bucketSetup.create")}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
      {bucket && (
        <AdjustFunds bucket={bucket} buckets={buckets} accounts={accounts} usable={usable} />
      )}
    </Stack>
  );
}

/**
 * Deletes a bucket (spec §2). What's left in it is released to the source
 * account's unallocated money in the same step, which needs a usable active
 * cycle unless TF is 0.
 */
function DeleteBucket({
  bucket,
  account,
  usable,
  onCancel,
  onDone,
}: {
  bucket: Bucket;
  account: Account | undefined;
  usable: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const tf = compareAmounts(bucket.target_funds, "0");
  const blocked = tf !== 0 && !usable;
  const values = {
    amount: formatMoney(
      tf < 0 ? subtractAmounts("0", bucket.target_funds) : bucket.target_funds,
      bucket.currency,
    ),
    account: account?.name ?? "",
  };

  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/buckets/{bucketId}", {
          params: { path: { bucketId: bucket.id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("bucketSetup.deleted", { name: bucket.name }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="bucketSetup.deleteQuestion"
          values={{ name: bucket.name }}
          components={{ b: <strong /> }}
        />
      </Text>
      {tf > 0 && <Text>{t("bucketSetup.deleteReleases", values)}</Text>}
      {tf < 0 && <Text>{t("bucketSetup.deleteSettles", values)}</Text>}
      {blocked && <Alert color="orange">{t("bucketSetup.deleteNeedsCycle")}</Alert>}
      {remove.error && <ErrorAlert error={remove.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          {t("common.back")}
        </Button>
        <Button
          color="red"
          loading={remove.isPending}
          disabled={blocked}
          onClick={() => {
            remove.mutate();
          }}
        >
          {t("bucketSetup.deleteBucket")}
        </Button>
      </Group>
    </Stack>
  );
}
