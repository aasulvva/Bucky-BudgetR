import { Button, Group, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/api/client";
import { useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
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
} from "@/lib/cycles";

import { CycleDates } from "./CycleDates";

interface PlanCycleDialogProps {
  opened: boolean;
  onClose: () => void;
  /** All the user's cycles, for the "next month" shortcut. */
  cycles: Cycle[];
  /** A planned cycle to edit; without it, a new one is planned. */
  cycle?: Cycle;
}

/** Plans a future cycle, or moves a planned one. */
export function PlanCycleDialog({ opened, onClose, cycles, cycle }: PlanCycleDialogProps) {
  return (
    <ResponsiveModal
      opened={opened}
      onClose={onClose}
      title={cycle ? "Edit planned cycle" : "Plan a cycle"}
    >
      <PlanCycleForm key={cycle?.id ?? "new"} cycles={cycles} cycle={cycle} onDone={onClose} />
    </ResponsiveModal>
  );
}

/** The month after the latest cycle (or from today, if that's later). */
function nextMonth(cycles: Cycle[]): DateRange {
  const after = latestEnd(cycles);
  const now = today();
  return monthFrom(after && after > now ? after : now);
}

function PlanCycleForm({
  cycles,
  cycle,
  onDone,
}: Omit<PlanCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const refresh = useRefreshCycles();
  const [range, setRange] = useState<DateRange>(() =>
    cycle ? { start: firstDay(cycle), end: lastDay(cycle) } : nextMonth(cycles),
  );
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
      notifications.show({
        color: "green",
        message: `${formatDateRange(firstDay(saved), lastDay(saved))} ${cycle ? "saved" : "planned"}.`,
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
              setRange(nextMonth(cycles));
            }}
          >
            Next month
          </Button>
        )}
        {save.error && <ErrorAlert error={save.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {cycle ? "Save" : "Plan cycle"}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
