import { Anchor, Card, Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import { SESSION_KEY } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { PasswordForm } from "@/components/PasswordForm";

/** A link that doesn't work: unknown, used, expired or replaced. */
const isInvalidLink = (error: unknown) =>
  error instanceof ApiError && (error.code === "invalid_link" || error.status === 400);

/**
 * A setup or reset link from an admin (`/set-password#<token>`): the user
 * chooses their own password and is logged in. Outside the session guard,
 * like the login page.
 */
export default function SetPassword() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const token = useLocation().hash.slice(1);
  const link = useQuery({
    queryKey: ["password-link", token],
    queryFn: () => unwrap(api.POST("/api/v1/auth/password-link", { body: { token } })),
    enabled: token !== "",
    staleTime: Infinity,
  });

  if (token !== "" && link.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={440}>
        {link.data ? (
          <Stack gap="md">
            <Title order={1} size="h3">
              {link.data.purpose === "setup"
                ? t("auth.link.setupTitle", { username: link.data.username })
                : t("auth.link.resetTitle")}
            </Title>
            <Text size="sm" c="dimmed">
              {link.data.purpose === "setup"
                ? t("auth.link.setupIntro", { username: link.data.username })
                : t("auth.link.resetIntro", { username: link.data.username })}
            </Text>
            <PasswordForm
              submitLabel={t("auth.link.submit")}
              save={async (next) => {
                const user = await unwrap(
                  api.POST("/api/v1/auth/password-link/use", {
                    body: { token, new_password: next },
                  }),
                );
                client.setQueryData(SESSION_KEY, user);
              }}
              onChanged={() => {
                void navigate("/", { replace: true });
              }}
            />
          </Stack>
        ) : token === "" || isInvalidLink(link.error) ? (
          <Stack gap="md">
            <Title order={1} size="h3">
              {t("auth.link.invalidTitle")}
            </Title>
            <Text size="sm">{t("auth.link.invalidDetail")}</Text>
            <Anchor component={Link} to="/login">
              {t("auth.link.toLogin")}
            </Anchor>
          </Stack>
        ) : (
          <ErrorAlert error={link.error} onRetry={() => void link.refetch()} />
        )}
      </Card>
    </Center>
  );
}
