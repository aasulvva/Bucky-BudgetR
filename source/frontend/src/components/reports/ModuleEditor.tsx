import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Input,
  MultiSelect,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useSession } from "@/app/session";
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
  PART_MODULE_TYPES,
  SECTION_UNITS,
  type SectionModule,
  newModule,
  subPeriods,
  type Breakdown,
  type BudgetModule,
  FLOWS_SHOWS,
  FLOWS_VIEWS,
  type FlowsModule,
  type GraphModule,
  type ReportModule,
  type ReportSettings,
  type TransactionsModule,
  TRANSACTIONS_GROUPS,
  TRANSACTIONS_ORDERS,
  TRANSACTIONS_SECTIONS,
  withoutPeriod,
} from "@/lib/reports";
import {
  DEFAULT_COLUMNS,
  TRANSACTION_COLUMNS,
  TRANSACTIONS_ROWS,
  TRANSACTIONS_VIEWS,
  type TransactionColumn,
} from "@/lib/transactionTable";
import { USER_TYPES } from "@/lib/transactionList";
import { readSavedModules, savedModuleOptions, toReportModule } from "@/lib/savedModules";

/** An In/out/balance module's average (#220). */
const FLOWS_AVERAGES = ["none", "month", "cycle"] as const;

/** A module title's most characters. */
export const MAX_MODULE_TITLE = 80;
const MAX_TITLE = MAX_MODULE_TITLE;

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
  /** In a section (#194): no sections, and no breakdowns, as a part is short. */
  inSection?: boolean;
  /** A saved module on its own (#201): an empty filter means all, not the report's. */
  standalone?: boolean;
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
  // A copied saved module's fields start over, with its settings.
  const [copies, setCopies] = useState(0);
  const tooLong = (draft.title ?? "").trim().length > MAX_TITLE;
  const saved = readSavedModules(useSession().data?.preferences.saved_modules);
  const [copied, setCopied] = useState<string | null>(null);
  // The four types don't fit side by side on a phone.
  const theme = useMantineTheme();
  const phone = !useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);

  return (
    <Stack gap="md">
      {adding && !rest.standalone && saved.length > 0 && (
        <Select
          comboboxProps={{ withinPortal: false }}
          label={t("stats.reports.module.fromSaved")}
          description={t("stats.reports.module.fromSavedHint")}
          placeholder={t("stats.reports.module.fromSavedPlaceholder")}
          data={savedModuleOptions(saved, t)}
          value={copied}
          onChange={(id) => {
            setCopied(id);
            const s = saved.find((x) => x.id === id);
            if (!s) return;
            // A copy, over the report's period; the id stays the new one's.
            setDraft({ ...toReportModule(s, report), id: draft.id });
            setCopies((n) => n + 1);
          }}
          searchable
          clearable
        />
      )}
      {adding && (
        <Input.Wrapper label={t("stats.reports.module.type")}>
          <SegmentedControl
            fullWidth
            orientation={phone ? "vertical" : "horizontal"}
            mt={4}
            data={(rest.inSection ? PART_MODULE_TYPES : MODULE_TYPES).map((x) => ({
              value: x,
              label: t(`stats.reports.module.types.${x}`),
            }))}
            value={draft.type}
            onChange={(type) => {
              if (type === draft.type) return;
              setCopied(null);
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
      <Stack key={copies} gap="md">
        {draft.type === "transactions" ? (
          <TransactionsFields draft={draft} onChange={setDraft} {...rest} />
        ) : draft.type === "flows" ? (
          <FlowsFields draft={draft} onChange={setDraft} {...rest} />
        ) : draft.type === "budget" ? (
          <BudgetFields draft={draft} onChange={setDraft} {...rest} />
        ) : draft.type === "section" ? (
          <SectionFields draft={draft} onChange={setDraft} />
        ) : (
          <GraphFields draft={draft} onChange={setDraft} report={report} {...rest} />
        )}
      </Stack>
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

/** A module that isn't a graph or a section: what the Stats tab edits in place (#204). */
export type PlainModule = TransactionsModule | FlowsModule | BudgetModule;

/**
 * A transactions, in/out/balance or budget module's fields, applied as
 * they change: the Stats tab shows them in place (#204), as a graph's
 * controls are. Each group of fields is one element, so a grid can lay
 * them out side by side.
 */
export function ModuleFields({
  module,
  onChange,
  ...rest
}: Omit<FieldsProps, "comparable"> & {
  module: PlainModule;
  onChange: (module: PlainModule) => void;
}) {
  const props = { ...rest, comparable: false };
  return module.type === "transactions" ? (
    <TransactionsFields draft={module} onChange={onChange} {...props} />
  ) : module.type === "flows" ? (
    <FlowsFields draft={module} onChange={onChange} {...props} />
  ) : (
    <BudgetFields draft={module} onChange={onChange} {...props} />
  );
}

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
  inSection,
  standalone,
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
        inherits={!standalone}
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
      {!inSection && (
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
      )}
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
  standalone,
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
        inherits={!standalone}
      />
      <Stack gap="sm">
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
      </Stack>
      <Stack gap="sm">
        <Input.Wrapper
          label={t("stats.reports.transactions.sections.label")}
          description={t("stats.reports.transactions.sections.hint")}
        >
          <SegmentedControl
            fullWidth
            mt={4}
            data={TRANSACTIONS_SECTIONS.map((x) => ({
              value: x,
              label: t(`stats.reports.transactions.sections.options.${x}`),
            }))}
            value={s.sections ?? "off"}
            onChange={(x) => {
              set({ sections: x });
            }}
          />
        </Input.Wrapper>
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
      </Stack>
      <Stack gap="sm">
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
        <Input.Wrapper label={t("stats.reports.transactions.view.label")}>
          <SegmentedControl
            fullWidth
            mt={4}
            data={TRANSACTIONS_VIEWS.map((v) => ({
              value: v,
              label: t(`stats.reports.transactions.view.options.${v}`),
            }))}
            value={s.view ?? "list"}
            onChange={(v) => {
              set({ view: v });
            }}
          />
        </Input.Wrapper>
        {s.view === "table" && (
          <>
            <ColumnsField
              value={s.columns?.length ? s.columns : DEFAULT_COLUMNS}
              onChange={(columns) => {
                set({ columns });
              }}
            />
            <Input.Wrapper label={t("stats.reports.transactions.rows.label")}>
              <SegmentedControl
                fullWidth
                mt={4}
                data={TRANSACTIONS_ROWS.map((r) => ({
                  value: r,
                  label: t(`stats.reports.transactions.rows.options.${r}`),
                }))}
                value={s.rows ?? "transaction"}
                onChange={(r) => {
                  set({ rows: r });
                }}
              />
            </Input.Wrapper>
          </>
        )}
      </Stack>
    </>
  );
}

/**
 * A table's columns (#185): the chosen ones first, in order, with buttons to
 * move them, then the others. At least one stays chosen.
 */
function ColumnsField({
  value,
  onChange,
}: {
  value: TransactionColumn[];
  onChange: (columns: TransactionColumn[]) => void;
}) {
  const { t } = useTranslation();
  const name = (c: TransactionColumn) => t(`stats.reports.transactions.table.columns.${c}`);
  const move = (i: number, d: -1 | 1) => {
    const list = [...value];
    const [c] = list.splice(i, 1);
    if (c) list.splice(i + d, 0, c);
    onChange(list);
  };
  const rest = TRANSACTION_COLUMNS.filter((c) => !value.includes(c));
  return (
    <Input.Wrapper
      label={t("stats.reports.transactions.table.columnsLabel")}
      description={t("stats.reports.transactions.table.columnsHint")}
    >
      <Stack gap={2} mt={6}>
        {value.map((c, i) => (
          <Group key={c} justify="space-between" wrap="nowrap" gap="xs">
            <Checkbox
              label={name(c)}
              checked
              disabled={value.length === 1}
              onChange={() => {
                onChange(value.filter((x) => x !== c));
              }}
            />
            <Group gap={2} wrap="nowrap">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={t("stats.reports.transactions.table.moveUp", { column: name(c) })}
                disabled={i === 0}
                onClick={() => {
                  move(i, -1);
                }}
              >
                <IconArrowUp size={14} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={t("stats.reports.transactions.table.moveDown", { column: name(c) })}
                disabled={i === value.length - 1}
                onClick={() => {
                  move(i, 1);
                }}
              >
                <IconArrowDown size={14} />
              </ActionIcon>
            </Group>
          </Group>
        ))}
        {rest.map((c) => (
          <Checkbox
            key={c}
            label={name(c)}
            checked={false}
            py={4}
            onChange={() => {
              onChange([...value, c]);
            }}
          />
        ))}
      </Stack>
    </Input.Wrapper>
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

/** A budget vs spending module's accounts and buckets (#126); it's always per cycle. */
function BudgetFields({
  draft,
  onChange,
  accounts,
  buckets,
  inSection,
  standalone,
}: FieldsProps & { draft: BudgetModule; onChange: (m: BudgetModule) => void }) {
  const { t } = useTranslation();
  const s = draft.budget;
  const set = (patch: Partial<BudgetModule["budget"]>) => {
    onChange({ ...draft, budget: { ...s, ...patch } });
  };
  const chosenAccounts = s.account_ids ?? [];
  return (
    <>
      <Stack gap="sm">
        <MultiSelect
          comboboxProps={{ withinPortal: false }}
          label={t("stats.graphs.accounts")}
          placeholder={
            chosenAccounts.length
              ? undefined
              : t(standalone ? "stats.graphs.allAccounts" : "stats.reports.asReport")
          }
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
          placeholder={
            s.bucket_ids?.length
              ? undefined
              : t(standalone ? "stats.graphs.allBuckets" : "stats.reports.asReport")
          }
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
      </Stack>
      <Stack gap="sm">
        <Switch
          label={t("stats.reports.budget.perCycle")}
          description={t("stats.reports.budget.perCycleHint")}
          checked={s.per_cycle !== false}
          onChange={(e) => {
            set({ per_cycle: e.currentTarget.checked });
          }}
        />
        {!inSection && (
          <Switch
            label={t("stats.reports.average.budgetLabel")}
            description={t("stats.reports.average.budgetHint")}
            checked={s.average ?? false}
            onChange={(e) => {
              set({ average: e.currentTarget.checked });
            }}
          />
        )}
        <Text size="sm" c="dimmed">
          {t("stats.reports.budget.hint")}
        </Text>
      </Stack>
    </>
  );
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
  inSection,
  standalone,
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
      <Stack gap="sm">
        <Input.Wrapper label={t("stats.reports.flows.view.label")}>
          <SegmentedControl
            fullWidth
            mt={4}
            data={FLOWS_VIEWS.map((x) => ({
              value: x,
              label: t(`stats.reports.flows.view.options.${x}`),
            }))}
            value={s.view ?? "table"}
            onChange={(x) => {
              set({ view: x });
            }}
          />
        </Input.Wrapper>
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
      </Stack>
      <Stack gap="sm">
        <MultiSelect
          comboboxProps={{ withinPortal: false }}
          label={t("stats.graphs.accounts")}
          placeholder={
            chosenAccounts.length
              ? undefined
              : t(standalone ? "stats.graphs.allAccounts" : "stats.reports.asReport")
          }
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
          placeholder={
            s.bucket_ids?.length
              ? undefined
              : t(standalone ? "stats.graphs.allBuckets" : "stats.reports.asReport")
          }
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
      </Stack>
      <Stack gap="sm">
        {show !== "buckets" && (
          <>
            <Switch
              label={t("stats.reports.flows.transfers")}
              checked={s.transfers ?? false}
              onChange={(e) => {
                set({ transfers: e.currentTarget.checked });
              }}
            />
            <Switch
              label={t("stats.reports.flows.balances")}
              description={t("stats.reports.flows.balancesHint")}
              checked={s.balances ?? false}
              onChange={(e) => {
                set({ balances: e.currentTarget.checked });
              }}
            />
          </>
        )}
        <Switch
          label={t("stats.reports.flows.details")}
          description={t("stats.reports.flows.detailsHint")}
          checked={s.details ?? false}
          onChange={(e) => {
            set({ details: e.currentTarget.checked });
          }}
        />
      </Stack>
      {!inSection && (
        <Stack gap="sm">
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
          <Input.Wrapper
            label={t("stats.reports.average.label")}
            description={t("stats.reports.average.hint")}
          >
            <SegmentedControl
              fullWidth
              mt={4}
              data={FLOWS_AVERAGES.map((a) => ({
                value: a,
                label: t(`stats.reports.average.options.${a}`),
                disabled: a === "cycle" && cycles.length === 0 && s.average !== "cycle",
              }))}
              value={s.average ?? "none"}
              onChange={(a) => {
                set({ average: a });
              }}
            />
          </Input.Wrapper>
        </Stack>
      )}
    </>
  );
}

/** A section's unit (#194): its modules are repeated per month or cycle. */
function SectionFields({
  draft,
  onChange,
}: {
  draft: SectionModule;
  onChange: (m: SectionModule) => void;
}) {
  const { t } = useTranslation();
  return (
    <Input.Wrapper
      label={t("stats.reports.section.unit.label")}
      description={t("stats.reports.section.unit.hint", { max: MAX_SUB_PERIODS })}
    >
      <SegmentedControl
        fullWidth
        mt={4}
        data={SECTION_UNITS.map((u) => ({
          value: u,
          label: t(`stats.reports.section.unit.options.${u}`),
        }))}
        value={draft.section.unit}
        onChange={(unit) => {
          onChange({ ...draft, section: { ...draft.section, unit } });
        }}
      />
    </Input.Wrapper>
  );
}
