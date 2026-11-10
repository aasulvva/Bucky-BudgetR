import { ActionIcon, Badge, Card, Group, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { GraphView, type Compare } from "@/components/stats/GraphView";
import { formatDateRange } from "@/lib/cycles";
import { specificLabel } from "@/lib/graphs";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  BREAKDOWN_MIN_DAYS,
  MAX_SUB_PERIODS,
  moduleGraph,
  moduleTitle,
  ownFilters,
  partResolution,
  subPeriods,
  type ReportModule,
  type ReportSettings,
  type SubPeriod,
} from "@/lib/reports";

interface ModuleCardProps {
  report: ReportSettings;
  module: ReportModule;
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
}

/** One module of a report (#125): its graph, compared or broken down as set. */
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
}: ModuleCardProps) {
  const { t } = useTranslation();
  const graph = moduleGraph(report, module);
  const title = moduleTitle(module);
  const own = ownFilters(module);
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
    <Card withBorder padding="md" aria-label={title} component="section">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600}>{title}</Text>
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
          <Group gap={2} wrap="nowrap">
            <Tooltip label={t("stats.reports.module.moveUp")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("stats.reports.module.moveUp")}
                disabled={index === 0}
                onClick={() => {
                  onMove(-1);
                }}
              >
                <IconArrowUp size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("stats.reports.module.moveDown")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("stats.reports.module.moveDown")}
                disabled={index === count - 1}
                onClick={() => {
                  onMove(1);
                }}
              >
                <IconArrowDown size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("stats.reports.module.edit")}>
              <ActionIcon
                variant="subtle"
                aria-label={t("stats.reports.module.edit")}
                onClick={onEdit}
              >
                <IconPencil size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("stats.reports.module.remove")}>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("stats.reports.module.remove")}
                onClick={onRemove}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
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
      </Stack>
    </Card>
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
