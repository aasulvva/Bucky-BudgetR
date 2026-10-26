import { Anchor, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import { useTransaction } from "@/api/transactions";
import { QueryState } from "@/components/QueryState";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { isCorrectable, isCorrectableType } from "@/lib/transactionList";

/**
 * Edit a transaction (spec §9): the Create transaction form, filled in. Saving
 * records a correction; a new account moves the transaction.
 */
export default function EditTransaction() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const transaction = useTransaction(id);
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={transaction}>
      {(tx) => (
        <Stack gap="lg">
          <Title order={2}>
            {isCorrectableType(tx.type)
              ? t(`newTransaction.editTitle.${tx.type}`)
              : t("transactions.detail")}{" "}
            <Text span inherit c="dimmed" fw={400}>
              (#{tx.id})
            </Text>
          </Title>
          {isCorrectable(tx) ? (
            <QueryState query={accounts}>
              {(accountList) => (
                <QueryState query={buckets}>
                  {(bucketList) => (
                    <TransactionForm accounts={accountList} buckets={bucketList} editing={tx} />
                  )}
                </QueryState>
              )}
            </QueryState>
          ) : (
            <Text c="dimmed">
              {t(tx.reversed ? "transactions.reversedNote" : "transactions.systemNote")}{" "}
              <Anchor component={Link} to={`/transactions?open=${tx.id}`}>
                {t("transactions.backToList")}
              </Anchor>
            </Text>
          )}
        </Stack>
      )}
    </QueryState>
  );
}
