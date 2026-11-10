import {
  Button,
  Group,
  Input,
  MultiSelect,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { FilterFields } from "@/components/stats/FilterFields";
import { GraphControls } from "@/components/stats/GraphControls";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  BREAKDOWN_MIN_DAYS,
  BREAKDOWNS,
  MAX_SUB_PERIODS,
  MODULE_COMPARES,
  MODULE_TYPES,
  newModule,
  subPeriods,
  type Breakdown,
  FLOWS_SHOWS,
  type FlowsModule,
  type GraphModule,
  type ReportModule,
  type ReportSettings,
  type TransactionsModule,
  TRANSACTIONS_GROUPS,
  TRANSACTIONS_ORDERS,
  withoutPeriod,
} from "@/lib/reports";
import { USER_TYPES } from "@/lib/transactionList";

const MAX_TITLE = 80;

interface ModuleEditorProps {
  /** The module to edit, or null when closed. */
  module: ReportModule | null;
  /** Whether it's being added. */
  adding: boolean;
  report: ReportSettings;
  choice: PeriodChoice;
  period: Period | null;
  /** Whether the report's period has one before it to compare with. */
  comparable: boolean;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  onApply: (module: ReportModule) => void;
  onClose: () => void;
}

/** A report module's settings (#125): its type when added, a title, and its type's settings. */
export function ModuleEditor(props: ModuleEditorProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal
      opened={props.module !== null}
      onClose={props.onClose}
      size="lg"
      title={t(props.adding ? "stats.reports.module.addTitle" : "stats.reports.module.editTitle")}
    >
      {props.module && <Editor {...props} module={props.module} />}
    </ResponsiveModal>
  );
}

function Editor({
  module,
  adding,
  report,
  onApply,
  onClose,
  ...rest
}: ModuleEditorProps & { module: ReportModule }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(module);
  const tooLong = (draft.title ?? "").trim().length > MAX_TITLE;

  return (
    <Stack gap="md">
      {adding && (
        <Input.Wrapper label={t("stats.reports.module.type")}>
          <SegmentedControl
            fullWidth
            mt={4}
            data={MODULE_TYPES.map((x) => ({
              value: x,
              label: t(`stats.reports.module.types.${x}`),
            }))}
            value={draft.type}
            onChange={(type) => {
              if (type === draft.type) return;
              // A new module of the other type, keeping the id and title.
              const next = newModule(report, type);
              setDraft({
                ...next,
                id: draft.id,
                ...(draft.title === undefined ? {} : { title: draft.title }),
              });
            }}
          />
        </Input.Wrapper>
      )}
      <TextInput
        label={t("stats.reports.module.title")}
        description={t("stats.reports.module.titleHint")}
        value={draft.title ?? ""}
        error={tooLong ? t("common.maxChars", { count: MAX_TITLE }) : undefined}
        onChange={(e) => {
          setDraft({ ...draft, title: e.currentTarget.value });
        }}
      />
      {draft.type === "transactions" ? (
        <TransactionsFields draft={draft} onChange={setDraft} {...rest} />
      ) : draft.type === "flows" ? (
        <FlowsFields draft={draft} onChange={setDraft} {...rest} />
      ) : (
        <GraphFields draft={draft} onChange={setDraft} report={report} {...rest} />
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={tooLong}
          onClick={() => {
            onApply(draft);
          }}
        >
          {t(adding ? "stats.reports.module.add" : "stats.reports.module.apply")}
        </Button>
      </Group>
    </Stack>
  );
}

type FieldsProps = Omit<ModuleEditorProps, "module" | "adding" | "report" | "onApply" | "onClose">;

/** A graph module's graph, comparison and breakdown (#125). */
function GraphFields({
  draft,
  onChange,
  report,
  choice,
  period,
  comparable,
  cycles,
  accounts,
  buckets,
  tags,
}: FieldsProps & {
  draft: GraphModule;
  onChange: (m: GraphModule) => void;
  report: ReportSettings;
}) {
  const { t } = useTranslation();
  const g = draft.graph;
  const breakdownWhy = useBreakdownWhy({ choice, period, cycles });
  const breakdown = draft.breakdown ?? "none";
  const why = breakdown === "none" ? null : breakdownWhy(breakdown);
  // A pie's difference would be the same two pies.
  const compares = MODULE_COMPARES.filter((c) => g.kind !== "pie" || c !== "difference");
  const compare =
    draft.compare === "difference" && g.kind === "pie" ? "both" : (draft.compare ?? "off");

  return (
    <>
      <GraphControls
        value={{ ...g, period: report.period }}
        onChange={(next) => {
          onChange({ ...draft, graph: withoutPeriod(next) });
        }}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        narrow
        reportPeriod={choice}
      />
      <Input.Wrapper
        label={t("stats.reports.compare.label")}
        description={
          comparable ? t("stats.reports.compare.hint") : t("stats.reports.compare.unavailable")
        }
      >
        <SegmentedControl
          fullWidth
          mt={4}
          disabled={!comparable}
          data={compares.map((c) => ({ value: c, label: t(`stats.reports.compare.options.${c}`) }))}
          value={compare}
          onChange={(c) => {
            onChange({ ...draft, compare: c });
          }}
        />
      </Input.Wrapper>
      <Input.Wrapper
        label={t("stats.reports.breakdown.label")}
        description={t("stats.reports.breakdown.hint", { days: BREAKDOWN_MIN_DAYS })}
      >
        <SegmentedControl
          fullWidth
          mt={4}
          data={BREAKDOWNS.map((b) => ({
            value: b,
            label: t(`stats.reports.breakdown.options.${b}`),
            disabled: b !== "none" && b !== breakdown && breakdownWhy(b) !== null,
          }))}
          value={breakdown}
          onChange={(b) => {
            onChange({ ...draft, breakdown: b });
          }}
        />
      </Input.Wrapper>
      {why && (
        <Text size="sm" c="dimmed">
          {why}
        </Text>
      )}
    </>
  );
}

/** A transactions module's filters, types and what else it shows (#126). */
function TransactionsFields({
  draft,
  onChange,
  accounts,
  buckets,
  tags,
}: FieldsProps & { draft: TransactionsModule; onChange: (m: TransactionsModule) => void }) {
  const { t } = useTranslation();
  const s = draft.transactions;
  const set = (patch: Partial<TransactionsModule["transactions"]>) => {
    onChange({ ...draft, transactions: { ...s, ...patch } });
  };
  return (
    <>
      <FilterFields
        value={s}
        onChange={set}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        inline
        inherits
      />
      <MultiSelect
        comboboxProps={{ withinPortal: false }}
        label={t("transactions.filters.type")}
        placeholder={s.types?.length ? undefined : t("transactions.filters.all")}
        data={USER_TYPES.map((x) => ({ value: x, label: t(`transactionTypes.${x}`) }))}
        value={s.types ?? []}
        onChange={(v) => {
          set({ types: USER_TYPES.filter((x) => v.includes(x)) });
        }}
        clearable
      />
      <Input.Wrapper label={t("stats.reports.transactions.groupBy.label")}>
        <SegmentedControl
          fullWidth
          mt={4}
          data={TRANSACTIONS_GROUPS.map((g) => ({
            value: g,
            label: t(`stats.reports.transactions.groupBy.options.${g}`),
          }))}
          value={s.group_by ?? "day"}
          onChange={(g) => {
            set({ group_by: g });
          }}
        />
      </Input.Wrapper>
      <Input.Wrapper label={t("stats.reports.transactions.order.label")}>
        <SegmentedControl
          fullWidth
          mt={4}
          data={TRANSACTIONS_ORDERS.map((o) => ({
            value: o,
            label: t(`stats.reports.transactions.order.options.${o}`),
          }))}
          value={s.order ?? "newest"}
          onChange={(o) => {
            set({ order: o });
          }}
        />
      </Input.Wrapper>
      <Switch
        label={t("transactions.filters.system")}
        checked={s.system ?? false}
        onChange={(e) => {
          set({ system: e.currentTarget.checked });
        }}
      />
      <Switch
        label={t("transactions.filters.reversed")}
        checked={s.reversed ?? false}
        onChange={(e) => {
          set({ reversed: e.currentTarget.checked });
        }}
      />
    </>
  );
}

/** Why a breakdown by month or cycle isn't available for the period, or null. */
function useBreakdownWhy({
  choice,
  period,
  cycles,
}: Pick<FieldsProps, "choice" | "period" | "cycles">) {
  const { t } = useTranslation();
  return (by: Exclude<Breakdown, "none">) => {
    if (!period) return null;
    const parts = subPeriods(choice, period, by, cycles);
    if (parts.ok) return null;
    return parts.reason === "short"
      ? t("stats.reports.breakdown.short", { days: BREAKDOWN_MIN_DAYS })
      : parts.reason === "many"
        ? t("stats.reports.breakdown.many", { max: MAX_SUB_PERIODS })
        : t("stats.reports.breakdown.none");
  };
}

/** An In/out/balance module's accounts and buckets, what it shows and its breakdown (#126). */
function FlowsFields({
  draft,
  onChange,
  choice,
  period,
  cycles,
  accounts,
  buckets,
}: FieldsProps & { draft: FlowsModule; onChange: (m: FlowsModule) => void }) {
  const { t } = useTranslation();
  const s = draft.flows;
  const set = (patch: Partial<FlowsModule["flows"]>) => {
    onChange({ ...draft, flows: { ...s, ...patch } });
  };
  const breakdownWhy = useBreakdownWhy({ choice, period, cycles });
  const breakdown = s.breakdown ?? "none";
  const why = breakdown === "none" ? null : breakdownWhy(breakdown);
  const show = s.show ?? "buckets";
  const chosenAccounts = s.account_ids ?? [];
  return (
    <>
      <MultiSelect
        comboboxProps={{ withinPortal: false }}
        label={t("stats.graphs.accounts")}
        placeholder={chosenAccounts.length ? undefined : t("stats.reports.asReport")}
        data={accounts.map((a) => ({ value: a.id, label: a.name }))}
        value={chosenAccounts}
        onChange={(v) => {
          set({ account_ids: v });
        }}
        clearable
      />
      <MultiSelect
        comboboxProps={{ withinPortal: false }}
        label={t("stats.graphs.buckets")}
        placeholder={s.bucket_ids?.length ? undefined : t("stats.reports.asReport")}
        data={buckets
          .filter(
            (b) => chosenAccounts.length === 0 || chosenAccounts.includes(b.source_account_id),
          )
          .map((b) => ({ value: b.id, label: b.name }))}
        value={s.bucket_ids ?? []}
        onChange={(v) => {
          set({ bucket_ids: v });
        }}
        clearable
        searchable
      />
      <Input.Wrapper label={t("stats.reports.flows.show.label")}>
        <SegmentedControl
          fullWidth
          mt={4}
          data={FLOWS_SHOWS.map((x) => ({
            value: x,
            label: t(`stats.reports.flows.show.options.${x}`),
          }))}
          value={show}
          onChange={(x) => {
            set({ show: x });
          }}
        />
      </Input.Wrapper>
      {show !== "buckets" && (
        <Switch
          label={t("stats.reports.flows.transfers")}
          checked={s.transfers ?? false}
          onChange={(e) => {
            set({ transfers: e.currentTarget.checked });
          }}
        />
      )}
      <Switch
        label={t("stats.reports.flows.details")}
        description={t("stats.reports.flows.detailsHint")}
        checked={s.details ?? false}
        onChange={(e) => {
          set({ details: e.currentTarget.checked });
        }}
      />
      <Input.Wrapper
        label={t("stats.reports.breakdown.label")}
        description={t("stats.reports.flows.breakdownHint", { days: BREAKDOWN_MIN_DAYS })}
      >
        <SegmentedControl
          fullWidth
          mt={4}
          data={BREAKDOWNS.map((b) => ({
            value: b,
            label: t(`stats.reports.breakdown.options.${b}`),
            disabled: b !== "none" && b !== breakdown && breakdownWhy(b) !== null,
          }))}
          value={breakdown}
          onChange={(b) => {
            set({ breakdown: b });
          }}
        />
      </Input.Wrapper>
      {why && (
        <Text size="sm" c="dimmed">
          {why}
        </Text>
      )}
    </>
  );
}
