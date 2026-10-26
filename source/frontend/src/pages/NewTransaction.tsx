import { Anchor, Stack, Text, Title } from "@mantine/core";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import { QueryState } from "@/components/QueryState";
import { TransactionForm } from "@/components/transactions/TransactionForm";

/**
 * Create transaction (spec §9, canvas "Create transaction"): an income,
 * expense or transfer, optionally split between the account's buckets. The
 * most-used screen, so it's built for quick entry on a phone.
 */
export default function NewTransaction() {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <Stack gap="lg">
      <Title order={2}>{t("nav.items.newTransaction")}</Title>
      <QueryState query={accounts}>
        {(accountList) =>
          accountList.length === 0 ? (
            <Text c="dimmed">
              <Trans
                i18nKey="accounts.empty"
                components={{ setup: <Anchor component={Link} to="/accounts/setup" /> }}
              />
            </Text>
          ) : (
            <QueryState query={buckets}>
              {(bucketList) => <TransactionForm accounts={accountList} buckets={bucketList} />}
            </QueryState>
          )
        }
      </QueryState>
    </Stack>
  );
}
