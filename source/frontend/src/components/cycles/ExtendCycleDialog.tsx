import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { useCycles, useRefreshCycles, type Cycle } from "@/api/cycles";
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
  const { t } = useTranslation();
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={t("cycles.extendTitle")}>
      <ExtendForm key={active.end_at} active={active} next={next} onDone={onClose} />
    </ResponsiveModal>
  );
}

function ExtendForm({
  active,
  next,
  onDone,
}: Omit<ExtendCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshCycles();
  const cycles = useCycles();
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
      notifications.show({
        color: "green",
        message: t("cycles.extended", { range: cycleRange(updated) }),
      });
      onDone();
      await refresh();
    },
  });

  // What the new end does to the planned cycles: the ones it covers are
  // removed, and the next one starts at it (#158).
  const newEnd = new Date(endAtFor(end)).getTime();
  const planned = (cycles.data?.filter((c) => c.state === "future") ?? (next ? [next] : [])).filter(
    (c) => new Date(c.start_at).getTime() < newEnd,
  );
  const removed = planned.filter((c) => new Date(c.end_at).getTime() <= newEnd);
  const pushed = planned.find((c) => new Date(c.end_at).getTime() > newEnd);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found =
          end < now
            ? t("cycles.endInFuture")
            : end <= current
              ? t("cycles.afterCurrent")
              : undefined;
        setProblem(found);
        if (!found) extend.mutate();
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("cycles.extendIntro", { range: cycleRange(active) })}
        </Text>
        <DatePickerInput
          label={t("cycles.newLastDay")}
          valueFormat="D MMM YYYY"
          value={end}
          minDate={now > current ? now : addDays(current, 1)}
          onChange={(v) => {
            if (v) setEnd(v);
            setProblem(undefined);
          }}
          error={problem}
        />
        {removed.length > 0 && (
          <Alert color="orange" variant="light">
            {t("cycles.removesPlanned", {
              count: removed.length,
              ranges: removed.map((c) => cycleRange(c)).join(", "),
            })}
          </Alert>
        )}
        {pushed && (
          <Alert color="blue" variant="light">
            {t("cycles.pushesNext", {
              range: cycleRange(pushed),
              date: formatDate(addDays(end, 1)),
            })}
          </Alert>
        )}
        {extend.error && <ErrorAlert error={extend.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={extend.isPending}>
            {t("common.extend")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
