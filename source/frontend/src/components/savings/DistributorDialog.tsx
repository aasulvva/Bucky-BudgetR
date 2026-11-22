// The Savings screen's distributor dialogs (#232, spec §8.4): Add to savings
// (split by the hold mode), Distribute now and Clear. The server checks it
// all again.

import { Button, Group, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { useDistributionPreview, type SavingsDistributor, type SavingsTarget } from "@/api/savings";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { autofocusField, isTouch } from "@/lib/device";
import { addAmounts, compareAmounts, formatMoney } from "@/lib/money";
import { addOutcome, distributorHeldOn, distributorSources } from "@/lib/savings";

import { PreviewShares } from "./DistributorForm";

/** Which dialog is open: Add, Distribute now (one account, or all), or Clear. */
export type DistributorAction =
  | { kind: "add" }
  | { kind: "distribute"; accountId: string | null }
  | { kind: "clear"; accountId: string };

export function DistributorDialog({
  distributor,
  targets,
  action,
  onClose,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  action: DistributorAction | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title =
    action?.kind === "distribute"
      ? t("savings.distributor.distribute.title")
      : action?.kind === "clear"
        ? t("savings.distributor.clear.title")
        : t("savings.distributor.add.title");
  return (
    <ResponsiveModal opened={action !== null} onClose={onClose} title={title}>
      {action?.kind === "add" && (
        <AddForm distributor={distributor} targets={targets} onDone={onClose} />
      )}
      {action?.kind === "distribute" && (
        <DistributeForm
          key={action.accountId ?? "all"}
          distributor={distributor}
          targets={targets}
          accountId={action.accountId}
          onDone={onClose}
        />
      )}
      {action?.kind === "clear" && (
        <ClearForm
          key={action.accountId}
          distributor={distributor}
          accountId={action.accountId}
          onDone={onClose}
        />
      )}
    </ResponsiveModal>
  );
}

function useAccountName() {
  const accounts = useAccounts().data ?? [];
  return (id: string) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
}

function AddForm({
  distributor,
  targets,
  onDone,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const sources = distributorSources(useAccounts().data ?? [], targets);
  const [accountId, setAccountId] = useState<string | null>(
    () => mostUnallocated(sources)?.id ?? null,
  );
  const [amount, setAmount] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const account = sources.find((a) => a.id === accountId);
  const money = (a: string) => formatMoney(a, account?.currency);
  const valid = amount !== null && compareAmounts(amount, "0") > 0;
  const over = account !== undefined && valid && compareAmounts(amount, account.unallocated) > 0;
  const outcome = account && valid ? addOutcome(distributor, account.id, amount) : null;
  const splits = outcome === "split" || outcome === "reachesMinimum";
  const held = account ? distributorHeldOn(distributor, account.id) : "0.00";

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/savings/distributor/add", {
          body: { account_id: accountId ?? "", amount: amount ?? "" },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (res) => {
      notifications.show({
        color: "green",
        message: t(
          res.distributed.length > 0
            ? "savings.distributor.add.split"
            : "savings.distributor.add.held",
          { amount: money(amount ?? "0") },
        ),
      });
      onDone();
      await refresh();
    },
  });

  if (targets.length === 0) return <Text>{t("savings.distributor.noTargets")}</Text>;
  if (sources.length === 0) return <Text>{t("savings.distributor.add.noAccounts")}</Text>;
  return (
    <Stack gap="md">
      <Select
        label={t("savings.add.from")}
        data={sources.map((a) => ({
          value: a.id,
          label: `${a.name} (${t("savings.add.unallocated", {
            amount: formatMoney(a.unallocated, a.currency),
          })})`,
        }))}
        value={accountId}
        allowDeselect={false}
        onChange={setAccountId}
        comboboxProps={isTouch() ? { withinPortal: false } : undefined}
      />
      <AmountInput
        label={t("savings.amount")}
        currency={account?.currency}
        value={amount}
        onChange={(v) => {
          setAmount(v);
          setTouched(true);
        }}
        error={
          touched && amount !== null
            ? !valid
              ? t("savings.enterAmount")
              : over
                ? t("savings.add.overUnallocated", { amount: money(account.unallocated) })
                : undefined
            : undefined
        }
        maw={260}
        {...autofocusField()}
      />
      {account && valid && !over && (
        <Stack gap="xs">
          <Text size="sm">
            {t(`savings.distributor.add.${outcome ?? "waits"}`, {
              amount: money(amount),
              account: account.name,
              minimum: money(distributor.min_amount ?? "0"),
              total: money(addAmounts(held, amount)),
            })}
          </Text>
          {splits && (
            <PreviewShares
              accountId={account.id}
              amount={addAmounts(held, amount)}
              currency={account.currency}
              targets={targets}
            />
          )}
        </Stack>
      )}
      {add.error && <ErrorAlert error={add.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={add.isPending}
          disabled={!account || !valid || over}
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

function mostUnallocated(sources: Account[]): Account | undefined {
  return [...sources].sort((a, b) => compareAmounts(b.unallocated, a.unallocated))[0];
}

/** Distribute now: what's held on the account (or every account), split by the rules. */
function DistributeForm({
  distributor,
  targets,
  accountId,
  onDone,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  accountId: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const name = useAccountName();
  const currency = targets[0]?.currency;
  const held = accountId
    ? distributor.held.filter((h) => h.account_id === accountId)
    : distributor.held;
  const one = accountId ? distributorHeldOn(distributor, accountId) : null;
  // The same query as the shares below, so it's asked once.
  const preview = useDistributionPreview(accountId, one);
  const nobody = accountId !== null && preview.data?.shares.length === 0;

  const distribute = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/savings/distributor/distribute", {
          body: accountId ? { account_id: accountId } : {},
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (res) => {
      notifications.show({
        color: res.distributed.length > 0 ? "green" : "orange",
        message: t(
          res.distributed.length > 0
            ? "savings.distributor.distribute.done"
            : "savings.distributor.distribute.nothing",
          { count: res.distributed.length },
        ),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("savings.distributor.distribute.hint")}
      </Text>
      {held.map((h) => (
        <Stack key={h.account_id} gap={4}>
          <Text size="sm" fw={600}>
            {t("savings.heldOn", {
              amount: formatMoney(h.amount, currency),
              account: name(h.account_id),
            })}
          </Text>
          <PreviewShares
            accountId={h.account_id}
            amount={h.amount}
            currency={currency ?? "NOK"}
            targets={targets}
          />
        </Stack>
      ))}
      {distribute.error && <ErrorAlert error={distribute.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={distribute.isPending}
          disabled={held.length === 0 || nobody}
          onClick={() => {
            distribute.mutate();
          }}
        >
          {t("savings.distributor.distribute.submit")}
        </Button>
      </Group>
    </Stack>
  );
}

/** Clear: gives what the distributor holds on the account back to unallocated. */
function ClearForm({
  distributor,
  accountId,
  onDone,
}: {
  distributor: SavingsDistributor;
  accountId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const name = useAccountName();
  const account = useAccounts().data?.find((a) => a.id === accountId);
  const held = distributorHeldOn(distributor, accountId);
  const [amount, setAmount] = useState<string | null>(held);
  const money = (a: string) => formatMoney(a, account?.currency);
  const valid = amount !== null && compareAmounts(amount, "0") > 0;
  const over = valid && compareAmounts(amount, held) > 0;

  const clear = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/savings/distributor/clear", {
          body: { account_id: accountId, amount: amount ?? "" },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("savings.distributor.clear.cleared", { amount: money(amount ?? "0") }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("savings.clear.hint", { amount: money(held), account: name(accountId) })}
      </Text>
      <AmountInput
        label={t("savings.amount")}
        currency={account?.currency}
        value={amount}
        onChange={setAmount}
        error={
          !valid
            ? t("savings.enterAmount")
            : over
              ? t("savings.overHeld", { amount: money(held) })
              : undefined
        }
        maw={260}
        {...autofocusField()}
      />
      {valid && !over && (
        <Text size="sm">
          {t("savings.clear.preview", { amount: money(amount), account: name(accountId) })}
        </Text>
      )}
      {clear.error && <ErrorAlert error={clear.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          loading={clear.isPending}
          disabled={!valid || over}
          onClick={() => {
            clear.mutate();
          }}
        >
          {t("savings.clear.submit")}
        </Button>
      </Group>
    </Stack>
  );
}
