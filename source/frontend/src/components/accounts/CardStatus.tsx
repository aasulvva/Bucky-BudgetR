// Credit cards (#260, spec §2.2): the card's line on Accounts, and its fields
// in Account setup.

import { Select, SimpleGrid, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account } from "@/api/accounts";
import { AmountInput } from "@/components/AmountInput";
import {
  cardLine,
  cardNear,
  cardProblems,
  dayOptions,
  defaultAccountChoices,
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
    </Stack>
  );
}
