import { Anchor, Badge, Center, Group, Loader, Progress, Stack, Table, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useBucketFiguresFor, type Bucket, type BucketFigures } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { ErrorAlert } from "@/components/ErrorAlert";
import { toneText, usageColor } from "@/lib/buckets";
import { formatDateRange } from "@/lib/cycles";
import { specificLabel } from "@/lib/graphs";
import { compareAmounts, formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";
import {
  budgetRows,
  budgetSummary,
  MAX_SUB_PERIODS,
  periodCycles,
  transactionsLink,
  type BudgetRow,
  type PeriodCycle,
  type ReportBudget,
} from "@/lib/reports";

/**
 * A budget vs spending module (#126): each bucket's budget, used and left
 * per cycle that overlaps the period, whole, from the cycle's bucket
 * figures, after a summary over all of them.
 */
export function BudgetModule({
  settings,
  period,
  cycles,
  buckets,
  filtered,
}: {
  /** With the report's accounts and buckets where the module has none of its own. */
  settings: ReportBudget;
  period: Period | null;
  cycles: Cycle[];
  buckets: Bucket[];
  /** Whether the report has tags or a counterparty, which don't apply here. */
  filtered: boolean;
}) {
  const { t } = useTranslation();
  const list = period ? periodCycles(period, cycles) : null;
  const shown = list?.ok ? list.cycles : [];
  const queries = useBucketFiguresFor(shown.map((c) => c.id));
  if (!list) return null;

  const note = filtered && (
    <Text size="sm" c="dimmed">
      {t("stats.reports.budget.filtersNote")}
    </Text>
  );
  if (!list.ok) {
    return (
      <Stack gap="sm">
        {note}
        <Text size="sm" c="dimmed">
          {list.reason === "many"
            ? t("stats.reports.budget.many", { max: MAX_SUB_PERIODS })
            : t("stats.reports.budget.none")}
        </Text>
      </Stack>
    );
  }
  const failed = queries.find((q) => q.isError);
  if (failed) {
    return (
      <ErrorAlert
        error={failed.error}
        onRetry={() => {
          for (const q of queries) if (q.isError) void q.refetch();
        }}
      />
    );
  }
  const figures = queries.flatMap((q) => (q.data ? [q.data] : []));
  if (figures.length < shown.length) {
    return (
      <Center p="md">
        <Loader size="sm" />
      </Center>
    );
  }

  const first = shown[0];
  const last = shown.at(-1);
  const perCycle = settings.per_cycle !== false;
  return (
    <Stack gap="md">
      {note}
      {first && last && (shown.length > 1 || !perCycle) && (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t("stats.reports.budget.summary")} ·{" "}
            {formatDateRange(first.period.from, last.period.to)}
          </Text>
          <Text size="xs" c="dimmed">
            {t("stats.reports.budget.summaryHint")}
          </Text>
          <BudgetTable
            label={t("stats.reports.budget.summary")}
            figures={budgetSummary(figures)}
            buckets={buckets}
            settings={settings}
            period={{
              from: first.period.from,
              to: last.period.to,
              fromAt: first.period.fromAt,
              toAt: last.period.toAt,
            }}
          />
        </Stack>
      )}
      {perCycle &&
        shown.map((c, i) => (
          <Stack key={c.id} gap={4} data-testid="budget-cycle">
            <CycleLabel cycle={c} cycles={cycles} />
            <BudgetTable
              label={specificLabel({ kind: "specific", unit: "cycle", at: c.id }, cycles)}
              figures={figures[i] ?? []}
              buckets={buckets}
              settings={settings}
              period={c.period}
            />
          </Stack>
        ))}
    </Stack>
  );
}

function CycleLabel({ cycle, cycles }: { cycle: PeriodCycle; cycles: Cycle[] }) {
  const { t } = useTranslation();
  return (
    <Group gap="xs">
      <Text size="sm" fw={500}>
        {specificLabel({ kind: "specific", unit: "cycle", at: cycle.id }, cycles)}
      </Text>
      {cycle.active && (
        <Badge variant="light" size="xs">
          {t("stats.reports.budget.active")}
        </Badge>
      )}
      {cycle.partial && (
        <Badge variant="light" color="gray" size="xs">
          {t("stats.reports.budget.partial")}
        </Badge>
      )}
    </Group>
  );
}

/** One cycle's, or the summary's, table: Bucket | Budget | Used | Used % | Left. */
function BudgetTable({
  label,
  figures,
  buckets,
  settings,
  period,
}: {
  label: string;
  figures: BucketFigures[];
  buckets: Bucket[];
  settings: ReportBudget;
  /** The span the figures cover, for the buckets' Transactions links. */
  period: Period;
}) {
  const { t } = useTranslation();
  const { rows, totals } = budgetRows(figures, buckets, settings);
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.reports.budget.empty")}
      </Text>
    );
  }
  const several = totals.length > 1;
  return (
    <Table.ScrollContainer minWidth={520} type="native">
      <Table striped highlightOnHover verticalSpacing={4} fz="sm" aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("stats.reports.budget.bucket")}</Table.Th>
            <Table.Th ta="right">{t("stats.reports.budget.budget")}</Table.Th>
            <Table.Th ta="right">{t("stats.reports.budget.used")}</Table.Th>
            <Table.Th ta="right">{t("stats.reports.budget.usedPct")}</Table.Th>
            <Table.Th ta="right">{t("stats.reports.budget.overflow")}</Table.Th>
            <Table.Th ta="right">{t("stats.reports.budget.left")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              name={
                <Anchor
                  component={Link}
                  to={
                    transactionsLink({ bucket_ids: [r.id], system: true }, period) ??
                    "/transactions"
                  }
                  size="sm"
                >
                  {r.name}
                </Anchor>
              }
            />
          ))}
        </Table.Tbody>
        <Table.Tfoot>
          {totals.map((r) => (
            <Row
              key={r.currency}
              row={r}
              bold
              name={
                several
                  ? t("stats.reports.budget.totalIn", { currency: r.currency })
                  : t("stats.reports.budget.total")
              }
            />
          ))}
        </Table.Tfoot>
      </Table>
    </Table.ScrollContainer>
  );
}

function Row({ row, name, bold }: { row: BudgetRow; name: React.ReactNode; bold?: boolean }) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, row.currency);
  const over = compareAmounts(row.values.left, "0") < 0;
  const overColor = over ? toneText("alert") : undefined;
  const cell = {
    ta: "right" as const,
    style: { whiteSpace: "nowrap" as const, fontVariantNumeric: "tabular-nums" },
  };
  // A fixed width, so the bars line up whatever the share's digits.
  const pct = (text: string) => (
    <span style={{ display: "inline-block", minWidth: "4.5ch", textAlign: "right" }}>{text}</span>
  );
  return (
    <Table.Tr fw={bold ? 600 : undefined}>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          {over && (
            <IconAlertTriangle
              size={16}
              role="img"
              aria-label={t("stats.reports.budget.overBudget")}
              color={overColor}
            />
          )}
          {name}
        </Group>
      </Table.Td>
      <Table.Td {...cell}>{money(row.values.budget)}</Table.Td>
      <Table.Td {...cell}>{money(row.values.used)}</Table.Td>
      <Table.Td {...cell}>
        {row.usedPct === null ? (
          pct("–")
        ) : (
          <Group gap={6} justify="flex-end" wrap="nowrap">
            <Progress
              value={Math.min(row.usedPct, 100)}
              color={usageColor(row.usedPct)}
              size="xs"
              w={48}
              aria-hidden
            />
            {pct(`${String(row.usedPct)}%`)}
          </Group>
        )}
      </Table.Td>
      <Table.Td {...cell}>{money(row.values.overflow)}</Table.Td>
      <Table.Td {...cell} c={overColor}>
        {money(row.values.left)}
      </Table.Td>
    </Table.Tr>
  );
}
