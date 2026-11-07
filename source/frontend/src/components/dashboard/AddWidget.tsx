import { Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ResponsiveModal } from "@/components/ResponsiveModal";
import { WIDGET_TYPES, newWidget, type Layout, type WidgetInstance } from "@/lib/dashboard";

import { widgetTitle } from "./frame";
import { WidgetSettingsForm } from "./WidgetSettings";
import classes from "./AddWidget.module.css";

/**
 * Picks a widget type to add. A type with settings shows them first, with
 * their defaults; Budget health has none and is added at once.
 */
export function AddWidgetDialog({
  opened,
  layout,
  onClose,
  onAdd,
}: {
  opened: boolean;
  layout: Layout;
  onClose: () => void;
  onAdd: (widget: WidgetInstance) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<WidgetInstance | null>(null);
  const close = () => {
    setChosen(null);
    onClose();
  };
  return (
    <ResponsiveModal
      opened={opened}
      onClose={close}
      title={
        chosen
          ? t("dashboard.edit.addNamed", { widget: widgetTitle(t, chosen.type) })
          : t("dashboard.edit.add")
      }
    >
      {chosen ? (
        <WidgetSettingsForm
          widget={chosen}
          saveLabel={t("dashboard.edit.addButton")}
          onClose={close}
          onSave={onAdd}
        />
      ) : (
        <Stack gap="xs">
          {WIDGET_TYPES.map((type) => (
            <UnstyledButton
              key={type}
              className={classes.type}
              onClick={() => {
                const widget = newWidget(type, layout);
                if (widget.type === "health") {
                  onAdd(widget);
                  close();
                } else {
                  setChosen(widget);
                }
              }}
            >
              <Text fw={600}>{widgetTitle(t, type)}</Text>
              <Text size="sm" c="dimmed">
                {t(`dashboard.types.${type}`)}
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      )}
    </ResponsiveModal>
  );
}
