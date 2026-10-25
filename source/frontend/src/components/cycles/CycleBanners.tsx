import { Alert, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle, IconCalendarOff } from "@tabler/icons-react";
import { useState } from "react";
import { useLocation } from "react-router";

import { useCurrentCycles, useCycles } from "@/api/cycles";
import { isOverdue, lastDay } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";

import { EndCycleDialog } from "./EndCycleDialog";
import { ExtendCycleDialog } from "./ExtendCycleDialog";
import { StartCycleDialog } from "./StartCycleDialog";

/**
 * Tells the user when there's no active cycle or the active one is overdue,
 * on every screen. Without a cycle the start dialog opens once per session
 * (the shell stays mounted until sign out); after "Not now" a banner can
 * reopen it. The Cycles screen has the same actions itself, so the banners
 * stay off it.
 */
export function CycleBanners() {
  const current = useCurrentCycles();
  const cycles = useCycles();
  const onCycles = useLocation().pathname === "/cycles";
  const [dialog, setDialog] = useState<"start" | "end" | "extend" | null>(null);
  const [prompted, setPrompted] = useState(false);

  // The first time the cycles are known, prompt if there's none.
  if (!prompted && current.data) {
    setPrompted(true);
    if (current.data.active === null) setDialog("start");
  }

  if (!current.data) return null;
  const { active, next } = current.data;
  const close = () => {
    setDialog(null);
  };

  return (
    <>
      {active === null && !onCycles && (
        <Alert color="blue" mb="md" icon={<IconCalendarOff size={20} />}>
          <Group justify="space-between" gap="sm">
            <Text size="sm">
              No active cycle. Buckets, refills and bucket lines on transactions need one.
            </Text>
            <Button
              size="xs"
              onClick={() => {
                setDialog("start");
              }}
            >
              Start cycle
            </Button>
          </Group>
        </Alert>
      )}
      {active !== null && isOverdue(active) && !onCycles && (
        <Alert color="orange" mb="md" icon={<IconAlertTriangle size={20} />}>
          <Group justify="space-between" gap="sm">
            <Text size="sm">
              The cycle ended on {formatDate(lastDay(active))}. Bucket transactions are paused until
              you end or extend it.
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setDialog("extend");
                }}
              >
                Extend
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  setDialog("end");
                }}
              >
                End cycle
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
      {active === null && (
        <StartCycleDialog
          opened={dialog === "start"}
          onClose={close}
          next={next}
          cycles={cycles.data ?? []}
        />
      )}
      {active !== null && (
        <>
          <EndCycleDialog opened={dialog === "end"} onClose={close} active={active} next={next} />
          <ExtendCycleDialog
            opened={dialog === "extend"}
            onClose={close}
            active={active}
            next={next}
          />
        </>
      )}
    </>
  );
}
