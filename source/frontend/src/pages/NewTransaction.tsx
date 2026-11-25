import { Anchor, Stack, Text, Title } from "@mantine/core";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import { usePlannedPurchase, type PlannedPurchase } from "@/api/planned";
import { QueryState } from "@/components/QueryState";
import { TransactionForm } from "@/components/transactions/TransactionForm";
import { PLANNED_PATH } from "@/lib/planned";

/**
 * Create transaction (spec §9, canvas "Create transaction"): an income,
 * expense or transfer, optionally split between the account's buckets. The
 * most-used screen, so it's built for quick entry on a phone.
 *
 * With ?planned=<id>, Record charge (#265): the planned purchase's expense.
 */
export default function NewTransaction() {
  const [params] = useSearchParams();
  const planned = params.get("planned");
  return planned ? <RecordCharge id={planned} /> : <Screen />;
}

function RecordCharge({ id }: { id: string }) {
  const { t } = useTranslation();
  const plan = usePlannedPurchase(id);
  return (
    <QueryState query={plan}>
      {(p) =>
        p.status === "open" ? (
          <Screen planned={p} />
        ) : (
          <Stack gap="lg">
            <Title order={2}>{t("planned.recordCharge")}</Title>
            <Text c="dimmed">
              {t("planned.closedNote")}{" "}
              <Anchor component={Link} to={PLANNED_PATH}>
                {t("planned.back")}
              </Anchor>
            </Text>
          </Stack>
        )
      }
    </QueryState>
  );
}

function Screen({ planned }: { planned?: PlannedPurchase }) {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <Stack gap="lg">
      <Title order={2}>{t(planned ? "planned.recordCharge" : "nav.items.newTransaction")}</Title>
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
                <TransactionForm
                  accounts={accountList}
                  buckets={bucketList}
                  {...(planned ? { planned } : {})}
                />
              )}
            </QueryState>
          )
        }
      </QueryState>
    </Stack>
  );
}
