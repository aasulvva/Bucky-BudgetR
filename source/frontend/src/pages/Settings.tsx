import { Badge, Card, Group, Select, Stack, Switch, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { useSession, useUpdatePreferences, type Preferences } from "@/app/session";
import { CycleRuleCard } from "@/components/cycles/CycleRuleCard";
import { NotificationsCard } from "@/components/notifications/NotificationsCard";
import { PasswordForm } from "@/components/PasswordForm";
import { QueryState } from "@/components/QueryState";
import { browserTimeZone } from "@/lib/cycleRule";
import { LANGUAGES } from "@/lib/language";
import { LOCALE_OPTIONS } from "@/lib/locale";

/**
 * Settings (spec §9, canvas): preferences, the cycle rule, notifications,
 * password, status. The bucket defaults and income rules are on Bucket setup
 * (#102).
 */
export default function Settings() {
  const { t } = useTranslation();
  const user = useSession().data;
  return (
    <Stack gap="lg" maw={720}>
      <Title order={2}>{t("nav.items.settings")}</Title>
      {user && (
        <>
          <PreferencesCard preferences={user.preferences} />
          <CycleRuleCard preferences={user.preferences} />
          <NotificationsCard preferences={user.preferences} />
        </>
      )}
      <PasswordCard />
      <DataCard />
      <ApiStatus />
    </Stack>
  );
}

/** The value the locale select uses for "the browser's locale". */
const BROWSER = "browser";
/** The value the language select uses for "follow the locale". */
const FOLLOW = "follow";

/** The time zones to pick from, with the user's own even if it isn't listed. */
function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes(current) ? zones : [current, ...zones];
}

function PreferencesCard({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>{t("settings.preferences")}</Text>
        <Select
          label={t("settings.language")}
          description={t("settings.languageHint")}
          data={[{ value: FOLLOW, label: t("settings.languageFollows") }, ...LANGUAGES]}
          value={preferences.language ?? FOLLOW}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({
              language: LANGUAGES.find((l) => l.value === value)?.value ?? null,
            });
          }}
        />
        <Select
          label={t("settings.locale")}
          description={t("settings.localeHint")}
          data={[{ value: BROWSER, label: t("settings.browserDefault") }, ...LOCALE_OPTIONS]}
          value={preferences.locale ?? BROWSER}
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            update.mutate({ locale: value === BROWSER || value === null ? null : value });
          }}
        />
        <Select
          label={t("settings.timeZone")}
          description={t("settings.timeZoneHint")}
          data={timeZones(preferences.time_zone ?? browserTimeZone())}
          value={preferences.time_zone ?? browserTimeZone()}
          searchable
          allowDeselect={false}
          disabled={update.isPending}
          onChange={(value) => {
            if (value) update.mutate({ time_zone: value });
          }}
        />
        <Switch
          label={t("settings.whatsNewPopup")}
          description={t("settings.whatsNewPopupHint")}
          checked={preferences.whats_new_popup !== false}
          disabled={update.isPending}
          onChange={(e) => {
            // On is the default (null).
            update.mutate({ whats_new_popup: e.currentTarget.checked ? null : false });
          }}
        />
      </Stack>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Text fw={600}>{t("settings.password")}</Text>
        <PasswordForm
          onChanged={() => {
            notifications.show({ color: "green", message: t("settings.passwordChanged") });
          }}
        />
      </Stack>
    </Card>
  );
}

function DataCard() {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Group gap="xs">
        <Text fw={600}>{t("settings.data")}</Text>
        <Badge variant="light" color="gray">
          {t("common.later")}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mt="xs">
        {t("settings.dataText")}
      </Text>
    </Card>
  );
}

/** Whether the backend and its database are reachable (GET /readyz). */
function ApiStatus() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["readyz"],
    queryFn: () => unwrap(api.GET("/readyz")),
    retry: false,
  });
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        {t("settings.serverStatus")}
      </Text>
      <QueryState query={query}>
        {(data) => (
          <Group gap="xs">
            <Badge color="green">{data.status}</Badge>
            <Text size="sm" c="dimmed">
              {t("settings.serverReachable")}
            </Text>
          </Group>
        )}
      </QueryState>
    </Card>
  );
}
