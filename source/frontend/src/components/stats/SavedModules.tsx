import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Input,
  Menu,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useSession, useUpdatePreferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  addModuleWidget,
  dashboardLayouts,
  layoutsToPreferences,
  moduleWidgetsFor,
  type ModuleWidgetPlace,
} from "@/lib/dashboard";
import {
  cleanSavedModule,
  MAX_SAVED_MODULES,
  MAX_SAVED_NAME,
  newSavedModuleId,
  sameSavedModule,
  savedModuleOptions,
  type SavedModule,
} from "@/lib/savedModules";

interface SavedModulesProps {
  saved: SavedModule[];
  /** What's on screen, as a saved module (its id and name don't count). */
  current: SavedModule;
  /** The saved module picked, if any. */
  selectedId: string | null;
  /** Picks a saved module (it replaces what's on screen), or none. */
  onSelect: (saved: SavedModule | null) => void;
}

type Dialog =
  | { kind: "saveAs" | "rename"; name: string }
  | { kind: "delete" }
  | { kind: "dashboard"; where: ModuleWidgetPlace }
  | null;

const PLACES: ModuleWidgetPlace[] = ["desktop", "mobile", "both"];

/**
 * Saved modules (#201; saved graphs before, #122): pick one, save what's on
 * screen, rename or delete it, or add it to the Dashboard as a module
 * widget (#124).
 */
export function SavedModules({ saved, current, selectedId, onSelect }: SavedModulesProps) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const preferences = useSession().data?.preferences;
  const theme = useMantineTheme();
  const phone = !useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const selected = saved.find((g) => g.id === selectedId) ?? null;
  const changed = selected !== null && !sameSavedModule(selected, current);
  const onDashboard =
    selected && preferences ? moduleWidgetsFor(dashboardLayouts(preferences), selected.id) : 0;
  const full = saved.length >= MAX_SAVED_MODULES;

  const save = async (list: SavedModule[]) => {
    await update.mutateAsync({ saved_modules: list.map(cleanSavedModule) });
  };
  const close = () => {
    update.reset();
    setDialog(null);
  };

  const nameError = (name: string) => {
    if (dialog?.kind !== "saveAs" && dialog?.kind !== "rename") return undefined;
    if (name.trim() === "") return t("common.enterName");
    if (name.trim().length > MAX_SAVED_NAME) return t("common.maxChars", { count: MAX_SAVED_NAME });
    return undefined;
  };

  const confirm = async () => {
    if (!dialog) return;
    if (dialog.kind === "dashboard") {
      if (!selected || !preferences) return;
      const layouts = addModuleWidget(dashboardLayouts(preferences), selected.id, dialog.where);
      await update.mutateAsync({ dashboard: layoutsToPreferences(layouts) });
      notifications.show({
        color: "green",
        message: t("stats.saved.added", { name: selected.name }),
      });
    } else if (dialog.kind === "delete") {
      if (!selected) return;
      await save(saved.filter((g) => g.id !== selected.id));
      onSelect(null);
    } else if (dialog.kind === "saveAs") {
      const made = cleanSavedModule({
        ...current,
        id: newSavedModuleId(saved),
        name: dialog.name.trim(),
      });
      await save([...saved, made]);
      onSelect(made);
    } else if (selected) {
      await save(saved.map((g) => (g.id === selected.id ? { ...g, name: dialog.name.trim() } : g)));
    }
    setDialog(null);
  };

  return (
    <Stack gap="xs">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          label={t("stats.saved.label")}
          placeholder={saved.length === 0 ? t("stats.saved.none") : t("stats.saved.pick")}
          data={savedModuleOptions(saved, t)}
          value={selected?.id ?? null}
          onChange={(id) => {
            onSelect(saved.find((g) => g.id === id) ?? null);
          }}
          disabled={saved.length === 0}
          clearable
          w={260}
        />
        {selected && (
          <Button
            variant="default"
            disabled={!changed}
            loading={update.isPending && dialog === null}
            onClick={() => {
              void save(
                saved.map((g) =>
                  g.id === selected.id ? { ...current, id: g.id, name: g.name } : g,
                ),
              );
            }}
          >
            {t("common.save")}
          </Button>
        )}
        <Button
          variant={selected ? "subtle" : "default"}
          disabled={full}
          onClick={() => {
            update.reset();
            setDialog({ kind: "saveAs", name: "" });
          }}
        >
          {t(selected ? "stats.saved.saveAs" : "stats.saved.save")}
        </Button>
        {selected && (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" size="lg" aria-label={t("stats.saved.more")}>
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  update.reset();
                  setDialog({ kind: "rename", name: selected.name });
                }}
              >
                {t("stats.saved.rename")}
              </Menu.Item>
              <Menu.Item
                disabled={!preferences}
                onClick={() => {
                  update.reset();
                  setDialog({ kind: "dashboard", where: phone ? "mobile" : "desktop" });
                }}
              >
                {t("stats.saved.addToDashboard")}
              </Menu.Item>
              <Menu.Item
                color="red"
                onClick={() => {
                  update.reset();
                  setDialog({ kind: "delete" });
                }}
              >
                {t("common.delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        {changed && (
          <Badge variant="light" color="gray" mb={6}>
            {t("stats.saved.unsaved")}
          </Badge>
        )}
      </Group>
      {full && (
        <Text size="xs" c="dimmed">
          {t("stats.saved.max", { max: MAX_SAVED_MODULES })}
        </Text>
      )}
      {update.error && dialog === null && <ErrorAlert error={update.error} />}

      <ResponsiveModal
        opened={dialog !== null}
        onClose={close}
        title={
          dialog?.kind === "delete"
            ? t("stats.saved.deleteTitle")
            : dialog?.kind === "dashboard"
              ? t("stats.saved.addTitle")
              : dialog?.kind === "rename"
                ? t("stats.saved.renameTitle")
                : t("stats.saved.saveAsTitle")
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dialog && (dialog.kind === "saveAs" || dialog.kind === "rename")) {
              if (nameError(dialog.name)) return;
            }
            void confirm().catch(() => undefined);
          }}
        >
          <Stack gap="md">
            {dialog?.kind === "delete" ? (
              <>
                <Text size="sm">{t("stats.saved.deleteText", { name: selected?.name ?? "" })}</Text>
                {onDashboard > 0 && (
                  <Text size="sm">{t("stats.saved.onDashboard", { count: onDashboard })}</Text>
                )}
              </>
            ) : dialog?.kind === "dashboard" ? (
              <>
                <Text size="sm">{t("stats.saved.addHint", { name: selected?.name ?? "" })}</Text>
                <Input.Wrapper label={t("stats.saved.where")}>
                  <SegmentedControl
                    fullWidth
                    data={PLACES.map((p) => ({
                      value: p,
                      label: t(`stats.saved.whereOptions.${p}`),
                    }))}
                    value={dialog.where}
                    onChange={(where) => {
                      setDialog({ kind: "dashboard", where });
                    }}
                  />
                </Input.Wrapper>
                {changed && (
                  <Text size="sm" c="dimmed">
                    {t("stats.saved.unsavedNote")}
                  </Text>
                )}
              </>
            ) : (
              dialog && (
                <TextInput
                  label={t("stats.saved.name")}
                  value={dialog.name}
                  onChange={(e) => {
                    setDialog({ ...dialog, name: e.currentTarget.value });
                  }}
                  error={dialog.name !== "" ? nameError(dialog.name) : undefined}
                  data-autofocus
                />
              )
            )}
            {update.error && <ErrorAlert error={update.error} />}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                color={dialog?.kind === "delete" ? "red" : undefined}
                loading={update.isPending}
                disabled={
                  dialog !== null &&
                  (dialog.kind === "saveAs" || dialog.kind === "rename") &&
                  nameError(dialog.name) !== undefined
                }
              >
                {dialog?.kind === "delete"
                  ? t("common.delete")
                  : dialog?.kind === "dashboard"
                    ? t("stats.saved.addButton")
                    : t("common.save")}
              </Button>
            </Group>
          </Stack>
        </form>
      </ResponsiveModal>
    </Stack>
  );
}
