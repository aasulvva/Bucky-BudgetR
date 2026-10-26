import { ActionIcon, Alert, Button, Code, CopyButton, Group, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy, IconInfoCircle } from "@tabler/icons-react";
import { Trans, useTranslation } from "react-i18next";

import { passwordLinkUrl, type NewCredential } from "@/api/admin";
import { formatDateTime } from "@/lib/dates";

/**
 * What an admin hands over after creating a user or resetting a password: a
 * setup or reset link, or a temporary password. It is shown only once.
 */
export function NewCredentialView({
  username,
  credential,
  onDone,
}: {
  username: string;
  credential: NewCredential;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { link } = credential;
  const value = link ? passwordLinkUrl(link.token) : (credential.temporary_password ?? "");

  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey={link ? "admin.link.intro" : "admin.password.intro"}
          values={{ name: username }}
          components={{ b: <strong /> }}
        />
      </Text>
      <Group gap="xs" wrap="nowrap" justify="center">
        <Code
          fz={link ? "sm" : "lg"}
          px="md"
          py="xs"
          style={{ wordBreak: "break-all" }}
          data-testid={link ? "password-link" : "temporary-password"}
        >
          {value}
        </Code>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <ActionIcon
              variant="subtle"
              color={copied ? "teal" : "gray"}
              size={44}
              aria-label={
                copied
                  ? t("admin.password.copied")
                  : link
                    ? t("admin.link.copy")
                    : t("admin.password.copy")
              }
              onClick={copy}
            >
              {copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Group>
      <Alert color="orange" icon={<IconInfoCircle />}>
        {link
          ? t("admin.link.onceOnly", { when: formatDateTime(link.expires_at) })
          : t("admin.password.onceOnly")}
      </Alert>
      <Group justify="flex-end">
        <Button onClick={onDone} data-autofocus>
          {t("admin.password.done")}
        </Button>
      </Group>
    </Stack>
  );
}
