import { BarChart, LineChart } from "@mantine/charts";
import { Box, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useStatsSeries, type StatsSeries } from "@/api/stats";
import { QueryState } from "@/components/QueryState";
import {
  cleanGraph,
  compareGraphData,
  fitResolution,
  intervalLink,
  maxIntervals,
  pieData,
  pieSlicing,
  queryResolution,
  shownCurrency,
  showDots,
  statsQuery,
  yDomain,
  PREVIOUS_SUFFIX,
  type CompareMode,
  type GraphData,
  type GraphKind,
  type GraphSettings,
} from "@/lib/graphs";
import { getLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import type { Period, Resolution } from "@/lib/periods";

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
  /** A bar, point or slice opens its transactions; off on the Dashboard (#124), where the whole graph opens Stats. */
  clickThrough?: boolean;
  /** The previous period, beside this one or taken from it (reports, #125). */
  compare?: Compare;
}

export interface Compare {
  period: Period;
  mode: CompareMode;
  /** The two periods' names, over a compared pie's two pies. */
  labels: { current: string; previous: string };
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
  clickThrough = true,
  compare,
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
  // The previous period at the same resolution, so the intervals line up.
  const previous = useStatsSeries(
    period && compare ? statsQuery(s, compare.period, resolution) : null,
  );
  const view: View = { s, fitted, resolution, ...shownCurrency(s, accounts) };

  // While a changed graph loads, the previous numbers are kept (#167). They
  // are drawn as they were, with the settings they were fetched for: the new
  // settings on the old numbers mixed them up (bucket lines read per account
  // all became Total). Remembered in state, not a ref, as React allows.
  const [settled, setSettled] = useState<{ data: StatsSeries; view: View } | null>(null);
  if (query.data && !query.isPlaceholderData && settled?.data !== query.data) {
    setSettled({ data: query.data, view });
  }
  const waiting = query.isPlaceholderData && settled !== null;

  const render = (result: StatsSeries, { s, fitted, resolution, currency, leftOut }: View) => {
    const coarsened = fitted.coarsened && {
      why: fitted.coarsened,
      resolution: t(`stats.resolution.options.${fitted.resolution}`),
      max: maxIntervals(s.kind),
      kind: s.kind,
    };
    if (compare && !previous.data) {
      return previous.isError ? (
        <Text c="dimmed">{t("stats.reports.previousFailed")}</Text>
      ) : (
        <Loader size="sm" />
      );
    }
    const before = compare && previous.data ? previous.data : null;
    if (s.kind === "pie" && before && compare) {
      const now = pieData(result, s, resolution, currency, accounts, buckets);
      const then = pieData(before, s, resolution, currency, accounts, buckets);
      const half = width >= 640 ? width / 2 : width;
      return (
        <Stack gap="xs">
          <SimpleGrid cols={width >= 640 ? 2 : 1} spacing="md">
            {[
              { pie: now, label: compare.labels.current },
              { pie: then, label: compare.labels.previous },
            ].map(({ pie, label }) => (
              <Stack key={label} gap={4}>
                <Text size="sm" fw={500}>
                  {label}
                </Text>
                {pie.slices.length === 0 ? (
                  <Text c="dimmed">{t("stats.graphs.empty")}</Text>
                ) : (
                  <PieView data={pie} settings={s} currency={currency} width={half} />
                )}
              </Stack>
            ))}
          </SimpleGrid>
          <Notes
            other={now.other}
            belowZero={now.belowZero}
            leftOut={leftOut}
            coarsened={coarsened}
          />
        </Stack>
      );
    }
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
              linkOf={
                clickThrough
                  ? (slice) => {
                      const interval = result.intervals[slice.index] ?? result.intervals[0];
                      const series = slice.name.startsWith("i-") ? "total" : slice.name;
                      return interval ? intervalLink(s, series, interval) : "/transactions";
                    }
                  : undefined
              }
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
    const data = compareGraphData(
      result,
      before && compare ? { result: before, mode: compare.mode } : null,
      s,
      fitted.resolution,
      currency,
      accounts,
      buckets,
    );
    return (
      <Stack gap="xs">
        <Chart
          data={data}
          settings={s}
          currency={currency}
          height={height}
          dots={showDots(data.rows.length, plot)}
          intervals={result.intervals}
          clickThrough={clickThrough}
        />
        <Notes other={data.other} leftOut={leftOut} coarsened={coarsened} />
      </Stack>
    );
  };

  return (
    <Box
      ref={ref}
      aria-busy={waiting || undefined}
      data-loading={waiting || undefined}
      style={{ opacity: waiting ? 0.5 : 1, transition: "opacity 150ms" }}
    >
      {period === null ? (
        <Text c="dimmed">{t("stats.graphs.noPeriod")}</Text>
      ) : (
        <QueryState query={query}>
          {(result) => (waiting ? render(settled.data, settled.view) : render(result, view))}
        </QueryState>
      )}
    </Box>
  );
}

/** What a graph is drawn with, besides its numbers. */
interface View {
  s: GraphSettings;
  fitted: ReturnType<typeof fitResolution>;
  resolution: Resolution;
  currency: string;
  leftOut: number;
}

interface ChartProps {
  data: GraphData;
  settings: GraphSettings;
  currency: string;
  height: number;
  dots: boolean;
  intervals: { start: string; end: string }[];
  clickThrough: boolean;
}

function Chart({ data, settings, currency, height, dots, intervals, clickThrough }: ChartProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const empty =
    data.series.length === 0 || data.series.every((x) => x.amounts.every((a) => Number(a) === 0));
  if (empty && settings.metric !== "balance") {
    return <Text c="dimmed">{t("stats.graphs.empty")}</Text>;
  }
  const compared = data.series.some((x) => x.previous);
  const open = (seriesName: string, index: unknown) => {
    // The previous period's series open nothing: their intervals aren't these.
    if (seriesName.endsWith(PREVIOUS_SUFFIX)) return;
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
    series: data.series.map(({ name, label, color, previous }) => ({
      name,
      label,
      // The previous period's bars are a lighter step of the same colour.
      color:
        previous && settings.kind === "bar"
          ? `color-mix(in srgb, ${color} 45%, var(--mantine-color-body))`
          : color,
      ...(previous && settings.kind === "line" ? { strokeDasharray: "5 4" } : {}),
      // Stacked bars stack per period: this period's and the previous one's.
      ...(compared && !settings.side_by_side ? { stackId: previous ? "previous" : "current" } : {}),
    })),
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
        type={settings.side_by_side || compared ? "default" : "stacked"}
        maxBarWidth={48}
        barProps={
          clickThrough
            ? (series) => ({
                onClick: (_: unknown, index: number) => {
                  open(series.name, index);
                },
                style: { cursor: "pointer" },
              })
            : undefined
        }
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
      lineChartProps={
        clickThrough
          ? {
              onClick: (state: { activeTooltipIndex?: unknown }) => {
                open(single, state.activeTooltipIndex);
              },
              style: { cursor: "pointer" },
            }
          : undefined
      }
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
