import { Alert, Button, Divider, Group, Radio, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useBuckets } from "@/api/accounts";
import { api } from "@/api/client";
import { useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { endPreview } from "@/lib/cycleEnd";
import { cycleRange, daysLeft, isOverdue, lastDay } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";
import { compareAmounts, formatMoney } from "@/lib/money";

interface EndCycleDialogProps {
  opened: boolean;
  onClose: () => void;
  active: Cycle;
  next: Cycle | null;
}

/**
 * Ends the active cycle (canvas "End cycle"), with a preview of what the
 * cycle-end routine empties and what the next cycle's start refills.
 */
export function EndCycleDialog({ opened, onClose, active, next }: EndCycleDialogProps) {
  const early = !isOverdue(active);
  return (
    <ResponsiveModal
      opened={opened}
      onClose={onClose}
      title={early ? "End this cycle now?" : "End this cycle?"}
      size="lg"
    >
      <EndForm key={active.id} active={active} next={next} onDone={onClose} />
    </ResponsiveModal>
  );
}

function EndForm({
  active,
  next,
  onDone,
}: Omit<EndCycleDialogProps, "opened" | "onClose"> & { onDone: () => void }) {
  const refresh = useRefreshCycles();
  const buckets = useBuckets();
  const now = new Date();
  const early = !isOverdue(active, now);
  // Where the cycle will end: now when early, else its planned end.
  const endsAt = early ? now : new Date(active.end_at);
  // A next cycle that begins where this one ends starts by itself; one that
  // begins later starts now only if the user says so.
  const autoStart = next !== null && new Date(next.start_at) <= endsAt;
  const canChoose = next !== null && !autoStart;
  const [startNext, setStartNext] = useState(true);
  const refills = autoStart || (canChoose && startNext);

  const end = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/cycles/{cycleId}/end", {
          params: { path: { cycleId: active.id } },
          ...(canChoose ? { body: { start_next: startNext } } : {}),
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (result) => {
      notifications.show({
        color: "green",
        message: result.started
          ? `Cycle ended. ${cycleRange(result.started)} has started.`
          : "Cycle ended. There's no active cycle until you start one.",
      });
      onDone();
      await refresh();
    },
  });

  const days = daysLeft(active, now);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {cycleRange(active)}.{" "}
        {early
          ? days > 0
            ? `It ends ${days === 1 ? "1 day" : `${String(days)} days`} early.`
            : "It ends before its last day is over."
          : `It keeps its planned end, ${formatDate(lastDay(active))}.`}
      </Text>

      {canChoose && (
        <Radio.Group
          label={`The next cycle, ${cycleRange(next)}, is planned to start later.`}
          value={startNext ? "now" : "gap"}
          onChange={(v) => {
            setStartNext(v === "now");
          }}
        >
          <Stack gap="xs" mt="xs">
            <Radio value="now" label="Start it now" />
            <Radio value="gap" label="Leave a gap until it starts" />
          </Stack>
        </Radio.Group>
      )}

      <QueryState query={buckets}>
        {(list) => {
          const preview = endPreview(list, refills);
          return (
            <Stack gap="md">
              <Stack gap={6}>
                <Title order={3} size="h5">
                  Emptied (Keep funds off)
                </Title>
                {preview.emptied.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No buckets to empty.
                  </Text>
                ) : (
                  <>
                    {preview.emptied.map((e) => (
                      <Group key={e.bucket.id} justify="space-between" gap="sm">
                        <Text size="sm">{e.bucket.name}</Text>
                        <Text size="sm">{formatMoney(`-${e.amount}`, e.bucket.currency)}</Text>
                      </Group>
                    ))}
                    <Divider />
                    {preview.backToUnallocated.map((t) => (
                      <Group key={t.currency} justify="space-between" gap="sm">
                        <Text size="sm" fw={600}>
                          Back to unallocated
                        </Text>
                        <Text size="sm" fw={600}>
                          {formatMoney(t.amount, t.currency)}
                        </Text>
                      </Group>
                    ))}
                  </>
                )}
              </Stack>

              {refills ? (
                <Alert
                  color="gray"
                  variant="light"
                  title={`${cycleRange(next)} starts right after`}
                >
                  <Stack gap={4}>
                    {preview.refilled.length === 0 ? (
                      <Text size="sm">No Auto buckets to refill.</Text>
                    ) : (
                      preview.refilled.map((r) => (
                        <Group key={r.bucket.id} justify="space-between" gap="sm" wrap="nowrap">
                          <Text size="sm">{r.bucket.name}</Text>
                          <Text size="sm" ta="right">
                            {compareAmounts(r.amount, "0") > 0 ? "+" : ""}
                            {formatMoney(r.amount, r.bucket.currency)}
                            {compareAmounts(r.overflow, "0") > 0 &&
                              ` (${formatMoney(r.overflow, r.bucket.currency)} overflows)`}
                          </Text>
                        </Group>
                      ))
                    )}
                    <Text size="sm" c="dimmed" mt={4}>
                      Manual and On income buckets wait for their refill.
                    </Text>
                  </Stack>
                </Alert>
              ) : next ? (
                <Alert color="orange" variant="light" title="No active cycle in the gap">
                  Until {cycleRange(next)} starts, transactions can&apos;t be split into buckets and
                  nothing is refilled.
                </Alert>
              ) : (
                <Alert color="orange" variant="light" title="No cycle planned after this one">
                  Plan one to refill your buckets. Until a cycle is active, transactions can&apos;t
                  be split into buckets.
                </Alert>
              )}
              <Text size="xs" c="dimmed">
                A preview: the amounts can change slightly, because the money is reallocated first.
              </Text>
            </Stack>
          );
        }}
      </QueryState>

      {end.error && <ErrorAlert error={end.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button
          loading={end.isPending}
          onClick={() => {
            end.mutate();
          }}
        >
          End cycle
        </Button>
      </Group>
    </Stack>
  );
}
