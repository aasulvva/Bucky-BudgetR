import { Anchor, Badge, Box, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Cycle } from "@/api/cycles";
import { useTransactionPages, type Transaction } from "@/api/transactions";
import { ErrorAlert } from "@/components/ErrorAlert";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import { signedMoney, useLookups, type Lookups } from "@/components/transactions/lookups";
import { formatDateRange } from "@/lib/cycles";
import { formatMoney } from "@/lib/money";
import type { Period } from "@/lib/periods";
import { usePrintMode } from "@/lib/print";
import {
  groupTransactions,
  MAX_SUB_PERIODS,
  periodParts,
  sectionAnchor,
  sectionLabel,
  transactionSections,
  transactionsLink,
  transactionsQuery,
  type ReportTransactions,
  type TransactionSection,
  type TransactionsGroup,
} from "@/lib/reports";
import { sectionSummary, tableColumns, tableRows, tableTotals } from "@/lib/transactionTable";

import { TransactionsTable } from "./TransactionsTable";

/**
 * A transactions module (#126): the period's transactions with the module's
 * filters, as the Transactions list shows them, a page at a time, under a
 * heading per day, week, month or cycle, newest or oldest first. With
 * sections (#191), each month or cycle of the period has its own heading
 * and summary, and starts a new page in a PDF.
 */
export function TransactionsModule({
  moduleId,
  settings,
  period,
  cycles,
  isDesktop,
}: {
  /** For the sections' ids, which a PDF's contents link to (#193). */
  moduleId: string;
  /** With the report's filters where the module has none of its own. */
  settings: ReportTransactions;
  period: Period | null;
  cycles: Cycle[];
  isDesktop: boolean;
}) {
  const { t } = useTranslation();
  const print = usePrintMode();
  const names = useLookups();
  const pages = useTransactionPages(
    period ? transactionsQuery(settings, period) : { limit: 1 },
    period !== null,
  );
  // A PDF (#127) has all of them: the next page as soon as one is in.
  const { hasNextPage, isFetching, fetchNextPage } = pages;
  useEffect(() => {
    if (print && hasNextPage && !isFetching) void fetchNextPage();
  }, [print, hasNextPage, isFetching, fetchNextPage]);
  if (!period) return null;
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const link = transactionsLink(settings, period);
  // An amount is signed from the account's or bucket's side when there's one.
  const only = (list: string[] | undefined) => (list?.length === 1 ? (list[0] ?? null) : null);
  const focus = { accountId: only(settings.account_ids), bucketId: only(settings.bucket_ids) };

  if (pages.isPending) {
    return (
      <Center p="md">
        <Loader size="sm" />
      </Center>
    );
  }
  if (pages.isError) {
    return (
      <ErrorAlert
        error={pages.error}
        onRetry={() => {
          void pages.refetch();
        }}
      />
    );
  }
  const groupBy = settings.group_by ?? "day";
  const by = settings.sections ?? "off";
  const parts = by === "off" ? null : periodParts(period, by, cycles);
  const many = parts?.ok === false && parts.reason === "many";
  const sections =
    parts && !many
      ? transactionSections(
          items,
          parts.ok ? parts.parts : [],
          settings.order ?? "newest",
          pages.hasNextPage,
        )
      : null;

  /** The list or the table, over some of the transactions. */
  const view = (list: Transaction[], groups: TransactionsGroup | null, label?: string) =>
    settings.view === "table" ? (
      <TransactionsTable
        items={list}
        settings={settings}
        period={period}
        cycles={cycles}
        names={names}
        focus={focus}
        groupBy={groups}
        total={sections === null}
        label={label}
      />
    ) : (
      <TransactionList
        items={list}
        groupBy={groups}
        cycles={cycles}
        names={names}
        focus={focus}
        heading={print ? "div" : sections === null ? "h3" : "h4"}
        link={(id) =>
          print ? undefined : (transactionsLink(settings, period, id) ?? "/transactions")
        }
        badge={isDesktop}
      />
    );

  return (
    <Stack gap="xs">
      {items.length === 0 ? (
        <Text c="dimmed">{t("stats.reports.transactions.empty")}</Text>
      ) : sections ? (
        <Stack gap="md">
          {sections.map((s) => {
            const label = sectionLabel(s.part, cycles);
            return (
              <Box
                key={s.key}
                id={sectionAnchor(moduleId, s.key)}
                component="section"
                aria-label={label}
                data-transactions-section
              >
                <SectionHeading section={s} label={label} names={names} focus={focus} />
                {s.items.length === 0 ? (
                  <Text size="sm" c="dimmed" px="xs" py={6}>
                    {t("stats.reports.transactions.sections.empty")}
                  </Text>
                ) : (
                  view(s.items, groupBy === by ? null : groupBy, label)
                )}
              </Box>
            );
          })}
          {settings.view === "table" &&
            tableColumns(settings.columns, focus).includes("amount") && (
              <PeriodTotal
                items={items}
                rows={settings.rows ?? "transaction"}
                names={names}
                focus={focus}
              />
            )}
        </Stack>
      ) : (
        <>
          {many && (
            <Text size="sm" c="dimmed">
              {t("stats.reports.transactions.sections.many", { max: MAX_SUB_PERIODS })}
            </Text>
          )}
          {view(items, groupBy)}
        </>
      )}
      {!print && (
        <Group justify="space-between" gap="xs">
          {pages.hasNextPage ? (
            <Button
              variant="default"
              size="xs"
              loading={pages.isFetchingNextPage}
              onClick={() => {
                void pages.fetchNextPage();
              }}
            >
              {t("transactions.loadMore")}
            </Button>
          ) : (
            <span />
          )}
          {link && (
            <Anchor component={Link} to={link} size="sm">
              {t("stats.reports.transactions.open")}
            </Anchor>
          )}
        </Group>
      )}
    </Stack>
  );
}

interface Focus {
  accountId: string | null;
  bucketId: string | null;
}

/** Transactions as the Transactions list shows them, under a heading per group. */
function TransactionList({
  items,
  groupBy,
  cycles,
  names,
  focus,
  heading,
  link,
  badge,
}: {
  items: Transaction[];
  groupBy: TransactionsGroup | null;
  cycles: Cycle[];
  names: Lookups;
  focus: Focus;
  /** A div in a PDF, so the outline has only modules and sections (#193). */
  heading: "h3" | "h4" | "div";
  link: (id: string) => string | undefined;
  badge: boolean;
}) {
  const groups = groupBy
    ? groupTransactions(items, groupBy, cycles)
    : [{ key: "all", label: "", items }];
  return (
    <Box>
      {groups.map((g) => (
        <Box key={g.key} component="section" aria-label={groupBy ? g.label : undefined}>
          {groupBy && (
            <Text
              component={heading}
              m={0}
              px="xs"
              py={6}
              size="sm"
              fw={600}
              c="dimmed"
              bg="var(--mantine-color-default-hover)"
            >
              {g.label}
            </Text>
          )}
          {g.items.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              names={names}
              filter={focus}
              to={link(tx.id)}
              selected={false}
              badge={badge}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}

const figures = { fontVariantNumeric: "tabular-nums" } as const;

/** A section's heading band and summary (#191), kept together on paper. */
function SectionHeading({
  section,
  label,
  names,
  focus,
}: {
  section: TransactionSection;
  label: string;
  names: Lookups;
  focus: Focus;
}) {
  const { t } = useTranslation();
  const { part } = section;
  // A month's dates; a cycle's name is its dates already.
  const dates =
    part && !part.partial && part.choice.unit === "month"
      ? formatDateRange(part.period.from, part.period.to)
      : null;
  return (
    <Box
      data-section-heading
      px="xs"
      py={6}
      bg="var(--mantine-color-blue-light)"
      style={{ borderRadius: "var(--mantine-radius-sm)" }}
    >
      <Group gap="xs" wrap="wrap">
        <Text component="h3" m={0} size="sm" fw={700}>
          {label}
        </Text>
        {dates && (
          <Text size="xs" c="dimmed">
            {dates}
          </Text>
        )}
        {part?.partial && (
          <Badge variant="light" color="gray" size="xs">
            {t("stats.reports.partial")}
          </Badge>
        )}
      </Group>
      {section.items.length > 0 && <Summary section={section} names={names} focus={focus} />}
    </Box>
  );
}

function Summary({
  section,
  names,
  focus,
}: {
  section: TransactionSection;
  names: Lookups;
  focus: Focus;
}) {
  const { t } = useTranslation();
  if (!section.complete) {
    return (
      <Text size="xs" c="dimmed">
        {t("stats.reports.transactions.sections.more")}
      </Text>
    );
  }
  const summary = sectionSummary(tableRows(section.items, "transaction", names, focus));
  const sums = summary.totals.map((x) => {
    const currency = x.currency || undefined;
    return [
      t("stats.reports.transactions.sections.in", { amount: formatMoney(x.in, currency) }),
      t("stats.reports.transactions.sections.out", { amount: formatMoney(x.out, currency) }),
      t("stats.reports.transactions.sections.net", {
        amount: signedMoney({ amount: x.net, signed: true }, currency),
      }),
    ].join(" · ");
  });
  const count = t("stats.reports.transactions.sections.count", { count: summary.count });
  const lines = [[count, ...sums.slice(0, 1)].join(" · "), ...sums.slice(1)];
  return (
    <Stack gap={0} data-section-summary>
      {lines.map((l) => (
        <Text key={l} size="xs" c="dimmed" style={figures}>
          {l}
        </Text>
      ))}
    </Stack>
  );
}

/** A sectioned table's total over the whole period, per currency. */
function PeriodTotal({
  items,
  rows,
  names,
  focus,
}: {
  items: Transaction[];
  rows: NonNullable<ReportTransactions["rows"]>;
  names: Lookups;
  focus: Focus;
}) {
  const { t } = useTranslation();
  const totals = tableTotals(tableRows(items, rows, names, focus));
  const several = totals.length > 1;
  return (
    <Stack gap={0} data-period-total>
      {totals.map((x) => (
        <Group key={x.currency} justify="space-between" px="xs" wrap="nowrap">
          <Text size="sm" fw={600}>
            {several
              ? t("stats.reports.transactions.sections.periodTotalIn", { currency: x.currency })
              : t("stats.reports.transactions.sections.periodTotal")}
          </Text>
          <Text size="sm" fw={600} style={{ ...figures, whiteSpace: "nowrap" }}>
            {formatMoney(x.amount, x.currency || undefined)}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
