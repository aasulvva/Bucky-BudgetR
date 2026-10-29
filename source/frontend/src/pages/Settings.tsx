import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import type { components } from "@/api/schema";
import { useSession, useUpdatePreferences, type Preferences } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { CycleRuleCard } from "@/components/cycles/CycleRuleCard";
import { ErrorAlert } from "@/components/ErrorAlert";
import { PasswordForm } from "@/components/PasswordForm";
import { QueryState } from "@/components/QueryState";
import i18n from "@/i18n";
import { browserTimeZone } from "@/lib/cycleRule";
import { LANGUAGES } from "@/lib/language";
import { LOCALE_OPTIONS } from "@/lib/locale";
import { parseAmount } from "@/lib/money";

type RefillMode = components["schemas"]["RefillMode"];
type NegativeTf = components["schemas"]["NegativeTf"];

/** The API's limit on income rules. */
const MAX_RULES = 20;

/**
 * Settings (spec §9, canvas): preferences, the cycle rule, income rules,
 * password, status.
 */
export default function Settings() {
  const { t } = useTranslation();
  const user = useSession().data;
  return (
    <Stack gap="lg" maw={720}>
      <Title order={2}>{t("nav.items.settings")}</Title>
      {user && (
        <>
          <PreferencesCard preferences={user.preferences} />
          <CycleRuleCard preferences={user.preferences} />
          <IncomeRulesCard rules={user.preferences.income_refill_rules ?? []} />
        </>
      )}
      <PasswordCard />
      <DataCard />
      <ApiStatus />
    </Stack>
  );
}

/** The value the locale select uses for "the browser's locale". */
const BROWSER = "browser";
/** The value the language select uses for "follow the locale". */
const FOLLOW = "follow";

const REFILL_MODES: RefillMode[] = ["auto", "manual", "on_income"];
const NEGATIVE_TFS: NegativeTf[] = ["debt", "clear"];

/** The time zones to pick from, with the user's own even if it isn't listed. */
function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

function PreferencesCard({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>{t("settings.preferences")}</Text>
        <Select
          label={t("settings.language")}
          description={t("settings.languageHint")}
          data={[{ value: FOLLOW, label: t("settings.languageFollows") }, ...LANGUAGES]}
          value={preferences.language ?? FOLLOW}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({
              language: LANGUAGES.find((l) => l.value === value)?.value ?? null,
            });
          }}
        />
        <Select
          label={t("settings.locale")}
          description={t("settings.localeHint")}
          data={[{ value: BROWSER, label: t("settings.browserDefault") }, ...LOCALE_OPTIONS]}
          value={preferences.locale ?? BROWSER}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({ locale: value === BROWSER || value === null ? null : value });
          }}
        />
        <Select
          label={t("settings.timeZone")}
          description={t("settings.timeZoneHint")}
          data={timeZones(preferences.time_zone ?? browserTimeZone())}
          value={preferences.time_zone ?? browserTimeZone()}
          searchable
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            if (value) update.mutate({ time_zone: value });
          }}
        />
        <Select
          label={t("settings.refillMode")}
          description={t("settings.refillModeHint")}
          data={REFILL_MODES.map((mode) => ({
            value: mode,
            label: t(`settings.refillModes.${mode}`),
          }))}
          value={preferences.default_refill_mode ?? "auto"}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({ default_refill_mode: value === "auto" ? null : value });
          }}
        />
        <Select
          label={t("settings.negativeTf")}
          description={t("settings.negativeTfHint")}
          data={NEGATIVE_TFS.map((n) => ({ value: n, label: t(`settings.negativeTfs.${n}`) }))}
          value={preferences.default_negative_tf ?? "debt"}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            const next = NEGATIVE_TFS.find((n) => n === value);
            if (next) update.mutate({ default_negative_tf: next === "debt" ? null : next });
          }}
        />
        <Switch
          label={t("settings.whatsNewPopup")}
          description={t("settings.whatsNewPopupHint")}
          checked={preferences.whats_new_popup !== false}
          disabled={update.isPending}
          onChange={(e) => {
            // On is the default (null).
            update.mutate({ whats_new_popup: e.currentTarget.checked ? null : false });
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
  if (row.counterparty.trim() === "")
    errors.counterparty = i18n.t("settings.rules.enterCounterparty");
  else if (row.counterparty.length > 200) {
    errors.counterparty = i18n.t("common.maxChars", { count: 200 });
  }
  if (row.minAmount === null) errors.minAmount = i18n.t("settings.rules.enterAmount");
  else if (row.minAmount.startsWith("-")) errors.minAmount = i18n.t("common.notNegative");
  else if (!/^\d{1,12}(\.|$)/.test(row.minAmount)) {
    errors.minAmount = i18n.t("settings.rules.tooLarge");
  }
  return errors;
}

/**
 * Income rules (spec §6): an income from the counterparty of at least the
 * minimum refills the account's "on income" buckets.
 */
function IncomeRulesCard({ rules }: { rules: components["schemas"]["IncomeRefillRule"][] }) {
  const { t } = useTranslation();
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
          notifications.show({ color: "green", message: t("settings.rules.saved") });
        },
      },
    );
  };

  return (
    <Card withBorder>
      <Stack gap="md">
        <Stack gap={6}>
          <Text fw={600}>{t("settings.rules.title")}</Text>
          <Text size="sm" c="dimmed">
            {t("settings.rules.intro1")}
          </Text>
          <Text size="sm" c="dimmed">
            {t("settings.rules.intro2")}
          </Text>
          <Text size="sm" c="dimmed">
            {t("settings.rules.intro3")}
          </Text>
        </Stack>
        {rows.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("settings.rules.empty")}
          </Text>
        )}
        {rows.map((row, i) => {
          const errors = validate ? ruleErrors(row) : {};
          return (
            <Group key={row.key} align="flex-start" wrap="nowrap" gap="sm">
              <TextInput
                label={t("settings.rules.counterparty")}
                placeholder={t("settings.rules.counterpartyExample")}
                style={{ flex: 2 }}
                value={row.counterparty}
                maxLength={200}
                onChange={(e) => {
                  change(row.key, { counterparty: e.currentTarget.value });
                }}
                error={errors.counterparty}
              />
              <AmountInput
                label={t("settings.rules.atLeast")}
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
                aria-label={t("settings.rules.remove", { number: i + 1 })}
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
            {t("settings.rules.add")}
          </Button>
          <Button onClick={save} disabled={!dirty} loading={update.isPending}>
            {t("settings.rules.save")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>{t("settings.password")}</Text>
        <PasswordForm
          onChanged={() => {
            notifications.show({ color: "green", message: t("settings.passwordChanged") });
          }}
        />
      </Stack>
    </Card>
  );
}

function DataCard() {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Group gap="xs">
        <Text fw={600}>{t("settings.data")}</Text>
        <Badge variant="light" color="gray">
          {t("common.later")}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mt="xs">
        {t("settings.dataText")}
      </Text>
    </Card>
  );
}

/** Whether the backend and its database are reachable (GET /readyz). */
function ApiStatus() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["readyz"],
    queryFn: () => unwrap(api.GET("/readyz")),
    retry: false,
  });
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        {t("settings.serverStatus")}
      </Text>
      <QueryState query={query}>
        {(data) => (
          <Group gap="xs">
            <Badge color="green">{data.status}</Badge>
            <Text size="sm" c="dimmed">
              {t("settings.serverReachable")}
            </Text>
          </Group>
        )}
      </QueryState>
    </Card>
  );
}
