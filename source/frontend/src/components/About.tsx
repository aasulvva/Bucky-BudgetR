import { Button, Group, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { ResponsiveModal } from "@/components/ResponsiveModal";
import { APP_COMMIT, APP_VERSION, IS_DEV } from "@/lib/changelog";

interface AboutProps {
  opened: boolean;
  onClose: () => void;
  /** Opens What's New in its place. */
  onWhatsNew: () => void;
}

/** About: the version running, the commit it was built from, dev or prod. */
export function About({ opened, onClose, onWhatsNew }: AboutProps) {
  const { t } = useTranslation();
  const rows = [
    { label: t("about.version"), value: APP_VERSION },
    { label: t("about.commit"), value: APP_COMMIT, mono: true },
    {
      label: t("about.environment"),
      value: IS_DEV ? t("about.development") : t("about.production"),
    },
  ];
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={t("about.title")}>
      <Stack gap="md">
        <Table variant="vertical" withTableBorder layout="fixed">
          <Table.Tbody>
            {rows.map(({ label, value, mono }) => (
              <Table.Tr key={label}>
                <Table.Th w={140}>{label}</Table.Th>
                <Table.Td>
                  <Text size="sm" ff={mono ? "monospace" : undefined}>
                    {value}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify="flex-end">
          <Button variant="default" onClick={onWhatsNew}>
            {t("about.whatsNew")}
          </Button>
        </Group>
      </Stack>
    </ResponsiveModal>
  );
}
