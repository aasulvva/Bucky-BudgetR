import { Anchor, Badge, Center, Group, Loader, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useStatsFlows, type StatsFlows } from "@/api/stats";
import { ErrorAlert } from "@/components/ErrorAlert";
import { formatDateRange } from "@/lib/cycles";
import { specificLabel } from "@/lib/graphs";
import { formatMoney } from "@/lib/money";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  ACCOUNT_DETAILS,
  ACCOUNT_FIGURES,
  BREAKDOWN_MIN_DAYS,
  BUCKET_DETAILS,
  BUCKET_FIGURES,
  flowsQuery,
  flowTables,
  MAX_SUB_PERIODS,
  subPeriods,
  transactionsLink,
  type FlowRow,
  type ReportFlows,
  type SubPeriod,
} from "@/lib/reports";

/**
 * An In/out/balance module (#126): each bucket's start, in, out and end, and
 * each account's in, out and net, for the whole period and, broken down, per
 * month or cycle.
 */
export function FlowsModule({
  settings,
  choice,
  period,
  cycles,
  accounts,
  buckets,
  filtered,
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
}) {
  const { t } = useTranslation();
  const breakdown = settings.breakdown ?? "none";
  const parts =
    breakdown !== "none" && period ? subPeriods(choice, period, breakdown, cycles) : null;
  const whole = useStatsFlows(period ? flowsQuery(settings, period, "total") : null);
  const split = useStatsFlows(
    period && parts?.ok && breakdown !== "none" ? flowsQuery(settings, period, breakdown) : null,
  );
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

/** The buckets' and accounts' tables for one interval, as the module shows them. */
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
  const tables = flowTables(result, index, accounts, buckets, settings.transfers ?? false);
  const showBuckets = show !== "accounts";
  const showAccounts = show !== "buckets";
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
          linkOf={(id) =>
            transactionsLink({ bucket_ids: [id], system: true }, period) ?? "/transactions"
          }
        />
      )}
      {showAccounts && tables.accounts.rows.length > 0 && (
        <FlowTable
          label={t("stats.reports.flows.accounts")}
          nameHeader={t("stats.reports.flows.account")}
          columns={details ? ACCOUNT_DETAILS : ACCOUNT_FIGURES}
          heading={(c) =>
            c === "transfers_in" || c === "transfers_out"
              ? t(`stats.reports.flows.accountColumns.${c}`)
              : t(`stats.reports.flows.columns.${c}`)
          }
          rows={tables.accounts.rows}
          totals={tables.accounts.totals}
          linkOf={(id) => transactionsLink({ account_ids: [id] }, period) ?? "/transactions"}
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
  linkOf: (id: string) => string;
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
                <Anchor component={Link} to={linkOf(r.id)} size="sm">
                  {r.name}
                </Anchor>
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
