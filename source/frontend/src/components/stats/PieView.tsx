import { DonutChart } from "@mantine/charts";
import { Anchor, Box, ColorSwatch, Group, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { getLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import type { GraphSettings, PieData, PieSlice } from "@/lib/graphs";

/** From this width the list goes beside the pie instead of below it. */
const SIDE_BY_SIDE_PX = 600;
/** Slices smaller than this get no label on the pie, so labels don't collide. */
const MIN_LABEL_SHARE = 0.04;
/** Room a label takes on each side of the pie. */
const LABEL_PX = 90;
/** A label's name is cut to this many characters. */
const LABEL_CHARS = 14;

interface PieViewProps {
  data: PieData;
  settings: GraphSettings;
  currency: string;
  /** The width it has, from GraphView's measurement. */
  width: number;
  /** The Transactions link for a slice; without it, slices and rows aren't links. */
  linkOf?: (slice: PieSlice) => string;
}

/**
 * A pie (#123): a donut with the total in the middle, and a list of the
 * slices with their amounts and shares beside it, labels on the slices, or
 * both (`pie_labels`). Clicking a slice or a row opens its transactions.
 */
export function PieView({ data, settings, currency, width, linkOf }: PieViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mode = settings.pie_labels ?? "list";
  const withList = mode !== "slices";
  const withLabels = mode !== "list";
  const wide = width >= SIDE_BY_SIDE_PX;
  const room = Math.max(0, width - (withLabels ? 2 * LABEL_PX : 0));
  const size = Math.max(140, Math.min(wide ? 260 : 220, room));
  const height = size + (withLabels ? 60 : 0);
  const locale = getLocale();
  const money = (n: number) => formatMoney(n.toFixed(2), currency);
  const percent = (share: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: share < 0.1 ? 1 : 0,
    }).format(share);
  const compact = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(data.total));
  const byLabel = new Map(data.slices.map((x) => [x.label, x]));
  const open = (slice: PieSlice | undefined) => {
    if (slice && linkOf) void navigate(linkOf(slice));
  };
  const short = (name: string) =>
    name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name;

  const chart = (
    <DonutChart
      data={data.slices.map((x) => ({ name: x.label, value: Number(x.amount), color: x.color }))}
      size={size}
      thickness={Math.round(size / 7)}
      strokeWidth={2}
      chartLabel={compact}
      tooltipDataSource="segment"
      valueFormatter={money}
      withLabels={withLabels}
      // The pie stays `size` across; the box is as wide as the space, for the labels.
      style={
        withLabels ? { width: "100%", minWidth: 0, height, minHeight: height } : { flexShrink: 0 }
      }
      pieProps={
        withLabels
          ? {
              label: (p: {
                x?: number;
                y?: number;
                cx?: number | string;
                percent?: number;
                name?: string;
              }) => {
                const share = p.percent ?? 0;
                if (share < MIN_LABEL_SHARE || p.x === undefined || p.y === undefined) return null;
                const anchor = p.x > Number(p.cx) ? "start" : "end";
                return (
                  <text
                    x={p.x}
                    y={p.y}
                    textAnchor={anchor}
                    fill="var(--mantine-color-text)"
                    fontFamily="var(--mantine-font-family)"
                    fontSize={12}
                  >
                    <tspan x={p.x} dy="-0.2em">
                      {short(p.name ?? "")}
                    </tspan>
                    <tspan x={p.x} dy="1.2em" fill="var(--mantine-color-dimmed)">
                      {percent(share)}
                    </tspan>
                  </text>
                );
              },
              labelLine: (p: { percent?: number; points?: { x: number; y: number }[] }) => {
                const [a, b] = p.points ?? [];
                if ((p.percent ?? 0) < MIN_LABEL_SHARE || !a || !b) return <g />;
                return (
                  <path
                    d={`M${String(a.x)},${String(a.y)}L${String(b.x)},${String(b.y)}`}
                    stroke="var(--mantine-color-dimmed)"
                    strokeWidth={1}
                    fill="none"
                  />
                );
              },
            }
          : undefined
      }
      cellProps={
        linkOf
          ? (cell) => ({
              onClick: () => {
                open(byLabel.get(cell.name));
              },
              style: { cursor: "pointer" },
            })
          : undefined
      }
      aria-label={t("stats.graphs.chartLabel")}
    />
  );

  if (!withList) {
    return (
      <Group justify="center" data-testid="pie">
        {chart}
      </Group>
    );
  }
  const list = (
    <Table
      data-testid="pie-list"
      highlightOnHover
      verticalSpacing={4}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("stats.graphs.slice")}</Table.Th>
          <Table.Th ta="right">{t("stats.graphs.amount")}</Table.Th>
          <Table.Th ta="right">{t("stats.graphs.share")}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {data.slices.map((x) => (
          <Table.Tr
            key={x.name}
            style={linkOf ? { cursor: "pointer" } : undefined}
            onClick={
              linkOf
                ? () => {
                    open(x);
                  }
                : undefined
            }
          >
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <ColorSwatch color={x.color} size={12} withShadow={false} />
                {linkOf ? (
                  <Anchor
                    component={Link}
                    to={linkOf(x)}
                    c="inherit"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {x.label}
                  </Anchor>
                ) : (
                  <Text size="sm" span>
                    {x.label}
                  </Text>
                )}
              </Group>
            </Table.Td>
            <Table.Td ta="right">
              <Text size="sm" span style={{ whiteSpace: "nowrap" }}>
                {formatMoney(x.amount, currency)}
              </Text>
            </Table.Td>
            <Table.Td ta="right">
              <Text size="sm" span c="dimmed">
                {percent(x.share)}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
      <Table.Tfoot>
        <Table.Tr>
          <Table.Th>{t("stats.graphs.total")}</Table.Th>
          <Table.Th ta="right" style={{ whiteSpace: "nowrap" }}>
            {formatMoney(data.total, currency)}
          </Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Tfoot>
    </Table>
  );
  return wide ? (
    <Group wrap="nowrap" align="center" gap="xl" data-testid="pie">
      <Box style={withLabels ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }}>{chart}</Box>
      <Box style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>{list}</Box>
    </Group>
  ) : (
    <Stack gap="md" align="stretch" data-testid="pie">
      <Group justify="center">{chart}</Group>
      {list}
    </Stack>
  );
}
