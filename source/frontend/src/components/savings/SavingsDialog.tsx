// The Savings screen's dialogs (#231, spec §8): Add to savings, Done and
// Clear. The pure rules are in lib/savings.ts; the server checks them again.

import { Alert, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useBuckets, useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import type { SavingsTarget } from "@/api/savings";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { RecordConfirm } from "@/components/transactions/RecordConfirm";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { isOverdue } from "@/lib/cycles";
import { autofocusField, isTouch } from "@/lib/device";
import { compareAmounts, formatMoney } from "@/lib/money";
import {
  addKind,
  addProblem,
  bucketRoom,
  heldOn,
  heldProblem,
  pastBsuRoom,
  pastGoal,
  sourceAccounts,
  targetBucket,
  type AmountProblem,
} from "@/lib/savings";
import { bsuAsk } from "@/lib/bsu";

/** Which dialog is open: Add to savings, or Done or Clear for the money held on an account. */
export type SavingsAction =
  { kind: "add" } | { kind: "done"; accountId: string } | { kind: "clear"; accountId: string };

export function SavingsDialog({
  target,
  action,
  onClose,
}: {
  target: SavingsTarget;
  action: SavingsAction | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title =
    action?.kind === "done"
      ? t("savings.done.title", { name: target.name })
      : action?.kind === "clear"
        ? t("savings.clear.title", { name: target.name })
        : t("savings.add.title", { name: target.name });
  return (
    <ResponsiveModal opened={action !== null} onClose={onClose} title={title}>
      {action?.kind === "add" && <AddForm target={target} onDone={onClose} />}
      {action && action.kind !== "add" && (
        <HeldForm
          key={`${action.kind}:${action.accountId}`}
          target={target}
          accountId={action.accountId}
          done={action.kind === "done"}
          onDone={onClose}
        />
      )}
    </ResponsiveModal>
  );
}

/** The amount field's error for a problem. */
function amountError(
  problem: AmountProblem | null,
  money: (a: string) => string,
  values: { unallocated: string; held: string; room: string | null },
): string | undefined {
  const t = i18n.t.bind(i18n);
  switch (problem) {
    case "notPositive":
      return t("savings.enterAmount");
    case "overUnallocated":
      return t("savings.add.overUnallocated", { amount: money(values.unallocated) });
    case "overHeld":
      return t("savings.overHeld", { amount: money(values.held) });
    case "overCapacity":
      return t("savings.overCapacity", { amount: money(values.room ?? "0") });
    default:
      return undefined;
  }
}

/** Whether a running cycle allows bucket lines now. */
function useUsableCycle() {
  const active = useCurrentCycles().data?.active ?? null;
  return { active, usable: active !== null && !isOverdue(active) };
}

function AddForm({ target, onDone }: { target: SavingsTarget; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const { usable } = useUsableCycle();
  const sources = sourceAccounts(target, accounts);
  const bucket = targetBucket(target, buckets);
  const [accountId, setAccountId] = useState<string | null>(
    () => defaultSource(sources, bucket?.source_account_id)?.id ?? null,
  );
  const [amount, setAmount] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const account = sources.find((a) => a.id === accountId);
  const money = (a: string) => formatMoney(a, target.currency);
  const direct = account !== undefined && addKind(target, account.id, buckets) === "direct";
  const problem = addProblem(target, account, amount, buckets);
  const blocked = direct && !usable;

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/savings/targets/{targetId}/add", {
          params: { path: { targetId: target.id } },
          body: { account_id: accountId ?? "", amount: amount ?? "" },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t(direct ? "savings.add.addedDirect" : "savings.add.added", {
          name: target.name,
          amount: money(amount ?? "0"),
        }),
      });
      onDone();
      await refresh();
    },
  });

  if (sources.length === 0) {
    return <Text>{t("savings.add.noAccounts", { currency: target.currency })}</Text>;
  }
  return (
    <Stack gap="md">
      <Select
        label={t("savings.add.from")}
        data={sources.map((a) => ({
          value: a.id,
          label: `${a.name} (${t("savings.add.unallocated", { amount: money(a.unallocated) })})`,
        }))}
        value={accountId}
        allowDeselect={false}
        onChange={setAccountId}
        comboboxProps={isTouch() ? { withinPortal: false } : undefined}
      />
      <AmountInput
        label={t("savings.amount")}
        currency={target.currency}
        value={amount}
        onChange={(v) => {
          setAmount(v);
          setTouched(true);
        }}
        error={
          touched && amount !== null
            ? amountError(problem, money, {
                unallocated: account?.unallocated ?? "0",
                held: "0",
                room: bucketRoom(bucket),
              })
            : undefined
        }
        maw={260}
        {...autofocusField()}
      />
      {account && problem === null && (
        <Text size="sm">
          {t(direct ? "savings.add.previewDirect" : "savings.add.preview", {
            amount: money(amount ?? "0"),
            account: account.name,
            name: target.name,
          })}
        </Text>
      )}
      {account && problem === null && pastGoal(target, amount) && (
        <Text size="sm" c="dimmed">
          {t("savings.add.pastGoal", { goal: money(target.goal) })}
        </Text>
      )}
      {account && problem === null && pastBsuRoom(target, amount) && (
        <Text size="sm" c="var(--mantine-color-orange-text)">
          {t("savings.add.pastBsuRoom", { amount: money(target.bsu_room ?? "0") })}
        </Text>
      )}
      {blocked && <Alert color="orange">{t("savings.needsCycle")}</Alert>}
      {add.error && <ErrorAlert error={add.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={add.isPending}
          disabled={problem !== null || blocked}
          onClick={() => {
            add.mutate();
          }}
        >
          {t("savings.add.submit")}
        </Button>
      </Group>
    </Stack>
  );
}

/** A bucket target's own account first, else the account with the most unallocated. */
function defaultSource(sources: Account[], bucketAccount: string | undefined): Account | undefined {
  const own = sources.find((a) => a.id === bucketAccount);
  if (own) return own;
  return [...sources].sort((a, b) => compareAmounts(b.unallocated, a.unallocated))[0];
}

/** Done (the money has been moved) or Clear (give it back to unallocated). */
function HeldForm({
  target,
  accountId,
  done,
  onDone,
}: {
  target: SavingsTarget;
  accountId: string;
  done: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const { active, usable } = useUsableCycle();
  const held = heldOn(target, accountId);
  const [amount, setAmount] = useState<string | null>(held);
  const [at, setAt] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const money = (a: string) => formatMoney(a, target.currency);
  const name = (id: string | undefined) =>
    accounts.find((a) => a.id === id)?.name ?? `#${id ?? ""}`;
  const bucket = targetBucket(target, buckets);
  const problem = heldProblem(target, accountId, amount, buckets, done);
  // Done into a bucket records a bucket line: it needs a running cycle.
  const blocked = done && target.bucket_id !== null && !usable;

  const apply = useMutation({
    // confirmed resends a Done the BSU check asked about (#236).
    mutationFn: (confirmed: boolean) =>
      done
        ? unwrap(
            api.POST("/api/v1/savings/targets/{targetId}/done", {
              params: { path: { targetId: target.id } },
              body: {
                account_id: accountId,
                amount: amount ?? "",
                ...(at ? { at } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
                ...(confirmed ? { bsu_confirmed: true } : {}),
              },
            }),
          )
        : unwrap(
            api.POST("/api/v1/savings/targets/{targetId}/clear", {
              params: { path: { targetId: target.id } },
              body: { account_id: accountId, amount: amount ?? "" },
            }),
          ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t(done ? "savings.done.recorded" : "savings.clear.cleared", {
          name: target.name,
          amount: money(amount ?? "0"),
        }),
      });
      onDone();
      await refresh();
    },
  });

  // A BSU over its limits, or money out of one, asks first (#236).
  const ask = done ? bsuAsk(apply.error) : undefined;

  const to =
    target.account_id !== null
      ? name(target.account_id)
      : bucket
        ? name(bucket.source_account_id)
        : "";
  const preview = done
    ? target.account_id !== null
      ? t("savings.done.previewAccount", {
          amount: money(amount ?? "0"),
          from: name(accountId),
          to,
        })
      : bucket?.source_account_id === accountId
        ? t("savings.done.previewBucketSame", { amount: money(amount ?? "0"), name: target.name })
        : t("savings.done.previewBucket", {
            amount: money(amount ?? "0"),
            from: name(accountId),
            to,
            name: target.name,
          })
    : t("savings.clear.preview", { amount: money(amount ?? "0"), account: name(accountId) });

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t(done ? "savings.done.hint" : "savings.clear.hint", {
          amount: money(held),
          account: name(accountId),
        })}
      </Text>
      <AmountInput
        label={t("savings.amount")}
        currency={target.currency}
        value={amount}
        onChange={setAmount}
        error={amountError(problem, money, { unallocated: "0", held, room: bucketRoom(bucket) })}
        maw={260}
        {...autofocusField()}
      />
      {done && (
        <>
          <DateTimeInput
            label={t("savings.done.when")}
            description={t("savings.done.whenHint")}
            value={at}
            onChange={setAt}
            {...(target.bucket_id !== null && active && usable
              ? { minDate: new Date(active.start_at) }
              : {})}
          />
          <TextInput
            label={t("savings.done.description")}
            value={description}
            onChange={(e) => {
              setDescription(e.currentTarget.value);
            }}
            maxLength={500}
          />
        </>
      )}
      {problem === null && <Text size="sm">{preview}</Text>}
      {blocked && <Alert color="orange">{t("savings.needsCycle")}</Alert>}
      {ask ? (
        <RecordConfirm
          ask={ask}
          pending={apply.isPending}
          onConfirm={() => {
            apply.mutate(true);
          }}
          onCancel={() => {
            apply.reset();
          }}
        />
      ) : (
        apply.error && <ErrorAlert error={apply.error} />
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color={done ? undefined : "red"}
          loading={apply.isPending}
          disabled={problem !== null || blocked || ask !== undefined}
          onClick={() => {
            apply.mutate(false);
          }}
        >
          {t(done ? "savings.done.submit" : "savings.clear.submit")}
        </Button>
      </Group>
    </Stack>
  );
}
