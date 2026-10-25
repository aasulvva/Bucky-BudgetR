import { Button, Card, Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";

import { SESSION_KEY, useSignOut, useSession } from "@/app/session";
import { PasswordForm } from "@/components/PasswordForm";
import { applyLanguage, resolveLanguage } from "@/lib/language";

/**
 * The forced password change, for the initial admin and after an admin reset.
 * Until it's done the API refuses everything else, so this page stands alone.
 */
export default function ChangePassword() {
  const { t } = useTranslation();
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
  applyLanguage(resolveLanguage(session.data.preferences));

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={440}>
        <Stack gap="md">
          <Title order={1} size="h3">
            {t("auth.changeTitle")}
          </Title>
          <Text size="sm" c="dimmed">
            {t("auth.changeIntro", { username: session.data.username })}
          </Text>
          <PasswordForm
            submitLabel={t("auth.saveAndContinue")}
            onChanged={() => {
              void client.invalidateQueries({ queryKey: SESSION_KEY });
            }}
          />
          <Button variant="subtle" onClick={signOut} style={{ alignSelf: "flex-start" }}>
            {t("nav.signOut")}
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}
