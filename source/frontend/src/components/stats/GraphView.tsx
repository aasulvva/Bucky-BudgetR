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
  maxIntervals,
  pieData,
  pieSlicing,
  queryResolution,
  shownCurrency,
  showDots,
  statsQuery,
  yDomain,
  type GraphData,
  type GraphKind,
  type GraphSettings,
} from "@/lib/graphs";
import { getLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";

import { PieView } from "./PieView";

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
 * A line, bar or pie graph (#122, #123), from the Stats API. It measures
 * its width, goes coarser when the intervals don't fit and says so, shows
 * exact amounts on hover, and opens the transactions behind a bar, point
 * or slice.
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
  // A pie per bucket or account sums the whole period: nothing to fit.
  const whole = s.kind === "pie" && pieSlicing(s) !== "interval";
  const fitted =
    period && !whole
      ? fitResolution(period, s.resolution, s.kind, plot, cycles)
      : { resolution: s.resolution, coarsened: null };
  const resolution = queryResolution(s, fitted.resolution);
  const query = useStatsSeries(period ? statsQuery(s, period, resolution) : null);
  const { currency, leftOut } = shownCurrency(s, accounts);

  return (
    <Box ref={ref}>
      {period === null ? (
        <Text c="dimmed">{t("stats.graphs.noPeriod")}</Text>
      ) : (
        <QueryState query={query}>
          {(result) => {
            const coarsened = fitted.coarsened && {
              why: fitted.coarsened,
              resolution: t(`stats.resolution.options.${fitted.resolution}`),
              max: maxIntervals(s.kind),
              kind: s.kind,
            };
            if (s.kind === "pie") {
              const pie = pieData(result, s, resolution, currency, accounts, buckets);
              return (
                <Stack gap="xs">
                  {pie.slices.length === 0 ? (
                    <Text c="dimmed">{t("stats.graphs.empty")}</Text>
                  ) : (
                    <PieView
                      data={pie}
                      settings={s}
                      currency={currency}
                      width={width}
                      linkOf={(slice) => {
                        const interval = result.intervals[slice.index] ?? result.intervals[0];
                        const series = slice.name.startsWith("i-") ? "total" : slice.name;
                        return interval ? intervalLink(s, series, interval) : "/transactions";
                      }}
                    />
                  )}
                  <Notes
                    other={pie.other}
                    belowZero={pie.belowZero}
                    leftOut={leftOut}
                    coarsened={coarsened}
                  />
                </Stack>
              );
            }
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
                <Notes other={data.other} leftOut={leftOut} coarsened={coarsened} />
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

const TOO_MANY = {
  bar: "stats.graphs.tooManyBars",
  line: "stats.graphs.tooManyPoints",
  pie: "stats.graphs.tooManySlices",
} as const satisfies Record<GraphKind, string>;

function Notes({
  other,
  belowZero = 0,
  leftOut,
  coarsened,
}: {
  other: number;
  belowZero?: number;
  leftOut: number;
  coarsened: { why: "count" | "width"; resolution: string; max: number; kind: GraphKind } | null;
}) {
  const { t } = useTranslation();
  const notes = [
    coarsened &&
      (coarsened.why === "width"
        ? t("stats.graphs.coarsened", { resolution: coarsened.resolution })
        : t(TOO_MANY[coarsened.kind], {
            resolution: coarsened.resolution,
            max: coarsened.max,
          })),
    other > 0 && t("stats.graphs.otherNote", { count: other }),
    belowZero > 0 && t("stats.graphs.belowZero", { count: belowZero }),
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
