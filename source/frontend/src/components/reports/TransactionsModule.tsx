import { Anchor, Box, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useTransactionPages } from "@/api/transactions";
import { ErrorAlert } from "@/components/ErrorAlert";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import { useLookups } from "@/components/transactions/lookups";
import { formatDay } from "@/lib/dates";
import type { Period } from "@/lib/periods";
import { transactionsLink, transactionsQuery, type ReportTransactions } from "@/lib/reports";
import { groupByDay } from "@/lib/transactionList";

/**
 * A transactions module (#126): the period's transactions with the module's
 * filters, as the Transactions list shows them, a page at a time.
 */
export function TransactionsModule({
  settings,
  period,
  isDesktop,
}: {
  /** With the report's filters where the module has none of its own. */
  settings: ReportTransactions;
  period: Period | null;
  isDesktop: boolean;
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const pages = useTransactionPages(
    period ? transactionsQuery(settings, period) : { limit: 1 },
    period !== null,
  );
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
  return (
    <Stack gap="xs">
      {items.length === 0 ? (
        <Text c="dimmed">{t("stats.reports.transactions.empty")}</Text>
      ) : (
        <Box>
          {groupByDay(items).map((g) => (
            <Box key={g.day} component="section" aria-label={formatDay(g.day)}>
              <Text
                component="h3"
                m={0}
                px="xs"
                py={6}
                size="sm"
                fw={600}
                c="dimmed"
                bg="var(--mantine-color-default-hover)"
              >
                {formatDay(g.day)}
              </Text>
              {g.items.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  names={names}
                  filter={focus}
                  to={transactionsLink(settings, period, tx.id) ?? "/transactions"}
                  selected={false}
                  badge={isDesktop}
                />
              ))}
            </Box>
          ))}
        </Box>
      )}
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
    </Stack>
  );
}
