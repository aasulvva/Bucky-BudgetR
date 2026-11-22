import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account } from "@/api/accounts";
import { useSavingsTargets } from "@/api/savings";
import { compareAmounts, formatMoney } from "@/lib/money";
import { targetOf } from "@/lib/savings";

/**
 * What a change releases from savings (#231, spec §8): the bucket's or
 * account's savings target goes, with what's held for it, and an account's
 * reservations for other targets are released too. Nothing when there's
 * nothing to say.
 */
export function ReleaseNote({
  bucketId,
  account,
  reservedToo,
}: {
  bucketId?: string;
  account?: Account;
  /** Also mention what's held on the account for any target (deleting it). */
  reservedToo?: boolean;
}) {
  const { t } = useTranslation();
  const targets = useSavingsTargets().data ?? [];
  const target = targetOf(targets, { bucketId, accountId: account?.id });
  const lines: string[] = [];
  if (target) {
    lines.push(
      compareAmounts(target.held_total, "0") > 0
        ? t("savings.release.targetHeld", {
            name: target.name,
            amount: formatMoney(target.held_total, target.currency),
          })
        : t("savings.release.target", { name: target.name }),
    );
  }
  if (reservedToo && account && compareAmounts(account.reserved, "0") > 0) {
    lines.push(
      t("savings.release.reserved", { amount: formatMoney(account.reserved, account.currency) }),
    );
  }
  if (lines.length === 0) return null;
  return <Text size="sm">{lines.join(" ")}</Text>;
}
