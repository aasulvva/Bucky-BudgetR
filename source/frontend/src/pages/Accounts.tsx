import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  CloseButton,
  Drawer,
  Group,
  Menu,
  Stack,
  Text,
  Title,
  UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconDots, IconSettings } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import {
  accountTypeLabel,
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import {
  addAmounts,
  canonicalAmount,
  compareAmounts,
  formatMoney,
  subtractAmounts,
} from "@/lib/money";

type Panel = { kind: "adjust" | "interest"; accountId: string } | null;

/**
 * Accounts (spec §9, canvas "Accounts"): the balance of each account, its
 * buckets at a glance, and the balance adjustment and interest actions.
 */
export default function Accounts() {
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const [panel, setPanel] = useState<Panel>(null);

  return (
    <QueryState query={accounts}>
      {(list) => {
        const selected = panel ? list.find((a) => a.id === panel.accountId) : undefined;
        const close = () => {
          setPanel(null);
        };
        const panelContent =
          panel && selected ? (
            <PanelContent kind={panel.kind} account={selected} onClose={close} />
          ) : null;
        const actions = (a: Account) => ({
          onAdjust: () => {
            setPanel({ kind: "adjust", accountId: a.id });
          },
          onInterest: () => {
            setPanel({ kind: "interest", accountId: a.id });
          },
        });

        return (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-end" wrap="wrap">
              <Title order={2}>Accounts</Title>
              <Totals accounts={list} />
            </Group>
            {list.length === 0 ? (
              <Text c="dimmed">
                No accounts yet.{" "}
                <Anchor component={Link} to="/accounts/setup">
                  Create one in Account setup
                </Anchor>
                .
              </Text>
            ) : isDesktop ? (
              <Group align="flex-start" wrap="wrap" gap="lg">
                <Box
                  style={{
                    flex: "999 1 420px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: "var(--mantine-spacing-md)",
                  }}
                >
                  {list.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      summary={buckets.data && bucketSummary(a, buckets.data)}
                      selected={a.id === selected?.id}
                      {...actions(a)}
                    />
                  ))}
                </Box>
                {panelContent && (
                  <Card
                    withBorder
                    shadow="sm"
                    padding="lg"
                    style={{ flex: "1 1 320px", maxWidth: 380 }}
                  >
                    {panelContent}
                  </Card>
                )}
              </Group>
            ) : (
              <>
                <Card withBorder padding={0}>
                  {list.map((a) => (
                    <AccountRow key={a.id} account={a} {...actions(a)} />
                  ))}
                </Card>
                <Drawer
                  opened={panelContent !== null}
                  onClose={close}
                  position="bottom"
                  withCloseButton={false}
                  size="auto"
                >
                  {panelContent}
                </Drawer>
              </>
            )}
          </Stack>
        );
      }}
    </QueryState>
  );
}

/** The total balance per currency. */
function Totals({ accounts }: { accounts: Account[] }) {
  const currencies = [...new Set(accounts.map((a) => a.currency))];
  if (currencies.length === 0) return null;
  return (
    <Group gap="md">
      {currencies.map((currency) => (
        <Text key={currency} size="sm" c="dimmed">
          Total{" "}
          <Text span fw={700} size="lg" c="var(--mantine-color-text)">
            {formatMoney(
              addAmounts(...accounts.filter((a) => a.currency === currency).map((a) => a.balance)),
              currency,
            )}
          </Text>
        </Text>
      ))}
    </Group>
  );
}

/**
 * The account's buckets in a line: how many, and what's short (TF the
 * account can't cover) or else unallocated.
 */
function bucketSummary(account: Account, buckets: Bucket[]): string {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  if (own.length === 0) return "No buckets";
  const count = `${String(own.length)} bucket${own.length === 1 ? "" : "s"}`;
  const short = addAmounts(
    ...own.map((b) =>
      compareAmounts(b.target_funds, "0") > 0
        ? subtractAmounts(b.target_funds, b.current_available_funds)
        : "0",
    ),
  );
  if (compareAmounts(short, "0") > 0) {
    return `${count} · ${formatMoney(short, account.currency)} short`;
  }
  if (compareAmounts(account.unallocated, "0") > 0) {
    return `${count} · ${formatMoney(account.unallocated, account.currency)} unallocated`;
  }
  return count;
}

interface ActionsProps {
  onAdjust: () => void;
  onInterest: () => void;
}

function SetupLink({ account, size }: { account: Account; size: number }) {
  return (
    <ActionIcon
      component={Link}
      to={`/accounts/setup?edit=${account.id}`}
      variant="subtle"
      color="gray"
      size={size}
      aria-label={`Account setup for ${account.name}`}
      title="Account setup"
    >
      <IconSettings size={18} />
    </ActionIcon>
  );
}

function AccountCard({
  account,
  summary,
  selected,
  onAdjust,
  onInterest,
}: ActionsProps & { account: Account; summary?: string; selected: boolean }) {
  return (
    <Card
      withBorder
      component="article"
      aria-label={account.name}
      style={
        selected
          ? { borderColor: "var(--mantine-primary-color-filled)", borderWidth: 2 }
          : undefined
      }
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <Title order={3} size="h5" style={{ flexGrow: 1 }}>
            {account.name}
          </Title>
          <Badge variant="light" color="gray" radius="sm">
            {accountTypeLabel(account.type)}
          </Badge>
          <SetupLink account={account} size={32} />
        </Group>
        <Text fz={24} fw={600}>
          {formatMoney(account.balance, account.currency)}
        </Text>
        {summary && (
          <Text size="sm" c="dimmed">
            {summary}
          </Text>
        )}
        <Group
          gap="xs"
          pt="xs"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          <Button
            component={Link}
            to={`/transactions?account_id=${account.id}`}
            size="xs"
            variant="light"
          >
            Transactions
          </Button>
          <Button size="xs" variant="default" onClick={onAdjust}>
            Adjust balance
          </Button>
          <Button size="xs" variant="default" onClick={onInterest}>
            Register interest
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function AccountRow({ account, onAdjust, onInterest }: ActionsProps & { account: Account }) {
  return (
    <Group
      gap={0}
      wrap="nowrap"
      pr={4}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <UnstyledButton
        component={Link}
        to={`/transactions?account_id=${account.id}`}
        style={{ flexGrow: 1, minWidth: 0 }}
        py="xs"
        pl="md"
        pr={4}
        mih={64}
        aria-label={`${account.name} transactions`}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <div style={{ minWidth: 0 }}>
            <Text fw={600} truncate>
              {account.name}
            </Text>
            <Text size="sm" c="dimmed">
              {accountTypeLabel(account.type)}
            </Text>
          </div>
          <Text fw={600} style={{ whiteSpace: "nowrap" }}>
            {formatMoney(account.balance, account.currency)}
          </Text>
        </Group>
      </UnstyledButton>
      <SetupLink account={account} size={44} />
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={44}
            aria-label={`More for ${account.name}`}
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={onAdjust}>Adjust balance</Menu.Item>
          <Menu.Item onClick={onInterest}>Register interest</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function PanelContent({
  kind,
  account,
  onClose,
}: {
  kind: "adjust" | "interest";
  account: Account;
  onClose: () => void;
}) {
  const title = kind === "adjust" ? "Adjust balance" : "Register interest";
  return (
    <Stack gap="md" component="section" aria-label={title}>
      <Group justify="space-between">
        <Title order={3} size="h4">
          {title}
        </Title>
        <CloseButton aria-label="Close" onClick={onClose} />
      </Group>
      <Text size="sm" c="dimmed">
        {account.name} · {accountTypeLabel(account.type)}
      </Text>
      {/* Keyed so that switching accounts starts the form afresh. */}
      {kind === "adjust" ? (
        <AdjustForm key={account.id} account={account} onDone={onClose} />
      ) : (
        <InterestForm key={account.id} account={account} onDone={onClose} />
      )}
    </Stack>
  );
}

function FormButtons({
  onCancel,
  submit,
  loading,
}: {
  onCancel: () => void;
  submit: ReactNode;
  loading: boolean;
}) {
  return (
    <Group justify="flex-end" gap="xs">
      <Button variant="default" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" loading={loading}>
        {submit}
      </Button>
    </Group>
  );
}

/** Records a balance adjustment (BLA) to the balance the bank shows. */
function AdjustForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const refresh = useRefreshMoney();
  const balance = canonicalAmount(account.balance);
  const [actual, setActual] = useState<string | null>(balance);
  const [at, setAt] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const adjust = useMutation({
    mutationFn: (target: string) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/balance-adjustment", {
          params: { path: { accountId: account.id } },
          body: { target_balance: target, ...(at ? { at } : {}) },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({ color: "green", message: `Balance of ${account.name} adjusted.` });
      onDone();
      await refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "no_change") {
        setError("That's already the balance.");
      }
    },
  });

  const diff = actual === null ? null : subtractAmounts(actual, balance);
  const sign = diff !== null && compareAmounts(diff, "0") > 0 ? "+" : "";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (actual === null) setError("Enter the balance your bank shows.");
        else adjust.mutate(actual);
      }}
    >
      <Stack gap="md">
        <Group justify="space-between">
          <Text size="sm">Balance in the app</Text>
          <Text size="sm" fw={700}>
            {formatMoney(balance, account.currency)}
          </Text>
        </Group>
        <AmountInput
          label="Actual balance"
          currency={account.currency}
          value={actual}
          onChange={setActual}
          error={error}
          data-autofocus
        />
        <DateTimeInput
          label="Date and time"
          description="When the bank showed this balance. Empty means now."
          value={at}
          onChange={setAt}
        />
        {diff !== null && (
          <Alert color="gray" variant="light">
            {at
              ? "Records a balance adjustment for the difference to the balance at that time."
              : compareAmounts(diff, "0") === 0
                ? "That matches the balance in the app."
                : `Records a balance adjustment of ${sign}${formatMoney(diff, account.currency)}.`}
          </Alert>
        )}
        {adjust.error &&
          !(adjust.error instanceof ApiError && adjust.error.code === "no_change") && (
            <ErrorAlert error={adjust.error} />
          )}
        <FormButtons onCancel={onDone} submit="Record adjustment" loading={adjust.isPending} />
      </Stack>
    </form>
  );
}

/**
 * Registers interest as an income (INC) with counterparty "Interest" and the
 * tag "interest". It never triggers a refill. (The counterparty becomes the
 * account's bank with #70.)
 */
function InterestForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const refresh = useRefreshMoney();
  const [amount, setAmount] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const register = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.POST("/api/v1/transactions", {
          body: {
            type: "INC",
            account_id: account.id,
            amount: value,
            counterparty: "Interest",
            tags: ["interest"],
            triggers_refill: false,
            ...(at ? { at } : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({ color: "green", message: `Interest on ${account.name} registered.` });
      onDone();
      await refresh();
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (amount === null) setError("Enter the interest.");
        else if (compareAmounts(amount, "0") <= 0) setError("Interest must be more than 0.");
        else register.mutate(amount);
      }}
    >
      <Stack gap="md">
        <AmountInput
          label="Interest amount"
          currency={account.currency}
          value={amount}
          onChange={setAmount}
          error={error}
          data-autofocus
        />
        <DateTimeInput
          label="Date and time"
          description="When it was paid. Empty means now."
          value={at}
          onChange={setAt}
        />
        <Alert color="gray" variant="light">
          Recorded as an income with the counterparty <strong>Interest</strong> and the tag{" "}
          <strong>interest</strong>. It stays unallocated and doesn&apos;t trigger refills.
        </Alert>
        {register.error && <ErrorAlert error={register.error} />}
        <FormButtons onCancel={onDone} submit="Register interest" loading={register.isPending} />
      </Stack>
    </form>
  );
}
