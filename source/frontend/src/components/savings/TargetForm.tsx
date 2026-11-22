// The savings target form (spec §9, Savings setup): creates a target from a
// Fully manual bucket or a savings account, or changes one's name, goal and
// note. Deleting it releases what's held for it.

import {
  Anchor,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { accountTypeLabel, useRefreshMoney, type Account, type Bucket } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import type { SavingsTarget } from "@/api/savings";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { autofocusField, isTouch } from "@/lib/device";
import { formatMoney } from "@/lib/money";
import { freeAccounts, freeBuckets, goalLimit, goalProblem } from "@/lib/savings";

type Kind = "bucket" | "account";

const MAX_NAME = 100;
const MAX_NOTE = 500;

/** "Holiday (#4829135521)", or "New savings target". */
export function TargetTitle({ target }: { target: SavingsTarget | undefined }) {
  const { t } = useTranslation();
  if (!target) return <>{t("savingsSetup.newTarget")}</>;
  return (
    <>
      {target.name}{" "}
      <Text span inherit c="dimmed" fw={400}>
        (#{target.id})
      </Text>
    </>
  );
}

export function TargetForm({
  target,
  targets,
  accounts,
  buckets,
  onDone,
}: {
  target: SavingsTarget | undefined;
  targets: SavingsTarget[];
  accounts: Account[];
  buckets: Bucket[];
  /** After saving (with the target's ID), deleting or cancelling (null). */
  onDone: (saved: string | null) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [deleting, setDeleting] = useState(false);
  const bucketChoices = freeBuckets(buckets, targets);
  const accountChoices = freeAccounts(accounts, targets);
  const [kind, setKind] = useState<Kind>(
    target
      ? target.bucket_id !== null
        ? "bucket"
        : "account"
      : bucketChoices.length > 0
        ? "bucket"
        : "account",
  );
  const [bucketId, setBucketId] = useState<string | null>(target?.bucket_id ?? null);
  const [accountId, setAccountId] = useState<string | null>(target?.account_id ?? null);
  const [name, setName] = useState(target?.custom_name ?? "");
  const [goal, setGoal] = useState<string | null>(target?.goal ?? null);
  const [note, setNote] = useState(target?.note ?? "");
  const [errors, setErrors] = useState<{ what?: string; goal?: string; name?: string }>({});

  const bucket = buckets.find((b) => b.id === (kind === "bucket" ? bucketId : null));
  const account = accounts.find((a) => a.id === (kind === "account" ? accountId : null));
  const currency = target?.currency ?? bucket?.currency ?? account?.currency;
  const limit = goalLimit(bucket);
  const fallbackName = target
    ? target.custom_name === null
      ? target.name
      : (buckets.find((b) => b.id === target.bucket_id)?.name ??
        accounts.find((a) => a.id === target.account_id)?.name ??
        "")
    : (bucket?.name ?? account?.name ?? "");
  const comboboxProps = isTouch() ? { withinPortal: false } : undefined;

  const save = useMutation({
    mutationFn: async () => {
      if (target) {
        return unwrap(
          api.PATCH("/api/v1/savings/targets/{targetId}", {
            params: { path: { targetId: target.id } },
            body: { name: name.trim(), goal: goal ?? "", note: note.trim() },
          }),
        );
      }
      return unwrap(
        api.POST("/api/v1/savings/targets", {
          body: {
            ...(kind === "bucket"
              ? { bucket_id: bucketId ?? "" }
              : { account_id: accountId ?? "" }),
            ...(name.trim() ? { name: name.trim() } : {}),
            goal: goal ?? "",
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      );
    },
    meta: { silentError: true },
    onSuccess: async (saved) => {
      notifications.show({
        color: "green",
        message: t(target ? "savingsSetup.saved" : "savingsSetup.created", { name: saved.name }),
      });
      onDone(saved.id);
      await refresh();
    },
  });

  if (target && deleting) {
    return (
      <DeleteTarget
        target={target}
        accounts={accounts}
        onCancel={() => {
          setDeleting(false);
        }}
        onDone={() => {
          onDone(null);
        }}
      />
    );
  }

  const validate = () => {
    const problem = goalProblem(goal, bucket);
    return {
      what:
        target || (kind === "bucket" ? bucketId : accountId)
          ? undefined
          : t(kind === "bucket" ? "savingsSetup.pickBucket" : "savingsSetup.pickAccount"),
      goal:
        problem === "notPositive"
          ? t("savingsSetup.enterGoal")
          : problem === "aboveCapacity" && limit !== null
            ? t("savingsSetup.goalAboveCapacity", { amount: formatMoney(limit, currency) })
            : undefined,
      name: name.trim().length > MAX_NAME ? t("common.maxChars", { count: MAX_NAME }) : undefined,
    };
  };

  const noChoices = kind === "bucket" ? bucketChoices.length === 0 : accountChoices.length === 0;

  return (
    <form
      noValidate
      aria-label={target ? target.name : t("savingsSetup.newTarget")}
      onSubmit={(e) => {
        e.preventDefault();
        const found = validate();
        setErrors(found);
        if (Object.values(found).some((v) => v !== undefined)) return;
        save.mutate();
      }}
    >
      <Stack gap="lg">
        {target ? (
          <Text size="sm" c="dimmed">
            {t(target.bucket_id !== null ? "savingsSetup.isBucket" : "savingsSetup.isAccount", {
              name: fallbackName,
            })}
          </Text>
        ) : (
          <Stack gap="sm">
            <SegmentedControl
              value={kind}
              onChange={(v) => {
                setKind(v === "account" ? "account" : "bucket");
                setErrors({});
              }}
              data={[
                { value: "bucket", label: t("savingsSetup.kindBucket") },
                { value: "account", label: t("savingsSetup.kindAccount") },
              ]}
              aria-label={t("savingsSetup.kind")}
            />
            <Text size="xs" c="dimmed">
              {t(
                kind === "bucket" ? "savingsSetup.kindBucketHint" : "savingsSetup.kindAccountHint",
              )}
            </Text>
            {noChoices ? (
              <Text size="sm">
                <Trans
                  i18nKey={kind === "bucket" ? "savingsSetup.noBuckets" : "savingsSetup.noAccounts"}
                  components={{
                    setup: (
                      <Anchor
                        component={Link}
                        to={kind === "bucket" ? "/buckets/setup?new" : "/accounts/setup"}
                      />
                    ),
                  }}
                />
              </Text>
            ) : kind === "bucket" ? (
              <Select
                label={t("savingsSetup.bucket")}
                data={bucketChoices.map((b) => ({ value: b.id, label: b.name }))}
                value={bucketId}
                onChange={setBucketId}
                error={errors.what}
                comboboxProps={comboboxProps}
                searchable
              />
            ) : (
              <Select
                label={t("savingsSetup.account")}
                data={accountChoices.map((a) => ({
                  value: a.id,
                  label: `${a.name} (${accountTypeLabel(a.type)})`,
                }))}
                value={accountId}
                onChange={setAccountId}
                error={errors.what}
                comboboxProps={comboboxProps}
                searchable
              />
            )}
          </Stack>
        )}

        <AmountInput
          label={t("savingsSetup.goal")}
          description={
            limit !== null
              ? t("savingsSetup.goalLimit", { amount: formatMoney(limit, currency) })
              : t(
                  kind === "bucket"
                    ? "savingsSetup.goalBucketHint"
                    : "savingsSetup.goalAccountHint",
                )
          }
          currency={currency}
          value={goal}
          onChange={setGoal}
          error={errors.goal}
          maw={260}
          {...(target ? {} : autofocusField())}
        />
        <TextInput
          label={t("savingsSetup.name")}
          description={t("savingsSetup.nameHint")}
          placeholder={fallbackName}
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          error={errors.name}
          maxLength={MAX_NAME + 20}
        />
        <Textarea
          label={t("savingsSetup.note")}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
          autosize
          minRows={2}
          maxLength={MAX_NOTE}
        />

        {save.error && <ErrorAlert error={save.error} />}

        <Group justify="space-between" gap="xs">
          {target ? (
            <Button
              variant="subtle"
              color="red"
              onClick={() => {
                setDeleting(true);
              }}
            >
              {t("savingsSetup.delete")}
            </Button>
          ) : (
            <span />
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
            <Button type="submit" loading={save.isPending} disabled={!target && noChoices}>
              {t(target ? "common.save" : "savingsSetup.create")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
}

/** Deletes a target, after saying what of the held money goes back to unallocated. */
function DeleteTarget({
  target,
  accounts,
  onCancel,
  onDone,
}: {
  target: SavingsTarget;
  accounts: Account[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/savings/targets/{targetId}", {
          params: { path: { targetId: target.id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("savingsSetup.deleted", { name: target.name }),
      });
      onDone();
      await refresh();
    },
  });
  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="savingsSetup.deleteQuestion"
          values={{ name: target.name }}
          components={{ b: <strong /> }}
        />
      </Text>
      {target.held.length > 0 && (
        <Stack gap={4}>
          <Text>{t("savingsSetup.deleteReleases")}</Text>
          {target.held.map((h) => (
            <Text key={h.account_id} size="sm">
              {t("savingsSetup.deleteReleasesOn", {
                account: accounts.find((a) => a.id === h.account_id)?.name ?? `#${h.account_id}`,
                amount: formatMoney(h.amount, target.currency),
              })}
            </Text>
          ))}
        </Stack>
      )}
      <Text size="sm" c="dimmed">
        {t(
          target.bucket_id !== null
            ? "savingsSetup.deleteKeepsBucket"
            : "savingsSetup.deleteKeepsAccount",
        )}
      </Text>
      {remove.error && <ErrorAlert error={remove.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          {t("common.back")}
        </Button>
        <Button
          color="red"
          loading={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
        >
          {t("savingsSetup.delete")}
        </Button>
      </Group>
    </Stack>
  );
}
