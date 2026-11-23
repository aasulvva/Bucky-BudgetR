// A BSU account's lock until the history is set up (#214, spec §2.1), on
// Accounts and Account setup.

import { Alert, Anchor, Button, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Account } from "@/api/accounts";
import { BSU_CURRENCY } from "@/lib/bsu";

/** The lock, with Set up BSU (or what to do for one not in NOK). */
export function BsuLocked({ account, onSetUp }: { account: Account; onSetUp: () => void }) {
  const { t } = useTranslation();
  if (!account.bsu?.locked) return null;
  const nok = account.currency === BSU_CURRENCY;
  return (
    <Alert color="orange" icon={<IconLock size={18} />} title={t("bsu.locked.title")} p="xs">
      <Text size="sm">
        {nok ? t("bsu.locked.body") : t("bsu.locked.notNok", { currency: account.currency })}
      </Text>
      {nok ? (
        <Button
          size="xs"
          mt="xs"
          color="orange"
          onClick={onSetUp}
          aria-label={t("bsu.locked.setUpName", { name: account.name })}
        >
          {t("bsu.locked.setUp")}
        </Button>
      ) : (
        <Anchor component={Link} to={`/accounts/setup?edit=${account.id}`} size="sm">
          {t("bsu.locked.toSetup")}
        </Anchor>
      )}
    </Alert>
  );
}
