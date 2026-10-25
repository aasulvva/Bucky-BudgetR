import { Anchor, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/api/client";
import { useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
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
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title="Start a budget cycle">
      <StartCycleForm key={next?.id ?? "none"} next={next} cycles={cycles} onDone={onClose} />
    </ResponsiveModal>
  );
}

function StartCycleForm({
  next,
  cycles,
  onDone,
}: Omit<StartCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const refresh = useRefreshCycles();
  const [choice, setChoice] = useState<"planned" | "new">(next ? "planned" : "new");
  const [range, setRange] = useState<DateRange>(() => monthFrom(today()));
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
        message: `Cycle ${formatDateRange(firstDay(started), lastDay(started))} started.`,
      });
      onDone();
      await refresh();
    },
    // A cycle created before the start failed is planned now; show it.
    onError: () => refresh(),
  });

  const [openedAt] = useState(() => Date.now());
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
          You have no active cycle. Buckets, refills and bucket lines on transactions need one. A
          cycle usually runs from one payday to the day before the next.
        </Text>
        <Radio.Group
          value={choice}
          onChange={(v) => {
            setChoice(v);
          }}
          label="Which cycle"
          labelProps={{ className: "mantine-visually-hidden" }}
        >
          <Stack gap="sm">
            {next && (
              <Radio.Card value="planned" p="md" radius="md">
                <Group wrap="nowrap" align="flex-start">
                  <Radio.Indicator />
                  <div>
                    <Text fw={600}>Start the planned cycle</Text>
                    <Text size="sm" c="dimmed">
                      {cycleRange(next)}
                      {startsLater && `, starts today instead of ${formatDate(firstDay(next))}`}
                    </Text>
                  </div>
                </Group>
              </Radio.Card>
            )}
            <Radio.Card value="new" p="md" radius="md">
              <Group wrap="nowrap" align="flex-start">
                <Radio.Indicator />
                <Text fw={600}>Start a new cycle</Text>
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
          Starting the cycle refills your buckets set to Auto refill.
        </Text>
        {start.error && <ErrorAlert error={start.error} />}
        <Group justify="space-between" gap="sm">
          <Anchor component="button" type="button" size="sm" onClick={onDone}>
            Not now, record without buckets
          </Anchor>
          <Button type="submit" loading={start.isPending}>
            Start cycle
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
