import {
  ActionIcon,
  Badge,
  Card,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconDeviceFloppy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFolderSymlink,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { GraphView, type Compare } from "@/components/stats/GraphView";
import { formatDateRange } from "@/lib/cycles";
import { specificLabel } from "@/lib/graphs";
import type { Period, PeriodChoice } from "@/lib/periods";
import { usePrintMode } from "@/lib/print";
import {
  BREAKDOWN_MIN_DAYS,
  MAX_SUB_PERIODS,
  moduleBudget,
  moduleGraph,
  moduleFlows,
  moduleTitle,
  moduleTransactions,
  ownFilters,
  partResolution,
  subPeriods,
  type GraphModule,
  type PartModule,
  type ReportSettings,
  type SubPeriod,
} from "@/lib/reports";

import { BudgetModule } from "./BudgetModule";
import { FlowsModule } from "./FlowsModule";
import { TransactionsModule } from "./TransactionsModule";

interface ModuleCardProps {
  report: ReportSettings;
  /** A section has its own card (#194). */
  module: PartModule;
  index: number;
  count: number;
  choice: PeriodChoice;
  period: Period | null;
  /** What the report compares with, when it can. */
  compare: { period: Period; label: string; currentLabel: string } | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  isDesktop: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  /** Saves it as a saved module (#201); no button without it. */
  onSave?: () => void;
  /** The move, edit and remove buttons; not in a section's parts (#194). */
  actions?: boolean;
  /** Its title's heading level: 2, or 4 in a section's part. */
  headingLevel?: 2 | 4;
  /** Its id, which a PDF's contents link to (#193); none in a section's parts. */
  anchor?: string;
  /** In a section's part (#194): no average of its own (#220). */
  inSection?: boolean;
}

/** One module of a report (#125): its graph, compared or broken down as set, or its transactions (#126). */
export function ModuleCard({
  report,
  module,
  index,
  count,
  choice,
  period,
  compare,
  cycles,
  accounts,
  buckets,
  isDesktop,
  onEdit,
  onMove,
  onRemove,
  onSave,
  actions = true,
  headingLevel = 2,
  anchor,
  inSection = false,
}: ModuleCardProps) {
  const { t } = useTranslation();
  const print = usePrintMode();
  const title = moduleTitle(module);
  const own = ownFilters(module);

  return (
    <Card
      withBorder
      padding="md"
      aria-label={title}
      component="section"
      id={anchor}
      data-report-module
    >
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0 }}>
            {/* A heading, for the PDF's outline (#193). */}
            <Text component={headingLevel === 2 ? "h2" : "h4"} m={0} fw={600}>
              {title}
            </Text>
            {own.length > 0 && (
              <Group gap={4}>
                {own.map((f) => (
                  <Badge key={f} variant="light" color="gray" size="sm">
                    {t(`stats.reports.ownFilters.${f}`)}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
          {!print && actions && (
            <ModuleActions
              first={index === 0}
              last={index === count - 1}
              onMove={onMove}
              onEdit={onEdit}
              onRemove={onRemove}
              onSave={onSave}
            />
          )}
        </Group>
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
          anchor={anchor}
          headingLevel={headingLevel}
          average={!inSection}
        />
      </Stack>
    </Card>
  );
}

type ModuleBodyProps = Pick<
  ModuleCardProps,
  | "report"
  | "module"
  | "choice"
  | "period"
  | "compare"
  | "cycles"
  | "accounts"
  | "buckets"
  | "isDesktop"
  | "anchor"
> & {
  headingLevel?: 2 | 4;
  /** Whether a graph draws its breakdown (not in a Dashboard widget, #201). */
  breakdown?: boolean;
  /** Whether an in/out/balance or budget module shows its average (not in a section, #220). */
  average?: boolean;
};

/**
 * What a module shows, without its card: its graph, transactions, in/out
 * and balance or budget vs spending, over the period. The report's filters
 * apply where it has none of its own; a saved module (#201) shows through
 * a report of its own.
 */
export function ModuleBody({
  report,
  module,
  choice,
  period,
  compare,
  cycles,
  accounts,
  buckets,
  isDesktop,
  anchor,
  headingLevel = 2,
  breakdown = true,
  average = true,
}: ModuleBodyProps) {
  return module.type === "transactions" ? (
    <TransactionsModule
      anchor={anchor}
      headingLevel={headingLevel + 1}
      settings={moduleTransactions(report, module)}
      period={period}
      cycles={cycles}
      isDesktop={isDesktop}
    />
  ) : module.type === "flows" ? (
    <FlowsModule
      settings={moduleFlows(report, module)}
      choice={choice}
      period={period}
      cycles={cycles}
      accounts={accounts}
      buckets={buckets}
      filtered={(report.tags?.length ?? 0) > 0 || Boolean(report.counterparty?.trim())}
      average={average}
    />
  ) : module.type === "budget" ? (
    <BudgetModule
      settings={moduleBudget(report, module)}
      period={period}
      cycles={cycles}
      buckets={buckets}
      filtered={(report.tags?.length ?? 0) > 0 || Boolean(report.counterparty?.trim())}
      average={average}
    />
  ) : (
    <GraphBody
      breakdown={breakdown}
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
  );
}

/** A graph module's graph, its comparison and its breakdown. */
function GraphBody({
  report,
  module,
  choice,
  period,
  compare,
  cycles,
  accounts,
  buckets,
  isDesktop,
  breakdown: showBreakdown,
}: Pick<
  ModuleCardProps,
  "report" | "choice" | "period" | "compare" | "cycles" | "accounts" | "buckets" | "isDesktop"
> & { module: GraphModule; breakdown: boolean }) {
  const { t } = useTranslation();
  const graph = moduleGraph(report, module);
  const mode = module.compare ?? "off";
  const compared: Compare | undefined =
    mode !== "off" && compare
      ? {
          period: compare.period,
          mode: graph.kind === "pie" ? "both" : mode,
          labels: { current: compare.currentLabel, previous: compare.label },
        }
      : undefined;
  const breakdown = module.breakdown ?? "none";
  const parts =
    showBreakdown && breakdown !== "none" && period
      ? subPeriods(choice, period, breakdown, cycles)
      : null;

  return (
    <>
      {mode !== "off" && (
        <Text size="sm" c="dimmed">
          {compare
            ? t(
                mode === "difference" && graph.kind !== "pie"
                  ? "stats.reports.compare.differenceWith"
                  : "stats.reports.compare.comparedWith",
                { period: compare.label },
              )
            : t("stats.reports.compare.unavailable")}
        </Text>
      )}
      <GraphView
        settings={graph}
        period={period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={isDesktop ? 300 : 240}
        compare={compared}
      />
      {parts &&
        (parts.ok ? (
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              {t(
                breakdown === "cycle"
                  ? "stats.reports.breakdown.title.cycle"
                  : "stats.reports.breakdown.title.month",
              )}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" verticalSpacing="md">
              {parts.parts.map((part) => (
                <Part
                  key={part.period.fromAt}
                  part={part}
                  graph={graph}
                  cycles={cycles}
                  accounts={accounts}
                  buckets={buckets}
                />
              ))}
            </SimpleGrid>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {parts.reason === "short"
              ? t("stats.reports.breakdown.short", { days: BREAKDOWN_MIN_DAYS })
              : parts.reason === "many"
                ? t("stats.reports.breakdown.many", { max: MAX_SUB_PERIODS })
                : t("stats.reports.breakdown.none")}
          </Text>
        ))}
    </>
  );
}

function Part({
  part,
  graph,
  cycles,
  accounts,
  buckets,
}: {
  part: SubPeriod;
  graph: ReturnType<typeof moduleGraph>;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const label = part.partial
    ? formatDateRange(part.period.from, part.period.to)
    : specificLabel(part.choice, cycles);
  return (
    <Stack gap={4} data-testid="breakdown-part">
      <Group gap="xs">
        <Text size="sm">{label}</Text>
        {part.partial && (
          <Badge variant="light" color="gray" size="xs">
            {t("stats.reports.partial")}
          </Badge>
        )}
      </Group>
      <GraphView
        settings={{ ...graph, resolution: partResolution(graph, part, cycles) }}
        period={part.period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={180}
      />
    </Stack>
  );
}

/** A place Move to… (#202) offers, labelled. */
export interface MoveToItem {
  key: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}

/**
 * A module's buttons: move up and down, edit and remove. `name` is in their
 * labels when there are several lists of them, as in a section (#194). In
 * the report builder (#202) there's also Preview and Move to…, and on a
 * phone (`compact`) all but Preview and Edit go in a menu.
 */
export function ModuleActions({
  first,
  last,
  onMove,
  onEdit,
  onRemove,
  onSave,
  onPreview,
  previewing = false,
  moveTo = [],
  compact = false,
  name,
  size = "md",
}: {
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
  /** Saves it as a saved module (#201). */
  onSave?: () => void;
  /** Shows or hides its preview (#202). */
  onPreview?: () => void;
  previewing?: boolean;
  /** Where Move to… can put it (#202); none, no Move to…. */
  moveTo?: MoveToItem[];
  compact?: boolean;
  name?: string;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  const label = (plain: string, named: string) => (name ? named : plain);
  interface Action {
    key: string;
    label: string;
    icon: ReactNode;
    color: string | undefined;
    disabled: boolean;
    onClick: () => void;
  }
  const up: Action = {
    key: "up",
    label: label(
      t("stats.reports.module.moveUp"),
      t("stats.reports.section.moveUp", { module: name }),
    ),
    icon: <IconArrowUp size={16} />,
    color: "gray",
    disabled: first,
    onClick: () => {
      onMove(-1);
    },
  };
  const down: Action = {
    key: "down",
    label: label(
      t("stats.reports.module.moveDown"),
      t("stats.reports.section.moveDown", { module: name }),
    ),
    icon: <IconArrowDown size={16} />,
    color: "gray",
    disabled: last,
    onClick: () => {
      onMove(1);
    },
  };
  const edit: Action = {
    key: "edit",
    label: label(t("stats.reports.module.edit"), t("stats.reports.section.edit", { module: name })),
    icon: <IconPencil size={16} />,
    color: undefined,
    disabled: false,
    onClick: onEdit,
  };
  const save: Action[] = onSave
    ? [
        {
          key: "save",
          label: name
            ? t("stats.reports.module.saveNamed", { module: name })
            : t("stats.reports.module.save"),
          icon: <IconDeviceFloppy size={16} />,
          color: "gray",
          disabled: false,
          onClick: onSave,
        },
      ]
    : [];
  const remove: Action = {
    key: "remove",
    label: label(
      t("stats.reports.module.remove"),
      t("stats.reports.section.remove", { module: name }),
    ),
    icon: <IconTrash size={16} />,
    color: "red",
    disabled: false,
    onClick: onRemove,
  };
  const previewLabel = previewing
    ? label(
        t("stats.reports.builder.hidePreview"),
        t("stats.reports.builder.hidePreviewNamed", { module: name }),
      )
    : label(
        t("stats.reports.builder.preview"),
        t("stats.reports.builder.previewNamed", { module: name }),
      );
  const moveToLabel = label(
    t("stats.reports.builder.moveTo"),
    t("stats.reports.builder.moveToNamed", { module: name }),
  );

  const button = (b: Action) => (
    <Tooltip key={b.key} label={b.label}>
      <ActionIcon
        variant="subtle"
        size={size}
        color={b.color}
        aria-label={b.label}
        disabled={b.disabled}
        onClick={b.onClick}
      >
        {b.icon}
      </ActionIcon>
    </Tooltip>
  );
  const preview = onPreview && (
    <Tooltip label={previewLabel}>
      <ActionIcon
        variant={previewing ? "light" : "subtle"}
        size={size}
        aria-label={previewLabel}
        aria-pressed={previewing}
        onClick={onPreview}
      >
        {previewing ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </ActionIcon>
    </Tooltip>
  );
  const moveToItems = moveTo.map((x) => (
    <Menu.Item key={x.key} disabled={x.disabled} onClick={x.onClick}>
      {x.label}
    </Menu.Item>
  ));

  if (compact) {
    const moreLabel = label(
      t("stats.reports.builder.more"),
      t("stats.reports.builder.moreNamed", { module: name }),
    );
    return (
      <Group gap={2} wrap="nowrap">
        {preview}
        {button(edit)}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={size}
              aria-label={moreLabel}
              title={moreLabel}
            >
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {[up, down, ...save].map((b) => (
              <Menu.Item key={b.key} leftSection={b.icon} disabled={b.disabled} onClick={b.onClick}>
                {b.label}
              </Menu.Item>
            ))}
            {moveToItems.length > 0 && (
              <>
                <Menu.Label>{moveToLabel}</Menu.Label>
                {moveToItems}
              </>
            )}
            <Menu.Divider />
            <Menu.Item color="red" leftSection={remove.icon} onClick={remove.onClick}>
              {remove.label}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  }
  return (
    <Group gap={2} wrap="nowrap">
      {preview}
      {[up, down, edit, ...save].map(button)}
      {moveToItems.length > 0 && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={size}
              aria-label={moveToLabel}
              title={moveToLabel}
            >
              <IconFolderSymlink size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{moveToLabel}</Menu.Label>
            {moveToItems}
          </Menu.Dropdown>
        </Menu>
      )}
      {button(remove)}
    </Group>
  );
}
