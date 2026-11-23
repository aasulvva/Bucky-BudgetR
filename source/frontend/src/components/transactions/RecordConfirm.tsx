// The confirm when the server asks before recording (spec §2.1, §2.2): a
// transaction that takes a BSU account over its deposit limits or money out
// of one (#214), or a credit card past its limit (#260). Record it anyway
// sends it again with bsu_confirmed or limit_confirmed.

import { Alert, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { BsuAsk } from "@/lib/bsu";

/** What the server asks to confirm. */
export type RecordAsk = BsuAsk | "over_credit_limit";

export function RecordConfirm({
  ask,
  pending,
  onConfirm,
  onCancel,
}: {
  ask: RecordAsk;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, body] =
    ask === "over_credit_limit"
      ? [t("cards.confirm.title"), t("cards.confirm.body")]
      : ask === "bsu_over_limit"
        ? [t("bsu.confirm.overTitle"), t("bsu.confirm.overBody")]
        : [t("bsu.confirm.withdrawalTitle"), t("bsu.confirm.withdrawalBody")];
  return (
    <Alert color="orange" icon={<IconAlertTriangle size={18} />} title={title} role="alertdialog">
      <Text size="sm">{body}</Text>
      <Group gap="xs" mt="sm">
        <Button size="xs" color="orange" loading={pending} onClick={onConfirm}>
          {t("bsu.confirm.record")}
        </Button>
        <Button size="xs" variant="default" disabled={pending} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </Group>
    </Alert>
  );
}
