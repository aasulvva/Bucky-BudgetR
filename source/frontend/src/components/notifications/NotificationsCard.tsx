import { Card, Select, Stack, Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { DEFAULT_UPCOMING_DAYS, type NotificationSettings } from "@/api/notifications";
import { useUpdatePreferences, type Preferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";

/** Bills show this many days ahead unless set. */
const DAYS = [1, 2, 3, 5, 7, 14];

type Toggle =
  | "approval_queue"
  | "upcoming_bills"
  | "investment_balance"
  | "bucket_uncovered"
  | "savings_transfer"
  | "savings_short"
  | "bsu_over_limit"
  | "bsu_withdrawal"
  | "credit_limit"
  | "card_bills"
  | "bucket_charges"
  | "planned_purchases";
const TOGGLES: Toggle[] = [
  "approval_queue",
  "upcoming_bills",
  "investment_balance",
  "bucket_uncovered",
  "savings_transfer",
  "savings_short",
  "bsu_over_limit",
  "bsu_withdrawal",
  "credit_limit",
  "card_bills",
  "bucket_charges",
  "planned_purchases",
];

/** Settings › Notifications (#57): which kinds show, and how far ahead bills do. */
export function NotificationsCard({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const current: NotificationSettings = preferences.notifications ?? {};
  // The server replaces the object as a whole.
  const change = (patch: NotificationSettings) => {
    update.mutate({ notifications: { ...current, ...patch } });
  };
  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Text fw={600}>{t("notifications.settings.title")}</Text>
          <Text size="sm" c="dimmed">
            {t("notifications.settings.hint")}
          </Text>
        </div>
        {TOGGLES.map((key) => (
          <Switch
            key={key}
            label={t(`notifications.settings.${key}`)}
            description={t(`notifications.settings.${key}Hint`)}
            checked={current[key] !== false}
            disabled={update.isPending}
            onChange={(e) => {
              change({ [key]: e.currentTarget.checked ? null : false });
            }}
          />
        ))}
        <Select
          label={t("notifications.settings.upcomingDays")}
          data={DAYS.map((d) => ({
            value: String(d),
            label: t("notifications.settings.days", { count: d }),
          }))}
          value={String(current.upcoming_days ?? DEFAULT_UPCOMING_DAYS)}
          allowDeselect={false}
          disabled={update.isPending || current.upcoming_bills === false}
          onChange={(value) => {
            const days = Number(value);
            change({ upcoming_days: days === DEFAULT_UPCOMING_DAYS ? null : days });
          }}
          maw={240}
        />
        {update.error && <ErrorAlert error={update.error} />}
      </Stack>
    </Card>
  );
}
