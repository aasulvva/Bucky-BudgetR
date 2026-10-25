import {
  ActionIcon,
  Alert,
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
import { ApiError, unwrap } from "@/api/errors";
import type { components } from "@/api/schema";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { CURRENCY } from "@/lib/locale";
import { compareAmounts, currencyOptions, formatMoney } from "@/lib/money";

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
                  />
                )}
              </ResponsiveModal>
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
          onDone={() => {
            setCreating(false);
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
                <Table.Td>{accountTypeLabel(a.type)}</Table.Td>
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

function checkName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return i18n.t("common.enterName");
  if (trimmed.length > 100) return i18n.t("common.maxChars", { count: 100 });
  return undefined;
}

function CreateAccount({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const currencies = useMemo(() => currencyOptions(), []);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("usage");
  const [currency, setCurrency] = useState(CURRENCY);
  const [opening, setOpening] = useState<string | null>(null);
  const [openingAt, setOpeningAt] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string }>({});

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/accounts", {
          body: {
            name: name.trim(),
            type,
            currency,
            ...(opening !== null && compareAmounts(opening, "0") !== 0
              ? {
                  opening_balance: opening,
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
      onDone();
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
          data-autofocus
        />
        <Select
          label={t("accountSetup.type")}
          data={accountTypeOptions()}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setType(v);
          }}
        />
        <Select
          label={t("accountSetup.currency")}
          description={t("accountSetup.currencyFixed")}
          data={currencies}
          value={currency}
          searchable
          allowDeselect={false}
          onChange={(v) => {
            if (v) setCurrency(v);
          }}
        />
        <AmountInput
          label={t("accountSetup.openingBalance")}
          description={t("accountSetup.openingHint")}
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
          <Button variant="default" onClick={onDone}>
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
}: {
  account: Account;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<AccountType>(account.type);
  const [errors, setErrors] = useState<{ name?: string }>({});

  const changes = {
    ...(name.trim() !== account.name ? { name: name.trim() } : {}),
    ...(type !== account.type ? { type } : {}),
  };
  const changed = Object.keys(changes).length > 0;

  const update = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/accounts/{accountId}", {
          params: { path: { accountId: account.id } },
          body: changes,
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (updated) => {
      notifications.show({
        color: "green",
        message: t("accountSetup.saved", { name: updated.name }),
      });
      onDone();
      await refresh();
    },
    onError: (err) => {
      setErrors({ name: nameProblem(err) });
    },
  });

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
        <Select
          label={t("accountSetup.type")}
          data={accountTypeOptions()}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setType(v);
          }}
        />
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

/**
 * Deletes an account, settling it in the same step (spec §2): money left in
 * it is transferred or adjusted to 0, and its buckets move to another
 * account. Only the questions that apply are asked.
 */
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
  const others = accounts
    .filter((a) => a.id !== account.id && a.currency === account.currency)
    .map((a) => ({ value: a.id, label: a.name }));
  const hasMoney = compareAmounts(account.balance, "0") !== 0;

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
        const blocked = own.length > 0 && others.length === 0;
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
          if (own.length > 0) {
            body.bucket_sources = Object.fromEntries(own.map((b) => [b.id, sources[b.id] ?? ""]));
          }
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
              {hasMoney && (
                <Radio.Group
                  label={t("accountSetup.stillHolds", {
                    amount: formatMoney(account.balance, account.currency),
                  })}
                  value={funds}
                  onChange={(v) => {
                    setFunds(v);
                  }}
                >
                  <Stack gap="xs" mt="xs">
                    <Radio
                      value="transfer"
                      label={t("accountSetup.transferIt")}
                      description={
                        others.length === 0
                          ? t("accountSetup.noOther", { currency: account.currency })
                          : undefined
                      }
                      disabled={others.length === 0}
                    />
                    {funds === "transfer" && others.length > 0 && (
                      <Select
                        label={t("accountSetup.transferTo")}
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
                      description={t("accountSetup.adjustToZeroHint")}
                    />
                  </Stack>
                </Radio.Group>
              )}
              {own.length > 0 && (
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    {t("accountSetup.bucketsFunded", { count: own.length })}
                  </Text>
                  {blocked ? (
                    <Alert color="orange">
                      {t("accountSetup.noOtherForBuckets", { currency: account.currency })}
                    </Alert>
                  ) : (
                    own.map((b) => (
                      <Select
                        key={b.id}
                        label={b.name}
                        data={others}
                        value={sources[b.id] ?? null}
                        onChange={(v) => {
                          setSources((s) => ({ ...s, [b.id]: v }));
                        }}
                        error={validate && !sources[b.id] ? t("common.chooseAccount") : undefined}
                      />
                    ))
                  )}
                </Stack>
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
