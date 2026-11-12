import { Badge, Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { SortableList, type DragHandle } from "@/components/SortableList";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  MAX_SECTION_MODULES,
  MAX_SUB_PERIODS,
  moduleTitle,
  moveModuleTo,
  moveTargets,
  ownFilters,
  removeModule,
  sectionLabel,
  sectionParts,
  type PartModule,
  type ReportModule,
  type ReportSettings,
  type SectionModule,
  type SectionPart,
} from "@/lib/reports";

import { ModuleActions, ModuleBody, type MoveToItem } from "./ModuleCard";
import { SectionParts } from "./SectionCard";

interface ReportBuilderProps {
  report: ReportSettings;
  onChange: (report: ReportSettings) => void;
  choice: PeriodChoice;
  period: Period | null;
  compare: { period: Period; label: string; currentLabel: string } | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  isDesktop: boolean;
  /** Edits a module, in the section with this id if it's in one. */
  onEdit: (m: ReportModule, section?: string) => void;
  /** Adds a module to the section with this id. */
  onAddTo: (section: string) => void;
  onSave: (m: PartModule) => void;
}

/**
 * The report builder (#202): the report's modules by title, to arrange
 * larger reports. Each can be previewed under its row, only loading then;
 * dragged by its handle or moved with the arrows within its list; and moved
 * into or out of a section with Move to…. A section's modules are listed in
 * it, and its preview is its parts.
 */
export function ReportBuilder(props: ReportBuilderProps) {
  const { report, onChange } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const remove = (id: string) => {
    // A new module may get the id again: it starts closed.
    setOpen((prev) => new Set([...prev].filter((x) => x !== id)));
    onChange(removeModule(report, id));
  };
  const setModules = (modules: ReportModule[]) => {
    onChange({ ...report, modules });
  };
  const setSection = (id: string, modules: PartModule[]) => {
    setModules(
      report.modules.map((x) =>
        x.type === "section" && x.id === id ? { ...x, section: { ...x.section, modules } } : x,
      ),
    );
  };
  /** Move to…'s places for a module, labelled. */
  const moveTo = (m: PartModule): MoveToItem[] =>
    moveTargets(report, m.id).map((x) => {
      const section = report.modules.find((s) => s.id === x.section);
      return {
        key: x.section ?? "",
        label: section
          ? t("stats.reports.builder.moveInto", { section: moduleTitle(section) })
          : t("stats.reports.builder.moveOut"),
        disabled: x.disabled,
        onClick: () => {
          onChange(moveModuleTo(report, m.id, x.section));
        },
      };
    });
  const shared = { open, toggle, remove, moveTo, ...props };

  return (
    <Stack gap="xs">
      {report.modules.length > 0 && (
        <Text size="sm" c="dimmed">
          {t("stats.reports.builder.hint")}
        </Text>
      )}
      <SortableList
        items={report.modules}
        onReorder={setModules}
        dragLabel={(name) => t("stats.reports.builder.drag", { module: name })}
      >
        {(m, i, handle) =>
          m.type === "section" ? (
            <SectionRow
              // New parts with a new period or unit: the newest open again.
              key={`${m.id}:${report.period}:${m.section.unit}`}
              {...shared}
              module={m}
              index={i}
              handle={handle}
              onModules={(list) => {
                setSection(m.id, list);
              }}
            />
          ) : (
            <ModuleRow
              {...shared}
              module={m}
              index={i}
              count={report.modules.length}
              handle={handle}
              onMove={(d) => {
                const next = [...report.modules];
                next.splice(i, 1);
                next.splice(i + d, 0, m);
                setModules(next);
              }}
            />
          )
        }
      </SortableList>
    </Stack>
  );
}

type Shared = ReportBuilderProps & {
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
  remove: (id: string) => void;
  moveTo: (m: PartModule) => MoveToItem[];
};

/** A row: its handle, title and badges, its buttons, and what's under it. */
function Row({
  title,
  nested,
  handle,
  badges,
  actions,
  children,
}: {
  title: string;
  nested: boolean;
  handle: DragHandle;
  badges: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Paper
      withBorder
      p="xs"
      component={nested ? "div" : "section"}
      aria-label={nested ? undefined : title}
      data-builder-row={nested ? "nested" : "top"}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Group wrap="nowrap" gap="xs" align="flex-start" style={{ minWidth: 0 }}>
          {handle(title)}
          <Stack gap={2} style={{ minWidth: 0 }} pt={4}>
            <Text
              component={nested ? "h3" : "h2"}
              m={0}
              fw={nested ? 500 : 600}
              size={nested ? "sm" : undefined}
              style={{ overflowWrap: "anywhere" }}
            >
              {title}
            </Text>
            <Group gap={4}>{badges}</Group>
          </Stack>
        </Group>
        {actions}
      </Group>
      {children}
    </Paper>
  );
}

/** A module's type and its own filters, as badges. */
function ModuleBadges({ module }: { module: ReportModule }) {
  const { t } = useTranslation();
  return (
    <>
      <Badge variant="light" size="sm">
        {t(`stats.reports.module.types.${module.type}`)}
      </Badge>
      {module.type === "section" ? (
        <Badge variant="light" color="gray" size="sm">
          {t(`stats.reports.section.unit.options.${module.section.unit}`)}
        </Badge>
      ) : (
        ownFilters(module).map((f) => (
          <Badge key={f} variant="light" color="gray" size="sm">
            {t(`stats.reports.ownFilters.${f}`)}
          </Badge>
        ))
      )}
    </>
  );
}

/** A module's row; in a section, `part` is the newest part, which its preview shows. */
function ModuleRow({
  module,
  index,
  count,
  handle,
  onMove,
  section,
  part,
  noPart,
  report,
  choice,
  period,
  compare,
  cycles,
  accounts,
  buckets,
  isDesktop,
  open,
  toggle,
  remove,
  moveTo,
  onEdit,
  onSave,
}: Shared & {
  module: PartModule;
  index: number;
  count: number;
  handle: DragHandle;
  onMove: (direction: -1 | 1) => void;
  /** The section it's in, if any. */
  section?: SectionModule;
  part?: SectionPart | null;
  /** Why a section has no part to preview over. */
  noPart?: string;
}) {
  const { t } = useTranslation();
  const title = moduleTitle(module);
  const previewing = open.has(module.id);
  const nested = section !== undefined;
  return (
    <Row
      title={title}
      nested={nested}
      handle={handle}
      badges={<ModuleBadges module={module} />}
      actions={
        <ModuleActions
          name={nested ? title : undefined}
          size={nested ? "sm" : "md"}
          first={index === 0}
          last={index === count - 1}
          compact={!isDesktop}
          previewing={previewing}
          onPreview={() => {
            toggle(module.id);
          }}
          onMove={onMove}
          onEdit={() => {
            onEdit(module, section?.id);
          }}
          onSave={() => {
            onSave(module);
          }}
          moveTo={moveTo(module)}
          onRemove={() => {
            remove(module.id);
          }}
        />
      }
    >
      {previewing && (
        <Box mt="sm" data-testid="module-preview">
          {nested ? (
            part ? (
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  {t("stats.reports.builder.previewPart", {
                    part: sectionLabel(part.part, cycles),
                  })}
                </Text>
                <ModuleBody
                  report={report}
                  module={module}
                  choice={part.part.choice}
                  period={part.part.period}
                  compare={part.compare}
                  cycles={cycles}
                  accounts={accounts}
                  buckets={buckets}
                  isDesktop={isDesktop}
                  headingLevel={4}
                />
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {noPart}
              </Text>
            )
          ) : (
            <ModuleBody
              report={report}
              module={module}
              choice={choice}
              period={period}
              compare={compare}
              cycles={cycles}
              accounts={accounts}
              buckets={buckets}
              isDesktop={isDesktop}
            />
          )}
        </Box>
      )}
    </Row>
  );
}

/** A section's row: its modules, sorted within it, and its parts as its preview. */
function SectionRow(
  props: Shared & {
    module: SectionModule;
    index: number;
    handle: DragHandle;
    onModules: (modules: PartModule[]) => void;
  },
) {
  const {
    module,
    index,
    handle,
    onModules,
    report,
    cycles,
    accounts,
    buckets,
    isDesktop,
    open,
    toggle,
    remove,
    onChange,
    onEdit,
    onAddTo,
  } = props;
  const { t } = useTranslation();
  const title = moduleTitle(module);
  const modules = module.section.modules;
  const previewing = open.has(module.id);
  // Its modules preview over the newest part, as the editor shows them.
  const parts = useMemo(() => sectionParts(report, module, cycles), [report, module, cycles]);
  const newest = parts.ok ? (parts.parts.at(-1) ?? null) : null;
  const noPart =
    !parts.ok && parts.reason === "many"
      ? t("stats.reports.section.many", { max: MAX_SUB_PERIODS })
      : t("stats.reports.section.none");
  return (
    <Row
      title={title}
      nested={false}
      handle={handle}
      badges={<ModuleBadges module={module} />}
      actions={
        <ModuleActions
          first={index === 0}
          last={index === report.modules.length - 1}
          compact={!isDesktop}
          previewing={previewing}
          onPreview={() => {
            toggle(module.id);
          }}
          onMove={(d) => {
            const next = [...report.modules];
            next.splice(index, 1);
            next.splice(index + d, 0, module);
            onChange({ ...report, modules: next });
          }}
          onEdit={() => {
            onEdit(module);
          }}
          onRemove={() => {
            remove(module.id);
          }}
        />
      }
    >
      <Stack gap="xs" mt="xs" data-section-modules>
        {modules.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t("stats.reports.section.noModules")}
          </Text>
        ) : (
          <SortableList
            items={modules}
            onReorder={onModules}
            dragLabel={(name) => t("stats.reports.builder.drag", { module: name })}
          >
            {(m, i, inner) => (
              <ModuleRow
                {...props}
                module={m}
                index={i}
                count={modules.length}
                handle={inner}
                section={module}
                part={newest}
                noPart={noPart}
                onMove={(d) => {
                  const next = [...modules];
                  next.splice(i, 1);
                  next.splice(i + d, 0, m);
                  onModules(next);
                }}
              />
            )}
          </SortableList>
        )}
        <Group gap="xs">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconPlus size={14} />}
            disabled={modules.length >= MAX_SECTION_MODULES}
            aria-label={t("stats.reports.section.addTo", { section: title })}
            onClick={() => {
              onAddTo(module.id);
            }}
          >
            {t("stats.reports.section.add")}
          </Button>
          {modules.length >= MAX_SECTION_MODULES && (
            <Text size="xs" c="dimmed">
              {t("stats.reports.section.max", { max: MAX_SECTION_MODULES })}
            </Text>
          )}
        </Group>
        {previewing && modules.length > 0 && (
          <Box data-testid="section-preview">
            <SectionParts
              report={report}
              module={module}
              cycles={cycles}
              accounts={accounts}
              buckets={buckets}
              isDesktop={isDesktop}
            />
          </Box>
        )}
      </Stack>
    </Row>
  );
}
