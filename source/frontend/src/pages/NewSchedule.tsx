import { Anchor, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import { useTransaction } from "@/api/transactions";
import { QueryState } from "@/components/QueryState";
import { TransactionForm, type ScheduleOptions } from "@/components/transactions/TransactionForm";

/**
 * New schedule (#154): the Create transaction form with when to record it.
 * With ?from=<transaction>, Make recurring: it starts like that transaction.
 */
export default function NewSchedule() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const from = params.get("from");
  return (
    <Stack gap="lg">
      <Title order={2}>{t("schedules.new")}</Title>
      {from ? <FromTransaction id={from} /> : <Form schedule={{}} />}
    </Stack>
  );
}

function FromTransaction({ id }: { id: string }) {
  const transaction = useTransaction(id);
  return <QueryState query={transaction}>{(tx) => <Form schedule={{ from: tx }} />}</QueryState>;
}

/** The form, once the accounts and buckets are known. */
export function Form({ schedule }: { schedule: ScheduleOptions }): ReactNode {
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
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
            {(bucketList) => (
              <TransactionForm accounts={accountList} buckets={bucketList} schedule={schedule} />
            )}
          </QueryState>
        )
      }
    </QueryState>
  );
}
