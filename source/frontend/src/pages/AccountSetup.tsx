import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Card,
  Group,
  Radio,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPencil, IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import {
  accountTypeLabel,
  accountTypeOptions,
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type AccountType,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { ApiError, unwrap } from "@/api/errors";
import { useSavingsBudget, useSavingsTargets } from "@/api/savings";
import type { components } from "@/api/schema";
import { BsuSetupDialog } from "@/components/accounts/BsuSetup";
import { BsuLocked } from "@/components/accounts/BsuStatus";
import { CardFieldsInput } from "@/components/accounts/CardStatus";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ReleaseNote } from "@/components/savings/ReleaseNote";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { BSU_CURRENCY, isLockedBsu } from "@/lib/bsu";
import { canDelete } from "@/lib/buckets";
import {
  DEFAULT_ACCOUNT_TYPES,
  EMPTY_CARD,
  cardChanged,
  cardDraft,
  cardFields,
  cardProblems,
  cardsDefaultingTo,
  defaultAccountChoices,
  isCard,
  negate,
  withoutCards,
  type CardDraft,
} from "@/lib/cards";
import { isOverdue } from "@/lib/cycles";
import { CURRENCY } from "@/lib/locale";
import { INTEREST_TAG } from "@/lib/interest";
import { LANGUAGES } from "@/lib/language";
import { checkName } from "@/lib/names";
import { TARGET_ACCOUNT_TYPES, budgetDestination } from "@/lib/savings";
import { compareAmounts, currencyOptions, formatMoney, subtractAmounts } from "@/lib/money";
import { autofocusField } from "@/lib/device";

type AccountDelete = components["schemas"]["AccountDelete"];

/**
 * Account setup (spec §9): the accounts in a list; create, edit and delete
 * them in dialogs. `?edit=<id>` opens an account, as the cog on the Accounts
 * screen does.
 */
export default function AccountSetup() {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const editId = params.get("edit");
  // A locked BSU's history setup (#214), right after creating one too.
  const bsuId = params.get("bsu");
  const openBsu = (id: string | null) => {
    setParams(
      (p) => {
        if (id === null) p.delete("bsu");
        else {
          p.set("bsu", id);
          p.delete("edit");
        }
        return p;
      },
      { replace: id === null },
    );
  };

  const openEdit = (id: string | null) => {
    setParams(
      (p) => {
        if (id === null) p.delete("edit");
        else p.set("edit", id);
        return p;
      },
      { replace: id === null },
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.accountSetup")}</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("accountSetup.newAccount")}
        </Button>
      </Group>
      <QueryState query={accounts}>
        {(list) => {
          const editing = editId ? list.find((a) => a.id === editId) : undefined;
          const settingUp = bsuId ? list.find((a) => a.id === bsuId && isLockedBsu(a)) : undefined;
          return (
            <>
              {list.length === 0 ? (
                <Text c="dimmed">{t("accountSetup.empty")}</Text>
              ) : (
                <AccountTable accounts={list} onEdit={openEdit} />
              )}
              <ResponsiveModal
                opened={editing !== undefined}
                title={t("accountSetup.editAccount")}
                onClose={() => {
                  openEdit(null);
                }}
              >
                {editing && (
                  <EditAccount
                    key={editing.id}
                    account={editing}
                    accounts={list}
                    onDone={() => {
                      openEdit(null);
                    }}
                    onSetUpBsu={() => {
                      openBsu(editing.id);
                    }}
                  />
                )}
              </ResponsiveModal>
              <BsuSetupDialog
                account={settingUp}
                onClose={() => {
                  openBsu(null);
                }}
              />
            </>
          );
        }}
      </QueryState>
      <ResponsiveModal
        opened={creating}
        title={t("accountSetup.newAccount")}
        onClose={() => {
          setCreating(false);
        }}
      >
        <CreateAccount
          accounts={accounts.data ?? []}
          onDone={(created) => {
            setCreating(false);
            if (created?.type === "bsu") openBsu(created.id);
          }}
        />
      </ResponsiveModal>
    </Stack>
  );
}

function AccountTable({ accounts, onEdit }: { accounts: Account[]; onEdit: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={480}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("accountSetup.name")}</Table.Th>
              <Table.Th>{t("accountSetup.bank")}</Table.Th>
              <Table.Th>{t("accountSetup.type")}</Table.Th>
              <Table.Th>{t("accountSetup.currency")}</Table.Th>
              <Table.Th ta="right">{t("accountSetup.balance")}</Table.Th>
              <Table.Th w={56}>
                <span className="mantine-visually-hidden">{t("accountSetup.edit")}</span>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>
                  <Text span fw={600}>
                    {a.name}
                  </Text>{" "}
                  <Text span c="dimmed">
                    (#{a.id})
                  </Text>
                </Table.Td>
                <Table.Td c={a.bank ? undefined : "dimmed"}>{a.bank || "—"}</Table.Td>
                <Table.Td>
                  {accountTypeLabel(a.type)}
                  {isLockedBsu(a) && (
                    <Text size="xs" c="var(--mantine-color-orange-text)">
                      {t("bsu.locked.title")}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{a.currency}</Table.Td>
                <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
                  {formatMoney(a.balance, a.currency)}
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={36}
                    aria-label={t("accountSetup.editName", { name: a.name })}
                    onClick={() => {
                      onEdit(a.id);
                    }}
                  >
                    <IconPencil size={18} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

/** A problem that belongs on the name field, or undefined. */
function nameProblem(error: unknown): string | undefined {
  if (error instanceof ApiError && error.code === "name_taken") {
    return i18n.t("accountSetup.nameTaken");
  }
  return undefined;
}

/** The banks of the user's other accounts, to suggest (#70). */
function bankOptions(accounts: Account[], current = ""): string[] {
  const banks = new Set(accounts.map((a) => a.bank).filter((b) => b !== "" && b !== current));
  return [...banks].sort((a, b) => a.localeCompare(b));
}

function BankInput({
  value,
  onChange,
  accounts,
  current,
}: {
  value: string;
  onChange: (value: string) => void;
  accounts: Account[];
  current?: string;
}) {
  const { t } = useTranslation();
  return (
    <Autocomplete
      label={t("accountSetup.bank")}
      description={t("accountSetup.bankHint")}
      placeholder={t("accountSetup.bankPlaceholder")}
      data={bankOptions(accounts, current)}
      value={value}
      maxLength={100}
      onChange={onChange}
      // Rendered in place: the dialog is a drawer on phones.
      comboboxProps={{ withinPortal: false }}
    />
  );
}

function CreateAccount({
  accounts,
  onDone,
}: {
  accounts: Account[];
  /** Called with the new account, or nothing when cancelled. */
  onDone: (created?: Account) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const currencies = useMemo(() => currencyOptions(), []);
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [type, setType] = useState<AccountType>("usage");
  const [chosenCurrency, setCurrency] = useState(CURRENCY);
  // A BSU is always in NOK (#214).
  const bsu = type === "bsu";
  const currency = bsu ? BSU_CURRENCY : chosenCurrency;
  const [opening, setOpening] = useState<string | null>(null);
  const [openingAt, setOpeningAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string }>({});
  // A credit card's fields (#260); what's owed today is the opening balance,
  // negated.
  const card = type === "credit_card";
  const [cardValue, setCard] = useState<CardDraft>(EMPTY_CARD);
  const [tried, setTried] = useState(false);
  // The default account starts as the one usage account in the currency.
  const preselect = (cur: string): CardDraft => {
    const usage = defaultAccountChoices(accounts, cur).filter((a) => a.type === "usage");
    const keep = defaultAccountChoices(accounts, cur).some(
      (a) => a.id === cardValue.defaultAccount,
    );
    return {
      ...cardValue,
      defaultAccount: keep
        ? cardValue.defaultAccount
        : usage.length === 1
          ? (usage[0]?.id ?? null)
          : null,
    };
  };
  const balance = opening !== null && card ? negate(opening) : opening;

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/accounts", {
          body: {
            name: name.trim(),
            ...(bank.trim() ? { bank: bank.trim() } : {}),
            type,
            currency,
            ...(card ? { credit_card: cardFields(cardValue) } : {}),
            ...(balance !== null && compareAmounts(balance, "0") !== 0
              ? {
                  opening_balance: balance,
                  ...(openingAt ? { opening_at: openingAt } : {}),
                }
              : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (account) => {
      notifications.show({
        color: "green",
        message: t("accountSetup.created", { name: account.name }),
      });
      onDone(account);
      await refresh();
    },
    onError: (err) => {
      setErrors({ name: nameProblem(err) });
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = { name: checkName(name) };
        setErrors(found);
        setTried(true);
        if (card && Object.keys(cardProblems(cardValue)).length > 0) return;
        if (!found.name) create.mutate();
      }}
    >
      <Stack gap="md">
        <TextInput
          label={t("accountSetup.name")}
          placeholder={t("accountSetup.namePlaceholder")}
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          error={errors.name}
          required
          {...autofocusField()}
        />
        <BankInput value={bank} onChange={setBank} accounts={accounts} />
        <Select
          label={t("accountSetup.type")}
          data={accountTypeOptions()}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            if (!v) return;
            setType(v);
            if (v === "credit_card") setCard(preselect(currency));
          }}
        />
        {bsu && <Text size="sm">{t("bsu.createHint")}</Text>}
        {card && <Text size="sm">{t("cards.createHint")}</Text>}
        <Select
          label={t("accountSetup.currency")}
          description={t(bsu ? "bsu.currencyFixed" : "accountSetup.currencyFixed")}
          data={currencies}
          value={currency}
          searchable
          allowDeselect={false}
          disabled={bsu}
          onChange={(v) => {
            if (!v) return;
            setCurrency(v);
            if (card) setCard(preselect(v));
          }}
        />
        {card && (
          <CardFieldsInput
            value={cardValue}
            onChange={setCard}
            accounts={accounts}
            currency={currency}
            tried={tried}
          />
        )}
        <AmountInput
          label={t(card ? "cards.owedToday" : "accountSetup.openingBalance")}
          description={t(card ? "cards.owedHint" : "accountSetup.openingHint")}
          currency={currency}
          value={opening}
          onChange={setOpening}
        />
        {opening !== null && compareAmounts(opening, "0") !== 0 && (
          <DateTimeInput
            label={t("accountSetup.openingAt")}
            description={t("common.emptyMeansNow")}
            value={openingAt}
            onChange={setOpeningAt}
          />
        )}
        {create.error && !nameProblem(create.error) && <ErrorAlert error={create.error} />}
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            onClick={() => {
              onDone();
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("accountSetup.create")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function EditAccount({
  account,
  accounts,
  onDone,
  onSetUpBsu,
}: {
  account: Account;
  accounts: Account[];
  onDone: () => void;
  onSetUpBsu: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(account.name);
  const [bank, setBank] = useState(account.bank);
  const [type, setType] = useState<AccountType>(account.type);
  const [errors, setErrors] = useState<{ name?: string }>({});
  // A credit card's fields (#260).
  const [cardValue, setCard] = useState<CardDraft | null>(
    account.credit_card ? cardDraft(account.credit_card) : null,
  );
  const [tried, setTried] = useState(false);
  // Cards whose default account this is lose it if it can't be one any more.
  const defaultOf = cardsDefaultingTo(accounts, account.id);
  const [offer, setOffer] = useState<{ updated: Account; count: number; body: RenameBody } | null>(
    null,
  );

  const changes = {
    ...(name.trim() !== account.name ? { name: name.trim() } : {}),
    ...(bank.trim() !== account.bank ? { bank: bank.trim() } : {}),
    ...(type !== account.type ? { type } : {}),
    ...(cardValue && account.credit_card && cardChanged(cardValue, account.credit_card)
      ? { credit_card: cardFields(cardValue) }
      : {}),
  };
  const changed = Object.keys(changes).length > 0;

  const update = useMutation({
    mutationFn: async () => {
      const updated = await unwrap(
        api.PATCH("/api/v1/accounts/{accountId}", {
          params: { path: { accountId: account.id } },
          body: changes,
        }),
      );
      // A new bank: count the earlier interest that could take its name.
      if (updated.bank === "" || updated.bank === account.bank) return { updated, count: 0 };
      const body = renameInterestBody(account, updated.bank);
      try {
        const { count } = await unwrap(
          api.POST("/api/v1/transactions/counterparty-rename", { body }),
        );
        return { updated, count, body };
      } catch {
        // The account is saved; the offer is only a convenience.
        return { updated, count: 0 };
      }
    },
    meta: { silentError: true },
    onSuccess: async ({ updated, count, body }) => {
      notifications.show({
        color: "green",
        message: t("accountSetup.saved", { name: updated.name }),
      });
      if (count > 0 && body) setOffer({ updated, count, body });
      else onDone();
      await refresh();
    },
    onError: (err) => {
      setErrors({ name: nameProblem(err) });
    },
  });

  if (offer) {
    return (
      <RenameInterest
        account={offer.updated}
        count={offer.count}
        body={offer.body}
        onDone={onDone}
      />
    );
  }

  if (deleting) {
    return (
      <DeleteAccount
        account={account}
        accounts={accounts}
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
      onSubmit={(e) => {
        e.preventDefault();
        const found = { name: checkName(name) };
        setErrors(found);
        setTried(true);
        if (cardValue && Object.keys(cardProblems(cardValue)).length > 0) return;
        if (!found.name) update.mutate();
      }}
    >
      <Stack gap="md">
        <TextInput
          label={t("accountSetup.name")}
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          error={errors.name}
          required
        />
        <BankInput value={bank} onChange={setBank} accounts={accounts} current={account.bank} />
        <BsuLocked account={account} onSetUp={onSetUpBsu} />
        <Select
          label={t("accountSetup.type")}
          // Only a NOK account can be a BSU (#214), and no account changes
          // to or from a credit card (#260).
          data={accountTypeOptions().map((o) =>
            (o.value === "bsu" && account.currency !== BSU_CURRENCY && account.type !== "bsu") ||
            (o.value === "credit_card" && !isCard(account))
              ? { ...o, disabled: true }
              : o,
          )}
          description={
            isCard(account)
              ? t("cards.typeFixed")
              : account.currency !== BSU_CURRENCY && account.type !== "bsu"
                ? t("bsu.onlyNok")
                : undefined
          }
          disabled={isCard(account)}
          value={type}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            if (v) setType(v);
          }}
        />
        {type !== account.type && (type === "bsu" || account.type === "bsu") && (
          <Text size="sm" c="var(--mantine-color-orange-text)">
            {t(type === "bsu" ? "bsu.becomesBsu" : "bsu.leavesBsu")}
          </Text>
        )}
        {type !== account.type && !TARGET_ACCOUNT_TYPES.includes(type) && (
          <ReleaseNote account={account} />
        )}
        {type !== account.type && !DEFAULT_ACCOUNT_TYPES.includes(type) && defaultOf.length > 0 && (
          <Text size="sm" c="var(--mantine-color-orange-text)">
            {t("cards.stopsDefault", { names: defaultOf.map((a) => a.name).join(", ") })}
          </Text>
        )}
        {cardValue && (
          <CardFieldsInput
            value={cardValue}
            onChange={setCard}
            accounts={accounts.filter((a) => a.id !== account.id)}
            currency={account.currency}
            tried={tried}
          />
        )}
        <TextInput
          label={t("accountSetup.currency")}
          description={t("accountSetup.currencySet")}
          value={account.currency}
          readOnly
          variant="filled"
        />
        {update.error && !nameProblem(update.error) && <ErrorAlert error={update.error} />}
        <Group justify="space-between" gap="xs">
          <Button
            variant="subtle"
            color="red"
            onClick={() => {
              setDeleting(true);
            }}
          >
            {t("accountSetup.deleteMore")}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={onDone}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={update.isPending} disabled={!changed}>
              {t("common.save")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
}

type RenameBody = components["schemas"]["CounterpartyRename"];

/**
 * Renames an account's earlier interest to its new bank (#70): incomes
 * tagged interest whose counterparty is the default word, in any of the
 * app's languages, or the old bank.
 */
function renameInterestBody(account: Account, bank: string): RenameBody {
  const words = LANGUAGES.map(({ value }) =>
    i18n.t("accounts.interestCounterparty", { lng: value }),
  );
  if (account.bank) words.push(account.bank);
  return {
    account_id: account.id,
    type: "INC",
    tag: INTEREST_TAG,
    from: [...new Set(words)],
    to: bank,
    apply: false,
  };
}

/** Offers to rename the earlier interest after the bank was set or changed. */
function RenameInterest({
  account,
  count,
  body,
  onDone,
}: {
  account: Account;
  count: number;
  body: RenameBody;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const rename = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/transactions/counterparty-rename", { body: { ...body, apply: true } }),
      ),
    meta: { silentError: true },
    onSuccess: async ({ count: done }) => {
      notifications.show({
        color: "green",
        message: t("accountSetup.renameInterest.done", { count: done, bank: account.bank }),
      });
      onDone();
      await refresh();
    },
  });
  return (
    <Stack gap="md">
      <Text fw={600}>{t("accountSetup.renameInterest.title")}</Text>
      <Text>
        {t("accountSetup.renameInterest.body", {
          count,
          account: account.name,
          bank: account.bank,
        })}
      </Text>
      {rename.error && <ErrorAlert error={rename.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("accountSetup.renameInterest.leave")}
        </Button>
        <Button
          loading={rename.isPending}
          onClick={() => {
            rename.mutate();
          }}
        >
          {t("accountSetup.renameInterest.update", { count })}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * Deletes an account, settling it in the same step (spec §2): money left in
 * it is transferred or adjusted to 0, and its buckets move to another
 * account. Only the questions that apply are asked.
 */
/** The bucket-select value that deletes the bucket with its account (#137). */
const DELETE_BUCKET = "__delete";

/**
 * Why a bucket can't be deleted yet, or, once Delete is chosen, what that
 * does with what's left in it.
 */
function bucketFate(bucket: Bucket, deletable: boolean, chosen: boolean): string | undefined {
  if (!deletable) return i18n.t("bucketSetup.deleteNeedsCycle");
  if (!chosen) return undefined;
  const tf = compareAmounts(bucket.target_funds, "0");
  if (tf === 0) return i18n.t("accountSetup.bucketEmpty");
  const amount = formatMoney(
    tf < 0 ? subtractAmounts("0", bucket.target_funds) : bucket.target_funds,
    bucket.currency,
  );
  return i18n.t(tf > 0 ? "accountSetup.bucketLeft" : "accountSetup.bucketOwes", { amount });
}

function DeleteAccount({
  account,
  accounts,
  onCancel,
  onDone,
}: {
  account: Account;
  accounts: Account[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const buckets = useBuckets();
  // The savings budget's fixed amounts (#234) and sweeps (#235) from it go
  // with it.
  const entries = (useSavingsBudget().data ?? []).filter((e) => e.account_id === account.id);
  const targets = useSavingsTargets().data ?? [];
  const others = accounts
    .filter((a) => a.id !== account.id && a.currency === account.currency)
    .map((a) => ({ value: a.id, label: a.name }));
  // Buckets can't move to a credit card (#260).
  const bucketHomes = withoutCards(accounts)
    .filter((a) => a.id !== account.id && a.currency === account.currency)
    .map((a) => ({ value: a.id, label: a.name }));
  const card = isCard(account);
  const defaultOf = cardsDefaultingTo(accounts, account.id);
  const hasMoney = compareAmounts(account.balance, "0") !== 0;
  // A card that owes is paid off from the other account (#260).
  const owes = isCard(account) && compareAmounts(account.balance, "0") < 0;
  const active = useCurrentCycles().data?.active ?? null;
  // Deleting a bucket with funds left releases them, which needs this (#137).
  const usable = active !== null && !isOverdue(active);

  const [funds, setFunds] = useState<"transfer" | "adjust">(
    others.length > 0 ? "transfer" : "adjust",
  );
  const [fundsTo, setFundsTo] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string | null>>({});
  const [validate, setValidate] = useState(false);

  const remove = useMutation({
    mutationFn: (body: AccountDelete | undefined) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/delete", {
          params: { path: { accountId: account.id } },
          ...(body ? { body } : {}),
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("accountSetup.deleted", { name: account.name }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <QueryState query={buckets}>
      {(all) => {
        const own: Bucket[] = all.filter((b) => b.source_account_id === account.id);
        const deletable = (b: Bucket) => canDelete(b, usable);
        // A bucket that can neither move nor go yet.
        const blocked = own.some((b) => bucketHomes.length === 0 && !deletable(b));
        const deleted = own.filter((b) => sources[b.id] === DELETE_BUCKET);
        const submit = () => {
          setValidate(true);
          if (blocked) return;
          if (hasMoney && funds === "transfer" && !fundsTo) return;
          if (own.some((b) => !sources[b.id])) return;
          const body: AccountDelete = {};
          if (hasMoney) {
            body.remaining_funds =
              funds === "transfer" && fundsTo
                ? { action: "transfer", to_account_id: fundsTo }
                : { action: "adjust" };
          }
          const moved = own.filter((b) => sources[b.id] !== DELETE_BUCKET);
          if (moved.length > 0) {
            body.bucket_sources = Object.fromEntries(moved.map((b) => [b.id, sources[b.id] ?? ""]));
          }
          if (deleted.length > 0) body.delete_buckets = deleted.map((b) => b.id);
          remove.mutate(Object.keys(body).length > 0 ? body : undefined);
        };

        return (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Stack gap="md">
              <Text>
                <Trans
                  i18nKey="accountSetup.deleteQuestion"
                  values={{ name: account.name }}
                  components={{ b: <strong /> }}
                />
              </Text>
              <ReleaseNote account={account} reservedToo />
              {defaultOf.length > 0 && (
                <Text size="sm">
                  {t("cards.stopsDefault", { names: defaultOf.map((a) => a.name).join(", ") })}
                </Text>
              )}
              {hasMoney && (
                <Radio.Group
                  label={
                    card && compareAmounts(account.balance, "0") < 0
                      ? t("cards.owes", {
                          amount: formatMoney(negate(account.balance), account.currency),
                        })
                      : t("accountSetup.stillHolds", {
                          amount: formatMoney(account.balance, account.currency),
                        })
                  }
                  value={funds}
                  onChange={(v) => {
                    setFunds(v);
                  }}
                >
                  <Stack gap="xs" mt="xs">
                    <Radio
                      value="transfer"
                      label={t(owes ? "cards.payOff" : "accountSetup.transferIt")}
                      description={
                        others.length === 0
                          ? t("accountSetup.noOther", { currency: account.currency })
                          : undefined
                      }
                      disabled={others.length === 0}
                    />
                    {funds === "transfer" && others.length > 0 && (
                      <Select
                        label={t(owes ? "cards.payFrom" : "accountSetup.transferTo")}
                        data={others}
                        value={fundsTo}
                        onChange={setFundsTo}
                        error={validate && !fundsTo ? t("common.chooseAccount") : undefined}
                        ml="xl"
                      />
                    )}
                    <Radio
                      value="adjust"
                      label={t("accountSetup.adjustToZero")}
                      description={t(
                        owes ? "cards.adjustToZeroHint" : "accountSetup.adjustToZeroHint",
                      )}
                    />
                  </Stack>
                </Radio.Group>
              )}
              {own.length > 0 && (
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    {t("accountSetup.bucketsFunded", { count: own.length })}
                  </Text>
                  {blocked && (
                    <Alert color="orange">
                      {t("accountSetup.noOtherForBuckets", { currency: account.currency })}
                    </Alert>
                  )}
                  {own.length > 1 && (
                    <Group gap="xs" align="flex-end">
                      <Button
                        variant="default"
                        size="xs"
                        disabled={!own.some(deletable)}
                        onClick={() => {
                          setSources((s) => ({
                            ...s,
                            ...Object.fromEntries(
                              own.filter(deletable).map((b) => [b.id, DELETE_BUCKET]),
                            ),
                          }));
                        }}
                      >
                        {t("accountSetup.deleteAll")}
                      </Button>
                      {bucketHomes.length > 0 && (
                        <Select
                          size="xs"
                          aria-label={t("accountSetup.moveAllTo")}
                          placeholder={t("accountSetup.moveAllTo")}
                          data={bucketHomes}
                          value={null}
                          onChange={(v) => {
                            if (v) setSources(Object.fromEntries(own.map((b) => [b.id, v])));
                          }}
                        />
                      )}
                    </Group>
                  )}
                  {own.map((b) => (
                    <Select
                      key={b.id}
                      label={b.name}
                      description={bucketFate(b, deletable(b), sources[b.id] === DELETE_BUCKET)}
                      data={[
                        {
                          value: DELETE_BUCKET,
                          label: t("accountSetup.deleteTheBucket"),
                          disabled: !deletable(b),
                        },
                        ...bucketHomes,
                      ]}
                      value={sources[b.id] ?? null}
                      onChange={(v) => {
                        setSources((s) => ({ ...s, [b.id]: v }));
                      }}
                      error={validate && !sources[b.id] ? t("accountSetup.chooseFate") : undefined}
                    />
                  ))}
                  {deleted.length > 0 && (
                    <Text size="sm">
                      {t("accountSetup.deletesBuckets", {
                        count: deleted.length,
                        names: deleted.map((b) => b.name).join(", "),
                      })}
                    </Text>
                  )}
                </Stack>
              )}
              {entries.length > 0 && (
                <Text size="sm">
                  {t("accountSetup.deletesBudget", {
                    count: entries.length,
                    names: entries
                      .map((e) =>
                        e.amount === null
                          ? t(
                              e.when === "cycle_end"
                                ? "accountSetup.budgetSweep.cycle_end"
                                : "accountSetup.budgetSweep.after_refills",
                              { name: budgetDestination(e, targets) },
                            )
                          : t("accountSetup.budgetEntry", {
                              amount: formatMoney(e.amount, account.currency),
                              name: budgetDestination(e, targets),
                            }),
                      )
                      .join(", "),
                  })}
                </Text>
              )}
              {remove.error && <ErrorAlert error={remove.error} />}
              <Group justify="flex-end" gap="xs">
                <Button variant="default" onClick={onCancel}>
                  {t("common.back")}
                </Button>
                <Button type="submit" color="red" loading={remove.isPending} disabled={blocked}>
                  {t("accountSetup.deleteAccount")}
                </Button>
              </Group>
            </Stack>
          </form>
        );
      }}
    </QueryState>
  );
}
