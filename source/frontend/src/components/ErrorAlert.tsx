import { ActionIcon, Alert, Anchor, Button, Code, CopyButton, Group, Text } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconCopy } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { describeError } from "@/api/errors";
import { SESSION_KEY, type User } from "@/app/session";

interface ErrorAlertProps {
  error: unknown;
  onRetry?: () => void;
}

/**
 * Shows an error with its detail and reference (the request ID, #93), and an
 * optional Retry button. The reference can be copied to pass on; for admins
 * it opens the request's entries on the Logs screen.
 */
export function ErrorAlert({ error, onRetry }: ErrorAlertProps) {
  const { t } = useTranslation();
  const { title, detail, requestId } = describeError(error);
  // Read without fetching: an error can show before or without a session.
  const isAdmin = useQueryClient().getQueryData<User | null>(SESSION_KEY)?.admin === true;
  return (
    <Alert color="red" title={title} icon={<IconAlertTriangle />}>
      {detail && <Text size="sm">{detail}</Text>}
      {requestId && (
        <Group gap={4} mt={4} wrap="wrap">
          <Text size="xs" c="dimmed">
            {t("common.reference")}: <Code>{requestId}</Code>
          </Text>
          <CopyButton value={requestId}>
            {({ copied, copy }) => (
              <ActionIcon
                variant="subtle"
                color={copied ? "teal" : "gray"}
                size="sm"
                aria-label={copied ? t("common.copied") : t("common.copyReference")}
                onClick={copy}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </ActionIcon>
            )}
          </CopyButton>
          {isAdmin ? (
            <Anchor
              component={Link}
              to={`/admin/logs?request=${encodeURIComponent(requestId)}`}
              size="xs"
            >
              {t("common.openInLogs")}
            </Anchor>
          ) : (
            <Text size="xs" c="dimmed">
              {t("common.referenceHint")}
            </Text>
          )}
        </Group>
      )}
      {onRetry && (
        <Button size="xs" variant="light" color="red" mt="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </Alert>
  );
}
