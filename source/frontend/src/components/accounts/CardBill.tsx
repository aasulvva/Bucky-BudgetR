// A credit card's bill on Accounts (#262, spec §2.2): setting it up, the
// statement, finalizing it with its payment, and paying it now.

import {
  Anchor,
  Badge,
  Button,
  Group,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useRefreshMoney, type Account, type CardStatement } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { useRefreshSchedules } from "@/api/schedules";
import { useUpcomingDays } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { FigureRows, type FigureRow } from "@/components/accounts/FigureRows";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { PaymentReleases, type DebtAmounts } from "@/components/transactions/CardDebtFields";
import { RecordConfirm, type RecordAsk } from "@/components/transactions/RecordConfirm";
import { bsuAsk, isLockedBsu } from "@/lib/bsu";
import {
  autoRelease,
  billState,
  holderChoices,
  limitAsk,
  payAmount,
  payDay,
  releaseProblem,
  type BillState,
  type PayMode,
  type PayRule,
} from "@/lib/cards";
import { now } from "@/lib/clock";
import { formatDate, formatDateTime, parseDate } from "@/lib/dates";
import { canonicalAmount, compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

/** The panel's forms: the bill, finalizing it, or paying it now. */
export type BillView = "bill" | "finalize" | "pay";

/** The accounts a card's bill can be paid from: in its currency, not cards or locked BSUs. */
function payerChoices(card: Account, accounts: Account[]): Account[] {
  return holderChoices(accounts, card).filter((a) => !isLockedBsu(a));
}

/** The 409s that ask before recording a payment. */
function askOf(error: unknown): RecordAsk | undefined {
  return bsuAsk(error) ?? (limitAsk(error) ? "over_credit_limit" : undefined);
}

/** The card's bill: set it up, or its statement, payment and actions. */
export function CardBillPanel({
  card,
  accounts,
  view,
  onView,
  onDone,
}: {
  card: Account;
  accounts: Account[];
  view: BillView;
  onView: (view: BillView) => void;
  onDone: () => void;
}) {
  const bill = card.credit_card?.bill;
  if (!bill) return null;
  if (!bill.set_up) return <BillSetupForm card={card} onDone={onDone} />;
  const cur = bill.current;
  const back = () => {
    onView("bill");
  };
  if (view === "finalize" && cur && !cur.fixed) {
    return <FinalizeForm card={card} statement={cur} accounts={accounts} onDone={back} />;
  }
  if (view === "pay" && cur) {
    return <PayBillForm card={card} statement={cur} accounts={accounts} onDone={back} />;
  }
  return <BillDetails card={card} accounts={accounts} onView={onView} />;
}

/** The figures of a statement, a row each. */
function statementRows(
  card: Account,
  st: CardStatement,
  state: BillState | null,
  t: TFunction,
): FigureRow[] {
  const money = (a: string) => formatMoney(a, card.currency);
  const leftOrange = state === "soon";
  return [
    { label: t("cards.bill.amount"), value: money(st.amount) },
    { label: t("cards.bill.minimum"), value: money(st.minimum) },
    { label: t("cards.bill.paid"), value: money(st.paid) },
    {
      label: t("cards.bill.left"),
      value: money(st.left),
      orange: leftOrange,
      red: state === "past",
      ...(compareAmounts(st.minimum_left, "0") > 0
        ? { note: t("cards.bill.minimumLeft", { amount: money(st.minimum_left) }) }
        : {}),
      ...(state === "past" ? { warning: t("cards.bill.pastDue") } : {}),
      ...(state === "carried" ? { note: t("cards.bill.carried") } : {}),
    },
    { label: t("cards.bill.due"), value: formatDate(st.due_date), orange: leftOrange },
  ];
}

function BillDetails({
  card,
  accounts,
  onView,
}: {
  card: Account;
  accounts: Account[];
  onView: (view: BillView) => void;
}) {
  const { t } = useTranslation();
  const days = useUpcomingDays();
  const bill = card.credit_card?.bill;
  if (!bill) return null;
  const cur = bill.current;
  const money = (a: string) => formatMoney(a, card.currency);
  const state = billState(card, days);
  if (!cur) {
    return (
      <Text size="sm" c="dimmed">
        {t("cards.bill.firstOn", { date: formatDate(bill.next_statement_date) })}
      </Text>
    );
  }
  const badge = cur.fixed
    ? cur.fixed_by === "auto"
      ? t("cards.bill.fixedAuto")
      : cur.fixed_by === "due"
        ? t("cards.bill.fixedDue")
        : cur.fixed_by === "setup"
          ? t("cards.bill.fixedSetup")
          : t("cards.bill.finalized", { date: cur.fixed_at ? formatDate(cur.fixed_at) : "" })
    : t("cards.bill.estimate");
  const p = bill.payment;
  const from = p ? (accounts.find((a) => a.id === p.account_id)?.name ?? p.account_id) : "";
  const prev = bill.previous;
  return (
    <Stack gap="sm">
      <Group justify="space-between" gap="xs">
        <Text fw={600}>{t("cards.bill.statement", { date: formatDate(cur.statement_date) })}</Text>
        <Badge variant="light" color={cur.fixed ? "green" : "gray"} radius="sm">
          {badge}
        </Badge>
      </Group>
      {!cur.fixed && (
        <Text size="xs" c="dimmed">
          {t("cards.bill.estimateHint")}
        </Text>
      )}
      <FigureRows
        label={t("cards.bill.label", { name: card.name })}
        rows={statementRows(card, cur, state, t)}
      />
      {p && (
        <Text size="sm" c={p.state === "skipped" ? "dimmed" : undefined}>
          {t(`cards.bill.payment.${p.state}`, {
            amount: money(p.amount),
            from,
            date: formatDateTime(p.at),
          })}{" "}
          {p.state === "queued" || p.state === "scheduled" ? (
            <Anchor component={Link} to="/transactions/scheduled" size="sm">
              {t("cards.bill.payment.open")}
            </Anchor>
          ) : null}
        </Text>
      )}
      <Group gap="xs">
        {!cur.fixed && (
          <Button
            size="xs"
            onClick={() => {
              onView("finalize");
            }}
          >
            {t("cards.bill.finalize")}
          </Button>
        )}
        <Button
          size="xs"
          variant={cur.fixed ? "filled" : "default"}
          disabled={compareAmounts(cur.left, "0") <= 0}
          onClick={() => {
            onView("pay");
          }}
        >
          {t("cards.bill.pay")}
        </Button>
      </Group>
      {prev && compareAmounts(prev.left, "0") > 0 && (
        <Text size="sm" c="dimmed">
          {t("cards.bill.previousLeft", {
            date: formatDate(prev.statement_date),
            amount: money(prev.left),
          })}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The bill of a card from before #262: its last statement and what's been
 * paid on it since, or no statement yet.
 */
function BillSetupForm({ card, onDone }: { card: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [has, setHas] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState<string | null>(null);
  const [paid, setPaid] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (last: { amount: string; paid: string } | null) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/bill/setup", {
          params: { path: { accountId: card.id } },
          body: { last_statement: last },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("cards.bill.setupDone", { card: card.name }),
      });
      await refresh();
    },
  });
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (has === "no") {
          save.mutate(null);
        } else if (amount === null || compareAmounts(amount, "0") < 0) {
          setError(t("cards.bill.setupAmount"));
        } else {
          save.mutate({ amount, paid: paid ?? "0" });
        }
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("cards.bill.setupIntro")}
        </Text>
        <Radio.Group
          value={has}
          onChange={(v) => {
            setHas(v);
          }}
          label={t("cards.bill.setupHas")}
        >
          <Stack gap="xs" mt="xs">
            <Radio value="yes" label={t("cards.bill.setupYes")} />
            <Radio value="no" label={t("cards.bill.setupNo")} />
          </Stack>
        </Radio.Group>
        {has === "yes" && (
          <>
            <AmountInput
              label={t("cards.bill.lastAmount")}
              currency={card.currency}
              value={amount}
              onChange={setAmount}
              error={error}
              required
            />
            <AmountInput
              label={t("cards.bill.lastPaid")}
              description={t("cards.bill.lastPaidHint")}
              currency={card.currency}
              value={paid}
              onChange={setPaid}
            />
          </>
        )}
        {save.error && <ErrorAlert error={save.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("cards.bill.setUp")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Full, Minimum or Other, with the amount for Other. */
function RuleInput({
  card,
  rule,
  onRule,
  other,
  onOther,
  minimumLeft,
  error,
  otherLabel,
}: {
  card: Account;
  rule: PayRule;
  onRule: (rule: PayRule) => void;
  other: string | null;
  onOther: (v: string | null) => void;
  minimumLeft: string;
  error?: string;
  otherLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SegmentedControl
        aria-label={t("cards.pay.rule")}
        data={[
          { value: "full", label: t("cards.pay.full") },
          {
            value: "minimum",
            label: t("cards.pay.minimum"),
            disabled: compareAmounts(minimumLeft, "0") <= 0,
          },
          { value: "fixed", label: t("cards.pay.other") },
        ]}
        value={rule}
        onChange={(v) => {
          onRule(v);
        }}
      />
      {rule === "fixed" && (
        <AmountInput
          label={otherLabel}
          currency={card.currency}
          value={other}
          onChange={onOther}
          error={error}
          required
        />
      )}
    </>
  );
}

/** The from-account select, prefilled with the card's default account. */
function FromInput({
  card,
  accounts,
  value,
  onChange,
}: {
  card: Account;
  accounts: Account[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const choices = payerChoices(card, accounts);
  const money = (a: Account) => formatMoney(a.balance, a.currency);
  return (
    <Select
      label={t("cards.bill.from")}
      data={choices.map((a) => ({ value: a.id, label: `${a.name} · ${money(a)}` }))}
      value={value}
      allowDeselect={false}
      comboboxProps={{ withinPortal: false }}
      onChange={onChange}
      required
    />
  );
}

function firstPayer(card: Account, accounts: Account[]): string | null {
  const choices = payerChoices(card, accounts);
  return (
    choices.find((a) => a.id === card.credit_card?.default_account_id)?.id ?? choices[0]?.id ?? null
  );
}

/**
 * Finalize bill: the bank's statement amount (a different one adjusts the
 * card before the cutoff), then the payment: scheduled, now, or none.
 */
function FinalizeForm({
  card,
  statement: st,
  accounts,
  onDone,
}: {
  card: Account;
  statement: CardStatement;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refreshSchedules = useRefreshSchedules();
  const c = card.credit_card;
  const money = (a: string) => formatMoney(a, card.currency);
  // The payment day at 08:00 local time, unless it has passed.
  const day = c ? parseDate(payDay(c, st.due_date)) : now();
  day.setHours(8, 0, 0, 0);
  const later = day > now();
  const [amount, setAmount] = useState<string | null>(canonicalAmount(st.amount));
  const [when, setWhen] = useState<"later" | "now" | "none">(later ? "later" : "now");
  const [rule, setRule] = useState<PayRule>(c?.pay.rule ?? "full");
  const [other, setOther] = useState<string | null>(
    c?.pay.amount ? canonicalAmount(c.pay.amount) : null,
  );
  const [from, setFrom] = useState<string | null>(firstPayer(card, accounts));
  const [at, setAt] = useState<string | null>(later ? day.toISOString() : null);
  const [mode, setMode] = useState<PayMode>(c?.pay.mode ?? "approve");
  const [errors, setErrors] = useState<{ amount?: string; other?: string; at?: string }>({});

  // What the payment would pay, from the bank's amount.
  const bank = amount ?? st.amount;
  const minimum =
    compareAmounts(c?.minimum_payment ?? "0", bank) < 0 ? (c?.minimum_payment ?? "0") : bank;
  const clamp = (a: string) => (compareAmounts(a, "0") > 0 ? a : "0");
  const left = clamp(subtractAmounts(bank, st.paid));
  const minimumLeft = clamp(subtractAmounts(minimum, st.paid));
  const pays = payAmount(rule, left, minimumLeft, other);
  const differs = amount !== null && compareAmounts(amount, st.amount) !== 0;

  interface Body {
    amount: string;
    payment: {
      rule: PayRule;
      amount?: string;
      account_id: string;
      at?: string;
      mode: PayMode;
      bsu_confirmed?: boolean;
      limit_confirmed?: boolean;
    } | null;
  }
  const save = useMutation({
    mutationFn: (body: Body) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/bill/finalize", {
          params: { path: { accountId: card.id } },
          body,
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (done) => {
      notifications.show({
        color: "green",
        message: done.transaction_id
          ? t("cards.bill.finalizedPaid", { card: card.name })
          : done.schedule_id
            ? t("cards.bill.finalizedScheduled", { card: card.name })
            : t("cards.bill.finalizedDone", { card: card.name }),
      });
      onDone();
      await refreshSchedules();
    },
  });
  const ask = askOf(save.error);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found: typeof errors = {};
        if (amount === null || compareAmounts(amount, "0") < 0)
          found.amount = t("cards.bill.setupAmount");
        if (
          when !== "none" &&
          rule === "fixed" &&
          (other === null || compareAmounts(other, "0") <= 0)
        ) {
          found.other = t("cards.aboveZero");
        }
        if (when === "later" && at === null) found.at = t("cards.bill.chooseWhen");
        setErrors(found);
        if (Object.keys(found).length > 0 || amount === null) return;
        save.mutate({
          amount,
          payment:
            when === "none" || from === null
              ? null
              : {
                  rule,
                  ...(rule === "fixed" && other ? { amount: other } : {}),
                  account_id: from,
                  ...(when === "later" && at ? { at } : {}),
                  mode: when === "now" ? "auto" : mode,
                },
        });
      }}
    >
      <Stack gap="md">
        <AmountInput
          label={t("cards.bill.bankAmount")}
          description={
            differs
              ? t("cards.bill.bankDiffers", {
                  app: money(st.amount),
                  date: formatDateTime(st.cutoff),
                })
              : t("cards.bill.bankHint")
          }
          currency={card.currency}
          value={amount}
          onChange={setAmount}
          error={errors.amount}
          required
        />
        <Stack gap="xs" component="section" aria-label={t("cards.bill.payment.title")}>
          <Text size="sm" fw={600}>
            {t("cards.bill.payment.title")}
          </Text>
          <SegmentedControl
            aria-label={t("cards.bill.payment.when")}
            data={[
              { value: "later", label: t("cards.bill.payment.later") },
              { value: "now", label: t("cards.bill.payment.now") },
              { value: "none", label: t("cards.bill.payment.none") },
            ]}
            value={when}
            onChange={(v) => {
              setWhen(v);
            }}
          />
          {when !== "none" && (
            <>
              <RuleInput
                card={card}
                rule={rule}
                onRule={setRule}
                other={other}
                onOther={setOther}
                minimumLeft={minimumLeft}
                error={errors.other}
                otherLabel={t("cards.pay.amount")}
              />
              <FromInput card={card} accounts={accounts} value={from} onChange={setFrom} />
              {when === "later" && (
                <>
                  <DateTimeInput
                    label={t("cards.bill.payment.at")}
                    value={at}
                    onChange={setAt}
                    minDate={now()}
                    maxDate={undefined}
                    clearable={false}
                    error={errors.at}
                  />
                  <SegmentedControl
                    aria-label={t("cards.pay.mode")}
                    data={[
                      { value: "approve", label: t("cards.pay.approve") },
                      { value: "auto", label: t("cards.pay.auto") },
                    ]}
                    value={mode}
                    onChange={(v) => {
                      setMode(v);
                    }}
                  />
                </>
              )}
              <Text size="sm" c={compareAmounts(pays, "0") > 0 ? undefined : "dimmed"}>
                {compareAmounts(pays, "0") > 0
                  ? t(when === "now" ? "cards.bill.paysNow" : "cards.bill.paysLater", {
                      amount: money(pays),
                    })
                  : t("cards.bill.nothingLeft")}
              </Text>
            </>
          )}
        </Stack>
        {ask ? (
          <RecordConfirm
            ask={ask}
            pending={save.isPending}
            onConfirm={() => {
              const v = save.variables;
              if (!v?.payment) return;
              save.mutate({
                ...v,
                payment: {
                  ...v.payment,
                  ...(ask === "over_credit_limit"
                    ? { limit_confirmed: true }
                    : { bsu_confirmed: true }),
                },
              });
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
            {t("common.back")}
          </Button>
          <Button type="submit" loading={save.isPending && !ask}>
            {t("cards.bill.finalize")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * Pay bill: a transfer to the card now, what's left, the minimum or another
 * amount, with what it releases on other accounts (#261).
 */
function PayBillForm({
  card,
  statement: st,
  accounts,
  onDone,
}: {
  card: Account;
  statement: CardStatement;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const money = (a: string) => formatMoney(a, card.currency);
  const [rule, setRule] = useState<PayRule>("full");
  const [other, setOther] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(firstPayer(card, accounts));
  const [at, setAt] = useState<string | null>(null);
  const [releases, setReleases] = useState<DebtAmounts | null>(null);
  const [errors, setErrors] = useState<{ other?: string; releases?: string }>({});
  const amount =
    rule === "fixed" ? (other ?? "0") : payAmount(rule, st.left, st.minimum_left, null);
  const payer = accounts.find((a) => a.id === from);
  const auto = payer ? autoRelease(card, payer, accounts, amount) : null;
  const releaseValues: DebtAmounts =
    releases ?? Object.fromEntries((auto?.releases ?? []).map((r) => [r.account_id, r.amount]));

  interface Body {
    type: "TRF";
    account_id: string;
    to_account_id: string;
    amount: string;
    at?: string;
    release_card_debt?: { account_id: string; amount: string }[];
    bsu_confirmed?: boolean;
    limit_confirmed?: boolean;
  }
  const save = useMutation({
    mutationFn: (body: Body) => unwrap(api.POST("/api/v1/transactions", { body })),
    meta: { silentError: true },
    onSuccess: async (_, body) => {
      notifications.show({
        color: "green",
        message: t("cards.bill.paidDone", { amount: money(body.amount), card: card.name }),
      });
      onDone();
      await refresh();
    },
  });
  const ask = askOf(save.error);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found: typeof errors = {};
        if (compareAmounts(amount, "0") <= 0) found.other = t("cards.aboveZero");
        if (auto && releases !== null) {
          const p = releaseProblem(
            card,
            accounts,
            releaseValues,
            subtractAmounts(amount, auto.clears),
          );
          if (p) found.releases = p;
        }
        setErrors(found);
        if (Object.keys(found).length > 0 || from === null) return;
        save.mutate({
          type: "TRF",
          account_id: from,
          to_account_id: card.id,
          amount,
          ...(at ? { at } : {}),
          ...(releases !== null
            ? {
                release_card_debt: Object.entries(releaseValues)
                  .filter(
                    (e): e is [string, string] => e[1] !== null && compareAmounts(e[1], "0") > 0,
                  )
                  .map(([id, a]) => ({ account_id: id, amount: a })),
              }
            : {}),
        });
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("cards.bill.payIntro", { left: money(st.left), date: formatDate(st.due_date) })}
        </Text>
        <RuleInput
          card={card}
          rule={rule}
          onRule={(r) => {
            setRule(r);
            setReleases(null);
          }}
          other={other}
          onOther={(v) => {
            setOther(v);
            setReleases(null);
          }}
          minimumLeft={st.minimum_left}
          error={errors.other}
          otherLabel={t("cards.bill.payAmount")}
        />
        {rule !== "fixed" && (
          <Text size="sm">{t("cards.bill.paysNow", { amount: money(amount) })}</Text>
        )}
        <FromInput
          card={card}
          accounts={accounts}
          value={from}
          onChange={(v) => {
            setFrom(v);
            setReleases(null);
          }}
        />
        <DateTimeInput label={t("newTransaction.date")} value={at} onChange={setAt} />
        {payer && auto && (
          <PaymentReleases
            card={card}
            payer={payer}
            accounts={accounts}
            clears={auto.clears}
            values={releaseValues}
            onChange={(id, v) => {
              setReleases({ ...releaseValues, [id]: v });
            }}
            error={errors.releases}
          />
        )}
        {ask ? (
          <RecordConfirm
            ask={ask}
            pending={save.isPending}
            onConfirm={() => {
              const v = save.variables;
              if (!v) return;
              save.mutate({
                ...v,
                ...(ask === "over_credit_limit"
                  ? { limit_confirmed: true }
                  : { bsu_confirmed: true }),
              });
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
            {t("common.back")}
          </Button>
          <Button type="submit" loading={save.isPending && !ask}>
            {t("cards.bill.pay")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
