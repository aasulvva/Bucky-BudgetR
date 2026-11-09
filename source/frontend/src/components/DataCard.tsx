import {
  Alert,
  Button,
  Card,
  FileButton,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconDownload, IconUpload } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { downloadExport, parseExport, useImportData, type ExportPreview } from "@/api/userdata";
import { useSession } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { formatDateTime } from "@/lib/dates";

interface Picked {
  text: string;
  preview: ExportPreview;
  own: boolean;
}

/**
 * Settings → Data (#36): download all of the user's data as one file, or
 * replace it with such a file. The import downloads the current data first.
 */
export function DataCard() {
  const { t } = useTranslation();
  const user = useSession().data;
  const download = useMutation({
    mutationFn: (username: string) => downloadExport(username),
    meta: { silentError: true },
  });
  const [picked, setPicked] = useState<Picked | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  if (!user) return null;

  const pick = async (file: File | null) => {
    setFileError(null);
    if (!file) return;
    const text = await file.text();
    const parsed = parseExport(text);
    if (!parsed.ok) {
      setFileError(
        parsed.reason === "newer"
          ? t("settings.dataTransfer.newer")
          : t("settings.dataTransfer.invalid"),
      );
      return;
    }
    setPicked({ text, preview: parsed.preview, own: parsed.preview.userId === user.id });
  };

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Text fw={600}>{t("settings.data")}</Text>
        <Text size="sm" c="dimmed">
          {t("settings.dataText")}
        </Text>
        <Group gap="sm">
          <Button
            leftSection={<IconDownload size={16} />}
            loading={download.isPending}
            onClick={() => {
              download.mutate(user.username, {
                onSuccess: () => {
                  notifications.show({
                    color: "green",
                    message: t("settings.dataTransfer.downloaded"),
                  });
                },
              });
            }}
          >
            {t("settings.dataTransfer.download")}
          </Button>
          <FileButton accept="application/json,.json" onChange={(f) => void pick(f)}>
            {(props) => (
              <Button {...props} variant="default" leftSection={<IconUpload size={16} />}>
                {t("settings.dataTransfer.import")}
              </Button>
            )}
          </FileButton>
        </Group>
        <Text size="xs" c="dimmed">
          {t("settings.dataTransfer.privacy")} {t("settings.dataTransfer.importHint")}
        </Text>
        {download.error && <ErrorAlert error={download.error} />}
        {fileError && (
          <Alert color="red" icon={<IconAlertTriangle />}>
            {fileError}
          </Alert>
        )}
      </Stack>
      <ResponsiveModal
        opened={picked !== null}
        onClose={() => {
          setPicked(null);
        }}
        title={t("settings.dataTransfer.confirmTitle")}
      >
        {picked && (
          <ImportConfirm
            picked={picked}
            username={user.username}
            onDone={() => {
              setPicked(null);
            }}
          />
        )}
      </ResponsiveModal>
    </Card>
  );
}

function ImportConfirm({
  picked,
  username,
  onDone,
}: {
  picked: Picked;
  username: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const importData = useImportData();
  // The current data is downloaded first, so the import can be undone.
  const run = useMutation({
    mutationFn: async () => {
      await downloadExport(username);
      return importData.mutateAsync(picked.text);
    },
    meta: { silentError: true },
  });
  const { preview } = picked;
  const counts = ["accounts", "buckets", "cycles", "transactions", "schedules"] as const;
  return (
    <Stack gap="md">
      <Text size="sm">
        <Trans
          i18nKey="settings.dataTransfer.fileFrom"
          values={{
            username: preview.username,
            when: preview.exportedAt ? formatDateTime(preview.exportedAt) : "?",
          }}
          components={{ b: <b /> }}
        />{" "}
        {!picked.own && t("settings.dataTransfer.otherUser")}
      </Text>
      <Table withRowBorders={false} verticalSpacing={2} fz="sm" w="auto">
        <Table.Tbody>
          {counts.map((k) => (
            <Table.Tr key={k}>
              <Table.Td c="dimmed">{t(`settings.dataTransfer.counts.${k}`)}</Table.Td>
              <Table.Td ta="right">{preview[k]}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Alert color="orange" icon={<IconAlertTriangle />}>
        {t("settings.dataTransfer.replaceWarning")}
      </Alert>
      <TextInput
        label={t("settings.dataTransfer.typeUsername", { username })}
        value={typed}
        autoComplete="off"
        onChange={(e) => {
          setTyped(e.currentTarget.value);
        }}
      />
      {run.error && <ErrorAlert error={run.error} />}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          disabled={typed.trim() !== username}
          loading={run.isPending}
          onClick={() => {
            run.mutate(undefined, {
              onSuccess: (result) => {
                notifications.show({
                  color: "green",
                  message: t("settings.dataTransfer.imported", {
                    accounts: result.accounts,
                    transactions: result.transactions,
                  }),
                });
                onDone();
              },
            });
          }}
        >
          {t("settings.dataTransfer.confirm")}
        </Button>
      </Group>
    </Stack>
  );
}
