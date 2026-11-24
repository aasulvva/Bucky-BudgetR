// A credit card's interest and fees (#263, spec §2.2): an expense to the
// card's bank, tagged interest or fee, set aside like a purchase.

import { Alert, Button, Group, SegmentedControl, Select, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { useRefreshMoney, type Account } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { RecordConfirm } from "@/components/transactions/RecordConfirm";
import { isLockedBsu } from "@/lib/bsu";
import { holderChoices, limitAsk, NOWHERE } from "@/lib/cards";
import { autofocusField } from "@/lib/device";
import { chargeCounterparty, type ChargeTag } from "@/lib/interest";
import { compareAmounts, formatMoney } from "@/lib/money";

/** The accounts a card's charge can be set aside on: the default account first. */
function setAsideChoices(card: Account, accounts: Account[]): Account[] {
  const first = card.credit_card?.default_account_id;
  const choices = holderChoices(accounts, card).filter((a) => !isLockedBsu(a));
  return [...choices.filter((a) => a.id === first), ...choices.filter((a) => a.id !== first)];
}

/** Registers interest or a fee the bank charged on the card. */
export function CardChargesForm({
  card,
  accounts,
  onDone,
}: {
  card: Account;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const choices = setAsideChoices(card, accounts);
  const [tag, setTag] = useState<ChargeTag>("interest");
  const [amount, setAmount] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [on, setOn] = useState<string>(card.credit_card?.default_account_id ?? NOWHERE);
  const [error, setError] = useState<string>();
  const counterparty = chargeCounterparty(card, tag);

  interface Body {
    type: "EXP";
    account_id: string;
    amount: string;
    counterparty: string;
    tags: string[];
    set_aside_account_id: string | null;
    at?: string;
    limit_confirmed?: boolean;
  }
  const save = useMutation({
    mutationFn: (body: Body) => unwrap(api.POST("/api/v1/transactions", { body })),
    meta: { silentError: true },
    onSuccess: async (_, body) => {
      notifications.show({
        color: "green",
        message: t(tag === "fee" ? "cards.charges.feeDone" : "cards.charges.interestDone", {
          amount: formatMoney(body.amount, card.currency),
          card: card.name,
        }),
      });
      onDone();
      await refresh();
    },
  });
  const ask = limitAsk(save.error);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (amount === null || compareAmounts(amount, "0") <= 0) {
          setError(t("cards.aboveZero"));
          return;
        }
        save.mutate({
          type: "EXP",
          account_id: card.id,
          amount,
          counterparty,
          tags: [tag],
          set_aside_account_id: on === NOWHERE ? null : on,
          ...(at ? { at } : {}),
        });
      }}
    >
      <Stack gap="md">
        <SegmentedControl
          aria-label={t("cards.charges.kind")}
          data={[
            { value: "interest", label: t("cards.charges.interest") },
            { value: "fee", label: t("cards.charges.fee") },
          ]}
          value={tag}
          onChange={(v) => {
            setTag(v === "fee" ? "fee" : "interest");
          }}
        />
        <AmountInput
          label={t("cards.charges.amount")}
          currency={card.currency}
          value={amount}
          onChange={setAmount}
          error={error}
          required
          {...autofocusField()}
        />
        <DateTimeInput
          label={t("common.dateTime")}
          description={t("cards.charges.when")}
          value={at}
          onChange={setAt}
        />
        <Select
          label={t("cards.debt.setAsideOn")}
          description={t("cards.charges.setAsideHint")}
          data={[
            ...choices.map((a) => ({ value: a.id, label: a.name })),
            { value: NOWHERE, label: t("cards.debt.nowhere") },
          ]}
          value={on}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            if (v) setOn(v);
          }}
        />
        <Alert color="gray" variant="light">
          <Trans
            i18nKey="cards.charges.note"
            values={{ counterparty, tag }}
            components={{ b: <strong /> }}
          />
        </Alert>
        {ask ? (
          <RecordConfirm
            ask="over_credit_limit"
            pending={save.isPending}
            onConfirm={() => {
              const v = save.variables;
              if (v) save.mutate({ ...v, limit_confirmed: true });
            }}
            onCancel={() => {
              save.reset();
            }}
          />
        ) : (
          save.error && <ErrorAlert error={save.error} />
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending && !ask}>
            {t("cards.charges.register")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
