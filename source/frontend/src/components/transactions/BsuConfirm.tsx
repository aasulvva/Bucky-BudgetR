// The confirm when a transaction takes a BSU account over its deposit limits
// or money out of one (#214, spec §2.1): the server asks with a 409, and
// Record it anyway sends it again with bsu_confirmed.

import { Alert, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { BsuAsk } from "@/lib/bsu";

export function BsuConfirm({
  ask,
  pending,
  onConfirm,
  onCancel,
}: {
  ask: BsuAsk;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const key = ask === "bsu_over_limit" ? "over" : "withdrawal";
  return (
    <Alert
      color="orange"
      icon={<IconAlertTriangle size={18} />}
      title={t(`bsu.confirm.${key}Title`)}
      role="alertdialog"
    >
      <Text size="sm">{t(`bsu.confirm.${key}Body`)}</Text>
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
