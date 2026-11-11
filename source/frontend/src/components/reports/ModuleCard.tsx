import { ActionIcon, Badge, Card, Group, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from "@tabler/icons-react";
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
  /** The move, edit and remove buttons; not in a section's parts (#194). */
  actions?: boolean;
  /** Its title's heading level: 2, or 4 in a section's part. */
  headingLevel?: 2 | 4;
  /** Its id, which a PDF's contents link to (#193); none in a section's parts. */
  anchor?: string;
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
  actions = true,
  headingLevel = 2,
  anchor,
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
            />
          )}
        </Group>
        {module.type === "transactions" ? (
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
          />
        ) : module.type === "budget" ? (
          <BudgetModule
            settings={moduleBudget(report, module)}
            period={period}
            cycles={cycles}
            buckets={buckets}
            filtered={(report.tags?.length ?? 0) > 0 || Boolean(report.counterparty?.trim())}
          />
        ) : (
          <GraphBody
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
      </Stack>
    </Card>
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
}: Pick<
  ModuleCardProps,
  "report" | "choice" | "period" | "compare" | "cycles" | "accounts" | "buckets" | "isDesktop"
> & { module: GraphModule }) {
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
    breakdown !== "none" && period ? subPeriods(choice, period, breakdown, cycles) : null;

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

/**
 * A module's buttons: move up and down, edit and remove. `name` is in their
 * labels when there are several lists of them, as in a section (#194).
 */
export function ModuleActions({
  first,
  last,
  onMove,
  onEdit,
  onRemove,
  name,
  size = "md",
}: {
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
  name?: string;
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  const label = (plain: string, named: string) => (name ? named : plain);
  const buttons = [
    {
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
    },
    {
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
    },
    {
      key: "edit",
      label: label(
        t("stats.reports.module.edit"),
        t("stats.reports.section.edit", { module: name }),
      ),
      icon: <IconPencil size={16} />,
      color: undefined,
      disabled: false,
      onClick: onEdit,
    },
    {
      key: "remove",
      label: label(
        t("stats.reports.module.remove"),
        t("stats.reports.section.remove", { module: name }),
      ),
      icon: <IconTrash size={16} />,
      color: "red",
      disabled: false,
      onClick: onRemove,
    },
  ];
  return (
    <Group gap={2} wrap="nowrap">
      {buttons.map((b) => (
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
      ))}
    </Group>
  );
}
