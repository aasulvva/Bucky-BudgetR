// The BSU history setup (#214, spec §2.1): what the bank shows for each year
// since the account was opened, and today's balance. The server rebuilds the
// account from it, once, and unlocks it.

import {
  Alert,
  Button,
  Card,
  Group,
  List,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account } from "@/api/accounts";
import { useBsuHistory, useSetUpBsu, type BsuHistory } from "@/api/bsu";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  BSU_CURRENCY,
  MIN_OPENED_YEAR,
  SETUP_FIELDS,
  fieldProblem,
  overTotal,
  overYear,
  ruleFor,
  setupPlan,
  setupRows,
  type SetupField,
  type SetupRow,
} from "@/lib/bsu";
import { compareAmounts, formatMoney } from "@/lib/money";

/** The setup in a dialog; closed while account is undefined. */
export function BsuSetupDialog({
  account,
  onClose,
}: {
  account: Account | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal
      opened={account !== undefined}
      size="lg"
      title={account ? t("bsu.setup.title", { name: account.name }) : ""}
      onClose={onClose}
    >
      {account && <BsuSetup key={account.id} account={account} onDone={onClose} />}
    </ResponsiveModal>
  );
}

function BsuSetup({ account, onDone }: { account: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const nok = account.currency === BSU_CURRENCY;
  const history = useBsuHistory(account.id, nok);
  if (!nok) {
    return (
      <Stack gap="md">
        <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
          {t("bsu.setup.notNok", { currency: account.currency })}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            {t("common.close")}
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <QueryState query={history}>
      {(h) =>
        h.set_up_at ? (
          <Stack gap="md">
            <Text>{t("bsu.setup.already")}</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={onDone}>
                {t("common.close")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <SetupForm account={account} history={h} onDone={onDone} />
        )
      }
    </QueryState>
  );
}

function SetupForm({
  account,
  history,
  onDone,
}: {
  account: Account;
  history: BsuHistory;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, account.currency);
  const [opened, setOpened] = useState(history.latest_opened_year);
  const [rows, setRows] = useState<SetupRow[]>(() =>
    setupRows(history, history.latest_opened_year),
  );
  const [balance, setBalance] = useState<string | null>(history.balance);
  const [tried, setTried] = useState(false);
  const setUp = useSetUpBsu(account.id);

  const years: string[] = [];
  for (let y = history.latest_opened_year; y >= MIN_OPENED_YEAR; y--) years.push(String(y));

  const change = (year: number, field: SetupField, value: string | null) => {
    setRows(rows.map((r) => (r.year === year ? { ...r, [field]: value } : r)));
  };

  const valid =
    balance !== null && rows.every((r) => SETUP_FIELDS.every((f) => !fieldProblem(r, f)));
  const plan = setupPlan(history, rows, balance ?? history.balance);
  const totalOver = overTotal(history, rows);

  const submit = () => {
    setTried(true);
    if (!valid) return;
    setUp.mutate(
      {
        opened_year: opened,
        years: rows.map((r) => ({
          year: r.year,
          deposits: r.deposits ?? "0",
          interest: r.interest ?? "0",
          withdrawals: r.withdrawals ?? "0",
        })),
        balance,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: "green",
            message: t("bsu.setup.done", { name: account.name }),
          });
          onDone();
        },
      },
    );
  };

  const part = (key: SetupField, amount: string) =>
    compareAmounts(amount, "0") !== 0
      ? t(`bsu.setup.plan.${key}`, { amount: money(amount) })
      : null;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Stack gap="md">
        <Text size="sm">{t("bsu.setup.intro")}</Text>
        <Select
          label={t("bsu.setup.opened")}
          description={t("bsu.setup.openedHint", { year: history.latest_opened_year })}
          data={years}
          value={String(opened)}
          allowDeselect={false}
          searchable
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            if (!v) return;
            const year = Number(v);
            setOpened(year);
            setRows(setupRows(history, year, rows));
          }}
        />
        {rows.map((r) => {
          const over = overYear(r, history.rules);
          const limit = ruleFor(history.rules, r.year)?.yearly_limit;
          return (
            <Card
              key={r.year}
              withBorder
              padding="sm"
              component="fieldset"
              aria-label={String(r.year)}
            >
              <Stack gap="xs">
                <Title order={4} size="h5" component="legend">
                  {r.year}
                </Title>
                <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="xs">
                  {SETUP_FIELDS.map((f) => {
                    const problem = tried ? fieldProblem(r, f) : undefined;
                    return (
                      <AmountInput
                        key={f}
                        label={t(`bsu.setup.fields.${f}`)}
                        aria-label={t("bsu.setup.fieldName", {
                          field: t(`bsu.setup.fields.${f}`),
                          year: r.year,
                        })}
                        currency={account.currency}
                        value={r[f]}
                        onChange={(v) => {
                          change(r.year, f, v);
                        }}
                        error={
                          problem === "empty"
                            ? t("bsu.setup.enterAmount")
                            : problem === "belowRecorded"
                              ? t("bsu.setup.belowRecorded", { amount: money(r.min[f]) })
                              : undefined
                        }
                      />
                    );
                  })}
                </SimpleGrid>
                {over && limit && (
                  <Text size="xs" c="var(--mantine-color-orange-text)">
                    {t("bsu.setup.overYear", { amount: money(over), limit: money(limit) })}
                  </Text>
                )}
              </Stack>
            </Card>
          );
        })}
        {totalOver && (
          <Text size="sm" c="var(--mantine-color-orange-text)">
            {t("bsu.setup.overTotal", { amount: money(totalOver) })}
          </Text>
        )}
        <AmountInput
          label={t("bsu.setup.balance")}
          description={t("bsu.setup.balanceHint", { amount: money(history.balance) })}
          currency={account.currency}
          value={balance}
          onChange={setBalance}
          error={tried && balance === null ? t("bsu.setup.enterAmount") : undefined}
          required
        />
        <Card withBorder padding="sm" component="section" aria-label={t("bsu.setup.plan.title")}>
          <Text fw={600} size="sm">
            {t("bsu.setup.plan.title")}
          </Text>
          {plan.opening === null && plan.years.length === 0 && plan.adjustment === null ? (
            <Text size="sm" c="dimmed">
              {t("bsu.setup.plan.nothing")}
            </Text>
          ) : (
            <List size="sm" spacing={2}>
              {plan.opening && (
                <List.Item>
                  {t("bsu.setup.plan.opening", { amount: money(plan.opening) })}
                </List.Item>
              )}
              {plan.years.map((y) => (
                <List.Item key={y.year}>
                  {t("bsu.setup.plan.year", {
                    year: y.year,
                    parts: SETUP_FIELDS.map((f) => part(f, y[f]))
                      .filter(Boolean)
                      .join(", "),
                  })}
                </List.Item>
              ))}
              {plan.adjustment && (
                <List.Item>
                  {t("bsu.setup.plan.adjustment", { amount: money(plan.adjustment) })}
                </List.Item>
              )}
            </List>
          )}
          <Text size="xs" c="dimmed" mt="xs">
            {t("bsu.setup.plan.once")}
          </Text>
        </Card>
        {setUp.error && <ErrorAlert error={setUp.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={setUp.isPending}>
            {t("bsu.setup.submit")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
