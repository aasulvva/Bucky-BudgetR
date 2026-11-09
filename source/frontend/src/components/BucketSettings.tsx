import {
  ActionIcon,
  Button,
  Divider,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { components } from "@/api/schema";
import { useSession, useUpdatePreferences, type Preferences } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import i18n from "@/i18n";
import { isTouch } from "@/lib/device";
import { parseAmount } from "@/lib/money";

type RefillMode = components["schemas"]["RefillMode"];
type NegativeTf = components["schemas"]["NegativeTf"];
type IncomeRefillRule = components["schemas"]["IncomeRefillRule"];

const REFILL_MODES: RefillMode[] = ["auto", "manual", "on_income", "fully_manual"];
const NEGATIVE_TFS: NegativeTf[] = ["debt", "clear"];

/** The API's limit on income rules. */
const MAX_RULES = 20;

/**
 * Bucket settings (#102): the defaults new buckets start with and the income
 * rules, in a drawer on Bucket setup (`?settings`); full screen on mobile.
 */
export function BucketSettingsDrawer({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const preferences = useSession().data?.preferences;
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={isDesktop ? "md" : "100%"}
      // Above the bucket form's dialog (200), which a hint's link opens it over;
      // below dropdowns (300).
      zIndex={250}
      title={<Text fw={600}>{t("bucketSetup.settings.open")}</Text>}
    >
      {preferences && (
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            {t("bucketSetup.settings.intro")}
          </Text>
          <BucketDefaults preferences={preferences} />
          <Divider />
          <IncomeRules rules={preferences.income_refill_rules ?? []} />
        </Stack>
      )}
    </Drawer>
  );
}

/** What new buckets start with: the refill mode and, with Keep funds, what an overspend does. */
export function BucketDefaults({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  // Inside a drawer, a portalled dropdown closes at once on touch screens.
  const comboboxProps = isTouch() ? { withinPortal: false } : undefined;
  return (
    <Stack gap="md">
      <Text fw={600}>{t("bucketSetup.settings.defaults")}</Text>
      <Select
        label={t("bucketSetup.settings.refillMode")}
        description={t("bucketSetup.settings.refillModeHint")}
        data={REFILL_MODES.map((mode) => ({
          value: mode,
          label: t(`bucketSetup.settings.refillModes.${mode}`),
        }))}
        value={preferences.default_refill_mode ?? "auto"}
        allowDeselect={false}
        disabled={update.isPending}
        comboboxProps={comboboxProps}
        onChange={(value) => {
          update.mutate({ default_refill_mode: value === "auto" ? null : value });
        }}
      />
      <Select
        label={t("bucketSetup.settings.negativeTf")}
        description={t("bucketSetup.settings.negativeTfHint")}
        data={NEGATIVE_TFS.map((n) => ({
          value: n,
          label: t(`bucketSetup.settings.negativeTfs.${n}`),
        }))}
        value={preferences.default_negative_tf ?? "debt"}
        allowDeselect={false}
        disabled={update.isPending}
        comboboxProps={comboboxProps}
        onChange={(value) => {
          const next = NEGATIVE_TFS.find((n) => n === value);
          if (next) update.mutate({ default_negative_tf: next === "debt" ? null : next });
        }}
      />
      {update.error && <ErrorAlert error={update.error} />}
    </Stack>
  );
}

interface RuleRow {
  key: number;
  counterparty: string;
  minAmount: string | null;
}

let nextKey = 0;

function toRows(rules: IncomeRefillRule[]): RuleRow[] {
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
    errors.counterparty = i18n.t("bucketSetup.settings.rules.enterCounterparty");
  else if (row.counterparty.length > 200) {
    errors.counterparty = i18n.t("common.maxChars", { count: 200 });
  }
  if (row.minAmount === null) errors.minAmount = i18n.t("bucketSetup.settings.rules.enterAmount");
  else if (row.minAmount.startsWith("-")) errors.minAmount = i18n.t("common.notNegative");
  else if (!/^\d{1,12}(\.|$)/.test(row.minAmount)) {
    errors.minAmount = i18n.t("bucketSetup.settings.rules.tooLarge");
  }
  return errors;
}

/**
 * Income rules (spec §6): an income from the counterparty of at least the
 * minimum refills the account's "on income" buckets. On Bucket setup's
 * settings and on Budget setup.
 */
export function IncomeRules({
  rules,
  titled = true,
}: {
  rules: IncomeRefillRule[];
  /** False where the dialog's title already names them. */
  titled?: boolean;
}) {
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
          notifications.show({ color: "green", message: t("bucketSetup.settings.rules.saved") });
        },
      },
    );
  };

  return (
    <Stack gap="md">
      <Stack gap={6}>
        {titled && <Text fw={600}>{t("bucketSetup.settings.rules.title")}</Text>}
        <Text size="sm" c="dimmed">
          {t("bucketSetup.settings.rules.intro1")}
        </Text>
        <Text size="sm" c="dimmed">
          {t("bucketSetup.settings.rules.intro2")}
        </Text>
        <Text size="sm" c="dimmed">
          {t("bucketSetup.settings.rules.intro3")}
        </Text>
      </Stack>
      {rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("bucketSetup.settings.rules.empty")}
        </Text>
      )}
      {rows.map((row, i) => {
        const errors = validate ? ruleErrors(row) : {};
        return (
          <Group key={row.key} align="flex-start" wrap="nowrap" gap="sm">
            <TextInput
              label={t("bucketSetup.settings.rules.counterparty")}
              placeholder={t("bucketSetup.settings.rules.counterpartyExample")}
              style={{ flex: 2 }}
              value={row.counterparty}
              maxLength={200}
              onChange={(e) => {
                change(row.key, { counterparty: e.currentTarget.value });
              }}
              error={errors.counterparty}
            />
            <AmountInput
              label={t("bucketSetup.settings.rules.atLeast")}
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
              aria-label={t("bucketSetup.settings.rules.remove", { number: i + 1 })}
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
          {t("bucketSetup.settings.rules.add")}
        </Button>
        <Button onClick={save} disabled={!dirty} loading={update.isPending}>
          {t("bucketSetup.settings.rules.save")}
        </Button>
      </Group>
    </Stack>
  );
}
