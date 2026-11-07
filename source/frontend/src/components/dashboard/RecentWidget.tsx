import { Box, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useTransactionPages } from "@/api/transactions";
import { QueryState } from "@/components/QueryState";
import { useLookups } from "@/components/transactions/lookups";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import type { WidgetInstance } from "@/lib/dashboard";
import { USER_TYPES } from "@/lib/transactionList";

import { WidgetCard } from "./Widget";

/** Neither the Transactions list's account nor its bucket: amounts as they are. */
const NO_FOCUS = { accountId: null, bucketId: null };

/** The latest transactions. */
export function RecentWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"recent_transactions">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const pages = useTransactionPages({ type: USER_TYPES, limit: widget.settings.count });
  const items = pages.data?.pages[0]?.items ?? [];
  return (
    <WidgetCard
      title={t("dashboard.recent.title")}
      link={{ to: "/transactions", label: t("dashboard.recent.all") }}
      action={action}
    >
      <QueryState query={pages}>
        {() =>
          items.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("dashboard.recent.empty")}
            </Text>
          ) : (
            <Box
              mx="calc(var(--mantine-spacing-md) * -1)"
              mb="calc(var(--mantine-spacing-md) * -1)"
            >
              {items.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  names={names}
                  filter={NO_FOCUS}
                  to={`/transactions?open=${tx.id}`}
                  selected={false}
                  badge={false}
                />
              ))}
            </Box>
          )
        }
      </QueryState>
    </WidgetCard>
  );
}
