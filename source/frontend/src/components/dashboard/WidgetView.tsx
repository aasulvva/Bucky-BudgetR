import { ActionIcon, Group, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsHorizontal,
  IconLayoutColumns,
  IconX,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { SaveWidget, WidgetInstance, WidgetWidth } from "@/lib/dashboard";

import { AccountsWidget } from "./AccountsWidget";
import { BucketStatusWidget } from "./BucketStatusWidget";
import { CycleWidget } from "./CycleWidget";
import { ModuleWidget } from "./ModuleWidget";
import { HealthWidget } from "./HealthWidget";
import { InOutWidget } from "./InOutWidget";
import { RecentWidget } from "./RecentWidget";
import { SavingsTransferWidget } from "./SavingsTransferWidget";
import { SavingsWidget } from "./SavingsWidget";
import { ScheduledWidget } from "./ScheduledWidget";
import { WidgetFrame, useWidgetTitle } from "./frame";
import { SettingsButton } from "./Widget";
import { WidgetSettingsDialog } from "./WidgetSettings";

/** What edit mode needs to change a widget's place, width and presence. */
export interface WidgetEdit {
  /** The widget's name in the edit bar's labels, told apart from its copies. */
  name: string;
  /** One column (the mobile layout), so widths don't apply. */
  narrow: boolean;
  first: boolean;
  last: boolean;
  /** The drag handle, made by the sortable grid cell. */
  handle: ReactNode;
  onMove: (by: -1 | 1) => void;
  onWidth: (width: WidgetWidth) => void;
  onRemove: () => void;
}

/**
 * One widget on the Dashboard: its content, its settings dialog, and in edit
 * mode its edit bar.
 */
export function WidgetView({
  widget,
  edit,
  onSave,
}: {
  widget: WidgetInstance;
  edit?: WidgetEdit;
  onSave: SaveWidget;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(false);
  const title = useWidgetTitle(widget);
  const openSettings = () => {
    setSettings(true);
  };
  const cog = <SettingsButton widget={edit?.name ?? title} onClick={openSettings} />;

  return (
    <WidgetFrame.Provider
      value={{
        title,
        editing: !!edit,
        bar: edit && <EditBar edit={edit} cog={cog} widget={widget} />,
        openSettings,
      }}
    >
      {widget.type === "cycle" && <CycleWidget widget={widget} action={cog} />}
      {widget.type === "health" && <HealthWidget action={cog} />}
      {widget.type === "bucket_status" && <BucketStatusWidget widget={widget} action={cog} />}
      {widget.type === "accounts" && <AccountsWidget widget={widget} action={cog} />}
      {widget.type === "recent_transactions" && <RecentWidget widget={widget} action={cog} />}
      {widget.type === "in_out" && <InOutWidget widget={widget} action={cog} />}
      {widget.type === "module" && <ModuleWidget widget={widget} action={cog} />}
      {widget.type === "scheduled" && <ScheduledWidget widget={widget} action={cog} />}
      {widget.type === "savings" && <SavingsWidget widget={widget} action={cog} />}
      {widget.type === "savings_transfer" && <SavingsTransferWidget widget={widget} action={cog} />}
      <WidgetSettingsDialog
        widget={widget}
        opened={settings}
        title={t("dashboard.settingsTitle", { widget: title })}
        onClose={() => {
          setSettings(false);
        }}
        onSave={onSave}
      />
    </WidgetFrame.Provider>
  );
}

function EditBar({
  edit,
  cog,
  widget,
}: {
  edit: WidgetEdit;
  cog: ReactNode;
  widget: WidgetInstance;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  // The grid has two columns from md, unless narrow; otherwise every widget
  // is full width.
  const wide = useMediaQuery(`(min-width: ${theme.breakpoints.md})`, true) && !edit.narrow;
  const name = { widget: edit.name };
  const full = widget.width === "full";
  return (
    <Group gap={4} wrap="nowrap">
      {edit.handle}
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={t("dashboard.edit.moveUp", name)}
        title={t("dashboard.edit.moveUp", name)}
        disabled={edit.first}
        onClick={() => {
          edit.onMove(-1);
        }}
      >
        <IconArrowUp size={18} />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={t("dashboard.edit.moveDown", name)}
        title={t("dashboard.edit.moveDown", name)}
        disabled={edit.last}
        onClick={() => {
          edit.onMove(1);
        }}
      >
        <IconArrowDown size={18} />
      </ActionIcon>
      {wide && (
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t(full ? "dashboard.edit.half" : "dashboard.edit.full", name)}
          title={t(full ? "dashboard.edit.half" : "dashboard.edit.full", name)}
          onClick={() => {
            edit.onWidth(full ? "half" : "full");
          }}
        >
          {full ? <IconLayoutColumns size={18} /> : <IconArrowsHorizontal size={18} />}
        </ActionIcon>
      )}
      {cog}
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={t("dashboard.edit.remove", name)}
        title={t("dashboard.edit.remove", name)}
        onClick={edit.onRemove}
      >
        <IconX size={18} />
      </ActionIcon>
    </Group>
  );
}
