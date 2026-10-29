import { Button, Checkbox, Group, List, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useSession, useUpdatePreferences } from "@/app/session";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  APP_VERSION,
  CHANGELOG,
  entriesSince,
  entryTitle,
  isFeatureUpdate,
  type ChangelogEntry,
} from "@/lib/changelog";
import { LANGUAGES, type Language } from "@/lib/language";

/** The changelog's language: the app's, else English. */
function useChangelogLanguage(): Language {
  const { i18n } = useTranslation();
  return LANGUAGES.find((l) => l.value === i18n.resolvedLanguage)?.value ?? "en";
}

/** The entries, one section each: the title template and the changes. */
function Entries({ entries }: { entries: ChangelogEntry[] }) {
  const language = useChangelogLanguage();
  return (
    <Stack gap="lg">
      {entries.map((entry) => (
        <Stack key={entry.version} gap="xs" component="section">
          <Title order={3} size="h5">
            {entryTitle(entry, language)}
          </Title>
          <List size="sm" spacing={4}>
            {entry.changes[language].map((change) => (
              <List.Item key={change}>{change}</List.Item>
            ))}
          </List>
        </Stack>
      ))}
    </Stack>
  );
}

/** What's New from the profile menu: every version. */
export function WhatsNew({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={t("whatsNew.title")} size="lg">
      <Entries entries={CHANGELOG} />
    </ResponsiveModal>
  );
}

/**
 * What's New when the app opens after a feature or major update (not a
 * patch), with what changed since the user last saw it. Closing it saves
 * the version as seen; the checkbox stops it popping up again.
 */
export function WhatsNewPopup() {
  const preferences = useSession().data?.preferences;
  // Decided once, from the preferences the app opened with.
  const [seen] = useState(() =>
    preferences && preferences.whats_new_popup !== false
      ? { version: preferences.whats_new_seen ?? null }
      : null,
  );
  if (!seen || !isFeatureUpdate(seen.version, APP_VERSION)) return null;
  return <Popup entries={entriesSince(seen.version)} />;
}

function Popup({ entries }: { entries: ChangelogEntry[] }) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const [opened, setOpened] = useState(true);
  const [dontShow, setDontShow] = useState(false);
  const close = () => {
    setOpened(false);
    update.mutate({ whats_new_seen: APP_VERSION, ...(dontShow ? { whats_new_popup: false } : {}) });
  };
  return (
    <ResponsiveModal opened={opened} onClose={close} title={t("whatsNew.title")} size="lg">
      <Stack gap="lg">
        <Text size="sm" c="dimmed">
          {t("whatsNew.updated", { version: APP_VERSION })}
        </Text>
        <Entries entries={entries} />
        <Group justify="space-between" gap="sm">
          <Checkbox
            label={t("whatsNew.dontShow")}
            checked={dontShow}
            onChange={(e) => {
              setDontShow(e.currentTarget.checked);
            }}
          />
          <Button onClick={close}>{t("common.close")}</Button>
        </Group>
      </Stack>
    </ResponsiveModal>
  );
}
