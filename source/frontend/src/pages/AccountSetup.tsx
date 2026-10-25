import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Modal,
  Radio,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPencil, IconPlus } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import {
  ACCOUNT_TYPES,
  accountTypeLabel,
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
import { CURRENCY } from "@/lib/locale";
import { compareAmounts, currencyOptions, formatMoney } from "@/lib/money";

type AccountDelete = components["schemas"]["AccountDelete"];

/**
 * Account setup (spec §9): the accounts in a list; create, edit and delete
 * them in dialogs. `?edit=<id>` opens an account, as the cog on the Accounts
 * screen does.
 */
export default function AccountSetup() {
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
        <Title order={2}>Account setup</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            setCreating(true);
          }}
        >
          New account
        </Button>
      </Group>
      <QueryState query={accounts}>
        {(list) => {
          const editing = editId ? list.find((a) => a.id === editId) : undefined;
          return (
            <>
              {list.length === 0 ? (
                <Text c="dimmed">No accounts yet. Create your first one.</Text>
              ) : (
                <AccountTable accounts={list} onEdit={openEdit} />
              )}
              <AccountDialog
                opened={editing !== undefined}
                title="Edit account"
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
              </AccountDialog>
            </>
          );
        }}
      </QueryState>
      <AccountDialog
        opened={creating}
        title="New account"
        onClose={() => {
          setCreating(false);
        }}
      >
        <CreateAccount
          onDone={() => {
            setCreating(false);
          }}
        />
      </AccountDialog>
    </Stack>
  );
}

function AccountDialog({
  opened,
  title,
  onClose,
  children,
}: {
  opened: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  return (
    <Modal opened={opened} onClose={onClose} title={title} fullScreen={!isDesktop} size="md">
      {children}
    </Modal>
  );
}

function AccountTable({ accounts, onEdit }: { accounts: Account[]; onEdit: (id: string) => void }) {
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={480}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Currency</Table.Th>
              <Table.Th ta="right">Balance</Table.Th>
              <Table.Th w={56}>
                <span className="mantine-visually-hidden">Edit</span>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td fw={600}>{a.name}</Table.Td>
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
                    aria-label={`Edit ${a.name}`}
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
    return "You already have an account with this name.";
  }
  return undefined;
}

function checkName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name.";
  if (trimmed.length > 100) return "Use at most 100 characters.";
  return undefined;
}

function CreateAccount({ onDone }: { onDone: () => void }) {
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
              ? { opening_balance: opening, ...(openingAt ? { opening_at: openingAt } : {}) }
              : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (account) => {
      notifications.show({ color: "green", message: `${account.name} created.` });
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
          label="Name"
          placeholder="Main account"
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
          label="Type"
          data={ACCOUNT_TYPES}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setType(v);
          }}
        />
        <Select
          label="Currency"
          description="Can't be changed later."
          data={currencies}
          value={currency}
          searchable
          allowDeselect={false}
          onChange={(v) => {
            if (v) setCurrency(v);
          }}
        />
        <AmountInput
          label="Opening balance"
          description="What the account holds today. Recorded as an opening balance."
          currency={currency}
          value={opening}
          onChange={setOpening}
        />
        {opening !== null && compareAmounts(opening, "0") !== 0 && (
          <DateTimeInput
            label="Opening balance as of"
            description="Empty means now."
            value={openingAt}
            onChange={setOpeningAt}
          />
        )}
        {create.error && !nameProblem(create.error) && <ErrorAlert error={create.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create account
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
      notifications.show({ color: "green", message: `${updated.name} saved.` });
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
          label="Name"
          value={name}
          maxLength={100}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          error={errors.name}
          required
        />
        <Select
          label="Type"
          data={ACCOUNT_TYPES}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setType(v);
          }}
        />
        <TextInput
          label="Currency"
          description="Set when the account was created."
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
            Delete…
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" loading={update.isPending} disabled={!changed}>
              Save
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
      notifications.show({ color: "green", message: `${account.name} deleted.` });
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
                Delete <strong>{account.name}</strong>? Its transactions are kept.
              </Text>
              {hasMoney && (
                <Radio.Group
                  label={`It still holds ${formatMoney(account.balance, account.currency)}`}
                  value={funds}
                  onChange={(v) => {
                    setFunds(v);
                  }}
                >
                  <Stack gap="xs" mt="xs">
                    <Radio
                      value="transfer"
                      label="Transfer it to another account"
                      description={
                        others.length === 0
                          ? `You have no other ${account.currency} account.`
                          : undefined
                      }
                      disabled={others.length === 0}
                    />
                    {funds === "transfer" && others.length > 0 && (
                      <Select
                        label="Transfer to"
                        data={others}
                        value={fundsTo}
                        onChange={setFundsTo}
                        error={validate && !fundsTo ? "Choose an account." : undefined}
                        ml="xl"
                      />
                    )}
                    <Radio
                      value="adjust"
                      label="Adjust the balance to 0"
                      description="For money that's gone, e.g. a closed fund."
                    />
                  </Stack>
                </Radio.Group>
              )}
              {own.length > 0 && (
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    {own.length === 1 ? "A bucket is" : `${String(own.length)} buckets are`} funded
                    from it. Choose a new source account:
                  </Text>
                  {blocked ? (
                    <Alert color="orange">
                      There&apos;s no other {account.currency} account to move them to. Create one,
                      or delete the buckets in Bucket setup first.
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
                        error={validate && !sources[b.id] ? "Choose an account." : undefined}
                      />
                    ))
                  )}
                </Stack>
              )}
              {remove.error && <ErrorAlert error={remove.error} />}
              <Group justify="flex-end" gap="xs">
                <Button variant="default" onClick={onCancel}>
                  Back
                </Button>
                <Button type="submit" color="red" loading={remove.isPending} disabled={blocked}>
                  Delete account
                </Button>
              </Group>
            </Stack>
          </form>
        );
      }}
    </QueryState>
  );
}
