import { BarChart, LineChart } from "@mantine/charts";
import { Box, Stack, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useStatsSeries } from "@/api/stats";
import { QueryState } from "@/components/QueryState";
import {
  cleanGraph,
  fitResolution,
  graphData,
  intervalLink,
  shownCurrency,
  showDots,
  statsQuery,
  yDomain,
  type GraphData,
  type GraphSettings,
} from "@/lib/graphs";
import { getLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";

import "@mantine/charts/styles.css";
import "./graphs.css";

/** Room the Y axis takes from the plot. */
const AXIS_PX = 64;

interface GraphViewProps {
  settings: GraphSettings;
  /** The period resolved now; null when it doesn't resolve (no cycle). */
  period: Period | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  height?: number;
}

/**
 * A line or bar graph (#122), from the Stats API. It measures its width,
 * goes coarser when the intervals don't fit and says so, shows exact
 * amounts on hover, and opens the transactions behind a bar or point.
 */
export function GraphView({
  settings,
  period,
  cycles,
  accounts,
  buckets,
  height = 320,
}: GraphViewProps) {
  const { t } = useTranslation();
  const { ref, width } = useElementSize();
  const s = cleanGraph(settings);
  const plot = Math.max(0, width - AXIS_PX);
  const fitted = period
    ? fitResolution(period, s.resolution, s.kind, plot, cycles)
    : { resolution: s.resolution, coarsened: false };
  const query = useStatsSeries(period ? statsQuery(s, period, fitted.resolution) : null);
  const { currency, leftOut } = shownCurrency(s, accounts);

  return (
    <Box ref={ref}>
      {period === null ? (
        <Text c="dimmed">{t("stats.graphs.noPeriod")}</Text>
      ) : (
        <QueryState query={query}>
          {(result) => {
            const data = graphData(result, s, fitted.resolution, currency, accounts, buckets);
            return (
              <Stack gap="xs">
                <Chart
                  data={data}
                  settings={s}
                  currency={currency}
                  height={height}
                  dots={showDots(data.rows.length, plot)}
                  intervals={result.intervals}
                />
                <Notes
                  data={data}
                  leftOut={leftOut}
                  coarsened={
                    fitted.coarsened ? t(`stats.resolution.options.${fitted.resolution}`) : null
                  }
                />
              </Stack>
            );
          }}
        </QueryState>
      )}
    </Box>
  );
}

interface ChartProps {
  data: GraphData;
  settings: GraphSettings;
  currency: string;
  height: number;
  dots: boolean;
  intervals: { start: string; end: string }[];
}

function Chart({ data, settings, currency, height, dots, intervals }: ChartProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const empty =
    data.series.length === 0 || data.series.every((x) => x.amounts.every((a) => Number(a) === 0));
  if (empty && settings.metric !== "balance") {
    return <Text c="dimmed">{t("stats.graphs.empty")}</Text>;
  }
  const open = (seriesName: string, index: unknown) => {
    const interval = intervals[Number(index)];
    if (interval) void navigate(intervalLink(settings, seriesName, interval));
  };
  const domain = yDomain(data, settings);
  const money = (n: number) => formatMoney(n.toFixed(2), currency);
  const compact = (n: number) =>
    new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const common = {
    h: height,
    data: data.rows,
    dataKey: "label",
    series: data.series.map(({ name, label, color }) => ({ name, label, color })),
    valueFormatter: money,
    withLegend: data.series.length > 1,
    legendProps: { verticalAlign: "bottom" as const },
    yAxisProps: { tickFormatter: compact, width: AXIS_PX - 8, ...(domain ? { domain } : {}) },
    xAxisProps: { minTickGap: 12 },
    tooltipProps: {
      labelFormatter: (_: unknown, payload: readonly { payload?: { title?: string } }[]) =>
        payload[0]?.payload?.title ?? "",
    },
    "aria-label": t("stats.graphs.chartLabel"),
  };
  if (settings.kind === "bar") {
    return (
      <BarChart
        {...common}
        type={settings.side_by_side ? "default" : "stacked"}
        maxBarWidth={48}
        barProps={(series) => ({
          onClick: (_: unknown, index: number) => {
            open(series.name, index);
          },
          style: { cursor: "pointer" },
        })}
      />
    );
  }
  const single = data.series.length === 1 ? (data.series[0]?.name ?? "") : "";
  return (
    <LineChart
      {...common}
      curveType={settings.stepped ? "stepAfter" : "linear"}
      strokeWidth={2}
      withDots={dots}
      dotProps={{ r: 4 }}
      activeDotProps={{ r: 5 }}
      connectNulls
      lineChartProps={{
        onClick: (state: { activeTooltipIndex?: unknown }) => {
          open(single, state.activeTooltipIndex);
        },
        style: { cursor: "pointer" },
      }}
    />
  );
}

function Notes({
  data,
  leftOut,
  coarsened,
}: {
  data: GraphData;
  leftOut: number;
  coarsened: string | null;
}) {
  const { t } = useTranslation();
  const notes = [
    coarsened && t("stats.graphs.coarsened", { resolution: coarsened }),
    data.other > 0 && t("stats.graphs.otherNote", { count: data.other }),
    leftOut > 0 && t("stats.graphs.leftOut", { count: leftOut }),
  ].filter((n): n is string => typeof n === "string");
  if (notes.length === 0) return null;
  return (
    <Stack gap={2}>
      {notes.map((n) => (
        <Text key={n} size="sm" c="dimmed">
          {n}
        </Text>
      ))}
    </Stack>
  );
}
