// Card debt in the transaction form (#261, spec §2.2): what a payment to a
// card releases, and what a transfer carries along.

import { Card, Stack, Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account } from "@/api/accounts";
import { AmountInput } from "@/components/AmountInput";
import { heldFor } from "@/lib/cards";
import { compareAmounts, formatMoney } from "@/lib/money";

/** Amounts per account or card ID, as the form holds them. */
export type DebtAmounts = Record<string, string | null>;

/**
 * A payment to a card: what it clears on the paying account, and a row per
 * other account holding debt for the card with what it releases there.
 */
export function PaymentReleases({
  card,
  payer,
  accounts,
  clears,
  values,
  onChange,
  error,
}: {
  card: Account;
  payer: Account;
  accounts: Account[];
  clears: string;
  /** Each other holding account's release, as shown. */
  values: DebtAmounts;
  onChange: (id: string, value: string | null) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, card.currency);
  const holders = accounts.filter(
    (a) => a.id !== payer.id && compareAmounts(heldFor(a, card.id), "0") > 0,
  );
  if (holders.length === 0 && compareAmounts(clears, "0") <= 0) return null;
  return (
    <Card
      withBorder
      padding="sm"
      component="section"
      aria-label={t("cards.debt.title")}
      bg="var(--mantine-color-blue-light)"
    >
      <Stack gap="sm">
        <Text size="sm" fw={600}>
          {t("cards.debt.title")}
        </Text>
        {compareAmounts(clears, "0") > 0 && (
          <Text size="sm">
            {t("cards.debt.clears", { amount: money(clears), name: payer.name })}
          </Text>
        )}
        {holders.length > 0 && (
          <Text size="xs" c="dimmed">
            {t("cards.debt.releasesHint")}
          </Text>
        )}
        {holders.map((a) => (
          <AmountInput
            key={a.id}
            label={t("cards.debt.releaseOn", { name: a.name })}
            description={t("cards.debt.heldOn", { amount: money(heldFor(a, card.id)) })}
            currency={card.currency}
            value={values[a.id] ?? null}
            onChange={(v) => {
              onChange(a.id, v);
            }}
          />
        ))}
        {error && (
          <Text size="sm" c="var(--mantine-color-red-text)" role="alert">
            {error}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/**
 * A transfer from an account holding card debt: Move card debt with it, off
 * by default, with a row per card.
 */
export function CarryDebt({
  account,
  accounts,
  on,
  onToggle,
  values,
  onChange,
  error,
}: {
  account: Account;
  accounts: Account[];
  on: boolean;
  onToggle: (on: boolean) => void;
  /** Each card's carried amount, as shown. */
  values: DebtAmounts;
  onChange: (cardId: string, value: string | null) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, account.currency);
  const holds = account.card_holds.filter((h) => compareAmounts(h.amount, "0") > 0);
  if (holds.length === 0) return null;
  const cardName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  return (
    <Stack gap="sm">
      <Switch
        label={t("cards.debt.carry")}
        description={t("cards.debt.carryHint", {
          name: account.name,
          amounts: holds
            .map((h) =>
              t("cards.debt.heldFor", { amount: money(h.amount), card: cardName(h.card_id) }),
            )
            .join(", "),
        })}
        checked={on}
        onChange={(e) => {
          onToggle(e.currentTarget.checked);
        }}
      />
      {on &&
        holds.map((h) => (
          <AmountInput
            key={h.card_id}
            label={t("cards.debt.carryFor", { card: cardName(h.card_id) })}
            currency={account.currency}
            value={values[h.card_id] ?? null}
            onChange={(v) => {
              onChange(h.card_id, v);
            }}
          />
        ))}
      {on && error && (
        <Text size="sm" c="var(--mantine-color-red-text)" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
