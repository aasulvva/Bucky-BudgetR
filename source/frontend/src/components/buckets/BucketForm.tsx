// The bucket form (spec §9, Bucket setup): creates a bucket or edits one.
// Bucket setup saves it at once; Budget setup (#112) adds new buckets to its
// draft and creates them on Save.

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Radio,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  refillModeLabel,
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
import { ErrorAlert } from "@/components/ErrorAlert";
import i18n from "@/i18n";
import { isOverdue } from "@/lib/cycles";
import { compareAmounts, formatMoney, multiplyAmount, subtractAmounts } from "@/lib/money";
import { autofocusField } from "@/lib/device";
import { checkName } from "@/lib/names";

type BucketCreate = components["schemas"]["BucketCreate"];
type BucketUpdate = components["schemas"]["BucketUpdate"];
type CapMode = components["schemas"]["CapMode"];
type NegativeTf = components["schemas"]["NegativeTf"];
type OverflowDestination = components["schemas"]["OverflowDestination"];

const REFILL_MODES: RefillMode[] = ["auto", "manual", "on_income", "fully_manual"];
const NEGATIVE_TFS: NegativeTf[] = ["debt", "clear"];
const CAP_MODES: CapMode[] = ["multiplier", "fixed", "none"];
const CAP_MODE_LABELS = {
  multiplier: "bucketSetup.multiplier",
  fixed: "bucketSetup.fixed",
  none: "bucketSetup.noCap",
} as const;

/** "Groceries (#1000000001)", or "New bucket". */
export function FormTitle({ bucket }: { bucket: Bucket | undefined }) {
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
  if (mode === "none") return false;
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
 * A Fully manual bucket is never refilled, so it has the last two only.
 */
type Start = "refill" | "amount" | "zero";
const STARTS: Start[] = ["refill", "amount", "zero"];

/**
 * Creates a bucket, or edits one and sends only what changed. How it starts
 * (a refill or opening funds) is for a new bucket only; later changes to
 * its money are adjustments.
 *
 * A Fully manual bucket (#76) has no refill amount and always keeps its
 * funds, so those fields are hidden; its capacity is a fixed amount or none.
 * This mirrors settings.apply in internal/buckets.
 */
export function BucketForm({
  bucket,
  accounts,
  onDone,
  onOpenSettings,
  initial,
  source: presetSource,
  onDraft,
  onRemove,
  takenNames = [],
}: {
  bucket: Bucket | undefined;
  accounts: Account[];
  /** After saving (with the bucket's ID), deleting or cancelling (null). */
  onDone: (saved: string | null) => void;
  /** Opens the bucket settings, where the defaults and income rules are. */
  onOpenSettings: () => void;
  /** A new bucket's values to start from: one in Budget setup's draft (#112). */
  initial?: BucketCreate;
  /** The source account a new bucket starts with. */
  source?: string;
  /**
   * Draft mode (Budget setup, #112): a valid new bucket is handed over as
   * what would be posted, instead of being created.
   */
  onDraft?: (body: BucketCreate) => void;
  /** Takes a draft bucket out of the draft. */
  onRemove?: () => void;
  /** Names the bucket can't take besides the saved ones: the draft's other new buckets. */
  takenNames?: string[];
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const preferences = useSession().data?.preferences;
  const active = useCurrentCycles().data?.active ?? null;
  const usable = active !== null && !isOverdue(active);
  const [deleting, setDeleting] = useState(false);

  // A saved bucket, or a draft one's values (#112).
  const from = bucket ?? initial;
  const [name, setName] = useState(from?.name ?? "");
  const [source, setSource] = useState<string | null>(
    from?.source_account_id ??
      presetSource ??
      (accounts.length === 1 ? (accounts[0]?.id ?? null) : null),
  );
  const [priority, setPriority] = useState(from?.priority ?? false);
  const [importance, setImportance] = useState(from?.importance ?? 5);
  const [refillAmount, setRefillAmount] = useState<string | null>(from?.refill_amount ?? "0.00");
  const [capMode, setCapMode] = useState<CapMode>(from?.cap_mode ?? "multiplier");
  const [multiplier, setMultiplier] = useState(from?.cap_multiplier ?? "1.00");
  const [capAmount, setCapAmount] = useState<string | null>(from?.cap_amount ?? null);
  const [refillMode, setRefillMode] = useState<RefillMode>(
    from?.refill_mode ?? preferences?.default_refill_mode ?? "auto",
  );
  const [keepFunds, setKeepFunds] = useState(from?.keep_funds ?? false);
  const [negativeTf, setNegativeTf] = useState<NegativeTf>(
    from?.negative_tf ?? preferences?.default_negative_tf ?? "debt",
  );
  const [overflow, setOverflow] = useState<OverflowDestination>(
    from?.overflow_destination ?? "unallocated",
  );
  const [chosenStart, setStart] = useState<Start>(() => {
    if (!initial) return "refill";
    if (initial.refill) return "refill";
    return initial.opening_funds !== undefined ? "amount" : "zero";
  });
  const [opening, setOpening] = useState<string | null>(initial?.opening_funds ?? null);
  const [errors, setErrors] = useState<FormErrors>({});

  const sourceAccount = accounts.find((a) => a.id === source);
  const currency = bucket?.currency ?? sourceAccount?.currency;
  const sources = accounts
    .filter((a) => !bucket || a.currency === bucket.currency)
    .map((a) => ({ value: a.id, label: a.name }));

  const manual = refillMode === "fully_manual";
  const start = manual && chosenStart === "refill" ? "zero" : chosenStart;
  const ra = manual ? "0.00" : (refillAmount ?? "0.00");
  const keeps = manual || keepFunds;
  const mult = parseMultiplier(multiplier);
  const fixed = capMode === "fixed" ? capAmount : null;
  const capacity =
    capMode === "multiplier"
      ? mult && multiplyAmount(ra, mult)
      : fixed && (compareAmounts(fixed, ra) < 0 ? ra : fixed);
  const raised = fixed !== null && compareAmounts(fixed, ra) < 0;

  const chooseMode = (mode: RefillMode) => {
    setRefillMode(mode);
    // A Fully manual bucket has no multiplier, and no other one goes without a cap.
    if (mode === "fully_manual" && capMode === "multiplier") setCapMode("none");
    if (mode !== "fully_manual" && capMode === "none") setCapMode("multiplier");
  };

  const capChanged =
    !bucket || capacityChanged(bucket, capMode, capMode === "multiplier" ? mult : fixed);
  const capFields =
    capMode === "multiplier"
      ? { cap_mode: capMode, cap_multiplier: mult ?? "" }
      : capMode === "fixed"
        ? { cap_mode: capMode, cap_amount: fixed ?? "" }
        : { cap_mode: capMode };

  const changes: BucketUpdate = bucket
    ? {
        ...(name.trim() !== bucket.name ? { name: name.trim() } : {}),
        ...(source && source !== bucket.source_account_id ? { source_account_id: source } : {}),
        ...(priority !== bucket.priority ? { priority } : {}),
        ...(importance !== bucket.importance ? { importance } : {}),
        ...(compareAmounts(ra, bucket.refill_amount) !== 0 ? { refill_amount: ra } : {}),
        ...(capChanged ? capFields : {}),
        ...(refillMode !== bucket.refill_mode ? { refill_mode: refillMode } : {}),
        ...(keeps !== bucket.keep_funds ? { keep_funds: keeps } : {}),
        ...(negativeTf !== bucket.negative_tf ? { negative_tf: negativeTf } : {}),
        ...(overflow !== bucket.overflow_destination ? { overflow_destination: overflow } : {}),
      }
    : {};
  const changed = !bucket || Object.keys(changes).length > 0;

  /** What creating the bucket posts, or what draft mode hands over. */
  const createBody = (): BucketCreate => ({
    name: name.trim(),
    source_account_id: source ?? "",
    priority,
    importance,
    refill_amount: ra,
    ...capFields,
    refill_mode: refillMode,
    keep_funds: keeps,
    negative_tf: negativeTf,
    overflow_destination: overflow,
    ...(usable && start === "refill" ? { refill: true } : {}),
    ...(usable && start === "amount" && opening !== null ? { opening_funds: opening } : {}),
  });

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
      return unwrap(api.POST("/api/v1/buckets", { body: createBody() }));
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

  // The server checks saved buckets' names (ignoring case); a draft also has its own.
  const taken = takenNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());
  const validate = (): FormErrors => ({
    name: checkName(name) ?? (taken ? t("bucketSetup.nameTaken") : undefined),
    source: source ? undefined : t("common.chooseAccount"),
    refillAmount: manual
      ? undefined
      : refillAmount === null
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
      bucket || !usable || start !== "amount"
        ? undefined
        : opening === null || compareAmounts(opening, "0") <= 0
          ? t("bucketSetup.enterStartingFunds")
          : manual && capacity && compareAmounts(opening, capacity) > 0
            ? t("bucketSetup.overCapacity", { amount: formatMoney(capacity, currency) })
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
    <form
      noValidate
      aria-label={bucket ? bucket.name : t("bucketSetup.newBucket")}
      onSubmit={(e) => {
        e.preventDefault();
        const found = validate();
        setErrors(found);
        if (Object.values(found).some((v) => v !== undefined)) return;
        if (onDraft) onDraft(createBody());
        else save.mutate();
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
            {...autofocusField()}
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
          <Radio.Group
            label={t("bucketSetup.refillMode")}
            value={refillMode}
            onChange={(v) => {
              const mode = REFILL_MODES.find((m) => m === v);
              if (mode) chooseMode(mode);
            }}
          >
            <Stack gap="sm" mt="xs">
              {REFILL_MODES.map((m) => (
                <Radio
                  key={m}
                  value={m}
                  label={refillModeLabel(m)}
                  description={t(`bucketSetup.refillModeHints.${m}`)}
                />
              ))}
            </Stack>
          </Radio.Group>
          {bucket === undefined && (
            <Text size="sm" c="dimmed">
              <Trans
                i18nKey="bucketSetup.defaultModeHint"
                values={{ mode: refillModeLabel(preferences?.default_refill_mode ?? "auto") }}
                components={{
                  open: (
                    <Anchor component="button" type="button" size="sm" onClick={onOpenSettings} />
                  ),
                }}
              />
            </Text>
          )}
          {refillMode === "on_income" &&
            preferences !== undefined &&
            (preferences.income_refill_rules ?? []).length === 0 && (
              <Text size="sm" c="dimmed">
                <Trans
                  i18nKey="bucketSetup.noIncomeRules"
                  components={{
                    open: (
                      <Anchor component="button" type="button" size="sm" onClick={onOpenSettings} />
                    ),
                  }}
                />
              </Text>
            )}
          {!manual && (
            <AmountInput
              label={t("bucketSetup.refillAmount")}
              currency={currency}
              value={refillAmount}
              onChange={setRefillAmount}
              error={errors.refillAmount}
              required
            />
          )}
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              {t("bucketSetup.capacity")}
            </Text>
            <SegmentedControl
              aria-label={t("bucketSetup.capacity")}
              value={capMode}
              onChange={(v) => {
                const mode = CAP_MODES.find((m) => m === v);
                if (mode) setCapMode(mode);
              }}
              data={(manual
                ? (["none", "fixed"] as const)
                : (["multiplier", "fixed"] as const)
              ).map((m) => ({ value: m, label: t(CAP_MODE_LABELS[m]) }))}
            />
            {capMode === "multiplier" && (
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
            )}
            {capMode === "fixed" && (
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
              {capMode === "none"
                ? t("bucketSetup.noCapHint")
                : manual
                  ? t("bucketSetup.capacityHintManual")
                  : raised
                    ? t("bucketSetup.capacityRaised")
                    : t("bucketSetup.capacityHint")}
            </Text>
          </Stack>
          {/* A Fully manual bucket always keeps its funds and never overflows. */}
          {!manual && (
            <Checkbox
              label={t("bucketSetup.keepFunds")}
              description={t("bucketSetup.keepFundsHint")}
              checked={keepFunds}
              onChange={(e) => {
                setKeepFunds(e.currentTarget.checked);
              }}
            />
          )}
          {/* Without Keep funds a refill always clears an overspend (#62). */}
          {!manual && keepFunds && (
            <Radio.Group
              label={t("bucketSetup.negativeTf.label")}
              value={negativeTf}
              onChange={(v) => {
                const next = NEGATIVE_TFS.find((n) => n === v);
                if (next) setNegativeTf(next);
              }}
              ml="xl"
            >
              <Stack gap="sm" mt="xs">
                {NEGATIVE_TFS.map((n) => (
                  <Radio
                    key={n}
                    value={n}
                    label={t(`bucketSetup.negativeTf.${n}`)}
                    description={t(`bucketSetup.negativeTf.${n}Hint`)}
                  />
                ))}
              </Stack>
            </Radio.Group>
          )}
          {!manual && (
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
          )}
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
                  {!manual && (
                    <Radio
                      value="refill"
                      label={t("bucketSetup.startRefill", { amount: formatMoney(ra, currency) })}
                      description={t("bucketSetup.startRefillHint")}
                    />
                  )}
                  <Radio value="amount" label={t("bucketSetup.startAmount")} />
                  {start === "amount" && (
                    <AmountInput
                      label={t("bucketSetup.openingFunds")}
                      description={t(
                        manual ? "bucketSetup.openingHintManual" : "bucketSetup.openingHint",
                      )}
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
                    description={t(
                      manual ? "bucketSetup.startZeroHintManual" : "bucketSetup.startZeroHint",
                    )}
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
        <Group justify={bucket || onRemove ? "space-between" : "flex-end"} gap="xs">
          {onRemove && (
            <Button variant="subtle" color="red" onClick={onRemove}>
              {t("budgetSetup.removeNew")}
            </Button>
          )}
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
              {bucket
                ? t("common.save")
                : onDraft
                  ? t(initial ? "budgetSetup.updateNew" : "budgetSetup.addToBudget")
                  : t("bucketSetup.create")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
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
