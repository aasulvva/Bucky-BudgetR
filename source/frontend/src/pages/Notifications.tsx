import { Anchor, Box, Button, Card, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import {
  type Icon,
  IconAlertTriangle,
  IconCalendarDue,
  IconCheck,
  IconChecklist,
  IconCoinOff,
  IconPigMoney,
  IconTrendingUp,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  useDismiss,
  useNotifications,
  type Notification,
  type NotificationKind,
} from "@/api/notifications";
import { ErrorAlert } from "@/components/ErrorAlert";
import { useNotificationText } from "@/components/notifications/notificationText";
import { QueryState } from "@/components/QueryState";

const ICONS: Record<NotificationKind, Icon> = {
  approval_queue: IconChecklist,
  upcoming_bill: IconCalendarDue,
  investment_balance: IconTrendingUp,
  bucket_uncovered: IconAlertTriangle,
  savings_transfer: IconPigMoney,
  savings_short: IconCoinOff,
};

const COLORS: Record<Notification["severity"], string> = {
  alert: "red",
  warning: "orange",
  info: "blue",
};

/**
 * Notifications (#57): reminders and to-dos the app can't do for the user.
 * Each one opens where it's done, or is dismissed (marked done) until it
 * happens again. Ones whose task is done go away by themselves.
 */
export default function Notifications() {
  const { t } = useTranslation();
  const notifications = useNotifications();
  return (
    <Stack gap="lg" maw={860}>
      <Title order={2}>{t("nav.items.notifications")}</Title>
      <QueryState query={notifications}>
        {(list) =>
          list.length === 0 ? (
            <Card withBorder>
              <Stack gap={4} align="center" py="md">
                <ThemeIcon variant="light" color="green" size="lg" radius="xl">
                  <IconCheck size={20} />
                </ThemeIcon>
                <Text fw={600}>{t("notifications.empty")}</Text>
                <Text size="sm" c="dimmed" ta="center">
                  {t("notifications.emptyHint")}{" "}
                  <Anchor component={Link} to="/settings" size="sm">
                    {t("notifications.settingsLink")}
                  </Anchor>
                </Text>
              </Stack>
            </Card>
          ) : (
            <Card withBorder padding={0}>
              {list.map((n) => (
                <NotificationRow key={n.key} notification={n} />
              ))}
            </Card>
          )
        }
      </QueryState>
    </Stack>
  );
}

function NotificationRow({ notification: n }: { notification: Notification }) {
  const { t } = useTranslation();
  const text = useNotificationText()(n);
  const dismiss = useDismiss();
  const KindIcon = ICONS[n.kind];
  return (
    <Box
      px="md"
      py="sm"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      data-testid="notification"
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon variant="light" color={COLORS[n.severity]} size="lg" radius="xl">
          <KindIcon size={18} />
        </ThemeIcon>
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Box>
            <Text fw={600}>{text.title}</Text>
            <Text size="sm" c="dimmed">
              {text.body}
            </Text>
          </Box>
          <Group gap="xs">
            <Button size="xs" component={Link} to={text.link}>
              {text.open}
            </Button>
            <Button
              size="xs"
              variant={text.done ? "default" : "subtle"}
              color={text.done ? undefined : "gray"}
              leftSection={text.done ? <IconCheck size={14} /> : <IconX size={14} />}
              aria-label={`${t(text.done ? "notifications.done" : "notifications.dismiss")}: ${text.title}`}
              loading={dismiss.isPending}
              onClick={() => {
                dismiss.mutate(n.key);
              }}
            >
              {t(text.done ? "notifications.done" : "notifications.dismiss")}
            </Button>
          </Group>
          {dismiss.error && <ErrorAlert error={dismiss.error} />}
        </Stack>
      </Group>
    </Box>
  );
}
