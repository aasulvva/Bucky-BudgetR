import { Badge, Card, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { QueryState } from "@/components/QueryState";

import { Placeholder } from "./Placeholder";

export default function Settings() {
  return (
    <Stack gap="lg">
      <Placeholder title="Settings" issue={20} />
      <ApiStatus />
    </Stack>
  );
}

/** Whether the backend and its database are reachable (GET /readyz). */
function ApiStatus() {
  const query = useQuery({
    queryKey: ["readyz"],
    queryFn: () => unwrap(api.GET("/readyz")),
    retry: false,
  });
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Server status
      </Text>
      <QueryState query={query}>
        {(data) => (
          <Group gap="xs">
            <Badge color="green">{data.status}</Badge>
            <Text size="sm" c="dimmed">
              API and database are reachable.
            </Text>
          </Group>
        )}
      </QueryState>
    </Card>
  );
}
