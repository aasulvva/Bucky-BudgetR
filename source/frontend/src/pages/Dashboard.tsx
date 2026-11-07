import { Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { IconLayoutDashboard, IconPlus, IconRestore } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useSession, useUpdatePreferences } from "@/app/session";
import { AddWidgetDialog } from "@/components/dashboard/AddWidget";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  MAX_WIDGETS,
  dashboardLayout,
  defaultLayout,
  layoutToPreferences,
  replaceWidget,
  type Layout,
  type WidgetInstance,
} from "@/lib/dashboard";

/**
 * Dashboard (spec §9): the user's own layout of widgets (#37), such as the
 * active cycle, the budget's health, the buckets, the account balances and
 * the latest transactions. Edit mode adds, removes, arranges and sizes them,
 * and Done saves the layout in the user's preferences.
 */
export default function Dashboard() {
  const { t } = useTranslation();
  const preferences = useSession().data?.preferences ?? {};
  const layout = dashboardLayout(preferences);
  // A widget's settings outside edit mode are saved at once…
  const update = useUpdatePreferences();
  // …and edit mode saves the whole layout with Done.
  const saveLayout = useUpdatePreferences();
  const [draft, setDraft] = useState<Layout | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(false);

  const edit = () => {
    saveLayout.reset();
    setDraft(layout);
  };
  const shown = draft ?? layout;
  const full = shown.length >= MAX_WIDGETS;

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
            <Text size="sm">{t("dashboard.edit.editing")}</Text>
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
                  leftSection={<IconRestore size={16} />}
                  onClick={() => {
                    setResetting(true);
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
                      { dashboard: layoutToPreferences(draft) },
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
      ) : draft ? (
        <DashboardGrid
          layout={draft}
          onChange={setDraft}
          onSave={(w: WidgetInstance) => {
            setDraft((d) => d && replaceWidget(d, w));
          }}
        />
      ) : (
        <DashboardGrid
          layout={layout}
          onSave={(w: WidgetInstance) =>
            update.mutateAsync({ dashboard: layoutToPreferences(replaceWidget(layout, w)) })
          }
        />
      )}

      <AddWidgetDialog
        opened={adding}
        layout={shown}
        onClose={() => {
          setAdding(false);
        }}
        onAdd={(w) => {
          setDraft((d) => replaceWidget(d ?? layout, w));
        }}
      />
      <ResponsiveModal
        opened={resetting}
        onClose={() => {
          setResetting(false);
        }}
        title={t("dashboard.edit.resetTitle")}
      >
        <Stack gap="md">
          <Text size="sm">{t("dashboard.edit.resetText")}</Text>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              onClick={() => {
                setResetting(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                setDraft(defaultLayout());
                setResetting(false);
              }}
            >
              {t("dashboard.edit.reset")}
            </Button>
          </Group>
        </Stack>
      </ResponsiveModal>
    </Stack>
  );
}
