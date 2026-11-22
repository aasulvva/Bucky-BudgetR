// Savings setup's savings budget (#234, spec §8.6): the fixed amounts saved
// each cycle, per source account, and the form for one. The server checks it
// all again.

import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NavLink,
  Radio,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import {
  BUDGET_WHEN,
  type SavingsBudgetEntry,
  type SavingsBudgetWhen,
  type SavingsTarget,
} from "@/api/savings";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { isOverdue } from "@/lib/cycles";
import { isTouch } from "@/lib/device";
import { compareAmounts, formatMoney } from "@/lib/money";
import { budgetDestination, budgetTargets, budgetTotal } from "@/lib/savings";

/** The Select value for the distributor, as a destination. */
const DISTRIBUTOR = "distributor";

/** The entry being edited: its ID, "new", or null for the list. */
type Editing = string | null;

export function BudgetForm({
  entries,
  targets,
  accounts,
}: {
  entries: SavingsBudgetEntry[];
  targets: SavingsTarget[];
  accounts: Account[];
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const entry = entries.find((e) => e.id === editing);
  if (editing === "new" || entry) {
    return (
      <EntryForm
        key={editing}
        entry={entry}
        targets={targets}
        accounts={accounts}
        onDone={() => {
          setEditing(null);
        }}
      />
    );
  }
  return <BudgetList entries={entries} targets={targets} accounts={accounts} onEdit={setEditing} />;
}

function BudgetList({
  entries,
  targets,
  accounts,
  onEdit,
}: {
  entries: SavingsBudgetEntry[];
  targets: SavingsTarget[];
  accounts: Account[];
  onEdit: (id: Editing) => void;
}) {
  const { t } = useTranslation();
  const used = accounts.filter((a) => entries.some((e) => e.account_id === a.id));
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("savingsSetup.budget.intro")}
      </Text>
      {entries.length === 0 ? (
        <Text c="dimmed">{t("savingsSetup.budget.empty")}</Text>
      ) : (
        used.map((a) => (
          <Stack key={a.id} gap={4} component="section" aria-label={a.name}>
            <Group justify="space-between" gap="xs" wrap="wrap">
              <Text fw={600}>{a.name}</Text>
              <Text size="sm" c="dimmed">
                {t("savingsSetup.budget.perCycle", {
                  amount: formatMoney(budgetTotal(entries, a.id), a.currency),
                })}
              </Text>
            </Group>
            <Card withBorder padding={4}>
              {entries
                .filter((e) => e.account_id === a.id)
                .map((e) => {
                  const name = budgetDestination(e, targets);
                  return (
                    <NavLink
                      key={e.id}
                      component="button"
                      type="button"
                      label={name}
                      aria-label={t("savingsSetup.budget.editName", {
                        name,
                        amount: formatMoney(e.amount, a.currency),
                      })}
                      description={t(`savingsSetup.budget.when.${e.when}`)}
                      rightSection={
                        <Group gap="xs" wrap="nowrap">
                          {e.stopped && (
                            <Badge size="sm" color="orange" variant="light" radius="sm">
                              {t("savingsSetup.budget.stoppedBadge")}
                            </Badge>
                          )}
                          <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                            {formatMoney(e.amount, a.currency)}
                          </Text>
                        </Group>
                      }
                      onClick={() => {
                        onEdit(e.id);
                      }}
                    />
                  );
                })}
            </Card>
          </Stack>
        ))
      )}
      <Button
        variant="outline"
        leftSection={<IconPlus size={16} />}
        disabled={accounts.length === 0}
        style={{ alignSelf: "flex-start" }}
        onClick={() => {
          onEdit("new");
        }}
      >
        {t("savingsSetup.budget.add")}
      </Button>
    </Stack>
  );
}

function EntryForm({
  entry,
  targets,
  accounts,
  onDone,
}: {
  entry: SavingsBudgetEntry | undefined;
  targets: SavingsTarget[];
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const active = useCurrentCycles().data?.active ?? null;
  const running = active !== null && !isOverdue(active);
  const [accountId, setAccountId] = useState<string | null>(
    entry?.account_id ?? (accounts.length === 1 ? (accounts[0]?.id ?? null) : null),
  );
  const [destination, setDestination] = useState<string>(
    entry && !entry.stopped ? (entry.target_id ?? DISTRIBUTOR) : DISTRIBUTOR,
  );
  const [amount, setAmount] = useState<string | null>(entry?.amount ?? null);
  const [when, setWhen] = useState<SavingsBudgetWhen>(entry?.when ?? "cycle_start");
  const [startNow, setStartNow] = useState(true);
  const [validate, setValidate] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const account = accounts.find((a) => a.id === accountId);
  const choices = budgetTargets(targets, account);
  const money = (a: string) => formatMoney(a, account?.currency);
  const validAmount = amount !== null && compareAmounts(amount, "0") > 0;
  // Only an entry that starts (or switches to) At cycle start in a running
  // cycle, and hasn't run in it yet, can reserve now (#234).
  const asksStart =
    when === "cycle_start" &&
    running &&
    (!entry || (entry.when !== "cycle_start" && entry.this_cycle === null));
  const comboboxProps = isTouch() ? { withinPortal: false } : undefined;

  const save = useMutation({
    mutationFn: () => {
      const targetId = destination === DISTRIBUTOR ? null : destination;
      const thisCycle = asksStart ? { this_cycle: startNow } : {};
      if (entry) {
        return unwrap(
          api.PATCH("/api/v1/savings/budget/{entryId}", {
            params: { path: { entryId: entry.id } },
            body: { target_id: targetId, amount: amount ?? "", when, ...thisCycle },
          }),
        );
      }
      return unwrap(
        api.POST("/api/v1/savings/budget", {
          body: {
            account_id: accountId ?? "",
            // Without one, the distributor.
            ...(targetId === null ? {} : { target_id: targetId }),
            amount: amount ?? "",
            when,
            ...thisCycle,
          },
        }),
      );
    },
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t(entry ? "savingsSetup.budget.saved" : "savingsSetup.budget.created"),
      });
      onDone();
      await refresh();
    },
  });

  if (entry && deleting) {
    return (
      <DeleteEntry
        entry={entry}
        targets={targets}
        account={account}
        onCancel={() => {
          setDeleting(false);
        }}
        onDone={onDone}
      />
    );
  }

  return (
    <form
      noValidate
      aria-label={t(entry ? "savingsSetup.budget.editTitle" : "savingsSetup.budget.newTitle")}
      onSubmit={(e) => {
        e.preventDefault();
        setValidate(true);
        if (!account || !validAmount) return;
        save.mutate();
      }}
    >
      <Stack gap="md">
        <Title order={4} size="h5">
          {t(entry ? "savingsSetup.budget.editTitle" : "savingsSetup.budget.newTitle")}
        </Title>
        {entry?.stopped && (
          <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
            {t("savingsSetup.budget.stopped")}
          </Alert>
        )}
        {entry ? (
          <Text size="sm">{t("savingsSetup.budget.fromAccount", { name: account?.name })}</Text>
        ) : (
          <Select
            label={t("savingsSetup.budget.account")}
            description={t("savingsSetup.budget.accountHint")}
            data={accounts.map((a) => ({ value: a.id, label: a.name }))}
            value={accountId}
            allowDeselect={false}
            onChange={(v) => {
              setAccountId(v);
              const next = accounts.find((a) => a.id === v);
              if (!budgetTargets(targets, next).some((x) => x.id === destination)) {
                setDestination(DISTRIBUTOR);
              }
            }}
            error={validate && !account ? t("savingsSetup.budget.pickAccount") : undefined}
            comboboxProps={comboboxProps}
          />
        )}
        <Select
          label={t("savingsSetup.budget.destination")}
          description={t("savingsSetup.budget.destinationHint")}
          data={[
            { value: DISTRIBUTOR, label: t("savingsSetup.distributor.title") },
            ...choices.map((x) => ({ value: x.id, label: x.name })),
          ]}
          value={destination}
          allowDeselect={false}
          onChange={(v) => {
            setDestination(v ?? DISTRIBUTOR);
          }}
          comboboxProps={comboboxProps}
        />
        <AmountInput
          label={t("savingsSetup.budget.amount")}
          currency={account?.currency}
          value={amount}
          onChange={setAmount}
          error={validate && !validAmount ? t("savings.enterAmount") : undefined}
          maw={260}
        />
        <Radio.Group
          label={t("savingsSetup.budget.whenLabel")}
          value={when}
          onChange={(v) => {
            const next = BUDGET_WHEN.find((w) => w === v);
            if (next) setWhen(next);
          }}
        >
          <Stack gap="sm" mt="xs">
            {BUDGET_WHEN.map((w) => (
              <Radio
                key={w}
                value={w}
                label={t(`savingsSetup.budget.when.${w}`)}
                description={t(`savingsSetup.budget.whenHints.${w}`)}
              />
            ))}
          </Stack>
        </Radio.Group>
        {asksStart && (
          <Radio.Group
            label={t("savingsSetup.budget.start")}
            value={startNow ? "now" : "next"}
            onChange={(v) => {
              setStartNow(v === "now");
            }}
          >
            <Stack gap="sm" mt="xs">
              <Radio
                value="now"
                label={t("savingsSetup.budget.startNow")}
                description={
                  account
                    ? t("savingsSetup.budget.startNowHint", {
                        account: account.name,
                        amount: money(account.unallocated),
                      })
                    : undefined
                }
              />
              <Radio
                value="next"
                label={t("savingsSetup.budget.startNext")}
                description={t("savingsSetup.budget.startNextHint")}
              />
            </Stack>
          </Radio.Group>
        )}

        {save.error && <ErrorAlert error={save.error} />}

        <Group justify="space-between" gap="xs">
          {entry ? (
            <Button
              variant="subtle"
              color="red"
              onClick={() => {
                setDeleting(true);
              }}
            >
              {t("savingsSetup.budget.delete")}
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={onDone}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t(entry ? "common.save" : "savingsSetup.budget.create")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
}

/** Deletes an entry; what it reserved stays held. */
function DeleteEntry({
  entry,
  targets,
  account,
  onCancel,
  onDone,
}: {
  entry: SavingsBudgetEntry;
  targets: SavingsTarget[];
  account: Account | undefined;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const name = budgetDestination(entry, targets);
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/savings/budget/{entryId}", {
          params: { path: { entryId: entry.id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({ color: "green", message: t("savingsSetup.budget.deleted") });
      onDone();
      await refresh();
    },
  });
  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="savingsSetup.budget.deleteQuestion"
          values={{ amount: formatMoney(entry.amount, account?.currency), name }}
          components={{ b: <strong /> }}
        />
      </Text>
      <Text size="sm" c="dimmed">
        {t("savingsSetup.budget.deleteKeeps")}
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
          {t("savingsSetup.budget.delete")}
        </Button>
      </Group>
    </Stack>
  );
}
