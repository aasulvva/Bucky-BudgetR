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
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDots,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts } from "@/api/accounts";
import { useDeleteSchedule, useSaveSchedule, useSchedules } from "@/api/schedules";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { useLookups, type Lookups } from "@/components/transactions/lookups";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  repeatSentence,
  scheduleState,
  scheduleTitle,
  toInput,
  type Schedule,
} from "@/lib/schedules";

/** Which schedules the tab shows, remembered in this browser. */
const SHOW_KEY = "bucky.scheduledShow";

interface Show {
  paused: boolean;
  ended: boolean;
}

function loadShow(): Show {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOW_KEY) ?? "{}") as Partial<Show>;
    return { paused: saved.paused !== false, ended: saved.ended === true };
  } catch {
    return { paused: true, ended: false };
  }
}

function saveShow(show: Show) {
  try {
    localStorage.setItem(SHOW_KEY, JSON.stringify(show));
  } catch {
    // Not remembered; the next visit starts from the defaults.
  }
}

/**
 * The Scheduled tab of Transactions (#154): the user's schedules, each in
 * words with its next time, to edit, pause or delete. Paused ones show and
 * ended ones don't, unless switched.
 */
export function ScheduledTab() {
  const { t } = useTranslation();
  const schedules = useSchedules();
  const names = useLookups();
  const [show, setShow] = useState(loadShow);
  const change = (next: Partial<Show>) => {
    const value = { ...show, ...next };
    setShow(value);
    saveShow(value);
  };
  return (
    <Stack gap="md">
      <Group justify="space-between" gap="sm">
        <Group gap="md">
          <Checkbox
            label={t("schedules.showPaused")}
            checked={show.paused}
            onChange={(e) => {
              change({ paused: e.currentTarget.checked });
            }}
          />
          <Checkbox
            label={t("schedules.showEnded")}
            checked={show.ended}
            onChange={(e) => {
              change({ ended: e.currentTarget.checked });
            }}
          />
        </Group>
        <Button
          component={Link}
          to="/transactions/scheduled/new"
          leftSection={<IconPlus size={16} />}
        >
          {t("schedules.new")}
        </Button>
      </Group>
      <QueryState query={schedules}>
        {(list) => {
          if (list.length === 0) return <Text c="dimmed">{t("schedules.empty")}</Text>;
          const shown = list.filter((s) => {
            const state = scheduleState(s);
            return state === "active" || show[state];
          });
          const hidden = list.length - shown.length;
          return (
            <Stack gap="xs">
              {shown.length > 0 && (
                <Card withBorder padding={0}>
                  {shown.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} names={names} />
                  ))}
                </Card>
              )}
              {hidden > 0 && (
                <Text size="sm" c="dimmed">
                  {t("schedules.hidden", { count: hidden })}
                </Text>
              )}
            </Stack>
          );
        }}
      </QueryState>
    </Stack>
  );
}

function ScheduleRow({ schedule: s, names }: { schedule: Schedule; names: Lookups }) {
  const { t, i18n } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const [confirming, setConfirming] = useState(false);
  const title = scheduleTitle(s, t, names.accountName);
  const tx = s.transaction;
  const currency = accounts.find((a) => a.id === tx.account_id)?.currency;
  const amount = formatMoney(tx.type === "EXP" ? `-${tx.amount}` : tx.amount, currency);
  const where =
    tx.type === "TRF" && tx.to_account_id
      ? `${names.accountName(tx.account_id)} → ${names.accountName(tx.to_account_id)}`
      : names.accountName(tx.account_id);
  const editLink = `/transactions/scheduled/${s.id}/edit`;

  const pause = useSaveSchedule((saved) => {
    notifications.show({
      color: "green",
      message: t(saved.paused ? "schedules.pausedDone" : "schedules.resumedDone"),
    });
  });
  const remove = useDeleteSchedule(() => {
    notifications.show({ color: "green", message: t("schedules.deleted") });
  });

  const status = s.paused
    ? t("schedules.paused")
    : s.next_at
      ? t("schedules.next", { date: formatDateTime(s.next_at) })
      : t("schedules.ended");

  return (
    <Box style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      <Group gap={0} wrap="nowrap" align="stretch">
        <UnstyledButton
          component={Link}
          to={editLink}
          px="md"
          py={10}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("schedules.editAction") + ": " + title}
        >
          <Group justify="space-between" gap="sm" wrap="nowrap" align="flex-start">
            <Box style={{ minWidth: 0 }}>
              <Text fw={600} truncate c={s.paused || !s.next_at ? "dimmed" : undefined}>
                {title}
              </Text>
              <Text size="sm">{repeatSentence(s, t, i18n.language)}</Text>
              <Text size="sm" c="dimmed">
                {status} · {where}
              </Text>
            </Box>
            <Stack gap={4} align="flex-end">
              <Text
                fw={600}
                style={{ whiteSpace: "nowrap" }}
                c={tx.type === "INC" ? "var(--mantine-color-blue-text)" : undefined}
              >
                {amount}
              </Text>
              {s.mode === "approve" && (
                <Badge variant="light" size="sm" radius="sm">
                  {t("schedules.approve")}
                </Badge>
              )}
              {s.paused && (
                <Badge variant="light" color="gray" size="sm" radius="sm">
                  {t("schedules.paused")}
                </Badge>
              )}
            </Stack>
          </Group>
        </UnstyledButton>
        <Box pr="xs" pt={10}>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t("schedules.actions", { name: title })}
              >
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item component={Link} to={editLink} leftSection={<IconPencil size={16} />}>
                {t("schedules.editAction")}
              </Menu.Item>
              {s.next_at !== null && (
                <Menu.Item
                  leftSection={
                    s.paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />
                  }
                  onClick={() => {
                    pause.mutate({ id: s.id, body: toInput(s, { paused: !s.paused }) });
                  }}
                >
                  {t(s.paused ? "schedules.resume" : "schedules.pause")}
                </Menu.Item>
              )}
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t("schedules.delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      </Group>
      {pause.error && (
        <Box px="md" pb="sm">
          <ErrorAlert error={pause.error} />
        </Box>
      )}
      {confirming && (
        <Alert color="red" p="sm" mx="md" mb="sm">
          <Stack gap="sm">
            <Text size="sm">{t("schedules.deleteConfirm")}</Text>
            {remove.error && <ErrorAlert error={remove.error} />}
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                color="red"
                size="xs"
                loading={remove.isPending}
                aria-label={t("schedules.deleteName", { name: title })}
                onClick={() => {
                  remove.mutate(s.id);
                }}
              >
                {t("schedules.delete")}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
    </Box>
  );
}
