import {
  ActionIcon,
  Anchor,
  Autocomplete,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import {
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import {
  useCounterparties,
  useTags,
  type NewTransactionType,
  type TransactionCreate,
} from "@/api/transactions";
import { useSession } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { cycleRange, isOverdue } from "@/lib/cycles";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import {
  bucketTotals,
  fromLastTime,
  initialAccount,
  insideCycle,
  newLine,
  prefillFor,
  ruleMatches,
  waitingOnIncome,
  type SplitLine,
} from "@/lib/transactionForm";

/** The last account a transaction was saved on, in this browser. */
const LAST_ACCOUNT_KEY = "bucky.lastAccount";

function lastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function rememberAccount(id: string) {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, id);
  } catch {
    // Not remembered; the next form starts without it.
  }
}

const TYPES: NewTransactionType[] = ["EXP", "INC", "TRF"];

/**
 * Create transaction (spec §9, canvas "Create transaction"): an income,
 * expense or transfer, optionally split between the account's buckets. The
 * most-used screen, so it's built for quick entry on a phone.
 */
export default function NewTransaction() {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <Stack gap="lg">
      <Title order={2}>{t("nav.items.newTransaction")}</Title>
      <QueryState query={accounts}>
        {(accountList) =>
          accountList.length === 0 ? (
            <Text c="dimmed">
              <Trans
                i18nKey="accounts.empty"
                components={{ setup: <Anchor component={Link} to="/accounts/setup" /> }}
              />
            </Text>
          ) : (
            <QueryState query={buckets}>
              {(bucketList) => <TransactionForm accounts={accountList} buckets={bucketList} />}
            </QueryState>
          )
        }
      </QueryState>
    </Stack>
  );
}

interface Errors {
  amount?: string;
  account?: string;
  to?: string;
  at?: string;
  split?: string;
  /** Per row key. */
  lines?: Record<number, { bucket?: string; amount?: string }>;
}

function TransactionForm({ accounts, buckets }: { accounts: Account[]; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const navigate = useNavigate();
  const location = useLocation();
  const refresh = useRefreshMoney();
  const rules = useSession().data?.preferences.income_refill_rules ?? [];
  const active = useCurrentCycles().data?.active ?? null;
  const amountId = useId();

  const [type, setType] = useState<NewTransactionType>("EXP");
  const [amount, setAmount] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(() => initialAccount(accounts, lastAccount()));
  const [accountTouched, setAccountTouched] = useState(false);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [counterparty, setCounterparty] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [refill, setRefill] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency;
  const own = buckets.filter((b) => b.source_account_id === accountId);
  const transfer = type === "TRF";
  const others = accounts.filter((a) => a.id !== accountId && a.currency === currency);
  const totals = bucketTotals(amount, lines);
  const inCycle = insideCycle(at, active);
  const waiting = type === "INC" ? waitingOnIncome(buckets, accountId) : [];
  const refillShown = type === "INC" && inCycle && accountId !== null;
  const refillChecked = refill ?? (waiting.length > 0 || ruleMatches(rules, counterparty, amount));
  const money = (value: string) => formatMoney(value, currency);

  const accountOptions = (list: Account[]) =>
    list.map((a) => ({
      value: a.id,
      label: t("newTransaction.accountOption", {
        name: a.name,
        balance: formatMoney(a.balance, a.currency),
      }),
    }));

  const changeAccount = (id: string) => {
    setAccountId(id);
    setAccountTouched(true);
    setLines((ls) =>
      ls.filter(
        (l) =>
          l.bucketId === null ||
          buckets.some((b) => b.id === l.bucketId && b.source_account_id === id),
      ),
    );
    if (toAccountId === id) setToAccountId(null);
  };

  const reset = () => {
    setAmount(null);
    setCounterparty("");
    setTags([]);
    setLines([]);
    setRefill(null);
    setErrors({});
    document.getElementById(amountId)?.focus();
  };

  const save = useMutation({
    mutationFn: ({ body }: { body: TransactionCreate; addAnother: boolean }) =>
      unwrap(api.POST("/api/v1/transactions", { body })),
    meta: { silentError: true },
    onSuccess: async (_, { body, addAnother }) => {
      rememberAccount(body.account_id);
      notifications.show({ color: "green", message: t(`newTransaction.saved.${body.type}`) });
      await refresh();
      if (addAnother) reset();
      else if (location.key === "default") void navigate("/");
      else void navigate(-1);
    },
  });

  const validate = (): Errors => {
    const found: Errors = {};
    if (amount === null || compareAmounts(amount, "0") <= 0) {
      found.amount = t("newTransaction.enterAmount");
    }
    if (!accountId) found.account = t("common.chooseAccount");
    if (transfer && (!toAccountId || toAccountId === accountId)) {
      found.to = t("newTransaction.chooseOther");
    }
    if (!transfer && lines.length > 0) {
      const lineErrors: NonNullable<Errors["lines"]> = {};
      for (const l of lines) {
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
      if (totals.over) {
        found.split = t("newTransaction.overBy", {
          amount: money(subtractAmounts("0", totals.notTied)),
        });
      }
      if (active && !inCycle) {
        found.at = t("newTransaction.outsideCycle", { range: cycleRange(active) });
      }
    }
    return found;
  };

  const submit = (addAnother: boolean) => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0 || amount === null || accountId === null) return;
    const common = {
      account_id: accountId,
      amount,
      ...(at ? { at } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    const body: TransactionCreate = transfer
      ? { type, ...common, to_account_id: toAccountId ?? "" }
      : {
          type,
          ...common,
          ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
          ...(lines.length > 0
            ? {
                bucket_lines: lines.map((l) => ({
                  bucket_id: l.bucketId ?? "",
                  amount: l.amount ?? "",
                })),
              }
            : {}),
          ...(refillShown ? { triggers_refill: refillChecked } : {}),
        };
    save.mutate({ body, addAnother });
  };

  const fields = (
    <Stack gap="md" style={{ flex: "1 1 360px", minWidth: 0 }}>
      <Stack gap={4}>
        <AmountInput
          id={amountId}
          label={t("newTransaction.amount")}
          currency={currency}
          value={amount}
          onChange={setAmount}
          error={errors.amount}
          size={isDesktop ? "lg" : "xl"}
          styles={{ input: { fontWeight: 600 } }}
          autoFocus
        />
        <Text size="xs" c="dimmed">
          {t(`newTransaction.hints.${type}`)}
        </Text>
      </Stack>
      <DateTimeInput
        label={t("newTransaction.date")}
        description={t("common.emptyMeansNow")}
        value={at}
        onChange={setAt}
        error={errors.at}
        {...(!transfer && lines.length > 0 && active
          ? {
              minDate: new Date(active.start_at),
              // DateTimeInput stops at now; an overdue cycle ends earlier.
              ...(isOverdue(active)
                ? { maxDate: new Date(new Date(active.end_at).getTime() - 1) }
                : {}),
            }
          : {})}
      />
      <Select
        label={t(transfer ? "newTransaction.from" : "newTransaction.account")}
        data={accountOptions(accounts)}
        value={accountId}
        allowDeselect={false}
        onChange={(v) => {
          if (v) changeAccount(v);
        }}
        error={errors.account}
      />
      {transfer && (
        <Select
          label={t("newTransaction.to")}
          data={accountOptions(others)}
          value={toAccountId}
          onChange={setToAccountId}
          error={errors.to}
          description={
            accountId && others.length === 0 ? t("newTransaction.noOther", { currency }) : undefined
          }
          disabled={others.length === 0}
        />
      )}
      {!transfer && (
        <CounterpartyInput
          type={type === "INC" ? "INC" : "EXP"}
          value={counterparty}
          onChange={setCounterparty}
          onPick={(suggestion) => {
            const filled = fromLastTime(
              suggestion,
              { amount, accountId, accountTouched, tags, lines, bucketsAllowed: active !== null },
              accounts,
              buckets,
            );
            if (filled.accountId) setAccountId(filled.accountId);
            if (filled.tags) setTags(filled.tags);
            if (filled.lines) setLines(filled.lines);
          }}
        />
      )}
      {refillShown && (
        <Card withBorder padding="sm" bg="var(--mantine-color-blue-light)">
          <Checkbox
            label={t("newTransaction.triggersRefill")}
            description={
              waiting.length > 0
                ? t("newTransaction.refillsWaiting", {
                    names: waiting.map((b) => b.name).join(", "),
                  })
                : t("newTransaction.refillsNone")
            }
            checked={refillChecked}
            onChange={(e) => {
              setRefill(e.currentTarget.checked);
            }}
          />
        </Card>
      )}
      <TagInput value={tags} onChange={setTags} />
    </Stack>
  );

  return (
    <form
      noValidate
      aria-label={t("nav.items.newTransaction")}
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <Card withBorder padding={isDesktop ? "lg" : "md"} maw={960}>
        <Stack gap="lg">
          <SegmentedControl
            aria-label={t("newTransaction.type")}
            value={type}
            onChange={(v) => {
              const next = TYPES.find((x) => x === v);
              if (next) setType(next);
            }}
            fullWidth={!isDesktop}
            style={isDesktop ? { alignSelf: "flex-start" } : undefined}
            data={[
              ...TYPES.map((x) => ({ value: x, label: t(`newTransaction.types.${x}`) })),
              ...(isDesktop
                ? [{ value: "INP", label: t("newTransaction.types.INP"), disabled: true }]
                : []),
            ]}
          />
          <Group align="flex-start" gap="xl" wrap="wrap">
            {fields}
            {!transfer && (
              <BucketSplit
                account={account}
                own={own}
                active={active}
                amount={amount}
                lines={lines}
                onChange={setLines}
                errors={errors}
              />
            )}
          </Group>
          {save.error && <ErrorAlert error={save.error} />}
          {isDesktop ? (
            <Group
              justify="flex-end"
              gap="xs"
              pt="sm"
              style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
            >
              <Button
                variant="default"
                onClick={() => {
                  if (location.key === "default") void navigate("/");
                  else void navigate(-1);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="outline"
                loading={save.isPending && save.variables.addAnother}
                onClick={() => {
                  submit(true);
                }}
              >
                {t("newTransaction.saveAnother")}
              </Button>
              <Button type="submit" loading={save.isPending && !save.variables.addAnother}>
                {t("newTransaction.save")}
              </Button>
            </Group>
          ) : (
            <Stack
              gap="xs"
              pos="sticky"
              py="sm"
              mx="-md"
              px="md"
              bg="var(--mantine-color-body)"
              style={{
                bottom: "var(--app-shell-footer-offset, 0px)",
                borderTop: "1px solid var(--mantine-color-default-border)",
                zIndex: 1,
              }}
            >
              <Button
                variant="subtle"
                loading={save.isPending && save.variables.addAnother}
                onClick={() => {
                  submit(true);
                }}
              >
                {t("newTransaction.saveAnother")}
              </Button>
              <Button
                type="submit"
                size="lg"
                fullWidth
                loading={save.isPending && !save.variables.addAnother}
              >
                {t("newTransaction.save")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>
    </form>
  );
}

function CounterpartyInput({
  type,
  value,
  onChange,
  onPick,
}: {
  type: "INC" | "EXP";
  value: string;
  onChange: (value: string) => void;
  onPick: (suggestion: NonNullable<ReturnType<typeof useCounterparties>["data"]>[number]) => void;
}) {
  const { t } = useTranslation();
  const suggestions = useCounterparties(type, value);
  const list = suggestions.data ?? [];
  return (
    <Autocomplete
      label={t(`newTransaction.counterparty.${type}`)}
      placeholder={t("newTransaction.counterpartyPlaceholder")}
      value={value}
      maxLength={200}
      onChange={onChange}
      data={list.map((s) => s.counterparty)}
      // The server already filtered by what's typed.
      filter={({ options }) => options}
      onOptionSubmit={(picked) => {
        const s = list.find((x) => x.counterparty === picked);
        if (s) onPick(s);
      }}
    />
  );
}

function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation();
  const tags = useTags();
  return (
    <TagsInput
      label={t("newTransaction.tags")}
      placeholder={t("newTransaction.tagsPlaceholder")}
      data={tags.data?.map((x) => x.name) ?? []}
      value={value}
      onChange={(next) => {
        onChange(next.map((x) => x.trim()).filter((x) => x !== "" && x.length <= 50));
      }}
      maxTags={20}
      clearable
    />
  );
}

/** The split between the account's buckets; the rest isn't tied to a bucket. */
function BucketSplit({
  account,
  own,
  active,
  amount,
  lines,
  onChange,
  errors,
}: {
  account: Account | undefined;
  own: Bucket[];
  active: Cycle | null;
  amount: string | null;
  lines: SplitLine[];
  onChange: (lines: SplitLine[]) => void;
  errors: Errors;
}) {
  const { t } = useTranslation();
  const money = (value: string) => formatMoney(value, account?.currency);
  const totals = bucketTotals(amount, lines);
  const free = own.filter((b) => !lines.some((l) => l.bucketId === b.id));

  let body;
  if (!account) {
    body = (
      <Text size="sm" c="dimmed">
        {t("newTransaction.chooseAccountFirst")}
      </Text>
    );
  } else if (!active) {
    body = (
      <Text size="sm" c="dimmed">
        <Trans
          i18nKey="newTransaction.needsCycle"
          components={{ cycles: <Anchor component={Link} to="/cycles" /> }}
        />
      </Text>
    );
  } else if (own.length === 0) {
    body = (
      <Text size="sm" c="dimmed">
        {t("newTransaction.noAccountBuckets")}
      </Text>
    );
  } else {
    body = (
      <Stack gap="sm">
        {lines.map((l) => {
          const bucket = own.find((b) => b.id === l.bucketId);
          const lineErrors = errors.lines?.[l.key];
          const options = own
            .filter((b) => b.id === l.bucketId || !lines.some((o) => o.bucketId === b.id))
            .map((b) => ({
              value: b.id,
              label: t("newTransaction.bucketOption", {
                name: b.name,
                amount: money(b.current_available_funds),
              }),
            }));
          const update = (change: Partial<SplitLine>) => {
            onChange(lines.map((o) => (o.key === l.key ? { ...o, ...change } : o)));
          };
          return (
            <Group key={l.key} gap="xs" align="flex-start" wrap="nowrap">
              <Select
                aria-label={t("newTransaction.bucket")}
                placeholder={t("newTransaction.bucket")}
                data={options}
                value={l.bucketId}
                allowDeselect={false}
                onChange={(v) => {
                  update({ bucketId: v });
                }}
                error={lineErrors?.bucket}
                style={{ flex: 1, minWidth: 0 }}
              />
              <AmountInput
                aria-label={
                  bucket
                    ? t("newTransaction.amountFor", { name: bucket.name })
                    : t("newTransaction.amountForBucket")
                }
                currency={account.currency}
                value={l.amount}
                onChange={(v) => {
                  update({ amount: v });
                }}
                error={lineErrors?.amount}
                w={130}
              />
              <ActionIcon
                variant="default"
                size={36}
                aria-label={
                  bucket
                    ? t("newTransaction.removeBucket", { name: bucket.name })
                    : t("newTransaction.removeRow")
                }
                onClick={() => {
                  onChange(lines.filter((o) => o.key !== l.key));
                }}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          );
        })}
        <Button
          variant="subtle"
          leftSection={<IconPlus size={16} />}
          style={{ alignSelf: "flex-start" }}
          disabled={free.length === 0}
          onClick={() => {
            // With one bucket left to pick, pick it.
            const only = free.length === 1 ? (free[0]?.id ?? null) : null;
            onChange([...lines, newLine(only, prefillFor(amount, lines))]);
          }}
        >
          {t("newTransaction.addBucket")}
        </Button>
        <Box p="sm" bg="var(--mantine-color-default-hover)" style={{ borderRadius: 8 }}>
          <Group justify="space-between">
            <Text size="sm">{t("newTransaction.inBuckets")}</Text>
            <Text size="sm">{money(totals.inBuckets)}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {t("newTransaction.notTied")}
            </Text>
            <Text size="sm" c={totals.over ? "var(--mantine-color-red-text)" : "dimmed"}>
              {money(totals.notTied)}
            </Text>
          </Group>
        </Box>
        {errors.split && (
          <Text size="sm" c="var(--mantine-color-red-text)" role="alert">
            {errors.split}
          </Text>
        )}
      </Stack>
    );
  }

  return (
    <Stack
      gap="sm"
      style={{ flex: "1 1 360px", minWidth: 0 }}
      component="section"
      aria-label={t("newTransaction.buckets")}
    >
      <Group justify="space-between" align="baseline">
        <Title order={3} size="h5">
          {t("newTransaction.buckets")}
        </Title>
        {account && (
          <Text size="sm" c="dimmed">
            {t("newTransaction.fundedFrom", { name: account.name })}
          </Text>
        )}
      </Group>
      {body}
    </Stack>
  );
}
