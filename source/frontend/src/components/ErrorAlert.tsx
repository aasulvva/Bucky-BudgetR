import { Alert, Button, Code, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { describeError } from "@/api/errors";

interface ErrorAlertProps {
  error: unknown;
  onRetry?: () => void;
}

/** Shows an error with its detail and request ID, and an optional Retry button. */
export function ErrorAlert({ error, onRetry }: ErrorAlertProps) {
  const { title, detail, requestId } = describeError(error);
  return (
    <Alert color="red" title={title} icon={<IconAlertTriangle />}>
      {detail && <Text size="sm">{detail}</Text>}
      {requestId && (
        <Text size="xs" c="dimmed" mt={4}>
          Request ID: <Code>{requestId}</Code>
        </Text>
      )}
      {onRetry && (
        <Button size="xs" variant="light" color="red" mt="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Alert>
  );
}
