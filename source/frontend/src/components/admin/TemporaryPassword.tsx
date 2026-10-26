import { ActionIcon, Alert, Button, Code, CopyButton, Group, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy, IconInfoCircle } from "@tabler/icons-react";
import { Trans, useTranslation } from "react-i18next";

/**
 * A new temporary password, shown once: after creating a user or resetting
 * their password. The admin hands it over; the user changes it at login.
 */
export function TemporaryPassword({
  username,
  password,
  onDone,
}: {
  username: string;
  password: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="admin.password.intro"
          values={{ name: username }}
          components={{ b: <strong /> }}
        />
      </Text>
      <Group gap="xs" wrap="nowrap" justify="center">
        <Code fz="lg" px="md" py="xs" data-testid="temporary-password">
          {password}
        </Code>
        <CopyButton value={password}>
          {({ copied, copy }) => (
            <ActionIcon
              variant="subtle"
              color={copied ? "teal" : "gray"}
              size={44}
              aria-label={copied ? t("admin.password.copied") : t("admin.password.copy")}
              onClick={copy}
            >
              {copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Group>
      <Alert color="orange" icon={<IconInfoCircle />}>
        {t("admin.password.onceOnly")}
      </Alert>
      <Group justify="flex-end">
        <Button onClick={onDone} data-autofocus>
          {t("admin.password.done")}
        </Button>
      </Group>
    </Stack>
  );
}
