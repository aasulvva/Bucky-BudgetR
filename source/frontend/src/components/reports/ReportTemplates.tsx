import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useUpdatePreferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  cleanReport,
  MAX_TEMPLATES,
  newId,
  sourceValue,
  STARTER_IDS,
  type ReportSettings,
  type ReportSource,
  type ReportTemplate,
} from "@/lib/reports";

const MAX_NAME = 60;

interface ReportTemplatesProps {
  templates: ReportTemplate[];
  source: ReportSource;
  /** The report on screen. */
  current: ReportSettings;
  /** Whether it differs from its source. */
  changed: boolean;
  onSelect: (source: ReportSource) => void;
  /** More buttons at the end of the row: Export PDF (#127). */
  extra?: ReactNode;
}

type Dialog = { kind: "saveAs" | "rename"; name: string } | { kind: "delete" } | null;

/** Pick a starter or saved template (#125), save the report, rename or delete a template. */
export function ReportTemplates({
  templates,
  source,
  current,
  changed,
  onSelect,
  extra,
}: ReportTemplatesProps) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const [dialog, setDialog] = useState<Dialog>(null);
  const selected =
    source.kind === "template" ? (templates.find((x) => x.id === source.id) ?? null) : null;

  const save = async (list: ReportTemplate[]) => {
    await update.mutateAsync({ report_templates: list });
  };
  const close = () => {
    update.reset();
    setDialog(null);
  };
  const nameError = (name: string) => {
    if (name.trim() === "") return t("common.enterName");
    if (name.trim().length > MAX_NAME) return t("common.maxChars", { count: MAX_NAME });
    return undefined;
  };

  const confirm = async () => {
    if (!dialog) return;
    if (dialog.kind === "delete") {
      if (!selected) return;
      await save(templates.filter((x) => x.id !== selected.id));
      onSelect({ kind: "starter", id: "yearly" });
    } else if (dialog.kind === "saveAs") {
      const template: ReportTemplate = {
        id: newId(
          "r",
          templates.map((x) => x.id),
        ),
        name: dialog.name.trim(),
        report: cleanReport(current),
      };
      await save([...templates, template]);
      onSelect({ kind: "template", id: template.id });
    } else if (selected) {
      await save(
        templates.map((x) => (x.id === selected.id ? { ...x, name: dialog.name.trim() } : x)),
      );
    }
    setDialog(null);
  };

  const data = [
    {
      group: t("stats.reports.templates.builtIn"),
      items: STARTER_IDS.map((id) => ({
        value: sourceValue({ kind: "starter", id }),
        label: t(`stats.reports.starters.${id}`),
      })),
    },
    ...(templates.length > 0
      ? [
          {
            group: t("stats.reports.templates.saved"),
            items: templates.map((x) => ({
              value: sourceValue({ kind: "template", id: x.id }),
              label: x.name,
            })),
          },
        ]
      : []),
  ];

  return (
    <Stack gap="xs">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          label={t("stats.reports.templates.label")}
          data={data}
          value={sourceValue(source)}
          onChange={(v) => {
            if (!v) return;
            const [kind, ...rest] = v.split(":");
            const id = rest.join(":");
            if (kind === "starter") {
              const starter = STARTER_IDS.find((s) => s === id);
              if (starter) onSelect({ kind: "starter", id: starter });
            } else {
              onSelect({ kind: "template", id });
            }
          }}
          allowDeselect={false}
          w={260}
        />
        {selected && (
          <Button
            variant="default"
            disabled={!changed}
            loading={update.isPending && dialog === null}
            onClick={() => {
              void save(
                templates.map((x) =>
                  x.id === selected.id ? { ...x, report: cleanReport(current) } : x,
                ),
              ).catch(() => undefined);
            }}
          >
            {t("common.save")}
          </Button>
        )}
        <Button
          variant={selected ? "subtle" : "default"}
          disabled={templates.length >= MAX_TEMPLATES}
          onClick={() => {
            update.reset();
            setDialog({ kind: "saveAs", name: "" });
          }}
        >
          {t(selected ? "stats.saved.saveAs" : "stats.reports.templates.save")}
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
        {extra}
        {changed && (
          <Badge variant="light" color="gray" mb={6}>
            {t("stats.saved.unsaved")}
          </Badge>
        )}
      </Group>
      {update.error && dialog === null && <ErrorAlert error={update.error} />}

      <ResponsiveModal
        opened={dialog !== null}
        onClose={close}
        title={
          dialog?.kind === "delete"
            ? t("stats.reports.templates.deleteTitle")
            : dialog?.kind === "rename"
              ? t("stats.reports.templates.renameTitle")
              : t("stats.reports.templates.saveAsTitle")
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dialog && dialog.kind !== "delete" && nameError(dialog.name)) return;
            void confirm().catch(() => undefined);
          }}
        >
          <Stack gap="md">
            {dialog?.kind === "delete" ? (
              <Text size="sm">
                {t("stats.reports.templates.deleteText", { name: selected?.name ?? "" })}
              </Text>
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
                  dialog.kind !== "delete" &&
                  nameError(dialog.name) !== undefined
                }
              >
                {dialog?.kind === "delete" ? t("common.delete") : t("common.save")}
              </Button>
            </Group>
          </Stack>
        </form>
      </ResponsiveModal>
    </Stack>
  );
}
