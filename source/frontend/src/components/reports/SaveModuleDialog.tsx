import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useSession, useUpdatePreferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { moduleTitle, type PartModule, type ReportSettings } from "@/lib/reports";
import {
  fromReportModule,
  MAX_SAVED_MODULES,
  MAX_SAVED_NAME,
  newSavedModuleId,
  readSavedModules,
} from "@/lib/savedModules";

/**
 * Save module… (#201): a report's module saved by name, over the report's
 * period and with its filters, for the Graphs tab and the Dashboard. Give
 * it a key per module, so each opens with its title.
 */
export function SaveModuleDialog({
  report,
  module,
  onClose,
}: {
  report: ReportSettings;
  /** The module to save; none closes the dialog. */
  module: PartModule | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const saved = readSavedModules(useSession().data?.preferences.saved_modules);
  // Keyed by the module, so each one opens with its title.
  const [name, setName] = useState(() =>
    module ? moduleTitle(module).slice(0, MAX_SAVED_NAME) : "",
  );
  const full = saved.length >= MAX_SAVED_MODULES;

  const error =
    name.trim() === ""
      ? t("common.enterName")
      : name.trim().length > MAX_SAVED_NAME
        ? t("common.maxChars", { count: MAX_SAVED_NAME })
        : undefined;

  const save = async () => {
    if (!module || error || full) return;
    const made = fromReportModule(report, module, newSavedModuleId(saved), name);
    await update.mutateAsync({ saved_modules: [...saved, made] });
    notifications.show({
      color: "green",
      message: t("stats.reports.module.saved", { name: made.name }),
    });
    onClose();
  };

  return (
    <ResponsiveModal
      opened={module !== null}
      onClose={onClose}
      title={t("stats.reports.module.saveTitle")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch(() => undefined);
        }}
      >
        <Stack gap="md">
          {full ? (
            <Text size="sm">{t("stats.reports.module.savedMax", { max: MAX_SAVED_MODULES })}</Text>
          ) : (
            <>
              <TextInput
                label={t("stats.saved.name")}
                value={name}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                }}
                error={name !== "" ? error : undefined}
                data-autofocus
              />
              <Text size="sm" c="dimmed">
                {t("stats.reports.module.saveHint")}
              </Text>
            </>
          )}
          {update.error && <ErrorAlert error={update.error} />}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={update.isPending} disabled={full || error !== undefined}>
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </ResponsiveModal>
  );
}
