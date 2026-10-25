import { Button, Card, Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router";

import { SESSION_KEY, useSignOut, useSession } from "@/app/session";
import { PasswordForm } from "@/components/PasswordForm";

/**
 * The forced password change, for the initial admin and after an admin reset.
 * Until it's done the API refuses everything else, so this page stands alone.
 */
export default function ChangePassword() {
  const session = useSession();
  const client = useQueryClient();
  const signOut = useSignOut();

  if (session.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (!session.data) return <Navigate to="/login" replace />;
  if (!session.data.must_change_password) return <Navigate to="/" replace />;

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={440}>
        <Stack gap="md">
          <Title order={1} size="h3">
            Choose a new password
          </Title>
          <Text size="sm" c="dimmed">
            Hi {session.data.username}. Before you continue, replace the password you were given
            with one only you know.
          </Text>
          <PasswordForm
            submitLabel="Save and continue"
            onChanged={() => {
              void client.invalidateQueries({ queryKey: SESSION_KEY });
            }}
          />
          <Button variant="subtle" onClick={signOut} style={{ alignSelf: "flex-start" }}>
            Sign out
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}
