import {
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { Account, Bucket } from "@/api/accounts";
import { useCurrentCycles, useCycles } from "@/api/cycles";
import { useSavePlanned, type PlannedPurchase } from "@/api/planned";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { BucketSplit, type SplitErrors } from "@/components/transactions/BucketSplit";
import { isLockedBsu } from "@/lib/bsu";
import { bucketsFor } from "@/lib/cards";
import { cycleRange, startAtFor } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import {
  PLANNED_PATH,
  emptyPlanned,
  plannedBody,
  plannedValues,
  type PlannedValues,
} from "@/lib/planned";
import { bucketTotals, followAmount, type SplitLine } from "@/lib/transactionForm";

interface Errors extends SplitErrors {
  name?: string;
  account?: string;
  amount?: string;
  expected?: string;
}

/**
 * A planned purchase's form (#265): the name or store, the account it'll be
 * charged on, the expected amount and day, its buckets, and a note. With
 * `editing`, it changes that plan.
 */
export function PlannedForm({
  accounts,
  buckets,
  editing,
}: {
  accounts: Account[];
  buckets: Bucket[];
  editing?: PlannedPurchase;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const navigate = useNavigate();
  const active = useCurrentCycles().data?.active ?? null;
  const cycles = useCycles().data ?? [];
  const [v, setValues] = useState<PlannedValues>(() =>
    editing ? plannedValues(editing) : emptyPlanned(null),
  );
  // The rows as last set, and the amount they were set for (followAmount).
  const [base, setBase] = useState({ amount: v.amount, lines: v.lines });
  const [errors, setErrors] = useState<Errors>({});
  const change = (patch: Partial<PlannedValues>) => {
    setValues((cur) => ({ ...cur, ...patch }));
  };
  const account = accounts.find((a) => a.id === v.accountId);
  const own = bucketsFor(account, accounts, buckets);
  const money = (amount: string) => formatMoney(amount, account?.currency);

  const save = useSavePlanned(async (p) => {
    notifications.show({
      color: "green",
      message: t(editing ? "planned.form.savedEdit" : "planned.form.saved", {
        name: p.name,
        date: formatDate(p.expected_at),
      }),
    });
    await navigate(PLANNED_PATH);
  });

  const changeLines = (lines: SplitLine[]) => {
    change({ lines });
    setBase({ amount: v.amount, lines });
  };

  const validate = (): Errors => {
    const found: Errors = {};
    if (!v.name.trim()) found.name = t("planned.form.enterName");
    if (!v.accountId) found.account = t("common.chooseAccount");
    if (v.amount === null || compareAmounts(v.amount, "0") <= 0) {
      found.amount = t("newTransaction.enterAmount");
    }
    if (!v.expected) found.expected = t("planned.form.chooseDay");
    const lineErrors: NonNullable<Errors["lines"]> = {};
    for (const l of v.lines) {
      const e = {
        bucket: l.bucketId ? undefined : t("newTransaction.chooseBucket"),
        amount:
          l.amount === null || compareAmounts(l.amount, "0") <= 0
            ? t("newTransaction.enterAmount")
            : undefined,
      };
      if (e.bucket ?? e.amount) lineErrors[l.key] = e;
    }
    if (Object.keys(lineErrors).length > 0) found.lines = lineErrors;
    const totals = bucketTotals(v.amount, v.lines);
    if (totals.over) {
      found.split = t("newTransaction.overBy", {
        amount: money(subtractAmounts("0", totals.notTied)),
      });
    }
    return found;
  };

  // Which cycle it'll be set aside in, as the server works it out.
  const at = v.expected ? new Date(startAtFor(v.expected)).getTime() : null;
  const lands =
    at === null
      ? undefined
      : cycles.find(
          (c) => new Date(c.start_at).getTime() <= at && at < new Date(c.end_at).getTime(),
        );
  const before = at !== null && active !== null && at < new Date(active.start_at).getTime();
  const cycleNote =
    at === null
      ? null
      : before
        ? t("planned.movesActive")
        : lands
          ? t("planned.inCycle", { range: cycleRange(lands) })
          : t("planned.noCycle");

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        save.mutate({ ...(editing ? { id: editing.id } : {}), body: plannedBody(v) });
      }}
    >
      <Card withBorder padding={isDesktop ? "lg" : "md"} maw={960} style={{ overflow: "visible" }}>
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            {t("planned.form.intro")}
          </Text>
          <Group align="flex-start" gap="xl" wrap="wrap">
            <Stack gap="md" style={{ flex: "1 1 360px", minWidth: 0 }}>
              <TextInput
                label={t("planned.form.name")}
                description={t("planned.form.nameHint")}
                value={v.name}
                maxLength={200}
                onChange={(e) => {
                  change({ name: e.currentTarget.value });
                }}
                error={errors.name}
                data-autofocus
              />
              <AmountInput
                label={t("planned.form.amount")}
                currency={account?.currency}
                value={v.amount}
                onChange={(amount) => {
                  change({ amount, lines: followAmount(base, amount) });
                }}
                error={errors.amount}
              />
              <Select
                label={t("planned.form.account")}
                data={accounts
                  .filter((a) => !isLockedBsu(a) || a.id === v.accountId)
                  .map((a) => ({ value: a.id, label: a.name }))}
                value={v.accountId}
                allowDeselect={false}
                onChange={(id) => {
                  const usable = bucketsFor(
                    accounts.find((a) => a.id === id),
                    accounts,
                    buckets,
                  );
                  const lines = v.lines.filter(
                    (l) => l.bucketId === null || usable.some((b) => b.id === l.bucketId),
                  );
                  change({ accountId: id, lines });
                  setBase({ amount: v.amount, lines });
                }}
                error={errors.account}
              />
              <DatePickerInput
                label={t("planned.form.expected")}
                description={cycleNote}
                valueFormat="D MMM YYYY"
                value={v.expected}
                onChange={(expected) => {
                  change({ expected });
                }}
                error={errors.expected}
              />
              <Textarea
                label={t("planned.form.note")}
                value={v.note}
                maxLength={500}
                autosize
                minRows={2}
                onChange={(e) => {
                  change({ note: e.currentTarget.value });
                }}
              />
            </Stack>
            <BucketSplit
              account={account}
              accounts={accounts}
              own={own}
              all={buckets}
              active={active}
              amount={v.amount}
              lines={v.lines}
              onChange={changeLines}
              errors={errors}
              locked={false}
              needsCycle={false}
            />
          </Group>
          {save.error && <ErrorAlert error={save.error} />}
          <Group
            justify="flex-end"
            gap="xs"
            pt="sm"
            style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
          >
            <Button
              variant="default"
              onClick={() => {
                void navigate(PLANNED_PATH);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t(editing ? "planned.form.saveEdit" : "planned.form.save")}
            </Button>
          </Group>
        </Stack>
      </Card>
    </form>
  );
}
