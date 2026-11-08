import { ActionIcon, Badge, Indicator, NavLink, VisuallyHidden } from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useNotificationCount } from "@/api/notifications";

export const NOTIFICATIONS_PATH = "/notifications";

/** What a screen reader hears for the count. */
function useCountText(): { count: number; alert: boolean; text: string } {
  const { t } = useTranslation();
  const { count, alert } = useNotificationCount();
  return { count, alert, text: t("notifications.count", { count }) };
}

/**
 * The side menu's Notifications item (#57), above the profile button, with
 * the number of open ones; red when one is an alert.
 */
export function NotificationsNavLink({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { count, alert, text } = useCountText();
  return (
    <NavLink
      component={Link}
      to={NOTIFICATIONS_PATH}
      label={t("nav.items.notifications")}
      leftSection={<IconBell size={18} />}
      active={active}
      rightSection={
        count > 0 && (
          <Badge
            size="sm"
            circle={count < 10}
            color={alert ? "red" : "blue"}
            data-testid="notification-badge"
          >
            <span aria-hidden>{count}</span>
            <VisuallyHidden> {text}</VisuallyHidden>
          </Badge>
        )
      }
    />
  );
}

/** The mobile header's bell, next to the avatar, with the count on it. */
export function NotificationBell() {
  const { t } = useTranslation();
  const { count, alert, text } = useCountText();
  return (
    <Indicator
      label={<span aria-hidden>{count}</span>}
      size={16}
      color={alert ? "red" : "blue"}
      disabled={count === 0}
      offset={4}
    >
      <ActionIcon
        component={Link}
        to={NOTIFICATIONS_PATH}
        variant="subtle"
        color="gray"
        size="lg"
        aria-label={
          count > 0 ? `${t("nav.items.notifications")}, ${text}` : t("nav.items.notifications")
        }
      >
        <IconBell size={20} />
      </ActionIcon>
    </Indicator>
  );
}
