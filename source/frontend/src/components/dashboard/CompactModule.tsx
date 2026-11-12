import { Anchor, Box, Center, Group, Loader, Progress, Stack, Text } from "@mantine/core";
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
import { toneText, usageColor } from "@/lib/buckets";
import { COMPACT_FIGURES, type ModuleWidgetSettings } from "@/lib/dashboard";
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

/** Used more than this share, a bucket is near its budget (as Bucket status's Needs attention). */
const NEAR_PCT = 90;

/**
 * A saved module's compact form on the Dashboard (#203), over its own
 * period: a transactions module's count and total and its newest rows; an
 * In/out/balance module's In, Out and Net and where most was spent; a
 * budget module's most used buckets. `options` are the widget's (how many
 * rows, which figures and so on); `more` is where the rest is.
 */
export function CompactModule({
  report,
  module,
  period,
  cycles,
  accounts,
  buckets,
  options,
  more,
}: {
  report: ReportSettings;
  /** Not a graph, whose compact form is the widget's drawing of it. */
  module: PartModule;
  period: Period | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  options: ModuleWidgetSettings;
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
      return (
        <CompactTransactions
          settings={moduleTransactions(report, module)}
          period={period}
          options={options.transactions}
        />
      );
    case "flows":
      return (
        <CompactFlows
          settings={moduleFlows(report, module)}
          period={period}
          accounts={accounts}
          buckets={buckets}
          options={options.flows}
        />
      );
    case "budget":
      return (
        <CompactBudget
          settings={moduleBudget(report, module)}
          period={period}
          cycles={cycles}
          buckets={buckets}
          options={options.budget}
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
  options,
}: {
  settings: ReportTransactions;
  period: Period;
  options: ModuleWidgetSettings["transactions"];
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const query = transactionsQuery(settings, period);
  const summarised = options.summary !== "off";
  const summary = useTransactionSummary(summarised ? query : null);
  // The newest, whichever order the module lists them in.
  const newest: TransactionQuery = { ...query, limit: Math.max(options.rows, 1) };
  delete newest.order;
  const pages = useTransactionPages(newest, options.rows > 0);
  const link = transactionsLink(settings, period);
  // Signed from the account's or bucket's side when there's one, as the module.
  const focus = { accountId: only(settings.account_ids), bucketId: only(settings.bucket_ids) };
  const empty = (
    <Text size="sm" c="dimmed">
      {t("stats.reports.transactions.empty")}
    </Text>
  );
  const open = link && (
    <Anchor component={Link} to={link} size="sm">
      {t("dashboard.module.compact.openTransactions")}
    </Anchor>
  );
  const rows =
    options.rows > 0 ? (
      <QueryState query={pages}>
        {(p) => {
          const items = p.pages[0]?.items ?? [];
          if (items.length === 0) return summarised ? null : empty;
          return (
            <Box mx="calc(var(--mantine-spacing-md) * -1)">
              {items.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  names={names}
                  filter={focus}
                  to={transactionsLink(settings, period, tx.id) ?? `/transactions?open=${tx.id}`}
                  selected={false}
                  badge={false}
                />
              ))}
            </Box>
          );
        }}
      </QueryState>
    ) : null;
  if (!summarised) {
    return (
      <Stack gap="xs">
        {rows}
        {open}
      </Stack>
    );
  }
  return (
    <QueryState query={summary}>
      {(s) =>
        s.count === 0 ? (
          empty
        ) : (
          <Stack gap="xs">
            <Text size="sm" fw={500} data-testid="compact-summary">
              {[
                t("dashboard.module.compact.count", { count: s.count }),
                ...s.totals.flatMap((x) => {
                  const net = signedMoney({ amount: x.net, signed: true }, x.currency);
                  if (options.summary === "net") return [net];
                  const money = (a: string) => formatMoney(a, x.currency);
                  return [
                    t("stats.reports.transactions.sections.in", { amount: money(x.in) }),
                    t("stats.reports.transactions.sections.out", { amount: money(x.out) }),
                    t("stats.reports.transactions.sections.net", { amount: net }),
                  ];
                }),
              ].join(" · ")}
            </Text>
            {rows}
            {open}
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
  options,
}: {
  settings: ReportFlows;
  period: Period;
  accounts: Account[];
  buckets: Bucket[];
  options: ModuleWidgetSettings["flows"];
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
        const byAccount =
          options.topOf === "module" ? settings.show === "accounts" : options.topOf === "accounts";
        const top: { id: string; name: string; currency: string; values: { out: string } }[] =
          byAccount
            ? topSpending(tables.accounts.rows, options.top)
            : topSpending(tables.buckets.rows, options.top);
        // In the order In, Out, Net, whichever are picked.
        const shown = COMPACT_FIGURES.filter((k) => options.figures.includes(k));
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
                  figures={shown.map((k) => ({
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
function topSpending<R extends { values: { out: string } }>(rows: R[], count: number): R[] {
  return rows
    .filter((r) => compareAmounts(r.values.out, "0") > 0)
    .sort((a, b) => compareAmounts(b.values.out, a.values.out))
    .slice(0, count);
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
  options,
  more,
}: {
  settings: ReportBudget;
  period: Period;
  cycles: Cycle[];
  buckets: Bucket[];
  options: ModuleWidgetSettings["budget"];
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
  // Summed over the period's cycles, in the widget's order.
  const table = budgetRows(budgetSummary(figures), buckets, settings);
  if (table.rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("stats.reports.budget.empty")}
      </Text>
    );
  }
  const rows = ordered(table.rows, options.order).filter(
    (r) => !options.attention || nearBudget(r),
  );
  const limit = options.rows === 0 ? rows.length : options.rows;
  const rest = rows.length - limit;
  const usedOf = (r: BudgetRow) =>
    t("buckets.usedOf", {
      used: formatMoney(r.values.used, r.currency),
      budget: formatMoney(r.values.budget, r.currency),
    });
  const amount = (r: BudgetRow) => (
    <Text
      size="sm"
      fw={600}
      c={compareAmounts(r.values.unspent, "0") < 0 ? toneText("alert") : undefined}
      style={{ whiteSpace: "nowrap" }}
    >
      {usedOf(r)}
    </Text>
  );
  const several = table.totals.length > 1;
  return (
    <Stack gap="xs">
      {options.total &&
        table.totals.map((r) => {
          const label = several
            ? t("stats.reports.budget.totalIn", { currency: r.currency })
            : t("stats.reports.budget.total");
          return (
            <Stack key={r.currency} gap={4} data-testid="compact-budget-total">
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="sm" fw={600}>
                  {label}
                </Text>
                {amount(r)}
              </Group>
              {r.usedPct !== null && (
                <Progress
                  size="sm"
                  value={Math.min(r.usedPct, 100)}
                  color={usageColor(r.usedPct)}
                  aria-label={t("dashboard.bucketStatus.usedOf", { name: label, pct: r.usedPct })}
                />
              )}
            </Stack>
          );
        })}
      {rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("dashboard.module.compact.noneNear")}
        </Text>
      )}
      {rows.slice(0, limit).flatMap((r) => {
        const bucket = buckets.find((b) => b.id === r.id);
        return bucket
          ? [<CompactBucket key={r.id} bucket={bucket} pct={r.usedPct} right={amount(r)} />]
          : [];
      })}
      {rest > 0 && (
        <Anchor component={Link} to={more} size="sm">
          {t("dashboard.module.compact.more", { count: rest })}
        </Anchor>
      )}
    </Stack>
  );
}

/** More than NEAR_PCT of its budget used, or over it. */
function nearBudget(r: BudgetRow): boolean {
  return compareAmounts(r.values.unspent, "0") < 0 || (r.usedPct !== null && r.usedPct > NEAR_PCT);
}

/**
 * In the widget's order: the share used, highest first, those without a
 * budget last; the amount used, most first; or by name (budgetRows' own).
 * Ties go by the amount used.
 */
function ordered(rows: BudgetRow[], order: ModuleWidgetSettings["budget"]["order"]): BudgetRow[] {
  if (order === "name") return rows;
  const byUsed = (a: BudgetRow, b: BudgetRow) => compareAmounts(b.values.used, a.values.used);
  if (order === "used") return [...rows].sort(byUsed);
  return [...rows].sort((a, b) => {
    if (a.usedPct !== b.usedPct) {
      if (a.usedPct === null) return 1;
      if (b.usedPct === null) return -1;
      return b.usedPct - a.usedPct;
    }
    return byUsed(a, b);
  });
}
