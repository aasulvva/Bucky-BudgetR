import { Anchor, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={2}>{t("nav.notFound.title")}</Title>
      <Text c="dimmed">
        {t("nav.notFound.text")}{" "}
        <Anchor component={Link} to="/">
          {t("nav.notFound.home")}
        </Anchor>
      </Text>
    </Stack>
  );
}
