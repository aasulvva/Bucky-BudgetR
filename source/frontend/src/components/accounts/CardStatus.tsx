// Credit cards (#260, spec §2.2): the card's line on Accounts, and its fields
// in Account setup.

import { SegmentedControl, Select, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account } from "@/api/accounts";
import { AmountInput } from "@/components/AmountInput";
import {
  cardLine,
  cardNear,
  cardProblems,
  dayOptions,
  defaultAccountChoices,
  MAX_PAY_DAYS_BEFORE,
  type CardDraft,
  type CardField,
} from "@/lib/cards";

const ORANGE = "var(--mantine-color-orange-text)";

/** The card's line: what's owed and what's available, orange near the limit. */
export function CardLine({ account }: { account: Account }) {
  const line = cardLine(account);
  if (!line) return null;
  return (
    <Text size="sm" c={cardNear(account) ? ORANGE : "dimmed"}>
      {line}
    </Text>
  );
}

/** The card's own fields: its default account, limit, days and minimum. */
export function CardFieldsInput({
  value,
  onChange,
  accounts,
  currency,
  tried,
}: {
  value: CardDraft;
  onChange: (value: CardDraft) => void;
  accounts: Account[];
  currency: string;
  /** Whether to show the problems: the form was submitted. */
  tried: boolean;
}) {
  const { t } = useTranslation();
  const problems = tried ? cardProblems(value) : {};
  const set = (patch: Partial<CardDraft>) => {
    onChange({ ...value, ...patch });
  };
  const choices = defaultAccountChoices(accounts, currency);
  const days = dayOptions();
  const problem = (f: CardField) => {
    const p = problems[f];
    return p ? t(`cards.${p}`) : undefined;
  };
  return (
    <Stack gap="md">
      <Select
        label={t("cards.defaultAccount")}
        description={
          choices.length === 0 ? t("cards.noChoices", { currency }) : t("cards.defaultAccountHint")
        }
        placeholder={t("cards.noDefault")}
        data={choices.map((a) => ({ value: a.id, label: a.name }))}
        value={value.defaultAccount}
        clearable
        disabled={choices.length === 0}
        comboboxProps={{ withinPortal: false }}
        onChange={(v) => {
          set({ defaultAccount: v });
        }}
      />
      <AmountInput
        label={t("cards.creditLimit")}
        currency={currency}
        value={value.limit}
        onChange={(v) => {
          set({ limit: v });
        }}
        error={problem("limit")}
        required
      />
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
        <Select
          label={t("cards.statementDay")}
          description={t("cards.statementDayHint")}
          data={days}
          value={value.statementDay}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            set({ statementDay: v });
          }}
          error={problem("statementDay")}
          required
        />
        <Select
          label={t("cards.dueDay")}
          description={t("cards.dueDayHint")}
          data={days}
          value={value.dueDay}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            set({ dueDay: v });
          }}
          error={problem("dueDay")}
          required
        />
      </SimpleGrid>
      <AmountInput
        label={t("cards.minimumPayment")}
        description={t("cards.minimumHint")}
        currency={currency}
        value={value.minimum}
        onChange={(v) => {
          set({ minimum: v });
        }}
        error={problem("minimum")}
        required
      />
      <PayDefaultsInput value={value} set={set} currency={currency} problem={problem} />
    </Stack>
  );
}

/**
 * How the card's bill is paid by default (#262): what, when and how, and
 * auto-finalize, which pays from the default account.
 */
function PayDefaultsInput({
  value,
  set,
  currency,
  problem,
}: {
  value: CardDraft;
  set: (patch: Partial<CardDraft>) => void;
  currency: string;
  problem: (f: CardField) => string | undefined;
}) {
  const { t } = useTranslation();
  const days = Array.from({ length: MAX_PAY_DAYS_BEFORE + 1 }, (_, i) => ({
    value: String(i),
    label: i === 0 ? t("cards.pay.onDue") : t("cards.pay.daysBefore", { count: i }),
  }));
  return (
    <Stack gap="sm" component="section" aria-label={t("cards.pay.title")}>
      <div>
        <Text size="sm" fw={600}>
          {t("cards.pay.title")}
        </Text>
        <Text size="xs" c="dimmed">
          {t("cards.pay.hint")}
        </Text>
      </div>
      <SegmentedControl
        aria-label={t("cards.pay.rule")}
        data={[
          { value: "full", label: t("cards.pay.full") },
          { value: "minimum", label: t("cards.pay.minimum") },
          { value: "fixed", label: t("cards.pay.fixed") },
        ]}
        value={value.payRule}
        onChange={(v) => {
          set({ payRule: v });
        }}
      />
      {value.payRule === "fixed" && (
        <AmountInput
          label={t("cards.pay.amount")}
          description={t("cards.pay.amountHint")}
          currency={currency}
          value={value.payAmount}
          onChange={(v) => {
            set({ payAmount: v });
          }}
          error={problem("payAmount")}
          required
        />
      )}
      <Select
        label={t("cards.pay.when")}
        data={days}
        value={value.payDaysBefore}
        allowDeselect={false}
        comboboxProps={{ withinPortal: false }}
        onChange={(v) => {
          if (v !== null) set({ payDaysBefore: v });
        }}
      />
      <SegmentedControl
        aria-label={t("cards.pay.mode")}
        data={[
          { value: "approve", label: t("cards.pay.approve") },
          { value: "auto", label: t("cards.pay.auto") },
        ]}
        value={value.payMode}
        onChange={(v) => {
          set({ payMode: v });
        }}
      />
      <Switch
        label={t("cards.pay.autoFinalize")}
        description={
          value.defaultAccount ? t("cards.pay.autoFinalizeHint") : t("cards.pay.autoFinalizeNeeds")
        }
        checked={value.autoFinalize && value.defaultAccount !== null}
        disabled={value.defaultAccount === null}
        error={problem("autoFinalize")}
        onChange={(e) => {
          set({ autoFinalize: e.currentTarget.checked });
        }}
      />
    </Stack>
  );
}
