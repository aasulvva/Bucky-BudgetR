import {
  Button,
  Drawer,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { IconAdjustmentsHorizontal, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { FilterFields, type Filters } from "@/components/stats/FilterFields";
import { PeriodPicker } from "@/components/stats/PeriodPicker";
import { formatPeriod } from "@/lib/periods";
import {
  COMPARE_TOS,
  MAX_MODULES,
  newModule,
  REPORT_UNITS,
  moduleAnchor,
  reportPeriods,
  REPORT_VIEW_MODES,
  readViewMode,
  sectionParts,
  type PartModule,
  type ReportModule,
  type ReportSettings,
  type ReportViewMode,
  type SectionModule,
} from "@/lib/reports";

import { ModuleCard } from "./ModuleCard";
import { ModuleEditor } from "./ModuleEditor";
import { ReportBuilder } from "./ReportBuilder";
import { SaveModuleDialog } from "./SaveModuleDialog";
import { SectionCard } from "./SectionCard";

/** The module being edited, and the section it's in (#194), if any. */
interface Editing {
  module: ReportModule;
  adding: boolean;
  parent?: string;
}

/** A list with one item moved by one place. */
function moved<T>(list: T[], i: number, d: -1 | 1): T[] {
  const next = [...list];
  const [m] = next.splice(i, 1);
  if (m !== undefined) next.splice(i + d, 0, m);
  return next;
}

/** A list with a module put in place of the one with its id, or added at the end. */
function put<T extends { id: string }>(list: T[], m: T): T[] {
  return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
}

interface ReportViewProps {
  report: ReportSettings;
  onChange: (report: ReportSettings) => void;
  view: ReportViewMode;
  onView: (view: ReportViewMode) => void;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  isDesktop: boolean;
}

/**
 * A report on screen (#125): its period, compare-to and filters, then its
 * modules, in the report builder (#202) or in full.
 */
export function ReportView({
  report,
  onChange,
  view,
  onView,
  cycles,
  accounts,
  buckets,
  tags,
  isDesktop,
}: ReportViewProps) {
  const { t } = useTranslation();
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState<PartModule | null>(null);
  const { choice, period, label: current, compare } = reportPeriods(report, cycles);
  const compareTo = report.compare_to ?? "previous";

  const set = (patch: Partial<ReportSettings>) => {
    onChange({ ...report, ...patch });
  };
  const setModules = (modules: ReportModule[]) => {
    set({ modules });
  };
  /** A section's modules changed (#194). */
  const setSection = (id: string, f: (modules: PartModule[]) => PartModule[]) => {
    setModules(
      report.modules.map((x) =>
        x.type === "section" && x.id === id
          ? { ...x, section: { ...x.section, modules: f(x.section.modules) } }
          : x,
      ),
    );
  };
  const apply = (m: ReportModule) => {
    const parent = editing?.parent;
    if (parent !== undefined) {
      // The editor offers no section in a section.
      if (m.type !== "section") {
        setSection(parent, (list) => put(list, m));
      }
    } else {
      setModules(put(report.modules, m));
    }
    setEditing(null);
  };
  const move = (i: number, d: -1 | 1) => {
    setModules(moved(report.modules, i, d));
  };

  // A section's module is edited over its newest part (#194).
  const parent =
    editing?.parent === undefined
      ? undefined
      : report.modules.find(
          (x): x is SectionModule => x.type === "section" && x.id === editing.parent,
        );
  const parts = parent ? sectionParts(report, parent, cycles) : null;
  const newest = parts?.ok ? parts.parts.at(-1) : undefined;

  const custom = choice.kind === "custom";
  const controls = (inline: boolean) => {
    const dropdown = inline ? { withinPortal: false } : undefined;
    return (
      <SimpleGrid cols={inline ? 1 : { base: 1, sm: 2, md: 3 }} spacing="sm" verticalSpacing="sm">
        <PeriodPicker
          inline={inline}
          only={REPORT_UNITS}
          value={choice}
          cycles={cycles}
          onChange={(c) => {
            set({ period: formatPeriod(c) });
          }}
        />
        <Stack gap={4}>
          <Select
            comboboxProps={dropdown}
            label={t("stats.reports.compareTo.label")}
            data={COMPARE_TOS.map((c) => ({
              value: c,
              label: t(`stats.reports.compareTo.options.${c}`),
            }))}
            value={compareTo}
            disabled={custom}
            onChange={(c) => {
              if (c) set({ compare_to: c });
            }}
            allowDeselect={false}
          />
          <Text size="xs" c="dimmed">
            {custom
              ? t("stats.reports.compareTo.custom")
              : compare
                ? t("stats.reports.compareTo.with", { period: compare.label })
                : t("stats.reports.compare.unavailable")}
          </Text>
          {choice.kind !== "custom" && choice.unit === "cycle" && compareTo === "last_year" && (
            <Text size="xs" c="dimmed">
              {t("stats.reports.compareTo.cycle")}
            </Text>
          )}
        </Stack>
        <FilterFields
          value={report}
          onChange={(patch: Filters) => {
            set(patch);
          }}
          accounts={accounts}
          buckets={buckets}
          tags={tags}
          inline={inline}
        />
      </SimpleGrid>
    );
  };

  return (
    <Stack gap="md">
      {isDesktop ? (
        <Paper withBorder p="md">
          {controls(false)}
        </Paper>
      ) : (
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" c="dimmed" data-testid="report-summary" style={{ flex: 1, minWidth: 0 }}>
            {current}
          </Text>
          <Button
            variant="default"
            size="xs"
            style={{ flexShrink: 0 }}
            leftSection={<IconAdjustmentsHorizontal size={16} />}
            onClick={() => {
              setDrawer(true);
            }}
          >
            {t("stats.reports.settings")}
          </Button>
        </Group>
      )}
      {period === null && <Text c="dimmed">{t("stats.graphs.noPeriod")}</Text>}
      <SegmentedControl
        aria-label={t("stats.reports.view.label")}
        data={REPORT_VIEW_MODES.map((v) => ({ value: v, label: t(`stats.reports.view.${v}`) }))}
        value={view}
        onChange={(v) => {
          onView(readViewMode(v));
        }}
        style={{ alignSelf: "flex-start" }}
      />
      {report.modules.length === 0 && <Text c="dimmed">{t("stats.reports.noModules")}</Text>}
      {view === "builder" && (
        <ReportBuilder
          report={report}
          onChange={onChange}
          choice={choice}
          period={period}
          compare={compare}
          cycles={cycles}
          accounts={accounts}
          buckets={buckets}
          isDesktop={isDesktop}
          onEdit={(m, section) => {
            setEditing({ module: m, adding: false, parent: section });
          }}
          onAddTo={(section) => {
            setEditing({ module: newModule(report), adding: true, parent: section });
          }}
          onSave={setSaving}
        />
      )}
      {view === "report" &&
        report.modules.map((m, i) =>
          m.type === "section" ? (
            <SectionCard
              // New parts with a new period or unit: the newest open again.
              key={`${m.id}:${report.period}:${m.section.unit}`}
              report={report}
              module={m}
              index={i}
              count={report.modules.length}
              cycles={cycles}
              accounts={accounts}
              buckets={buckets}
              isDesktop={isDesktop}
              onEdit={() => {
                setEditing({ module: m, adding: false });
              }}
              onMove={(d) => {
                move(i, d);
              }}
              onRemove={() => {
                setModules(report.modules.filter((x) => x.id !== m.id));
              }}
              onAddModule={() => {
                setEditing({ module: newModule(report), adding: true, parent: m.id });
              }}
              onEditModule={(x) => {
                setEditing({ module: x, adding: false, parent: m.id });
              }}
              onMoveModule={(j, d) => {
                setSection(m.id, (list) => moved(list, j, d));
              }}
              onRemoveModule={(id) => {
                setSection(m.id, (list) => list.filter((x) => x.id !== id));
              }}
              onSaveModule={setSaving}
            />
          ) : (
            <ModuleCard
              key={m.id}
              report={report}
              module={m}
              index={i}
              count={report.modules.length}
              choice={choice}
              period={period}
              compare={compare}
              cycles={cycles}
              accounts={accounts}
              buckets={buckets}
              isDesktop={isDesktop}
              anchor={moduleAnchor(m.id)}
              onEdit={() => {
                setEditing({ module: m, adding: false });
              }}
              onMove={(d) => {
                move(i, d);
              }}
              onRemove={() => {
                setModules(report.modules.filter((x) => x.id !== m.id));
              }}
              onSave={() => {
                setSaving(m);
              }}
            />
          ),
        )}
      <Group>
        <Button
          variant="default"
          leftSection={<IconPlus size={16} />}
          disabled={report.modules.length >= MAX_MODULES}
          onClick={() => {
            setEditing({ module: newModule(report), adding: true });
          }}
        >
          {t("stats.reports.module.addButton")}
        </Button>
        {report.modules.length >= MAX_MODULES && (
          <Text size="sm" c="dimmed">
            {t("stats.reports.module.max", { max: MAX_MODULES })}
          </Text>
        )}
      </Group>
      <SaveModuleDialog
        key={saving?.id ?? ""}
        report={report}
        module={saving}
        onClose={() => {
          setSaving(null);
        }}
      />
      <ModuleEditor
        module={editing?.module ?? null}
        adding={editing?.adding ?? false}
        report={report}
        choice={
          newest?.part.choice ?? (parent ? { kind: "current", unit: parent.section.unit } : choice)
        }
        period={parent ? (newest?.part.period ?? null) : period}
        comparable={parent ? Boolean(newest?.compare) : compare !== null}
        inSection={parent !== undefined}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        onApply={apply}
        onClose={() => {
          setEditing(null);
        }}
      />
      {!isDesktop && (
        <Drawer
          opened={drawer}
          onClose={() => {
            setDrawer(false);
          }}
          position="bottom"
          size="90%"
          title={t("stats.reports.settings")}
        >
          {controls(true)}
        </Drawer>
      )}
    </Stack>
  );
}
