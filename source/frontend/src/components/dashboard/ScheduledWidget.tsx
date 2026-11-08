import { Anchor, Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useApprove, useQueue, useSchedules, useUpcoming } from "@/api/schedules";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { DueBadge } from "@/components/schedules/ApprovalQueue";
import { useScheduleText, type ScheduleText } from "@/components/schedules/scheduleText";
import type { WidgetInstance } from "@/lib/dashboard";
import { formatDateTime } from "@/lib/dates";
import { queueOrder, type Occurrence, type Schedule, type Upcoming } from "@/lib/schedules";

import { WidgetCard } from "./Widget";

const SCHEDULED_PATH = "/transactions/scheduled";

/**
 * Scheduled transactions (#155): the ones waiting for approval, overdue
 * first, to approve as they are, and what the schedules record next.
 */
export function ScheduledWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"scheduled">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const { show, count } = widget.settings;
  const queue = useQueue();
  const upcoming = useUpcoming(count, show !== "queue");
  const schedules = useSchedules();
  return (
    <WidgetShell action={action}>
      <QueryState query={schedules}>
        {(list) => {
          const byId = new Map(list.map((s) => [s.id, s]));
          return (
            <Stack gap="md">
              {show !== "upcoming" && (
                <Part title={show === "both" ? t("dashboard.scheduled.queue") : undefined}>
                  <QueryState query={queue}>
                    {(items) => <QueueRows items={items} count={count} byId={byId} />}
                  </QueryState>
                </Part>
              )}
              {show !== "queue" && (
                <Part title={show === "both" ? t("dashboard.scheduled.upcoming") : undefined}>
                  <QueryState query={upcoming}>
                    {(items) => <UpcomingRows items={items} byId={byId} />}
                  </QueryState>
                </Part>
              )}
            </Stack>
          );
        }}
      </QueryState>
    </WidgetShell>
  );
}

function WidgetShell({ action, children }: { action?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <WidgetCard
      title={t("dashboard.scheduled.title")}
      link={{ to: SCHEDULED_PATH, label: t("dashboard.scheduled.all") }}
      action={action}
    >
      {children}
    </WidgetCard>
  );
}

function Part({ title, children }: { title: string | undefined; children: ReactNode }) {
  return (
    <Stack gap={4}>
      {title && (
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          {title}
        </Text>
      )}
      {children}
    </Stack>
  );
}

function QueueRows({
  items,
  count,
  byId,
}: {
  items: Occurrence[];
  count: number;
  byId: Map<string, Schedule>;
}) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("dashboard.scheduled.nothingWaiting")}
      </Text>
    );
  }
  const shown = queueOrder(items).slice(0, count);
  const more = items.length - shown.length;
  return (
    <Stack gap={0}>
      {shown.map((o) => (
        <QueueItem key={o.id} occurrence={o} schedule={byId.get(o.schedule_id)} />
      ))}
      {more > 0 && (
        <Anchor component={Link} to={SCHEDULED_PATH} size="sm" pt={6}>
          {t("dashboard.scheduled.more", { count: more })}
        </Anchor>
      )}
    </Stack>
  );
}

function QueueItem({
  occurrence: o,
  schedule,
}: {
  occurrence: Occurrence;
  schedule: Schedule | undefined;
}) {
  const { t } = useTranslation();
  const text = useScheduleText()(schedule);
  const approve = useApprove();
  return (
    <Row text={text} data-testid="widget-queue-row">
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
          <Text size="sm" c="dimmed">
            {formatDateTime(o.scheduled_at)}
          </Text>
          <DueBadge occurrence={o} />
        </Group>
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconCheck size={12} />}
          aria-label={t("schedules.queue.approveName", { name: text.title })}
          loading={approve.isPending}
          onClick={() => {
            approve.mutate({ id: o.id });
          }}
        >
          {t("schedules.queue.approve")}
        </Button>
      </Group>
      {approve.error && <ErrorAlert error={approve.error} />}
    </Row>
  );
}

function UpcomingRows({ items, byId }: { items: Upcoming[]; byId: Map<string, Schedule> }) {
  const { t } = useTranslation();
  const text = useScheduleText();
  if (items.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("dashboard.scheduled.nothingUpcoming")}
      </Text>
    );
  }
  return (
    <Stack gap={0}>
      {items.map((u) => {
        const s = byId.get(u.schedule_id);
        return (
          <Row key={`${u.schedule_id}-${u.at}`} text={text(s)} data-testid="widget-upcoming-row">
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                {formatDateTime(u.at)}
              </Text>
              {s?.mode === "approve" && (
                <Badge variant="light" size="sm" radius="sm">
                  {t("schedules.approve")}
                </Badge>
              )}
            </Group>
          </Row>
        );
      })}
    </Stack>
  );
}

function Row({
  text,
  children,
  "data-testid": testId,
}: {
  text: ScheduleText;
  children: ReactNode;
  "data-testid": string;
}) {
  return (
    <Box
      py={6}
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      data-testid={testId}
    >
      <Group justify="space-between" gap="sm" wrap="nowrap">
        <Text size="sm" fw={600} truncate>
          {text.title}
        </Text>
        <Text
          size="sm"
          fw={600}
          style={{ whiteSpace: "nowrap" }}
          c={text.income ? "var(--mantine-color-blue-text)" : undefined}
        >
          {text.amount}
        </Text>
      </Group>
      {children}
    </Box>
  );
}
