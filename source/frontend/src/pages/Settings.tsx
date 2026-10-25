import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import type { components } from "@/api/schema";
import { SESSION_KEY, useSession, type User } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { PasswordForm } from "@/components/PasswordForm";
import { QueryState } from "@/components/QueryState";
import { LOCALE_OPTIONS } from "@/lib/locale";
import { parseAmount } from "@/lib/money";

type Preferences = components["schemas"]["Preferences"];
type RefillMode = components["schemas"]["RefillMode"];

/** The API's limit on income rules. */
const MAX_RULES = 20;

/** Settings (spec §9, canvas): preferences, income rules, password, status. */
export default function Settings() {
  const user = useSession().data;
  return (
    <Stack gap="lg" maw={720}>
      <Title order={2}>Settings</Title>
      {user && (
        <>
          <PreferencesCard preferences={user.preferences} />
          <IncomeRulesCard rules={user.preferences.income_refill_rules ?? []} />
        </>
      )}
      <PasswordCard />
      <DataCard />
      <ApiStatus />
    </Stack>
  );
}

/** PATCHes preferences and puts the result into the session user. */
function useUpdatePreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Preferences) => unwrap(api.PATCH("/api/v1/me/preferences", { body })),
    onSuccess: (preferences) => {
      client.setQueryData<User | null>(SESSION_KEY, (user) => user && { ...user, preferences });
    },
  });
}

/** The value the locale select uses for "the browser's locale". */
const BROWSER = "browser";

const REFILL_MODES = [
  { value: "auto", label: "Automatic, at the start of each cycle" },
  { value: "manual", label: "Manual" },
  { value: "on_income", label: "On income" },
];

function PreferencesCard({ preferences }: { preferences: Preferences }) {
  const update = useUpdatePreferences();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>Preferences</Text>
        <Select
          label="Number and date format"
          description="How amounts and dates are written."
          data={[{ value: BROWSER, label: "Browser default" }, ...LOCALE_OPTIONS]}
          value={preferences.locale ?? BROWSER}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({ locale: value === BROWSER || value === null ? null : value });
          }}
        />
        <Select
          label="Default refill mode"
          description="The refill mode new buckets start with."
          data={REFILL_MODES}
          value={preferences.default_refill_mode ?? "auto"}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({
              default_refill_mode:
                value === "auto" || value === null ? null : (value as RefillMode),
            });
          }}
        />
      </Stack>
    </Card>
  );
}

interface RuleRow {
  key: number;
  counterparty: string;
  minAmount: string | null;
}

let nextKey = 0;

function toRows(rules: components["schemas"]["IncomeRefillRule"][]): RuleRow[] {
  return rules.map((r) => ({
    key: nextKey++,
    counterparty: r.counterparty,
    minAmount: r.min_amount,
  }));
}

/** What a row says, to tell whether the rules have changed. */
function ruleKey(row: RuleRow): [string, string | null] {
  return [row.counterparty, row.minAmount === null ? null : parseAmount(row.minAmount, ".")];
}

function ruleErrors(row: RuleRow): { counterparty?: string; minAmount?: string } {
  const errors: { counterparty?: string; minAmount?: string } = {};
  if (row.counterparty.trim() === "") errors.counterparty = "Enter the counterparty.";
  else if (row.counterparty.length > 200) errors.counterparty = "Use at most 200 characters.";
  if (row.minAmount === null) errors.minAmount = "Enter an amount.";
  else if (row.minAmount.startsWith("-")) errors.minAmount = "Use 0 or more.";
  else if (!/^\d{1,12}(\.|$)/.test(row.minAmount)) errors.minAmount = "That's too large.";
  return errors;
}

/**
 * Income rules (spec §6): an income from the counterparty of at least the
 * minimum refills the account's "on income" buckets.
 */
function IncomeRulesCard({ rules }: { rules: components["schemas"]["IncomeRefillRule"][] }) {
  const update = useUpdatePreferences();
  const [rows, setRows] = useState(() => toRows(rules));
  const [validate, setValidate] = useState(false);

  const valid = rows.every((r) => Object.keys(ruleErrors(r)).length === 0);
  const saved = JSON.stringify(toRows(rules).map(ruleKey));
  const dirty = JSON.stringify(rows.map(ruleKey)) !== saved;

  const change = (key: number, patch: Partial<RuleRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const save = () => {
    setValidate(true);
    if (!valid) return;
    const body = rows.map((r) => ({
      counterparty: r.counterparty.trim(),
      min_amount: r.minAmount ?? "0",
    }));
    update.mutate(
      { income_refill_rules: body.length > 0 ? body : null },
      {
        onSuccess: (prefs) => {
          setRows(toRows(prefs.income_refill_rules ?? []));
          setValidate(false);
          notifications.show({ color: "green", message: "Income rules saved." });
        },
      },
    );
  };

  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Text fw={600}>Income rules</Text>
          <Text size="sm" c="dimmed">
            An income from one of these counterparties, of at least the minimum, refills its
            account&apos;s &ldquo;on income&rdquo; buckets. Once per cycle. You can also tick
            &ldquo;Triggers refill&rdquo; on the income itself.
          </Text>
        </div>
        {rows.length === 0 && (
          <Text size="sm" c="dimmed">
            No rules yet.
          </Text>
        )}
        {rows.map((row, i) => {
          const errors = validate ? ruleErrors(row) : {};
          return (
            <Group key={row.key} align="flex-start" wrap="nowrap" gap="sm">
              <TextInput
                label="Counterparty"
                placeholder="Employer AS"
                style={{ flex: 2 }}
                value={row.counterparty}
                maxLength={200}
                onChange={(e) => {
                  change(row.key, { counterparty: e.currentTarget.value });
                }}
                error={errors.counterparty}
              />
              <AmountInput
                label="At least"
                style={{ flex: 1 }}
                value={row.minAmount}
                onChange={(minAmount) => {
                  change(row.key, { minAmount });
                }}
                error={errors.minAmount}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                size={36}
                mt={25}
                aria-label={`Remove rule ${String(i + 1)}`}
                onClick={() => {
                  setRows((rs) => rs.filter((r) => r.key !== row.key));
                }}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
          );
        })}
        {update.error && <ErrorAlert error={update.error} />}
        <Group gap="sm">
          <Button
            variant="default"
            leftSection={<IconPlus size={16} />}
            disabled={rows.length >= MAX_RULES}
            onClick={() => {
              setRows((rs) => [...rs, { key: nextKey++, counterparty: "", minAmount: null }]);
            }}
          >
            Add rule
          </Button>
          <Button onClick={save} disabled={!dirty} loading={update.isPending}>
            Save rules
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function PasswordCard() {
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>Password</Text>
        <PasswordForm
          onChanged={() => {
            notifications.show({
              color: "green",
              message: "Password changed. Your other sessions were signed out.",
            });
          }}
        />
      </Stack>
    </Card>
  );
}

function DataCard() {
  return (
    <Card withBorder>
      <Group gap="xs">
        <Text fw={600}>Data export and import</Text>
        <Badge variant="light" color="gray">
          Later
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mt="xs">
        Download all your data, or bring it into another server (#36).
      </Text>
    </Card>
  );
}

/** Whether the backend and its database are reachable (GET /readyz). */
function ApiStatus() {
  const query = useQuery({
    queryKey: ["readyz"],
    queryFn: () => unwrap(api.GET("/readyz")),
    retry: false,
  });
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Server status
      </Text>
      <QueryState query={query}>
        {(data) => (
          <Group gap="xs">
            <Badge color="green">{data.status}</Badge>
            <Text size="sm" c="dimmed">
              API and database are reachable.
            </Text>
          </Group>
        )}
      </QueryState>
    </Card>
  );
}
