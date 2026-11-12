import { Anchor, Box, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useBucketFiguresFor, type Account, type Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { useStatsFlows } from "@/api/stats";
import {
  useTransactionPages,
  useTransactionSummary,
  type TransactionQuery,
} from "@/api/transactions";
import { CompactBucket } from "@/components/buckets/BucketParts";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { signedMoney, useLookups } from "@/components/transactions/lookups";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import { toneText } from "@/lib/buckets";
import { compareAmounts, formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";
import {
  accountFigureLabel,
  budgetRows,
  budgetSummary,
  flowsQuery,
  flowTables,
  MAX_SUB_PERIODS,
  moduleBudget,
  moduleFlows,
  moduleTransactions,
  periodCycles,
  transactionsLink,
  transactionsQuery,
  type BudgetRow,
  type PartModule,
  type ReportBudget,
  type ReportFlows,
  type ReportSettings,
  type ReportTransactions,
} from "@/lib/reports";

import { FlowFigures } from "./FlowFigures";

/** A compact transactions module's newest rows. */
const COMPACT_ROWS = 3;
/** A compact In/out/balance module's top buckets or accounts. */
const COMPACT_TOP = 3;
/** A compact budget module's buckets; the rest are "+N more". */
const COMPACT_BUDGET = 6;

/**
 * A saved module's compact form on the Dashboard (#203), over its own
 * period: a transactions module's count and total and its newest rows; an
 * In/out/balance module's In, Out and Net and where most was spent; a
 * budget module's most used buckets. `more` is where the rest is.
 */
export function CompactModule({
  report,
  module,
  period,
  cycles,
  accounts,
  buckets,
  more,
}: {
  report: ReportSettings;
  /** Not a graph, whose compact form is the widget's drawing of it. */
  module: PartModule;
  period: Period | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  more: string;
}) {
  const { t } = useTranslation();
  if (!period) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.graphs.noPeriod")}
      </Text>
    );
  }
  switch (module.type) {
    case "transactions":
      return <CompactTransactions settings={moduleTransactions(report, module)} period={period} />;
    case "flows":
      return (
        <CompactFlows
          settings={moduleFlows(report, module)}
          period={period}
          accounts={accounts}
          buckets={buckets}
        />
      );
    case "budget":
      return (
        <CompactBudget
          settings={moduleBudget(report, module)}
          period={period}
          cycles={cycles}
          buckets={buckets}
          more={more}
        />
      );
    case "graph":
      return null;
  }
}

/** The one id in a filter, or null for none or several. */
const only = (list: string[] | undefined) => (list?.length === 1 ? (list[0] ?? null) : null);

function CompactTransactions({
  settings,
  period,
}: {
  settings: ReportTransactions;
  period: Period;
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const query = transactionsQuery(settings, period);
  const summary = useTransactionSummary(query);
  // The newest, whichever order the module lists them in.
  const newest: TransactionQuery = { ...query, limit: COMPACT_ROWS };
  delete newest.order;
  const pages = useTransactionPages(newest);
  const link = transactionsLink(settings, period);
  // Signed from the account's or bucket's side when there's one, as the module.
  const focus = { accountId: only(settings.account_ids), bucketId: only(settings.bucket_ids) };
  return (
    <QueryState query={summary}>
      {(s) =>
        s.count === 0 ? (
          <Text size="sm" c="dimmed">
            {t("stats.reports.transactions.empty")}
          </Text>
        ) : (
          <Stack gap="xs">
            <Text size="sm" fw={500} data-testid="compact-summary">
              {[
                t("dashboard.module.compact.count", { count: s.count }),
                ...s.totals.map((x) => signedMoney({ amount: x.net, signed: true }, x.currency)),
              ].join(" · ")}
            </Text>
            <QueryState query={pages}>
              {(p) => (
                <Box mx="calc(var(--mantine-spacing-md) * -1)">
                  {(p.pages[0]?.items ?? []).map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      names={names}
                      filter={focus}
                      to={
                        transactionsLink(settings, period, tx.id) ?? `/transactions?open=${tx.id}`
                      }
                      selected={false}
                      badge={false}
                    />
                  ))}
                </Box>
              )}
            </QueryState>
            {link && (
              <Anchor component={Link} to={link} size="sm">
                {t("dashboard.module.compact.openTransactions")}
              </Anchor>
            )}
          </Stack>
        )
      }
    </QueryState>
  );
}

function CompactFlows({
  settings,
  period,
  accounts,
  buckets,
}: {
  settings: ReportFlows;
  period: Period;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const flows = useStatsFlows(flowsQuery(settings, period, "total"));
  return (
    <QueryState query={flows}>
      {(r) => {
        const tables = flowTables(r, 0, accounts, buckets, {
          transfers: settings.transfers ?? false,
          balances: false,
        });
        if (tables.accounts.rows.length === 0 && tables.buckets.rows.length === 0) {
          return (
            <Text size="sm" c="dimmed">
              {t("stats.reports.flows.empty")}
            </Text>
          );
        }
        const byAccount = settings.show === "accounts";
        const top: { id: string; name: string; currency: string; values: { out: string } }[] =
          byAccount ? topSpending(tables.accounts.rows) : topSpending(tables.buckets.rows);
        const several = tables.accounts.totals.length > 1;
        return (
          <Stack gap="sm">
            {tables.accounts.totals.map((total) => (
              <Stack key={total.currency} gap={4}>
                {several && (
                  <Text size="xs" c="dimmed">
                    {t("dashboard.module.compact.currency", { currency: total.currency })}
                  </Text>
                )}
                <FlowFigures
                  figures={(["in", "out", "net"] as const).map((k) => ({
                    key: k,
                    label: accountFigureLabel(k),
                    amount:
                      k === "net"
                        ? signedMoney({ amount: total.values.net, signed: true }, total.currency)
                        : formatMoney(total.values[k], total.currency),
                    color: k === "net" ? signColor(total.values.net) : undefined,
                  }))}
                />
              </Stack>
            ))}
            {top.length > 0 && (
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  {t(
                    byAccount
                      ? "dashboard.module.compact.topAccounts"
                      : "dashboard.module.compact.topBuckets",
                  )}
                </Text>
                {top.map((row) => (
                  <Group key={row.id} justify="space-between" gap="xs" wrap="nowrap">
                    <Anchor
                      component={Link}
                      size="sm"
                      to={
                        transactionsLink(
                          byAccount
                            ? { account_ids: [row.id] }
                            : { bucket_ids: [row.id], system: true },
                          period,
                        ) ?? "/transactions"
                      }
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {row.name}
                    </Anchor>
                    <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
                      {formatMoney(row.values.out, row.currency)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Stack>
        );
      }}
    </QueryState>
  );
}

/** The rows that spent the most, most first. */
function topSpending<R extends { values: { out: string } }>(rows: R[]): R[] {
  return rows
    .filter((r) => compareAmounts(r.values.out, "0") > 0)
    .sort((a, b) => compareAmounts(b.values.out, a.values.out))
    .slice(0, COMPACT_TOP);
}

function signColor(amount: string): string | undefined {
  const sign = compareAmounts(amount, "0");
  return sign > 0
    ? "var(--mantine-color-green-text)"
    : sign < 0
      ? "var(--mantine-color-red-text)"
      : undefined;
}

function CompactBudget({
  settings,
  period,
  cycles,
  buckets,
  more,
}: {
  settings: ReportBudget;
  period: Period;
  cycles: Cycle[];
  buckets: Bucket[];
  more: string;
}) {
  const { t } = useTranslation();
  const list = periodCycles(period, cycles);
  const shown = list.ok ? list.cycles : [];
  const queries = useBucketFiguresFor(shown.map((c) => c.id));
  if (!list.ok) {
    return (
      <Text size="sm" c="dimmed">
        {list.reason === "many"
          ? t("stats.reports.budget.many", { max: MAX_SUB_PERIODS })
          : t("stats.reports.budget.none")}
      </Text>
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
  // Summed over the period's cycles, the most used first.
  const rows = mostUsedFirst(budgetRows(budgetSummary(figures), buckets, settings).rows);
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.reports.budget.empty")}
      </Text>
    );
  }
  const rest = rows.length - COMPACT_BUDGET;
  return (
    <Stack gap="xs">
      {rows.slice(0, COMPACT_BUDGET).flatMap((r) => {
        const bucket = buckets.find((b) => b.id === r.id);
        if (!bucket) return [];
        const money = (a: string) => formatMoney(a, r.currency);
        const over = compareAmounts(r.values.unspent, "0") < 0;
        return [
          <CompactBucket
            key={r.id}
            bucket={bucket}
            pct={r.usedPct}
            right={
              <Text
                size="sm"
                fw={600}
                c={over ? toneText("alert") : undefined}
                style={{ whiteSpace: "nowrap" }}
              >
                {t("buckets.usedOf", {
                  used: money(r.values.used),
                  budget: money(r.values.budget),
                })}
              </Text>
            }
          />,
        ];
      })}
      {rest > 0 && (
        <Anchor component={Link} to={more} size="sm">
          {t("dashboard.module.compact.more", { count: rest })}
        </Anchor>
      )}
    </Stack>
  );
}

/** By used share, highest first; those without a budget last, by what they used. */
function mostUsedFirst(rows: BudgetRow[]): BudgetRow[] {
  return [...rows].sort((a, b) => {
    if (a.usedPct !== b.usedPct) {
      if (a.usedPct === null) return 1;
      if (b.usedPct === null) return -1;
      return b.usedPct - a.usedPct;
    }
    return compareAmounts(b.values.used, a.values.used);
  });
}
