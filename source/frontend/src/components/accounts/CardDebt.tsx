// Card debt held per account (#261, spec §2.2): the card's set-aside line,
// and Set aside / Release on Accounts.

import { Button, Group, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { isLockedBsu } from "@/lib/bsu";
import { cardDebtLine, heldFor, holderChoices, type CardDebtMode } from "@/lib/cards";
import { autofocusField } from "@/lib/device";
import { canonicalAmount, compareAmounts, formatMoney } from "@/lib/money";

/** The card's line of what's set aside for it, and what isn't. */
export function CardDebtLine({ account }: { account: Account }) {
  const line = cardDebtLine(account);
  if (!line) return null;
  return (
    <Text size="sm" c="dimmed">
      {line}
    </Text>
  );
}

/**
 * Set aside: holds part of what the card owes that isn't set aside, on an
 * account, out of its unallocated money (a CDH). Release: gives back what's
 * set aside on an account (a CDR).
 */
export function CardDebtForm({
  card,
  accounts,
  mode,
  onDone,
}: {
  card: Account;
  accounts: Account[];
  mode: CardDebtMode;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const c = card.credit_card;
  const held = (c?.held_on ?? []).filter((h) => compareAmounts(h.amount, "0") > 0);
  const choices =
    mode === "setAside"
      ? holderChoices(accounts, card).filter((a) => !isLockedBsu(a))
      : accounts.filter((a) => held.some((h) => h.account_id === a.id));
  const first =
    mode === "setAside"
      ? (choices.find((a) => a.id === c?.default_account_id) ?? choices[0])
      : choices.find((a) => a.id === held[0]?.account_id);
  const [accountId, setAccountId] = useState<string | null>(first?.id ?? null);
  const account = accounts.find((a) => a.id === accountId);
  // At most what isn't set aside, or what's set aside on the account.
  const most =
    mode === "setAside"
      ? canonicalAmount(c?.not_set_aside ?? "0")
      : canonicalAmount(heldFor(account, card.id));
  const [amount, setAmount] = useState<string | null>(most);
  const [error, setError] = useState<string>();
  const money = (a: string) => formatMoney(a, card.currency);

  const save = useMutation({
    mutationFn: (body: { account_id: string; amount: string }) =>
      unwrap(
        mode === "setAside"
          ? api.POST("/api/v1/accounts/{accountId}/card-debt/set-aside", {
              params: { path: { accountId: card.id } },
              body,
            })
          : api.POST("/api/v1/accounts/{accountId}/card-debt/release", {
              params: { path: { accountId: card.id } },
              body,
            }),
      ),
    meta: { silentError: true },
    onSuccess: async (_, body) => {
      notifications.show({
        color: "green",
        message: t(mode === "setAside" ? "cards.debt.setAsideDone" : "cards.debt.releaseDone", {
          amount: money(body.amount),
          card: card.name,
        }),
      });
      onDone();
      await refresh();
    },
  });

  if (choices.length === 0 || compareAmounts(most, "0") <= 0) {
    return (
      <Text size="sm" c="dimmed">
        {t(mode === "setAside" ? "cards.debt.nothingToSetAside" : "cards.debt.nothingHeld")}
      </Text>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (amount === null || compareAmounts(amount, "0") <= 0) {
          setError(t("cards.aboveZero"));
        } else if (compareAmounts(amount, most) > 0) {
          setError(t("cards.debt.atMost", { amount: money(most) }));
        } else if (accountId) {
          save.mutate({ account_id: accountId, amount });
        }
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t(mode === "setAside" ? "cards.debt.setAsideIntro" : "cards.debt.releaseIntro", {
            card: card.name,
          })}
        </Text>
        <Select
          label={t("cards.debt.account")}
          data={choices.map((a) => ({ value: a.id, label: a.name }))}
          value={accountId}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            setAccountId(v);
            if (mode === "release") {
              setAmount(
                canonicalAmount(
                  heldFor(
                    accounts.find((a) => a.id === v),
                    card.id,
                  ),
                ),
              );
            }
          }}
          description={
            account &&
            (mode === "setAside"
              ? t("cards.debt.unallocatedOn", { amount: money(account.unallocated) })
              : t("cards.debt.heldOn", { amount: money(heldFor(account, card.id)) }))
          }
        />
        <AmountInput
          label={t("cards.debt.amount")}
          description={
            mode === "setAside" ? t("cards.debt.notSetAside", { amount: money(most) }) : undefined
          }
          currency={card.currency}
          value={amount}
          onChange={setAmount}
          error={error}
          {...autofocusField()}
        />
        {save.error && <ErrorAlert error={save.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t(mode === "setAside" ? "cards.debt.setAside" : "cards.debt.release")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
