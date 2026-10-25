import { Anchor, Stack, Text, Title } from "@mantine/core";
import { Trans, useTranslation } from "react-i18next";

import type { NavItem } from "@/app/nav";

/** Stands in for a screen that hasn't been built yet. */
export function Placeholder({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={2}>{t(`nav.items.${item.key}`)}</Title>
      <Text c="dimmed">
        <Trans
          i18nKey="nav.comingIn"
          values={{ issue: item.issue }}
          components={{
            issue: (
              <Anchor
                href={`https://github.com/aasulvva/Bucky-BudgetR/issues/${String(item.issue)}`}
                target="_blank"
              />
            ),
          }}
        />
      </Text>
    </Stack>
  );
}
