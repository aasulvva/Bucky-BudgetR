// The savings distributor's form (spec §9, Savings setup, #232): its hold
// mode, every target's rules, and a preview of a split. Changing any of it
// never moves money already held.

import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Radio,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import {
  HOLD_MODES,
  SAVINGS_KEY,
  useDistributionPreview,
  type SavingsDistributor,
  type SavingsHoldMode,
  type SavingsRule,
  type SavingsTarget,
} from "@/api/savings";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import i18n from "@/i18n";
import { isTouch } from "@/lib/device";
import { compareAmounts, formatMoney } from "@/lib/money";
import {
  distributorHeldOn,
  distributorSources,
  gapsOf,
  goalLimit,
  position,
  rangeProblem,
  rangeText,
  rulesEnd,
  rulesOf,
  targetBucket,
  type RangeProblem,
} from "@/lib/savings";

const MAX_RULES = 20;
const PRIORITIES = ["0", "1", "2", "3", "4", "5", "6"];

export function DistributorForm({
  distributor,
  targets,
  rules,
  accounts,
  buckets,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  rules: SavingsRule[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        {t("savingsSetup.distributor.intro")}
      </Text>
      <HoldMode distributor={distributor} currency={targets[0]?.currency} />
      <Divider />
      <Stack gap="md" component="section" aria-label={t("savingsSetup.distributor.rules")}>
        <div>
          <Title order={4} size="h5">
            {t("savingsSetup.distributor.rules")}
          </Title>
          <Text size="sm" c="dimmed">
            {t("savingsSetup.distributor.rulesHint")}
          </Text>
        </div>
        {targets.length === 0 ? (
          <Text c="dimmed">{t("savingsSetup.distributor.noTargets")}</Text>
        ) : (
          targets.map((x) => (
            <TargetRules
              key={x.id}
              target={x}
              rules={rulesOf(rules, x.id)}
              bucket={targetBucket(x, buckets)}
            />
          ))
        )}
      </Stack>
      {targets.length > 0 && (
        <>
          <Divider />
          <Preview distributor={distributor} targets={targets} accounts={accounts} />
        </>
      )}
    </Stack>
  );
}

/** The hold mode: when money that comes in is split. */
function HoldMode({
  distributor,
  currency,
}: {
  distributor: SavingsDistributor;
  currency: string | undefined;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [mode, setMode] = useState<SavingsHoldMode>(distributor.hold_mode);
  const [minimum, setMinimum] = useState<string | null>(distributor.min_amount);
  const minimumMissing =
    mode === "minimum" && (minimum === null || compareAmounts(minimum, "0") <= 0);
  const changed =
    mode !== distributor.hold_mode || (mode === "minimum" && minimum !== distributor.min_amount);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/savings/distributor", {
          body: {
            hold_mode: mode,
            ...(mode === "minimum" && minimum !== null ? { min_amount: minimum } : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({ color: "green", message: t("savingsSetup.distributor.modeSaved") });
      await client.invalidateQueries({ queryKey: SAVINGS_KEY });
    },
  });

  return (
    <Stack gap="sm">
      <Radio.Group
        label={t("savingsSetup.distributor.holdMode")}
        description={t("savingsSetup.distributor.holdModeHint")}
        value={mode}
        onChange={(v) => {
          setMode(v);
        }}
      >
        <Stack gap="xs" mt="xs">
          {HOLD_MODES.map((m) => (
            <Radio
              key={m}
              value={m}
              label={t(`savingsSetup.distributor.modes.${m}`)}
              description={t(`savingsSetup.distributor.modeHints.${m}`)}
            />
          ))}
        </Stack>
      </Radio.Group>
      {mode === "minimum" && (
        <AmountInput
          label={t("savingsSetup.distributor.minimum")}
          description={t("savingsSetup.distributor.minimumHint")}
          currency={currency}
          value={minimum}
          onChange={setMinimum}
          error={
            minimumMissing && minimum !== null
              ? t("savingsSetup.distributor.enterMinimum")
              : undefined
          }
          maw={260}
        />
      )}
      {save.error && <ErrorAlert error={save.error} />}
      <Group>
        <Button
          variant="default"
          disabled={!changed || minimumMissing}
          loading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t("savingsSetup.distributor.saveMode")}
        </Button>
      </Group>
    </Stack>
  );
}

/** A target's rules, each a row to edit, with what no rule covers. */
function TargetRules({
  target,
  rules,
  bucket,
}: {
  target: SavingsTarget;
  rules: SavingsRule[];
  bucket: Bucket | undefined;
}) {
  const { t } = useTranslation();
  // The rule being edited: its ID, "new", or none.
  const [editing, setEditing] = useState<string | null>(null);
  const money = (a: string) => formatMoney(a, target.currency);
  const gaps = gapsOf(rules);
  const cap = goalLimit(bucket);
  const end = rulesEnd(rules);

  return (
    <Stack gap="xs" component="section" aria-label={target.name}>
      <Group justify="space-between" gap="xs" align="baseline">
        <Text fw={600}>{target.name}</Text>
        <Text size="sm" c="dimmed">
          {t("savingsSetup.distributor.standing", {
            position: money(position(target)),
            goal: money(target.goal),
          })}
        </Text>
      </Group>
      {rules.length === 0 && editing !== "new" && (
        <Text size="sm" c="dimmed">
          {t("savingsSetup.distributor.noRules")}
        </Text>
      )}
      {rules.map((r) =>
        editing === r.id ? (
          <RuleEditor
            key={r.id}
            target={target}
            rule={r}
            siblings={rules}
            onDone={() => {
              setEditing(null);
            }}
          />
        ) : (
          <RuleRow
            key={r.id}
            target={target}
            rule={r}
            disabled={editing !== null}
            onEdit={() => {
              setEditing(r.id);
            }}
          />
        ),
      )}
      {editing === "new" && (
        <RuleEditor
          target={target}
          siblings={rules}
          defaultFrom={end ?? gaps[0]?.from ?? "0.00"}
          onDone={() => {
            setEditing(null);
          }}
        />
      )}
      {gaps.map((g) => (
        <Text key={g.from} size="sm" c="var(--mantine-color-orange-text)">
          {t("savingsSetup.distributor.gap", {
            from: formatMoney(g.from ?? "0.00", target.currency),
            to: formatMoney(g.to ?? "0.00", target.currency),
            name: target.name,
          })}
        </Text>
      ))}
      {cap !== null && rules.some((r) => r.past_goal) && (
        <Text size="xs" c="dimmed">
          {t("savingsSetup.distributor.capacityCaps", { amount: money(cap) })}
        </Text>
      )}
      {editing === null && (
        <Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={14} />}
            disabled={rules.length >= MAX_RULES}
            aria-label={t("savingsSetup.distributor.addRuleFor", { name: target.name })}
            onClick={() => {
              setEditing("new");
            }}
          >
            {t("savingsSetup.distributor.addRule")}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** A rule as a line: its range, priority and past-the-goal, with edit and delete. */
function RuleRow({
  target,
  rule,
  disabled,
  onEdit,
}: {
  target: SavingsTarget;
  rule: SavingsRule;
  disabled: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const range = rangeText(rule, target.currency);
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/savings/rules/{ruleId}", { params: { path: { ruleId: rule.id } } }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SAVINGS_KEY });
    },
  });
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap="xs" style={{ minWidth: 0 }}>
          <Text size="sm">{range}</Text>
          <Badge variant="light" color={rule.priority === 0 ? "gray" : "blue"}>
            {t("savingsSetup.distributor.priorityValue", { priority: rule.priority })}
          </Badge>
          {rule.past_goal && (
            <Badge variant="light" color="grape">
              {t("savingsSetup.distributor.pastGoal")}
            </Badge>
          )}
        </Group>
        <Group gap={4} wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={disabled}
            aria-label={t("savingsSetup.distributor.editRule", { name: target.name, range })}
            onClick={onEdit}
          >
            <IconPencil size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            disabled={disabled}
            loading={remove.isPending}
            aria-label={t("savingsSetup.distributor.deleteRule", { name: target.name, range })}
            onClick={() => {
              remove.mutate();
            }}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>
      {remove.error && <ErrorAlert error={remove.error} />}
    </Stack>
  );
}

function rangeError(problem: RangeProblem | undefined, withRule: string | undefined) {
  switch (problem) {
    case "noFrom":
      return i18n.t("savingsSetup.distributor.enterFrom");
    case "toNotAbove":
      return i18n.t("savingsSetup.distributor.toNotAbove");
    case "overlap":
      return i18n.t("savingsSetup.distributor.overlap", { range: withRule ?? "" });
    default:
      return undefined;
  }
}

/** A new rule, or a rule being changed. */
function RuleEditor({
  target,
  rule,
  siblings,
  defaultFrom = "0.00",
  onDone,
}: {
  target: SavingsTarget;
  rule?: SavingsRule;
  siblings: SavingsRule[];
  defaultFrom?: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [from, setFrom] = useState<string | null>(rule?.from ?? defaultFrom);
  const [to, setTo] = useState<string | null>(rule?.to ?? null);
  const [priority, setPriority] = useState<number>(rule?.priority ?? 1);
  const [pastGoal, setPastGoal] = useState(rule?.past_goal ?? false);
  const found = rangeProblem({ from, to }, siblings, rule?.id);
  const error = rangeError(
    found?.problem,
    found?.with ? rangeText(found.with, target.currency) : undefined,
  );

  const save = useMutation({
    mutationFn: () => {
      const body = { from: from ?? "0.00", to, priority, past_goal: pastGoal };
      return rule
        ? unwrap(
            api.PATCH("/api/v1/savings/rules/{ruleId}", {
              params: { path: { ruleId: rule.id } },
              body,
            }),
          )
        : unwrap(api.POST("/api/v1/savings/rules", { body: { target_id: target.id, ...body } }));
    },
    meta: { silentError: true },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: SAVINGS_KEY });
      onDone();
    },
  });

  return (
    <Stack
      gap="xs"
      p="sm"
      style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}
      component="fieldset"
      aria-label={
        rule
          ? t("savingsSetup.distributor.editRuleTitle", { name: target.name })
          : t("savingsSetup.distributor.newRuleTitle", { name: target.name })
      }
    >
      <Group gap="sm" align="flex-start" wrap="wrap">
        <AmountInput
          label={t("savingsSetup.distributor.from")}
          currency={target.currency}
          value={from}
          onChange={setFrom}
          error={found?.problem === "noFrom" ? error : undefined}
          w={170}
        />
        <AmountInput
          label={t("savingsSetup.distributor.to")}
          placeholder={t("savingsSetup.distributor.noEnd")}
          currency={target.currency}
          value={to}
          onChange={setTo}
          error={found?.problem === "toNotAbove" ? error : undefined}
          w={170}
        />
        <Select
          label={t("savingsSetup.distributor.priority")}
          data={PRIORITIES.map((p) => ({
            value: p,
            label: p === "0" ? t("savingsSetup.distributor.priorityNone") : p,
          }))}
          value={String(priority)}
          allowDeselect={false}
          onChange={(v) => {
            setPriority(Number(v ?? "0"));
          }}
          comboboxProps={isTouch() ? { withinPortal: false } : undefined}
          w={150}
        />
      </Group>
      <Checkbox
        label={t("savingsSetup.distributor.pastGoal")}
        description={t("savingsSetup.distributor.pastGoalHint", {
          goal: formatMoney(target.goal, target.currency),
        })}
        checked={pastGoal}
        onChange={(e) => {
          setPastGoal(e.currentTarget.checked);
        }}
      />
      {found?.problem === "overlap" && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
      {save.error && <ErrorAlert error={save.error} />}
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          size="xs"
          disabled={found !== null}
          loading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t(rule ? "savingsSetup.distributor.saveRule" : "savingsSetup.distributor.addRule")}
        </Button>
      </Group>
    </Stack>
  );
}

/** How an amount from an account would be split now. */
function Preview({
  distributor,
  targets,
  accounts,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
  accounts: Account[];
}) {
  const { t } = useTranslation();
  const sources = distributorSources(accounts, targets);
  const [accountId, setAccountId] = useState<string | null>(
    () => distributor.held[0]?.account_id ?? sources[0]?.id ?? null,
  );
  const held = accountId ? distributorHeldOn(distributor, accountId) : "0.00";
  const [amount, setAmount] = useState<string | null>(() =>
    compareAmounts(held, "0") > 0 ? held : "5000.00",
  );
  const account = sources.find((a) => a.id === accountId);
  const currency = account?.currency ?? targets[0]?.currency;

  return (
    <Stack gap="sm" component="section" aria-label={t("savingsSetup.distributor.preview")}>
      <div>
        <Title order={4} size="h5">
          {t("savingsSetup.distributor.preview")}
        </Title>
        <Text size="sm" c="dimmed">
          {t("savingsSetup.distributor.previewHint")}
        </Text>
      </div>
      <Group gap="sm" align="flex-start" wrap="wrap">
        <Select
          label={t("savingsSetup.distributor.previewFrom")}
          data={sources.map((a) => ({ value: a.id, label: a.name }))}
          value={accountId}
          allowDeselect={false}
          onChange={setAccountId}
          comboboxProps={isTouch() ? { withinPortal: false } : undefined}
          w={220}
        />
        <AmountInput
          label={t("savings.amount")}
          currency={currency}
          value={amount}
          onChange={setAmount}
          w={200}
        />
      </Group>
      {account && (
        <PreviewShares
          accountId={account.id}
          amount={amount}
          currency={account.currency}
          targets={targets}
        />
      )}
    </Stack>
  );
}

/** The shares a split would give, and what would stay in the distributor. */
export function PreviewShares({
  accountId,
  amount,
  currency,
  targets,
}: {
  accountId: string;
  amount: string | null;
  currency: string;
  targets: SavingsTarget[];
}) {
  const { t } = useTranslation();
  const preview = useDistributionPreview(accountId, amount);
  if (preview.error) return <ErrorAlert error={preview.error} />;
  const data = preview.data;
  if (!data) return null;
  const money = (a: string) => formatMoney(a, currency);
  const name = (id: string) => targets.find((x) => x.id === id)?.name ?? `#${id}`;
  return (
    <Stack gap={4} aria-label={t("savingsSetup.distributor.previewResult")} role="list">
      {data.shares.length === 0 && (
        <Alert color="orange" role="listitem">
          {t("savingsSetup.distributor.nobodyTakes")}
        </Alert>
      )}
      {data.shares.map((s) => (
        <Group key={s.target_id} justify="space-between" gap="xs" role="listitem">
          <Text size="sm">
            {name(s.target_id)}
            {s.into_bucket && (
              <Text span size="xs" c="dimmed">
                {" "}
                · {t("savingsSetup.distributor.intoBucket")}
              </Text>
            )}
          </Text>
          <Text size="sm" fw={500}>
            {money(s.amount)}
          </Text>
        </Group>
      ))}
      {compareAmounts(data.left, "0") > 0 && (
        <Group justify="space-between" gap="xs" role="listitem">
          <Text size="sm" c="dimmed">
            {t("savingsSetup.distributor.stays")}
          </Text>
          <Text size="sm" c="dimmed">
            {money(data.left)}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
