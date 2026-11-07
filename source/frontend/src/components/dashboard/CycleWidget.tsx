import { Button, Stack, Text } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCycles, useCurrentCycles, type Cycle } from "@/api/cycles";
import { StartCycleDialog } from "@/components/cycles/StartCycleDialog";
import { QueryState } from "@/components/QueryState";
import { cycleRange, daysLeftLabel, isOverdue, lastDay } from "@/lib/cycles";
import type { WidgetInstance } from "@/lib/dashboard";
import { formatDate } from "@/lib/dates";

import { WidgetCard } from "./Widget";

/** The active cycle and, unless switched off, the next planned one. */
export function CycleWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"cycle">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const current = useCurrentCycles();
  const cycles = useCycles();
  const [starting, setStarting] = useState(false);
  const { showNext } = widget.settings;
  return (
    <WidgetCard
      title={t("dashboard.cycle.title")}
      link={{ to: "/cycles", label: t("dashboard.cycle.manage") }}
      action={action}
    >
      <QueryState query={current}>
        {({ active, next }) => {
          const planned = showNext && next && (
            <Text size="sm" c="dimmed">
              {t("dashboard.cycle.next", { range: cycleRange(next) })}
            </Text>
          );
          return active ? (
            <Stack gap={4}>
              <ActiveCycle active={active} />
              {planned}
            </Stack>
          ) : (
            <>
              <Stack gap={4}>
                <Text fw={600}>{t("cycles.noActive")}</Text>
                <Text size="sm" c="dimmed">
                  {t("cycles.needed")}
                </Text>
                {planned}
              </Stack>
              <Button
                variant="light"
                style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  setStarting(true);
                }}
              >
                {t("cycles.start")}
              </Button>
              <StartCycleDialog
                opened={starting}
                onClose={() => {
                  setStarting(false);
                }}
                next={next}
                cycles={cycles.data ?? []}
              />
            </>
          );
        }}
      </QueryState>
    </WidgetCard>
  );
}

function ActiveCycle({ active }: { active: Cycle }) {
  const { t } = useTranslation();
  const overdue = isOverdue(active);
  return (
    <>
      <Text fz={20} fw={700}>
        {cycleRange(active)}
      </Text>
      <Text size="sm" c={overdue ? "orange.8" : "dimmed"}>
        {overdue
          ? t("cycles.overdueSince", { date: formatDate(lastDay(active)) })
          : daysLeftLabel(active)}
      </Text>
    </>
  );
}
