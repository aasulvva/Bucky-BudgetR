import { Anchor, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { useCyclePeriods, useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { useSession } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  cycleRange,
  endAtFor,
  firstDay,
  formatDateRange,
  lastDay,
  monthFrom,
  rangeProblem,
  startAtAfter,
  today,
  type DateRange,
} from "@/lib/cycles";
import { now as clockNow } from "@/lib/clock";
import { formatDate } from "@/lib/dates";

import { CycleDates } from "./CycleDates";

interface StartCycleDialogProps {
  opened: boolean;
  onClose: () => void;
  /** The next planned cycle, if any. */
  next: Cycle | null;
  cycles: Cycle[];
}

/**
 * "Start a budget cycle" (canvas "Cycle prompt"): with no active cycle,
 * start the planned one or a new one.
 */
export function StartCycleDialog({ opened, onClose, next, cycles }: StartCycleDialogProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={t("cycles.startTitle")}>
      <StartCycleForm key={next?.id ?? "none"} next={next} cycles={cycles} onDone={onClose} />
    </ResponsiveModal>
  );
}

function StartCycleForm({
  next,
  cycles,
  onDone,
}: Omit<StartCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshCycles();
  const [choice, setChoice] = useState<"planned" | "new">(next ? "planned" : "new");
  // A new cycle starts today, and with a cycle rule ends with the rule's
  // current period; without one (or until it's known), a month from today.
  const rule = useSession().data?.preferences.cycle_rule ?? null;
  const periods = useCyclePeriods(rule, today(), 1);
  const current = rule ? periods.data?.[0] : undefined;
  const [picked, setRange] = useState<DateRange | null>(null);
  const range = picked ?? (current ? { start: today(), end: current.end } : monthFrom(today()));
  const [problem, setProblem] = useState<string>();

  const start = useMutation({
    mutationFn: async () => {
      let id = next?.id;
      if (choice === "new" || !id) {
        const created = await unwrap(
          api.POST("/api/v1/cycles", {
            body: { start_at: startAtAfter(range.start, cycles), end_at: endAtFor(range.end) },
          }),
        );
        id = created.id;
      }
      return unwrap(
        api.POST("/api/v1/cycles/{cycleId}/start", { params: { path: { cycleId: id } } }),
      );
    },
    meta: { silentError: true },
    onSuccess: async (started) => {
      notifications.show({
        color: "green",
        message: t("cycles.started", {
          range: formatDateRange(firstDay(started), lastDay(started)),
        }),
      });
      onDone();
      await refresh();
    },
    // A cycle created before the start failed is planned now; show it.
    onError: () => refresh(),
  });

  const [openedAt] = useState(() => clockNow().getTime());
  const startsLater = next !== null && new Date(next.start_at).getTime() > openedAt;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = choice === "new" ? rangeProblem(range) : undefined;
        setProblem(found);
        if (!found) start.mutate();
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("cycles.startIntro")}
        </Text>
        <Radio.Group
          value={choice}
          onChange={(v) => {
            setChoice(v);
          }}
          label={t("cycles.whichCycle")}
          labelProps={{ className: "mantine-visually-hidden" }}
        >
          <Stack gap="sm">
            {next && (
              <Radio.Card value="planned" p="md" radius="md">
                <Group wrap="nowrap" align="flex-start">
                  <Radio.Indicator />
                  <div>
                    <Text fw={600}>{t("cycles.startPlanned")}</Text>
                    <Text size="sm" c="dimmed">
                      {cycleRange(next)}
                      {startsLater &&
                        t("cycles.startsTodayInstead", { date: formatDate(firstDay(next)) })}
                    </Text>
                  </div>
                </Group>
              </Radio.Card>
            )}
            <Radio.Card value="new" p="md" radius="md">
              <Group wrap="nowrap" align="flex-start">
                <Radio.Indicator />
                <Text fw={600}>{t("cycles.startNew")}</Text>
              </Group>
            </Radio.Card>
          </Stack>
        </Radio.Group>
        {choice === "new" && (
          <CycleDates
            value={range}
            onChange={(r) => {
              setRange(r);
              setProblem(undefined);
            }}
            error={problem}
          />
        )}
        <Text size="sm" c="dimmed">
          {t("cycles.startRefills")}
        </Text>
        {start.error && <ErrorAlert error={start.error} />}
        <Group justify="space-between" gap="sm">
          <Anchor component="button" type="button" size="sm" onClick={onDone}>
            {t("cycles.notNow")}
          </Anchor>
          <Button type="submit" loading={start.isPending}>
            {t("cycles.start")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
