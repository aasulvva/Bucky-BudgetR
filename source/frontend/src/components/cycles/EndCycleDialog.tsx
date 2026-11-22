import { Alert, Button, Divider, Group, Radio, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useBuckets } from "@/api/accounts";
import { api } from "@/api/client";
import { useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { useSavingsBudget, useSavingsTargets } from "@/api/savings";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { now as clockNow } from "@/lib/clock";
import { endPreview, sweepEstimate } from "@/lib/cycleEnd";
import { cycleRange, daysLeft, isOverdue, lastDay } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";
import { compareAmounts, formatMoney } from "@/lib/money";
import { budgetDestination, fixedEntries, overflowTo, sweepEntries } from "@/lib/savings";

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
  const { t } = useTranslation();
  const early = !isOverdue(active);
  return (
    <ResponsiveModal
      opened={opened}
      onClose={onClose}
      title={early ? t("cycles.endNowTitle") : t("cycles.endTitle")}
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
  const { t } = useTranslation();
  const refresh = useRefreshCycles();
  const buckets = useBuckets();
  const targets = useSavingsTargets().data ?? [];
  const accounts = useAccounts().data ?? [];
  const budget = useSavingsBudget().data ?? [];
  // The savings budget's At cycle start amounts (#234), after the refills.
  const atStart = fixedEntries(budget).filter((e) => e.when === "cycle_start" && !e.stopped);
  // Its At cycle end sweeps (#235), after the buckets are emptied.
  const atEnd = sweepEntries(budget).filter((e) => e.when === "cycle_end" && !e.stopped);
  const now = clockNow();
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
          ? t("cycles.endedStarted", { range: cycleRange(result.started) })
          : t("cycles.ended"),
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
            ? t("cycles.endsEarly", { count: days })
            : t("cycles.endsBeforeLastDay")
          : t("cycles.keepsEnd", { date: formatDate(lastDay(active)) })}
      </Text>

      {canChoose && (
        <Radio.Group
          label={t("cycles.nextStartsLater", { range: cycleRange(next) })}
          value={startNext ? "now" : "gap"}
          onChange={(v) => {
            setStartNext(v === "now");
          }}
        >
          <Stack gap="xs" mt="xs">
            <Radio value="now" label={t("cycles.startItNow")} />
            <Radio value="gap" label={t("cycles.leaveGap")} />
          </Stack>
        </Radio.Group>
      )}

      <QueryState query={buckets}>
        {(list) => {
          const preview = endPreview(list, refills);
          const to = (b: (typeof list)[number]) => overflowTo(b, targets);
          return (
            <Stack gap="md">
              <Stack gap={6}>
                <Title order={3} size="h5">
                  {t("cycles.emptied")}
                </Title>
                {preview.emptied.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("cycles.noneToEmpty")}
                  </Text>
                ) : (
                  <>
                    {preview.emptied.map((e) => (
                      <Group key={e.bucket.id} justify="space-between" gap="sm">
                        <Text size="sm">
                          {e.bucket.name}
                          {to(e.bucket) !== null && (
                            <Text span size="sm" c="dimmed">
                              {" "}
                              {t("cycles.overflowTo", { to: to(e.bucket) })}
                            </Text>
                          )}
                        </Text>
                        <Text size="sm">{formatMoney(`-${e.amount}`, e.bucket.currency)}</Text>
                      </Group>
                    ))}
                    <Divider />
                    {preview.backToUnallocated.map((total) => (
                      <Group key={total.currency} justify="space-between" gap="sm">
                        <Text size="sm" fw={600}>
                          {t("cycles.backToUnallocated")}
                        </Text>
                        <Text size="sm" fw={600}>
                          {formatMoney(total.amount, total.currency)}
                        </Text>
                      </Group>
                    ))}
                    {preview.toSavings.map((total) => (
                      <Group key={`savings-${total.currency}`} justify="space-between" gap="sm">
                        <Text size="sm" fw={600}>
                          {t("cycles.toSavings")}
                        </Text>
                        <Text size="sm" fw={600}>
                          {formatMoney(total.amount, total.currency)}
                        </Text>
                      </Group>
                    ))}
                  </>
                )}
              </Stack>

              {atEnd.length > 0 && (
                <Stack gap={6}>
                  <Title order={3} size="h5">
                    {t("cycles.swept")}
                  </Title>
                  {atEnd.map((e) => {
                    const account = accounts.find((a) => a.id === e.account_id);
                    return (
                      <Group key={e.id} justify="space-between" gap="sm" wrap="nowrap">
                        <Text size="sm">
                          {t("cycles.savingsBudgetLine", {
                            name: budgetDestination(e, targets),
                            account: account?.name ?? `#${e.account_id}`,
                          })}
                        </Text>
                        <Text size="sm" ta="right">
                          {account
                            ? t("cycles.about", {
                                amount: formatMoney(
                                  sweepEstimate(list, preview, account, e.keep),
                                  account.currency,
                                ),
                              })
                            : null}
                        </Text>
                      </Group>
                    );
                  })}
                  <Text size="xs" c="dimmed">
                    {t("cycles.sweptNote")}
                  </Text>
                </Stack>
              )}

              {refills ? (
                <Alert
                  color="gray"
                  variant="light"
                  title={t("cycles.startsRightAfter", { range: cycleRange(next) })}
                >
                  <Stack gap={4}>
                    {preview.refilled.length === 0 ? (
                      <Text size="sm">{t("cycles.noneToRefill")}</Text>
                    ) : (
                      preview.refilled.map((r) => (
                        <Group key={r.bucket.id} justify="space-between" gap="sm" wrap="nowrap">
                          <Text size="sm">{r.bucket.name}</Text>
                          <Text size="sm" ta="right">
                            {compareAmounts(r.amount, "0") > 0 ? "+" : ""}
                            {formatMoney(r.amount, r.bucket.currency)}
                            {compareAmounts(r.overflow, "0") > 0 &&
                              (to(r.bucket) === null
                                ? t("cycles.overflows", {
                                    amount: formatMoney(r.overflow, r.bucket.currency),
                                  })
                                : t("cycles.overflowsTo", {
                                    amount: formatMoney(r.overflow, r.bucket.currency),
                                    to: to(r.bucket),
                                  }))}
                          </Text>
                        </Group>
                      ))
                    )}
                    {atStart.length > 0 && (
                      <Stack gap={4} mt={4}>
                        <Text size="sm" fw={600}>
                          {t("cycles.savingsBudget")}
                        </Text>
                        {atStart.map((e) => {
                          const account = accounts.find((a) => a.id === e.account_id);
                          return (
                            <Group key={e.id} justify="space-between" gap="sm" wrap="nowrap">
                              <Text size="sm">
                                {t("cycles.savingsBudgetLine", {
                                  name: budgetDestination(e, targets),
                                  account: account?.name ?? `#${e.account_id}`,
                                })}
                              </Text>
                              <Text size="sm" ta="right">
                                {t("cycles.upTo", {
                                  amount: formatMoney(e.amount, account?.currency),
                                })}
                              </Text>
                            </Group>
                          );
                        })}
                      </Stack>
                    )}
                    <Text size="sm" c="dimmed" mt={4}>
                      {t("cycles.othersWait")}
                    </Text>
                  </Stack>
                </Alert>
              ) : next ? (
                <Alert color="orange" variant="light" title={t("cycles.gapTitle")}>
                  {t("cycles.gapText", { range: cycleRange(next) })}
                </Alert>
              ) : (
                <Alert color="orange" variant="light" title={t("cycles.noneAfterTitle")}>
                  {t("cycles.noneAfterText")}
                </Alert>
              )}
              <Text size="xs" c="dimmed">
                {t("cycles.previewNote")}
              </Text>
            </Stack>
          );
        }}
      </QueryState>

      {end.error && <ErrorAlert error={end.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={end.isPending}
          onClick={() => {
            end.mutate();
          }}
        >
          {t("cycles.end")}
        </Button>
      </Group>
    </Stack>
  );
}
