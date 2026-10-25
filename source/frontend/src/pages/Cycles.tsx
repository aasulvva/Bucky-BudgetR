import { ActionIcon, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { useCurrentCycles, useCycles, useRefreshCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { EndCycleDialog } from "@/components/cycles/EndCycleDialog";
import { ExtendCycleDialog } from "@/components/cycles/ExtendCycleDialog";
import { PlanCycleDialog } from "@/components/cycles/PlanCycleDialog";
import { StartCycleDialog } from "@/components/cycles/StartCycleDialog";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { cycleRange, daysLeftLabel, isOverdue, lastDay } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";

/** Finished cycles shown before "Show all". */
const FINISHED_SHOWN = 6;

type Dialog =
  { kind: "start" | "end" | "extend" | "plan" } | { kind: "edit" | "delete"; cycle: Cycle } | null;

/**
 * Cycles (spec §3, §9; canvas "End cycle"): the active cycle with Extend and
 * End, the planned cycles to edit or delete, and the finished ones.
 */
export default function Cycles() {
  const { t } = useTranslation();
  const cycles = useCycles();
  const current = useCurrentCycles();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showAll, setShowAll] = useState(false);
  const close = () => {
    setDialog(null);
  };

  return (
    <Stack gap="lg" maw={860}>
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.cycles")}</Title>
        <Button
          variant="default"
          onClick={() => {
            setDialog({ kind: "plan" });
          }}
        >
          {t("cycles.plan")}
        </Button>
      </Group>

      <QueryState query={current}>
        {({ active, next }) => (
          <>
            {active ? (
              <ActiveCard
                active={active}
                next={next}
                onEnd={() => {
                  setDialog({ kind: "end" });
                }}
                onExtend={() => {
                  setDialog({ kind: "extend" });
                }}
              />
            ) : (
              <Card withBorder padding="lg">
                <Group justify="space-between" gap="md">
                  <div>
                    <Text fw={600}>{t("cycles.noActive")}</Text>
                    <Text size="sm" c="dimmed">
                      {t("cycles.needed")}
                    </Text>
                  </div>
                  <Button
                    onClick={() => {
                      setDialog({ kind: "start" });
                    }}
                  >
                    {t("cycles.start")}
                  </Button>
                </Group>
              </Card>
            )}
            {active ? (
              <>
                <EndCycleDialog
                  opened={dialog?.kind === "end"}
                  onClose={close}
                  active={active}
                  next={next}
                />
                <ExtendCycleDialog
                  opened={dialog?.kind === "extend"}
                  onClose={close}
                  active={active}
                  next={next}
                />
              </>
            ) : (
              <StartCycleDialog
                opened={dialog?.kind === "start"}
                onClose={close}
                next={next}
                cycles={cycles.data ?? []}
              />
            )}
          </>
        )}
      </QueryState>

      <QueryState query={cycles}>
        {(list) => {
          const planned = list.filter((c) => c.state === "future");
          const finished = list.filter((c) => c.state === "finished").reverse();
          const shown = showAll ? finished : finished.slice(0, FINISHED_SHOWN);
          return (
            <>
              <Stack gap="xs">
                <Title order={3} size="h4">
                  {t("cycles.planned")}
                </Title>
                {planned.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("cycles.nonePlanned")}
                  </Text>
                ) : (
                  <Card withBorder padding={0}>
                    {planned.map((c, i) => (
                      <CycleRow key={c.id} cycle={c}>
                        {i === 0 && (
                          <Badge variant="light" size="sm">
                            {t("cycles.next")}
                          </Badge>
                        )}
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={36}
                          aria-label={t("cycles.editRange", { range: cycleRange(c) })}
                          onClick={() => {
                            setDialog({ kind: "edit", cycle: c });
                          }}
                        >
                          <IconPencil size={18} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size={36}
                          aria-label={t("cycles.deleteRange", { range: cycleRange(c) })}
                          onClick={() => {
                            setDialog({ kind: "delete", cycle: c });
                          }}
                        >
                          <IconTrash size={18} />
                        </ActionIcon>
                      </CycleRow>
                    ))}
                  </Card>
                )}
              </Stack>

              {finished.length > 0 && (
                <Stack gap="xs">
                  <Title order={3} size="h4">
                    {t("cycles.finished")}
                  </Title>
                  <Card withBorder padding={0}>
                    {shown.map((c) => (
                      <CycleRow key={c.id} cycle={c} />
                    ))}
                  </Card>
                  {finished.length > FINISHED_SHOWN && (
                    <Button
                      variant="subtle"
                      size="xs"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() => {
                        setShowAll((s) => !s);
                      }}
                    >
                      {showAll
                        ? t("cycles.showFewer")
                        : t("cycles.showAll", { count: finished.length })}
                    </Button>
                  )}
                </Stack>
              )}

              <PlanCycleDialog
                opened={dialog?.kind === "plan" || dialog?.kind === "edit"}
                onClose={close}
                cycles={list}
                cycle={dialog?.kind === "edit" ? dialog.cycle : undefined}
              />
              <DeleteCycleDialog
                cycle={dialog?.kind === "delete" ? dialog.cycle : undefined}
                onClose={close}
              />
            </>
          );
        }}
      </QueryState>
    </Stack>
  );
}

function ActiveCard({
  active,
  next,
  onEnd,
  onExtend,
}: {
  active: Cycle;
  next: Cycle | null;
  onEnd: () => void;
  onExtend: () => void;
}) {
  const { t } = useTranslation();
  const overdue = isOverdue(active);
  return (
    <Card
      withBorder
      padding="lg"
      component="section"
      aria-label={t("cycles.active")}
      style={overdue ? { borderColor: "var(--mantine-color-orange-5)" } : undefined}
    >
      <Group justify="space-between" gap="md">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            {t("cycles.active")}
          </Text>
          <Text fz={20} fw={700}>
            {cycleRange(active)}
          </Text>
          <Text size="sm" c={overdue ? "orange.8" : "dimmed"}>
            {overdue
              ? t("cycles.overdueSince", { date: formatDate(lastDay(active)) })
              : daysLeftLabel(active)}
            {!overdue && next && t("cycles.nextPlanned", { range: cycleRange(next) })}
          </Text>
        </Stack>
        <Group gap="xs">
          <Button variant="default" onClick={onExtend}>
            {t("common.extend")}
          </Button>
          <Button variant="outline" onClick={onEnd}>
            {t("cycles.end")}
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

function CycleRow({ cycle, children }: { cycle: Cycle; children?: React.ReactNode }) {
  return (
    <Group
      justify="space-between"
      gap="xs"
      px="md"
      py="xs"
      mih={52}
      wrap="nowrap"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Text size="sm">{cycleRange(cycle)}</Text>
      {children && (
        <Group gap={4} wrap="nowrap">
          {children}
        </Group>
      )}
    </Group>
  );
}

function DeleteCycleDialog({ cycle, onClose }: { cycle?: Cycle; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshCycles();
  const remove = useMutation({
    mutationFn: (c: Cycle) =>
      unwrap(api.DELETE("/api/v1/cycles/{cycleId}", { params: { path: { cycleId: c.id } } })),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({ color: "green", message: t("cycles.deleted") });
      onClose();
      await refresh();
    },
  });

  return (
    <ResponsiveModal opened={cycle !== undefined} onClose={onClose} title={t("cycles.deleteTitle")}>
      {cycle && (
        <Stack gap="md">
          <Text>
            <Trans
              i18nKey="cycles.deleteText"
              values={{ range: cycleRange(cycle) }}
              components={{ b: <strong /> }}
            />
          </Text>
          {remove.error && <ErrorAlert error={remove.error} />}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              color="red"
              loading={remove.isPending}
              onClick={() => {
                remove.mutate(cycle);
              }}
            >
              {t("common.delete")}
            </Button>
          </Group>
        </Stack>
      )}
    </ResponsiveModal>
  );
}
