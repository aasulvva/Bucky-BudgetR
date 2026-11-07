import {
  Box,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCopy, IconLayoutDashboard, IconPlus, IconRestore } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useSession, useUpdatePreferences } from "@/app/session";
import { AddWidgetDialog } from "@/components/dashboard/AddWidget";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  LAYOUT_KINDS,
  MAX_WIDGETS,
  copyLayout,
  dashboardLayouts,
  defaultLayout,
  layoutsToPreferences,
  replaceWidget,
  type Layout,
  type LayoutKind,
  type Layouts,
  type WidgetInstance,
} from "@/lib/dashboard";

/** Edit mode's draft of both layouts, and the one being edited. */
interface Draft {
  layouts: Layouts;
  editing: LayoutKind;
}

const other = (kind: LayoutKind): LayoutKind => (kind === "desktop" ? "mobile" : "desktop");

/**
 * Dashboard (spec §9): the user's own layout of widgets (#37), such as the
 * active cycle, the budget's health, the buckets, the account balances and
 * the latest transactions. There's one layout for wide screens and one for
 * phones (#99), switching at the app shell's breakpoint. Edit mode adds,
 * removes, arranges and sizes the widgets of either layout, and Done saves
 * both in the user's preferences.
 */
export default function Dashboard() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const kind: LayoutKind = isDesktop ? "desktop" : "mobile";
  const preferences = useSession().data?.preferences ?? {};
  const layouts = dashboardLayouts(preferences);
  const layout = layouts[kind];
  // A widget's settings outside edit mode are saved at once…
  const update = useUpdatePreferences();
  // …and edit mode saves both layouts with Done.
  const saveLayout = useUpdatePreferences();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<"reset" | "copy" | null>(null);

  const edit = () => {
    saveLayout.reset();
    setDraft({ layouts, editing: kind });
  };
  /** Changes the layout being edited. */
  const change = (next: (layout: Layout) => Layout) => {
    setDraft(
      (d) => d && { ...d, layouts: { ...d.layouts, [d.editing]: next(d.layouts[d.editing]) } },
    );
  };
  const editing = draft?.editing ?? kind;
  const shown = draft ? draft.layouts[draft.editing] : layout;
  const full = shown.length >= MAX_WIDGETS;
  // The mobile layout always has one column; on a wide screen it's shown as narrow as a phone.
  const narrow = editing === "mobile";

  const grid = draft ? (
    <DashboardGrid
      layout={shown}
      narrow={narrow}
      onChange={(l) => {
        change(() => l);
      }}
      onSave={(w: WidgetInstance) => {
        change((l) => replaceWidget(l, w));
      }}
    />
  ) : (
    <DashboardGrid
      layout={layout}
      narrow={narrow}
      onSave={(w: WidgetInstance) =>
        update.mutateAsync({
          dashboard: layoutsToPreferences({ ...layouts, [kind]: replaceWidget(layout, w) }),
        })
      }
    />
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Title order={2}>{t("nav.items.dashboard")}</Title>
        {!draft && (
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconLayoutDashboard size={16} />}
              onClick={edit}
            >
              {t("dashboard.edit.edit")}
            </Button>
            <Button component={Link} to="/transactions/new" leftSection={<IconPlus size={16} />}>
              {t("transactions.new")}
            </Button>
          </Group>
        )}
      </Group>

      {draft && (
        <Paper withBorder p="sm" component="section" aria-label={t("dashboard.edit.edit")}>
          <Stack gap="sm">
            <SegmentedControl
              aria-label={t("dashboard.edit.layout")}
              data={LAYOUT_KINDS.map((k) => ({
                value: k,
                label: t(`dashboard.edit.layouts.${k}`),
              }))}
              value={draft.editing}
              onChange={(v) => {
                const next = LAYOUT_KINDS.find((k) => k === v);
                if (next) setDraft({ ...draft, editing: next });
              }}
              style={{ alignSelf: "flex-start" }}
            />
            <Text size="sm">
              {t(
                draft.editing === "desktop"
                  ? "dashboard.edit.editingDesktop"
                  : "dashboard.edit.editingMobile",
              )}
            </Text>
            {full && (
              <Text size="sm" c="dimmed">
                {t("dashboard.edit.max", { count: MAX_WIDGETS })}
              </Text>
            )}
            <Group justify="space-between" gap="xs" wrap="wrap">
              <Group gap="xs">
                <Button
                  variant="light"
                  leftSection={<IconPlus size={16} />}
                  disabled={full}
                  onClick={() => {
                    setAdding(true);
                  }}
                >
                  {t("dashboard.edit.add")}
                </Button>
                <Button
                  variant="subtle"
                  color="gray"
                  leftSection={<IconCopy size={16} />}
                  onClick={() => {
                    setConfirming("copy");
                  }}
                >
                  {t(
                    draft.editing === "desktop"
                      ? "dashboard.edit.copyFromMobile"
                      : "dashboard.edit.copyFromDesktop",
                  )}
                </Button>
                <Button
                  variant="subtle"
                  color="gray"
                  leftSection={<IconRestore size={16} />}
                  onClick={() => {
                    setConfirming("reset");
                  }}
                >
                  {t("dashboard.edit.reset")}
                </Button>
              </Group>
              <Group gap="xs">
                <Button
                  variant="default"
                  onClick={() => {
                    setDraft(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  loading={saveLayout.isPending}
                  onClick={() => {
                    saveLayout.mutate(
                      { dashboard: layoutsToPreferences(draft.layouts) },
                      {
                        onSuccess: () => {
                          setDraft(null);
                        },
                      },
                    );
                  }}
                >
                  {t("dashboard.edit.done")}
                </Button>
              </Group>
            </Group>
            {saveLayout.error && <ErrorAlert error={saveLayout.error} />}
          </Stack>
        </Paper>
      )}

      {shown.length === 0 ? (
        <Stack gap="xs" align="flex-start">
          <Text c="dimmed">{t("dashboard.edit.empty")}</Text>
          {!draft && (
            <Button
              variant="light"
              leftSection={<IconPlus size={16} />}
              onClick={() => {
                edit();
                setAdding(true);
              }}
            >
              {t("dashboard.edit.add")}
            </Button>
          )}
        </Stack>
      ) : draft && narrow && isDesktop ? (
        <Box
          maw={420}
          w="100%"
          mx="auto"
          p="sm"
          style={{
            border: "1px dashed var(--mantine-color-default-border)",
            borderRadius: "var(--mantine-radius-md)",
          }}
        >
          {grid}
        </Box>
      ) : (
        grid
      )}

      <AddWidgetDialog
        opened={adding}
        layout={shown}
        onClose={() => {
          setAdding(false);
        }}
        onAdd={(w) => {
          change((l) => replaceWidget(l, w));
        }}
      />
      <ResponsiveModal
        opened={confirming !== null}
        onClose={() => {
          setConfirming(null);
        }}
        title={t(confirming === "copy" ? "dashboard.edit.copyTitle" : "dashboard.edit.resetTitle")}
      >
        <Stack gap="md">
          <Text size="sm">
            {confirming === "copy"
              ? t(
                  editing === "desktop"
                    ? "dashboard.edit.copyTextDesktop"
                    : "dashboard.edit.copyTextMobile",
                )
              : t(
                  editing === "desktop"
                    ? "dashboard.edit.resetTextDesktop"
                    : "dashboard.edit.resetTextMobile",
                )}
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                const source = draft?.layouts[other(editing)];
                change(() =>
                  confirming === "copy" && source ? copyLayout(source) : defaultLayout(editing),
                );
                setConfirming(null);
              }}
            >
              {t(
                confirming === "copy"
                  ? editing === "desktop"
                    ? "dashboard.edit.copyFromMobile"
                    : "dashboard.edit.copyFromDesktop"
                  : "dashboard.edit.reset",
              )}
            </Button>
          </Group>
        </Stack>
      </ResponsiveModal>
    </Stack>
  );
}
