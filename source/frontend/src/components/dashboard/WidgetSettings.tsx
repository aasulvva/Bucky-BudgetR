import {
  Anchor,
  Button,
  Checkbox,
  Group,
  Input,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { useSession } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  ACCOUNTS_MODES,
  BUCKET_STATUS_MODES,
  COMPACT_BUDGET_ORDERS,
  COMPACT_BUDGET_ROWS,
  COMPACT_FIGURES,
  COMPACT_ROWS,
  COMPACT_SUMMARIES,
  COMPACT_TOP_OF,
  COMPACT_TOPS,
  GRAPH_HEIGHTS,
  MAX_TITLE,
  MODULE_VIEWS,
  SCHEDULED_SHOWS,
  TRANSACTION_COUNTS,
  customTitle,
  settingsComplete,
  type AccountsSettings,
  type BucketStatusSettings,
  type InOutSettings,
  type ModuleWidgetSettings,
  type WidgetInstance,
  type SaveWidget,
} from "@/lib/dashboard";
import { accountFigureLabel } from "@/lib/reports";
import { readSavedModules, savedModuleOptions, type SavedModule } from "@/lib/savedModules";

import { FLOW_FIGURES, FLOW_PERIODS, MAX_DAYS } from "@/lib/flows";

import { titleFor } from "./frame";

/**
 * A widget's settings, for its cog and for adding a widget. Saving hands the
 * changed widget to `onSave`, which saves it, or adds it to the layout being
 * edited.
 */
export function WidgetSettingsDialog({
  widget,
  opened,
  title,
  saveLabel,
  onClose,
  onSave,
}: {
  widget: WidgetInstance;
  opened: boolean;
  title: string;
  saveLabel?: string;
  onClose: () => void;
  onSave: SaveWidget;
}) {
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={title}>
      {opened && (
        <WidgetSettingsForm
          widget={widget}
          saveLabel={saveLabel}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </ResponsiveModal>
  );
}

/** A widget's settings, with Cancel and Save (or `saveLabel`). */
export function WidgetSettingsForm({
  widget,
  saveLabel,
  onClose,
  onSave,
}: {
  widget: WidgetInstance;
  saveLabel?: string;
  onClose: () => void;
  onSave: SaveWidget;
}) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const [draft, setDraft] = useState(widget);
  const [title, setTitle] = useState(widget.title ?? "");
  // What the title is when the field is left empty.
  const saved = readSavedModules(useSession().data?.preferences.saved_modules);
  const automatic = titleFor(t, { ...draft, title: null }, accounts, buckets, saved);
  const save = useMutation({
    mutationFn: async (w: WidgetInstance) => {
      await onSave(w);
    },
    meta: { silentError: true },
    onSuccess: onClose,
  });

  return (
    <Stack gap="md">
      <TextInput
        label={t("dashboard.title")}
        description={t("dashboard.titleHint")}
        placeholder={automatic}
        value={title}
        maxLength={MAX_TITLE}
        onChange={(e) => {
          setTitle(e.currentTarget.value);
        }}
      />
      {draft.type === "bucket_status" && (
        <Checkbox
          label={t("dashboard.bucketStatus.showMode", {
            example: t("dashboard.bucketStatus.modes.attention"),
          })}
          checked={draft.settings.showMode}
          onChange={(e) => {
            setDraft({
              ...draft,
              settings: { ...draft.settings, showMode: e.currentTarget.checked },
            });
          }}
        />
      )}
      {draft.type === "cycle" && (
        <Checkbox
          label={t("dashboard.cycle.showNext")}
          checked={draft.settings.showNext}
          onChange={(e) => {
            setDraft({ ...draft, settings: { showNext: e.currentTarget.checked } });
          }}
        />
      )}
      {draft.type === "bucket_status" && (
        <BucketStatusForm
          value={draft.settings}
          onChange={(settings) => {
            setDraft({ ...draft, settings });
          }}
          accounts={accounts}
          buckets={buckets}
        />
      )}
      {draft.type === "accounts" && (
        <AccountsForm
          value={draft.settings}
          onChange={(settings) => {
            setDraft({ ...draft, settings });
          }}
          accounts={accounts}
        />
      )}
      {draft.type === "recent_transactions" && (
        <>
          <Select
            label={t("dashboard.recent.count")}
            data={TRANSACTION_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
            value={String(draft.settings.count)}
            allowDeselect={false}
            onChange={(v) => {
              if (v) setDraft({ ...draft, settings: { ...draft.settings, count: Number(v) } });
            }}
          />
          <Checkbox
            label={t("transactions.filters.reversed")}
            checked={draft.settings.showReversed}
            onChange={(e) => {
              setDraft({
                ...draft,
                settings: { ...draft.settings, showReversed: e.currentTarget.checked },
              });
            }}
          />
        </>
      )}
      {draft.type === "scheduled" && (
        <>
          <Select
            label={t("dashboard.scheduled.show")}
            data={SCHEDULED_SHOWS.map((v) => ({
              value: v,
              label: t(`dashboard.scheduled.shows.${v}`),
            }))}
            value={draft.settings.show}
            allowDeselect={false}
            onChange={(v) => {
              const show = SCHEDULED_SHOWS.find((x) => x === v);
              if (show) setDraft({ ...draft, settings: { ...draft.settings, show } });
            }}
          />
          <Select
            label={t("dashboard.scheduled.count")}
            data={TRANSACTION_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
            value={String(draft.settings.count)}
            allowDeselect={false}
            onChange={(v) => {
              if (v) setDraft({ ...draft, settings: { ...draft.settings, count: Number(v) } });
            }}
          />
        </>
      )}
      {draft.type === "in_out" && (
        <InOutForm
          value={draft.settings}
          onChange={(settings) => {
            setDraft({ ...draft, settings });
          }}
          accounts={accounts}
        />
      )}
      {draft.type === "module" &&
        (saved.length === 0 ? (
          <Text size="sm" c="dimmed">
            <Trans
              i18nKey="dashboard.module.noneSaved"
              components={{ stats: <Anchor component={Link} to="/stats" size="sm" /> }}
            />
          </Text>
        ) : (
          <ModuleForm
            value={draft.settings}
            saved={saved}
            onChange={(settings) => {
              setDraft({ ...draft, settings });
            }}
          />
        ))}
      {save.error && <ErrorAlert error={save.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={save.isPending}
          disabled={!settingsComplete(draft, accounts, buckets, saved)}
          onClick={() => {
            save.mutate({ ...draft, title: customTitle(title) });
          }}
        >
          {saveLabel ?? t("common.save")}
        </Button>
      </Group>
    </Stack>
  );
}

function BucketStatusForm({
  value,
  onChange,
  accounts,
  buckets,
}: {
  value: BucketStatusSettings;
  onChange: (value: BucketStatusSettings) => void;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const groups = accounts
    .map((a) => ({
      group: a.name,
      items: buckets
        .filter((b) => b.source_account_id === a.id)
        .map((b) => ({ value: b.id, label: b.name })),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <>
      <Select
        label={t("dashboard.bucketStatus.show")}
        data={BUCKET_STATUS_MODES.map((m) => ({
          value: m,
          label: t(`dashboard.bucketStatus.modes.${m}`),
        }))}
        value={value.mode}
        allowDeselect={false}
        onChange={(v) => {
          const mode = BUCKET_STATUS_MODES.find((m) => m === v);
          if (mode) onChange({ ...value, mode });
        }}
      />
      {value.mode === "account" && (
        <Select
          label={t("dashboard.accounts.account")}
          placeholder={t("dashboard.accounts.pickAccount")}
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={accounts.some((a) => a.id === value.accountId) ? value.accountId : null}
          onChange={(accountId) => {
            onChange({ ...value, accountId });
          }}
        />
      )}
      {value.mode === "bucket" && (
        <Select
          label={t("dashboard.bucketStatus.bucket")}
          placeholder={t("dashboard.bucketStatus.pickBucket")}
          data={groups}
          value={buckets.some((b) => b.id === value.bucketId) ? value.bucketId : null}
          onChange={(bucketId) => {
            onChange({ ...value, bucketId });
          }}
          searchable
        />
      )}
    </>
  );
}

function AccountsForm({
  value,
  onChange,
  accounts,
}: {
  value: AccountsSettings;
  onChange: (value: AccountsSettings) => void;
  accounts: Account[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <Select
        label={t("dashboard.accounts.show")}
        data={ACCOUNTS_MODES.map((m) => ({ value: m, label: t(`dashboard.accounts.modes.${m}`) }))}
        value={value.mode}
        allowDeselect={false}
        onChange={(v) => {
          const mode = ACCOUNTS_MODES.find((m) => m === v);
          if (mode) onChange({ ...value, mode });
        }}
      />
      {value.mode === "account" && (
        <Select
          label={t("dashboard.accounts.account")}
          placeholder={t("dashboard.accounts.pickAccount")}
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={accounts.some((a) => a.id === value.accountId) ? value.accountId : null}
          onChange={(accountId) => {
            onChange({ ...value, accountId });
          }}
          searchable
        />
      )}
    </>
  );
}

/** All accounts, as the account Select's value. */
const ALL = "all";

function InOutForm({
  value,
  onChange,
  accounts,
}: {
  value: InOutSettings;
  onChange: (value: InOutSettings) => void;
  accounts: Account[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <Checkbox.Group
        label={t("dashboard.inOut.show")}
        value={value.figures}
        error={value.figures.length === 0 ? t("dashboard.inOut.figuresRequired") : undefined}
        onChange={(picked) => {
          // Keep the figures in their usual order.
          onChange({ ...value, figures: FLOW_FIGURES.filter((f) => picked.includes(f)) });
        }}
      >
        <Group gap="md" mt={4}>
          {FLOW_FIGURES.map((f) => (
            <Checkbox key={f} value={f} label={t(`dashboard.inOut.figures.${f}`)} />
          ))}
        </Group>
      </Checkbox.Group>
      <Select
        label={t("dashboard.inOut.period")}
        data={FLOW_PERIODS.map((p) => ({
          value: p,
          label: t(`dashboard.inOut.periodOptions.${p}`),
        }))}
        value={value.period}
        allowDeselect={false}
        onChange={(v) => {
          const period = FLOW_PERIODS.find((p) => p === v);
          if (period) onChange({ ...value, period });
        }}
      />
      {value.period === "days" && (
        <NumberInput
          label={t("dashboard.inOut.days")}
          description={t("dashboard.inOut.daysHint")}
          min={1}
          max={MAX_DAYS}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          // 0 stands for an empty field, which can't be saved.
          value={value.days || ""}
          onChange={(v) => {
            const days = typeof v === "number" ? v : Number.parseInt(v, 10);
            onChange({ ...value, days: Number.isNaN(days) ? 0 : days });
          }}
          maw={160}
        />
      )}
      <Select
        label={t("dashboard.inOut.accounts")}
        description={t("dashboard.inOut.accountsHint")}
        data={[
          { value: ALL, label: t("dashboard.accounts.modes.all") },
          ...accounts.map((a) => ({ value: a.id, label: a.name })),
        ]}
        value={
          value.accountId && accounts.some((a) => a.id === value.accountId) ? value.accountId : ALL
        }
        allowDeselect={false}
        onChange={(v) => {
          onChange({ ...value, accountId: v && v !== ALL ? v : null });
        }}
      />
    </>
  );
}

/** A select in the settings dialog, its list in place inside a full-screen dialog on phones (#122). */
function ChoiceSelect<V extends string | number>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <Select
      comboboxProps={{ withinPortal: false }}
      label={label}
      data={choices.map((c) => ({ value: String(c.value), label: c.label }))}
      value={String(value)}
      allowDeselect={false}
      onChange={(v) => {
        const picked = choices.find((c) => String(c.value) === v);
        if (picked) onChange(picked.value);
      }}
    />
  );
}

/**
 * A module widget's settings: the saved module, compact or full, the
 * period line, and the compact form's options for the module's type (#203).
 */
function ModuleForm({
  value,
  saved,
  onChange,
}: {
  value: ModuleWidgetSettings;
  saved: SavedModule[];
  onChange: (value: ModuleWidgetSettings) => void;
}) {
  const { t } = useTranslation();
  const type = saved.find((g) => g.id === value.savedModuleId)?.module.type;
  const compact = value.view === "compact";
  const count = (n: number, zero: string) => (n === 0 ? zero : String(n));
  const { transactions, flows, budget } = value;
  return (
    <>
      <Select
        // Inside a full-screen dialog on phones: render the list in place (#122's touch fix).
        comboboxProps={{ withinPortal: false }}
        maxDropdownHeight={360}
        label={t("dashboard.module.savedModule")}
        placeholder={t("dashboard.module.pick")}
        data={savedModuleOptions(saved, t)}
        value={type ? value.savedModuleId : null}
        allowDeselect={false}
        searchable
        onChange={(id) => {
          if (id) onChange({ ...value, savedModuleId: id });
        }}
      />
      <Input.Wrapper label={t("dashboard.module.view.label")}>
        <SegmentedControl
          fullWidth
          data={MODULE_VIEWS.map((v) => ({ value: v, label: t(`dashboard.module.view.${v}`) }))}
          value={value.view}
          onChange={(v) => {
            const view = MODULE_VIEWS.find((x) => x === v);
            if (view) onChange({ ...value, view });
          }}
        />
      </Input.Wrapper>
      <Checkbox
        label={t("dashboard.module.options.showPeriod")}
        checked={value.showPeriod}
        onChange={(e) => {
          onChange({ ...value, showPeriod: e.currentTarget.checked });
        }}
      />
      {compact && type === "graph" && (
        <Input.Wrapper label={t("dashboard.module.options.graphHeight")}>
          <SegmentedControl
            fullWidth
            data={GRAPH_HEIGHTS.map((h) => ({
              value: h,
              label: t(`dashboard.module.options.heights.${h}`),
            }))}
            value={value.graphHeight}
            onChange={(v) => {
              const graphHeight = GRAPH_HEIGHTS.find((x) => x === v);
              if (graphHeight) onChange({ ...value, graphHeight });
            }}
          />
        </Input.Wrapper>
      )}
      {compact && type === "transactions" && (
        <>
          <ChoiceSelect
            label={t("dashboard.module.options.summary")}
            choices={COMPACT_SUMMARIES.map((v) => ({
              value: v,
              label: t(`dashboard.module.options.summaries.${v}`),
            }))}
            value={transactions.summary}
            onChange={(summary) => {
              onChange({ ...value, transactions: { ...transactions, summary } });
            }}
          />
          <ChoiceSelect
            label={t("dashboard.module.options.rows")}
            choices={COMPACT_ROWS.map((n) => ({
              value: n,
              label: count(n, t("dashboard.module.options.none")),
            }))}
            value={transactions.rows}
            onChange={(rows) => {
              onChange({ ...value, transactions: { ...transactions, rows } });
            }}
          />
        </>
      )}
      {compact && type === "flows" && (
        <>
          <Checkbox.Group
            label={t("dashboard.module.options.figures")}
            value={flows.figures}
            error={
              flows.figures.length === 0 ? t("dashboard.module.options.figuresRequired") : undefined
            }
            onChange={(picked) => {
              const figures = COMPACT_FIGURES.filter((f) => picked.includes(f));
              onChange({ ...value, flows: { ...flows, figures } });
            }}
          >
            <Group gap="md" mt={4}>
              {COMPACT_FIGURES.map((f) => (
                <Checkbox key={f} value={f} label={accountFigureLabel(f)} />
              ))}
            </Group>
          </Checkbox.Group>
          <ChoiceSelect
            label={t("dashboard.module.options.top")}
            choices={COMPACT_TOPS.map((n) => ({
              value: n,
              label: count(n, t("dashboard.module.options.none")),
            }))}
            value={flows.top}
            onChange={(top) => {
              onChange({ ...value, flows: { ...flows, top } });
            }}
          />
          {flows.top > 0 && (
            <ChoiceSelect
              label={t("dashboard.module.options.topOf")}
              choices={COMPACT_TOP_OF.map((v) => ({
                value: v,
                label: t(`dashboard.module.options.topOfOptions.${v}`),
              }))}
              value={flows.topOf}
              onChange={(topOf) => {
                onChange({ ...value, flows: { ...flows, topOf } });
              }}
            />
          )}
        </>
      )}
      {compact && type === "budget" && (
        <>
          <ChoiceSelect
            label={t("dashboard.module.options.buckets")}
            choices={COMPACT_BUDGET_ROWS.map((n) => ({
              value: n,
              label: count(n, t("dashboard.module.options.all")),
            }))}
            value={budget.rows}
            onChange={(rows) => {
              onChange({ ...value, budget: { ...budget, rows } });
            }}
          />
          <ChoiceSelect
            label={t("dashboard.module.options.order")}
            choices={COMPACT_BUDGET_ORDERS.map((v) => ({
              value: v,
              label: t(`dashboard.module.options.orders.${v}`),
            }))}
            value={budget.order}
            onChange={(order) => {
              onChange({ ...value, budget: { ...budget, order } });
            }}
          />
          <Checkbox
            label={t("dashboard.module.options.attention")}
            checked={budget.attention}
            onChange={(e) => {
              onChange({ ...value, budget: { ...budget, attention: e.currentTarget.checked } });
            }}
          />
          <Checkbox
            label={t("dashboard.module.options.total")}
            checked={budget.total}
            onChange={(e) => {
              onChange({ ...value, budget: { ...budget, total: e.currentTarget.checked } });
            }}
          />
        </>
      )}
    </>
  );
}
