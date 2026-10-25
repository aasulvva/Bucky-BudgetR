import { Anchor, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <Stack gap="xs">
      <Title order={2}>Page not found</Title>
      <Text c="dimmed">
        There is nothing at this address.{" "}
        <Anchor component={Link} to="/">
          Go to the dashboard
        </Anchor>
      </Text>
    </Stack>
  );
}
