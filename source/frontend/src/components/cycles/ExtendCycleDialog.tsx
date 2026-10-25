import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/api/client";
import { useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { addDays, cycleRange, endAtFor, lastDay, today, type LocalDate } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";

interface ExtendCycleDialogProps {
  opened: boolean;
  onClose: () => void;
  active: Cycle;
  next: Cycle | null;
}

/** Moves the active cycle's end later, e.g. when it's overdue. */
export function ExtendCycleDialog({ opened, onClose, active, next }: ExtendCycleDialogProps) {
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title="Extend the cycle">
      <ExtendForm key={active.end_at} active={active} next={next} onDone={onClose} />
    </ResponsiveModal>
  );
}

function ExtendForm({
  active,
  next,
  onDone,
}: Omit<ExtendCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const refresh = useRefreshCycles();
  const now = today();
  const current = lastDay(active);
  // A week past the planned end, but never in the past.
  const [end, setEnd] = useState<LocalDate>(() => {
    const proposed = addDays(current, 7);
    return proposed < now ? addDays(now, 7) : proposed;
  });
  const [problem, setProblem] = useState<string>();

  const extend = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/cycles/{cycleId}", {
          params: { path: { cycleId: active.id } },
          body: { end_at: endAtFor(end) },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (updated) => {
      notifications.show({ color: "green", message: `The cycle now runs ${cycleRange(updated)}.` });
      onDone();
      await refresh();
    },
  });

  const pushesNext = next !== null && new Date(endAtFor(end)) > new Date(next.start_at);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found =
          end < now
            ? "The cycle must end in the future."
            : end <= current
              ? "Pick a day after the current last day."
              : undefined;
        setProblem(found);
        if (!found) extend.mutate();
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {cycleRange(active)}. Pick its new last day.
        </Text>
        <DatePickerInput
          label="New last day"
          valueFormat="D MMM YYYY"
          value={end}
          minDate={now > current ? now : addDays(current, 1)}
          onChange={(v) => {
            if (v) setEnd(v);
            setProblem(undefined);
          }}
          error={problem}
        />
        {pushesNext && (
          <Alert color="blue" variant="light">
            The next planned cycle ({cycleRange(next)}) then starts on {formatDate(addDays(end, 1))}{" "}
            instead.
          </Alert>
        )}
        {extend.error && <ErrorAlert error={extend.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={extend.isPending}>
            Extend
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
