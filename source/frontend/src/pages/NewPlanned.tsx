import { Anchor, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import type { PlannedPurchase } from "@/api/planned";
import { QueryState } from "@/components/QueryState";
import { PlannedForm } from "@/components/planned/PlannedForm";

/** New planned purchase (#265): a pre-order or the like, charged later. */
export default function NewPlanned() {
  const { t } = useTranslation();
  return (
    <Stack gap="lg">
      <Title order={2}>{t("planned.new")}</Title>
      <Form />
    </Stack>
  );
}

/** The form, once the accounts and buckets are known. */
export function Form({ editing }: { editing?: PlannedPurchase }): ReactNode {
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
              <PlannedForm
                accounts={accountList}
                buckets={bucketList}
                {...(editing ? { editing } : {})}
              />
            )}
          </QueryState>
        )
      }
    </QueryState>
  );
}
