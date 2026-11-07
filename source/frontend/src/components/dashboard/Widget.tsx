import { ActionIcon, Anchor, Box, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { useContext, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { QueryState } from "@/components/QueryState";

import { WidgetFrame } from "./frame";

/**
 * A widget's card: its title (the frame's, else the widget's name), a link
 * to its screen, and its settings button.
 */
export function WidgetCard({
  title,
  link,
  action,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  action?: ReactNode;
  children: ReactNode;
}) {
  const frame = useContext(WidgetFrame);
  const { editing, bar } = frame;
  const shownTitle = frame.title ?? title;
  return (
    <Card withBorder component="section" aria-label={shownTitle} h="100%">
      <Stack gap="sm">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Title order={3} size="h5">
            {shownTitle}
          </Title>
          {editing ? (
            bar
          ) : (
            <Group gap="xs" wrap="nowrap">
              {link && (
                <Anchor component={Link} to={link.to} size="sm">
                  {link.label}
                </Anchor>
              )}
              {action}
            </Group>
          )}
        </Group>
        {editing ? (
          <Box inert style={{ opacity: 0.6 }}>
            <Stack gap="sm">{children}</Stack>
          </Box>
        ) : (
          children
        )}
      </Stack>
    </Card>
  );
}

export function SettingsButton({ widget, onClick }: { widget: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      aria-label={t("dashboard.settingsFor", { widget })}
      title={t("dashboard.settings")}
      onClick={onClick}
    >
      <IconSettings size={18} />
    </ActionIcon>
  );
}

/** Loads the accounts and buckets for a widget. */
export function MoneyState({
  children,
}: {
  children: (accounts: Account[], buckets: Bucket[]) => ReactNode;
}) {
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={accounts}>
      {(accountList) => (
        <QueryState query={buckets}>{(bucketList) => children(accountList, bucketList)}</QueryState>
      )}
    </QueryState>
  );
}

/** Points to Bucket setup (or Account setup) while there are no buckets. */
export function NoBuckets({ accounts }: { accounts: Account[] }) {
  return (
    <Text size="sm" c="dimmed">
      <Trans
        i18nKey={accounts.length === 0 ? "accounts.empty" : "buckets.noBuckets"}
        components={{
          setup: (
            <Anchor
              component={Link}
              to={accounts.length === 0 ? "/accounts/setup" : "/buckets/setup"}
            />
          ),
        }}
      />
    </Text>
  );
}
