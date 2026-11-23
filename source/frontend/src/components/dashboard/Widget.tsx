import { ActionIcon, Anchor, Box, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { useContext, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { QueryState } from "@/components/QueryState";
import { accountSummary, toneText } from "@/lib/buckets";
import { compareAmounts, formatMoney } from "@/lib/money";

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

/**
 * What an account's buckets have left, and what its balance lacks (Short,
 * in the shortage's tone) or has to spare (Unallocated).
 */
export function BucketsSummary({ account, buckets }: { account: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const money = (amount: string) => formatMoney(amount, account.currency);
  const summary = accountSummary(account, buckets);
  const isShort = compareAmounts(summary.short, "0") > 0;
  return (
    <Group gap="lg" wrap="wrap">
      <Text size="sm" c="dimmed">
        {t("buckets.leftInBuckets")}{" "}
        <Text span fw={700} c="var(--mantine-color-text)">
          {money(summary.left)}
        </Text>
      </Text>
      <Text size="sm" c={isShort ? toneText(summary.tone) : "dimmed"}>
        {isShort ? t("buckets.short") : t("buckets.unallocated")}{" "}
        <Text span fw={700} c={isShort ? undefined : "var(--mantine-color-text)"}>
          {money(isShort ? summary.short : summary.unallocated)}
        </Text>
      </Text>
    </Group>
  );
}

/** Points to Bucket setup (or Account setup) while there are no buckets. */
/**
 * A widget pinned to an account or bucket that has been deleted (#89, #135):
 * says so and offers to choose another in its settings.
 */
const GONE_KEYS = {
  account: ["dashboard.gone.account", "dashboard.gone.chooseAccount"],
  bucket: ["dashboard.gone.bucket", "dashboard.gone.chooseBucket"],
  target: ["dashboard.gone.target", "dashboard.gone.chooseTarget"],
} as const;

export function Gone({ what }: { what: keyof typeof GONE_KEYS }) {
  const { t } = useTranslation();
  const { openSettings, editing } = useContext(WidgetFrame);
  const [text, choose] = GONE_KEYS[what];
  return (
    <Stack gap="xs" align="flex-start">
      <Text size="sm" c="dimmed">
        {t(text)}
      </Text>
      {openSettings && !editing && (
        <Button variant="light" size="xs" onClick={openSettings}>
          {t(choose)}
        </Button>
      )}
    </Stack>
  );
}

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
