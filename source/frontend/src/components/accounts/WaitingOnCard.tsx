// The card purchases whose buckets count them as they're paid off (#264), on
// a payment to the card: payments clear the oldest debt first.

import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import { useWaitingCharges } from "@/api/waiting";
import { addAmounts, formatMoney } from "@/lib/money";

export function WaitingOnCard({ card, buckets }: { card: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const charges = (useWaitingCharges().data ?? []).filter(
    (c) => c.when === "paid" && c.purchase_account_id === card.id,
  );
  if (charges.length === 0) return null;
  const names = [...new Set(charges.map((c) => c.bucket_id))].map(
    (id) => buckets.find((b) => b.id === id)?.name ?? id,
  );
  return (
    <Text size="sm" c="dimmed">
      {t("waiting.payment", {
        amount: formatMoney(addAmounts(...charges.map((c) => c.left)), card.currency),
        buckets: names.join(", "),
        count: charges.length,
      })}
    </Text>
  );
}
