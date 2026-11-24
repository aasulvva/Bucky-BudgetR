import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Menu,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconDots, IconPencil, IconPlayerSkipForward } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { describeError } from "@/api/errors";
import {
  useApprove,
  useQueue,
  useResolveMany,
  useSchedules,
  useSkip,
  type BulkAction,
} from "@/api/schedules";
import { ErrorAlert } from "@/components/ErrorAlert";
import { formatDate, formatDateTime } from "@/lib/dates";
import {
  approvePath,
  queueOrder,
  reasonText,
  type Occurrence,
  type Schedule,
} from "@/lib/schedules";

import { useScheduleText } from "./scheduleText";

/** A queued one's Overdue or Due badge; none without a due time. */
export function DueBadge({ occurrence: o }: { occurrence: Occurrence }) {
  const { t } = useTranslation();
  if (o.overdue) {
    return (
      <Badge color="red" variant="light" size="sm" radius="sm">
        {t("schedules.queue.overdue")}
      </Badge>
    );
  }
  if (!o.due_at) return null;
  return (
    <Badge color="gray" variant="light" size="sm" radius="sm">
      {t("schedules.queue.due", { date: formatDate(o.due_at) })}
    </Badge>
  );
}

/**
 * The approval queue (#155), at the top of the Scheduled tab while anything
 * waits: each one to approve as it is, edit and approve, or skip, and a
 * selection to approve or skip several. Overdue ones come first.
 */
export function ApprovalQueue() {
  const { t } = useTranslation();
  const queue = useQueue();
  const schedules = useSchedules().data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const many = useResolveMany();
  const items = queueOrder(queue.data ?? []);
  if (items.length === 0) return null;

  const byId = new Map(schedules.map((s) => [s.id, s]));
  // Only ones still queued count; the rest went with a refresh.
  const chosen = items.filter((o) => selected.has(o.id)).map((o) => o.id);
  const all = chosen.length === items.length;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const run = (action: BulkAction) => {
    setFailure(null);
    many.mutate(
      { action, ids: chosen },
      {
        onSuccess: ({ done, failed }) => {
          setSelected(new Set(failed.map((f) => f.id)));
          if (done.length > 0) {
            notifications.show({
              color: "green",
              message: t(
                action === "approve" ? "schedules.queue.approved" : "schedules.queue.skipped",
                { count: done.length },
              ),
            });
          }
          const first = failed[0];
          if (first) {
            const { title, detail } = describeError(first.error);
            setFailure(
              t(
                action === "approve"
                  ? "schedules.queue.approveFailed"
                  : "schedules.queue.skipFailed",
                { count: failed.length, reason: detail ?? title },
              ),
            );
          }
        },
      },
    );
  };

  return (
    <Card withBorder padding={0} component="section" aria-labelledby="approval-queue-title">
      <Group justify="space-between" gap="sm" px="md" py="sm" wrap="wrap">
        <Group gap="sm">
          <Checkbox
            aria-label={t("schedules.queue.selectAll")}
            checked={all}
            indeterminate={chosen.length > 0 && !all}
            onChange={(e) => {
              setSelected(e.currentTarget.checked ? new Set(items.map((o) => o.id)) : new Set());
            }}
          />
          <Title order={2} size="h5" id="approval-queue-title">
            {t("schedules.queue.title", { count: items.length })}
          </Title>
        </Group>
        {chosen.length > 0 && (
          <Group gap="xs">
            <Button
              size="xs"
              leftSection={<IconCheck size={14} />}
              loading={many.isPending && many.variables.action === "approve"}
              disabled={many.isPending}
              onClick={() => {
                run("approve");
              }}
            >
              {t("schedules.queue.approveSelected", { count: chosen.length })}
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={many.isPending && many.variables.action === "skip"}
              disabled={many.isPending}
              onClick={() => {
                run("skip");
              }}
            >
              {t("schedules.queue.skipSelected", { count: chosen.length })}
            </Button>
          </Group>
        )}
      </Group>
      {failure && (
        <Alert color="red" p="sm" mx="md" mb="sm">
          <Text size="sm">{failure}</Text>
        </Alert>
      )}
      {items.map((o) => (
        <QueueRow
          key={o.id}
          occurrence={o}
          schedule={byId.get(o.schedule_id)}
          selected={selected.has(o.id)}
          onSelect={(on) => {
            toggle(o.id, on);
          }}
          busy={many.isPending}
        />
      ))}
    </Card>
  );
}

function QueueRow({
  occurrence: o,
  schedule,
  selected,
  onSelect,
  busy,
}: {
  occurrence: Occurrence;
  schedule: Schedule | undefined;
  selected: boolean;
  onSelect: (on: boolean) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const text = useScheduleText()(schedule);
  const approve = useApprove(() => {
    notifications.show({ color: "green", message: t("schedules.queue.approved", { count: 1 }) });
  });
  const skip = useSkip(() => {
    notifications.show({ color: "green", message: t("schedules.queue.skipped", { count: 1 }) });
  });
  const pending = busy || approve.isPending || skip.isPending;
  const error = approve.error ?? skip.error;
  const editLink = approvePath(o.id);

  return (
    <Box
      px="md"
      py={10}
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      data-testid="queue-row"
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Checkbox
          mt={3}
          aria-label={t("schedules.queue.select", { name: text.title })}
          checked={selected}
          onChange={(e) => {
            onSelect(e.currentTarget.checked);
          }}
        />
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" gap="sm" wrap="nowrap" align="flex-start">
            <Box style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {text.title}
              </Text>
              <Text size="sm" c="dimmed">
                {formatDateTime(o.scheduled_at)} · {reasonText(o, t)}
              </Text>
            </Box>
            <Stack gap={4} align="flex-end">
              <Text
                fw={600}
                style={{ whiteSpace: "nowrap" }}
                c={text.income ? "var(--mantine-color-blue-text)" : undefined}
              >
                {text.amount}
              </Text>
              {text.rule && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {text.rule}
                </Text>
              )}
              <DueBadge occurrence={o} />
            </Stack>
          </Group>
          <Group gap="xs">
            <Button
              size="xs"
              leftSection={<IconCheck size={14} />}
              aria-label={t("schedules.queue.approveName", { name: text.title })}
              loading={approve.isPending}
              disabled={pending}
              onClick={() => {
                approve.mutate({ id: o.id });
              }}
            >
              {t("schedules.queue.approve")}
            </Button>
            {isDesktop ? (
              <>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconPencil size={14} />}
                  component={Link}
                  to={editLink}
                >
                  {t("schedules.queue.editApprove")}
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconPlayerSkipForward size={14} />}
                  aria-label={t("schedules.queue.skipName", { name: text.title })}
                  loading={skip.isPending}
                  disabled={pending}
                  onClick={() => {
                    skip.mutate(o.id);
                  }}
                >
                  {t("schedules.queue.skip")}
                </Button>
              </>
            ) : (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="md"
                    aria-label={t("schedules.queue.more", { name: text.title })}
                  >
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item component={Link} to={editLink} leftSection={<IconPencil size={16} />}>
                    {t("schedules.queue.editApprove")}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconPlayerSkipForward size={16} />}
                    disabled={pending}
                    onClick={() => {
                      skip.mutate(o.id);
                    }}
                  >
                    {t("schedules.queue.skip")}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
          {error && <ErrorAlert error={error} />}
        </Stack>
      </Group>
    </Box>
  );
}
