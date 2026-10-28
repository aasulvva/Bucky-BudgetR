import { Button, Group, Stack } from "@mantine/core";
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
  endAtFor,
  firstDay,
  formatDateRange,
  lastDay,
  latestEnd,
  monthFrom,
  rangeProblem,
  startAtAfter,
  today,
  type DateRange,
  type LocalDate,
} from "@/lib/cycles";
import { periodFrom } from "@/lib/cycleRule";

import { CycleDates } from "./CycleDates";

interface PlanCycleDialogProps {
  opened: boolean;
  onClose: () => void;
  /** All the user's cycles, for the "next month" (or "next from rule") shortcut. */
  cycles: Cycle[];
  /** A planned cycle to edit; without it, a new one is planned. */
  cycle?: Cycle;
}

/** Plans a future cycle, or moves a planned one. */
export function PlanCycleDialog({ opened, onClose, cycles, cycle }: PlanCycleDialogProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal
      opened={opened}
      onClose={onClose}
      title={cycle ? t("cycles.editPlanned") : t("cycles.plan")}
    >
      <PlanCycleForm key={cycle?.id ?? "new"} cycles={cycles} cycle={cycle} onDone={onClose} />
    </ResponsiveModal>
  );
}

/** Where the next cycle can start: after the latest cycle, or today if that's later. */
function nextFree(cycles: Cycle[]): LocalDate {
  const after = latestEnd(cycles);
  const now = today();
  return after && after > now ? after : now;
}

function PlanCycleForm({
  cycles,
  cycle,
  onDone,
}: Omit<PlanCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshCycles();
  // With a cycle rule, a new cycle is suggested from it: its first period
  // from where the next cycle can start. Until it's known, a month.
  const rule = useSession().data?.preferences.cycle_rule ?? null;
  const from = nextFree(cycles);
  const periods = useCyclePeriods(rule, from, 2);
  const fromRule = rule && periods.data ? periodFrom(periods.data, from) : undefined;
  const suggested: DateRange = fromRule ?? monthFrom(from);
  const [picked, setRange] = useState<DateRange | null>(() =>
    cycle ? { start: firstDay(cycle), end: lastDay(cycle) } : null,
  );
  const range = picked ?? suggested;
  const [problem, setProblem] = useState<string>();

  const save = useMutation({
    mutationFn: () => {
      const end_at = endAtFor(range.end);
      if (cycle) {
        return unwrap(
          api.PATCH("/api/v1/cycles/{cycleId}", {
            params: { path: { cycleId: cycle.id } },
            body: { start_at: startAtAfter(range.start, cycles), end_at },
          }),
        );
      }
      return unwrap(
        api.POST("/api/v1/cycles", {
          body: { start_at: startAtAfter(range.start, cycles), end_at },
        }),
      );
    },
    meta: { silentError: true },
    onSuccess: async (saved) => {
      const range = formatDateRange(firstDay(saved), lastDay(saved));
      notifications.show({
        color: "green",
        message: cycle ? t("cycles.rangeSaved", { range }) : t("cycles.rangePlanned", { range }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = rangeProblem(range);
        setProblem(found);
        if (!found) save.mutate();
      }}
    >
      <Stack gap="md">
        <CycleDates
          value={range}
          onChange={(r) => {
            setRange(r);
            setProblem(undefined);
          }}
          error={problem}
        />
        {!cycle && (
          <Button
            variant="light"
            size="xs"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              setRange(suggested);
            }}
          >
            {fromRule ? t("cycles.nextFromRule") : t("cycles.nextMonth")}
          </Button>
        )}
        {save.error && <ErrorAlert error={save.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {cycle ? t("common.save") : t("cycles.planSubmit")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
