import { Badge, Center, Group, Loader, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useStatsFlows, type StatsFlows } from "@/api/stats";
import { ErrorAlert } from "@/components/ErrorAlert";
import { formatDateRange } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";
import { specificLabel } from "@/lib/graphs";
import { compareAmounts, formatMoney } from "@/lib/money";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  ACCOUNT_DETAILS,
  ACCOUNT_FIGURES,
  accountColumns,
  accountFigureLabel,
  BREAKDOWN_MIN_DAYS,
  BUCKET_AVERAGE,
  BUCKET_AVERAGE_DETAILS,
  BUCKET_DETAILS,
  BUCKET_FIGURES,
  flowAverages,
  flowsQuery,
  flowTables,
  MAX_SUB_PERIODS,
  periodParts,
  subPeriods,
  transactionsLink,
  type AccountAverageFigure,
  type BucketAverageFigure,
  type FlowRow,
  type FlowTables,
  type ReportFlows,
  type SubPeriod,
} from "@/lib/reports";

import { FlowGrid } from "./FlowGrid";
import { ReportLink } from "./ReportLink";

/**
 * An In/out/balance module (#126): each bucket's start, in, out and end, and
 * each account's in, out and net (and its balances, #187), for the whole
 * period and, broken down, per month or cycle. As tables, or as a grid of
 * cards.
 */
export function FlowsModule({
  settings,
  choice,
  period,
  cycles,
  accounts,
  buckets,
  filtered,
  average: showAverage = true,
}: {
  /** With the report's accounts and buckets where the module has none of its own. */
  settings: ReportFlows;
  choice: PeriodChoice;
  period: Period | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  /** Whether the report has tags or a counterparty, which don't apply here. */
  filtered: boolean;
  /** Whether it shows its average (#220): not in a section's part. */
  average?: boolean;
}) {
  const { t } = useTranslation();
  const breakdown = settings.breakdown ?? "none";
  const parts =
    breakdown !== "none" && period ? subPeriods(choice, period, breakdown, cycles) : null;
  const whole = useStatsFlows(period ? flowsQuery(settings, period, "total") : null);
  const split = useStatsFlows(
    period && parts?.ok && breakdown !== "none" ? flowsQuery(settings, period, breakdown) : null,
  );
  // The average per month or cycle (#220), with the breakdown's numbers when it has them.
  const unit =
    showAverage && settings.average && settings.average !== "none" ? settings.average : null;
  const averageParts = unit && period ? periodParts(period, unit, cycles) : null;
  const reuse = unit !== null && unit === breakdown && parts?.ok === true;
  const own = useStatsFlows(
    period && unit && averageParts?.ok && !reuse ? flowsQuery(settings, period, unit) : null,
  );
  const averaged = reuse ? split : own;
  if (!period) return null;

  return (
    <Stack gap="sm">
      {filtered && (
        <Text size="sm" c="dimmed">
          {t("stats.reports.flows.filtersNote")}
        </Text>
      )}
      <Result query={whole} retry={() => void whole.refetch()}>
        {(r) => (
          <Tables
            result={r}
            index={0}
            period={period}
            settings={settings}
            {...{ accounts, buckets }}
          />
        )}
      </Result>
      {unit && (
        <Stack gap={4} data-testid="flow-average">
          <Text size="sm" fw={500}>
            {t(`stats.reports.average.title.${unit}`)}
          </Text>
          {averageParts?.ok ? (
            <Result query={averaged} retry={() => void averaged.refetch()}>
              {(r) => (
                <Averages
                  result={r}
                  parts={averageParts.parts}
                  unit={unit}
                  settings={settings}
                  accounts={accounts}
                  buckets={buckets}
                />
              )}
            </Result>
          ) : (
            <Text size="sm" c="dimmed">
              {averageParts?.reason === "many"
                ? t("stats.reports.average.many", { max: MAX_SUB_PERIODS })
                : t("stats.reports.average.noCycles")}
            </Text>
          )}
        </Stack>
      )}
      {parts &&
        (parts.ok ? (
          <Stack gap="sm">
            <Text size="sm" fw={500}>
              {t(
                breakdown === "cycle"
                  ? "stats.reports.breakdown.title.cycle"
                  : "stats.reports.breakdown.title.month",
              )}
            </Text>
            <Result query={split} retry={() => void split.refetch()}>
              {(r) =>
                parts.parts.map((part) => {
                  const index = r.intervals.findIndex(
                    (iv) => Date.parse(iv.start) === Date.parse(part.period.fromAt),
                  );
                  if (index < 0) return null;
                  return (
                    <Stack key={part.period.fromAt} gap={4} data-testid="breakdown-part">
                      <PartLabel part={part} cycles={cycles} />
                      <Tables
                        result={r}
                        index={index}
                        period={part.period}
                        settings={settings}
                        accounts={accounts}
                        buckets={buckets}
                      />
                    </Stack>
                  );
                })
              }
            </Result>
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
  );
}

function Result({
  query,
  retry,
  children,
}: {
  query: ReturnType<typeof useStatsFlows>;
  retry: () => void;
  children: (result: StatsFlows) => React.ReactNode;
}) {
  if (query.isError) return <ErrorAlert error={query.error} onRetry={retry} />;
  if (!query.data) {
    return (
      <Center p="md">
        <Loader size="sm" />
      </Center>
    );
  }
  return <>{children(query.data)}</>;
}

function PartLabel({ part, cycles }: { part: SubPeriod; cycles: Cycle[] }) {
  const { t } = useTranslation();
  const label = part.partial
    ? formatDateRange(part.period.from, part.period.to)
    : specificLabel(part.choice, cycles);
  return (
    <Group gap="xs">
      <Text size="sm">{label}</Text>
      {part.partial && (
        <Badge variant="light" color="gray" size="xs">
          {t("stats.reports.partial")}
        </Badge>
      )}
    </Group>
  );
}

/** The average per month or cycle (#220), as tables or a grid, with how many it counts. */
function Averages({
  result,
  parts,
  unit,
  settings,
  accounts,
  buckets,
}: {
  result: StatsFlows;
  parts: SubPeriod[];
  unit: "month" | "cycle";
  settings: ReportFlows;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const show = settings.show ?? "buckets";
  const details = settings.details ?? false;
  const showBuckets = show !== "accounts";
  const showAccounts = show !== "buckets";
  const avg = flowAverages(result, parts, accounts, buckets, {
    transfers: settings.transfers ?? false,
  });
  const empty =
    !avg ||
    ((!showBuckets || avg.buckets.rows.length === 0) &&
      (!showAccounts || avg.accounts.rows.length === 0));
  if (!avg || empty) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.reports.flows.empty")}
      </Text>
    );
  }
  const note = avg.whole < avg.of && (
    <Text size="xs" c="dimmed">
      {t(`stats.reports.average.whole.${unit}`, { count: avg.whole })}
    </Text>
  );
  if (settings.view === "grid") {
    // As the grid's cards: a start of 0 and an end of the change.
    const bucketCards = (rows: FlowRow<BucketAverageFigure>[]): FlowTables["buckets"]["rows"] =>
      rows.map((r) => ({ ...r, values: { ...r.values, start: "0.00", end: r.values.change } }));
    const accountCards = (rows: FlowRow<AccountAverageFigure>[]): FlowTables["accounts"]["rows"] =>
      rows.map((r) => ({
        ...r,
        values: { ...r.values, start: "0.00", other: "0.00", end: r.values.net },
      }));
    return (
      <Stack gap={4}>
        {note}
        <FlowGrid
          buckets={
            showBuckets
              ? { rows: bucketCards(avg.buckets.rows), totals: bucketCards(avg.buckets.totals) }
              : null
          }
          accounts={
            showAccounts
              ? {
                  rows: accountCards(avg.accounts.rows),
                  totals: accountCards(avg.accounts.totals),
                }
              : null
          }
          details={details}
          balances={false}
          bucketLink={() => ""}
          accountLink={() => ""}
          average
        />
      </Stack>
    );
  }
  const bucketHeading = (c: BucketAverageFigure) =>
    c === "change" ? t("stats.reports.average.change") : t(`stats.reports.flows.columns.${c}`);
  return (
    <Stack gap="sm">
      {note}
      {showBuckets && avg.buckets.rows.length > 0 && (
        <FlowTable
          label={`${t(`stats.reports.average.title.${unit}`)}: ${t("stats.reports.flows.buckets")}`}
          nameHeader={t("stats.reports.flows.bucket")}
          columns={details ? BUCKET_AVERAGE_DETAILS : BUCKET_AVERAGE}
          heading={bucketHeading}
          rows={avg.buckets.rows}
          totals={avg.buckets.totals}
        />
      )}
      {showAccounts && avg.accounts.rows.length > 0 && (
        <FlowTable
          label={`${t(`stats.reports.average.title.${unit}`)}: ${t("stats.reports.flows.accounts")}`}
          nameHeader={t("stats.reports.flows.account")}
          columns={details ? ACCOUNT_DETAILS : ACCOUNT_FIGURES}
          heading={accountFigureLabel}
          rows={avg.accounts.rows}
          totals={avg.accounts.totals}
        />
      )}
    </Stack>
  );
}

/** The buckets' and accounts' tables or grids for one interval, as the module shows them. */
function Tables({
  result,
  index,
  period,
  settings,
  accounts,
  buckets,
}: {
  result: StatsFlows;
  index: number;
  period: Period;
  settings: ReportFlows;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const show = settings.show ?? "buckets";
  const details = settings.details ?? false;
  const showBuckets = show !== "accounts";
  const showAccounts = show !== "buckets";
  const balances = showAccounts && (settings.balances ?? false);
  const tables = flowTables(result, index, accounts, buckets, {
    transfers: settings.transfers ?? false,
    balances,
  });
  const empty =
    (!showBuckets || tables.buckets.rows.length === 0) &&
    (!showAccounts || tables.accounts.rows.length === 0);
  if (empty) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.reports.flows.empty")}
      </Text>
    );
  }
  const bucketLink = (id: string) =>
    transactionsLink({ bucket_ids: [id], system: true }, period) ?? "/transactions";
  const accountLink = (id: string) =>
    transactionsLink({ account_ids: [id] }, period) ?? "/transactions";
  if (settings.view === "grid") {
    return (
      <FlowGrid
        buckets={showBuckets ? tables.buckets : null}
        accounts={showAccounts ? tables.accounts : null}
        details={details}
        balances={balances}
        bucketLink={bucketLink}
        accountLink={accountLink}
      />
    );
  }
  // The other column only when something else moved a balance.
  const columns = accountColumns(details, balances).filter(
    (c) =>
      c !== "other" || tables.accounts.rows.some((r) => compareAmounts(r.values.other, "0") !== 0),
  );
  return (
    <Stack gap="sm">
      {showBuckets && tables.buckets.rows.length > 0 && (
        <FlowTable
          label={t("stats.reports.flows.buckets")}
          nameHeader={t("stats.reports.flows.bucket")}
          columns={details ? BUCKET_DETAILS : BUCKET_FIGURES}
          heading={(c) => t(`stats.reports.flows.columns.${c}`)}
          rows={tables.buckets.rows}
          totals={tables.buckets.totals}
          linkOf={bucketLink}
        />
      )}
      {showAccounts && tables.accounts.rows.length > 0 && (
        <FlowTable
          label={t("stats.reports.flows.accounts")}
          nameHeader={t("stats.reports.flows.account")}
          columns={columns}
          heading={accountFigureLabel}
          rows={tables.accounts.rows}
          totals={tables.accounts.totals}
          linkOf={accountLink}
        />
      )}
    </Stack>
  );
}

function FlowTable<F extends string>({
  label,
  nameHeader,
  columns,
  heading,
  rows,
  totals,
  linkOf,
}: {
  label: string;
  nameHeader: string;
  columns: readonly F[];
  heading: (column: F) => string;
  rows: FlowRow<F>[];
  totals: FlowRow<F>[];
  /** A row's Transactions link; an average's rows have none (#220). */
  linkOf?: (id: string) => string;
}) {
  const { t } = useTranslation();
  const several = totals.length > 1;
  return (
    <Table.ScrollContainer minWidth={columns.length > 4 ? 640 : 320} type="native">
      <Table striped highlightOnHover verticalSpacing={4} fz="sm" aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{nameHeader}</Table.Th>
            {columns.map((c) => (
              <Table.Th key={c} ta="right">
                {heading(c)}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>
                {linkOf ? <ReportLink to={linkOf(r.id)}>{r.name}</ReportLink> : r.name}
                {r.openedAt && (
                  <Text span size="xs" c="dimmed" ml={6} style={{ whiteSpace: "nowrap" }}>
                    {t("stats.reports.flows.openedOn", { date: formatDate(r.openedAt) })}
                  </Text>
                )}
              </Table.Td>
              {columns.map((c) => (
                <Table.Td key={c} ta="right" style={{ whiteSpace: "nowrap" }}>
                  {formatMoney(r.values[c], r.currency)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
        <Table.Tfoot>
          {totals.map((r) => (
            <Table.Tr key={r.currency} fw={600}>
              <Table.Td>
                {several
                  ? t("stats.reports.flows.totalIn", { currency: r.currency })
                  : t("stats.reports.flows.total")}
              </Table.Td>
              {columns.map((c) => (
                <Table.Td key={c} ta="right" style={{ whiteSpace: "nowrap" }}>
                  {formatMoney(r.values[c], r.currency)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tfoot>
      </Table>
    </Table.ScrollContainer>
  );
}
