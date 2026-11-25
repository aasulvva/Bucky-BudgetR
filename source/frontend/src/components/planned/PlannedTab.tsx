import {
  ActionIcon,
  Alert,
  Anchor,
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
import { DatePickerInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import {
  IconCalendarEvent,
  IconDots,
  IconPencil,
  IconPlus,
  IconReceipt,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useCycles, type Cycle } from "@/api/cycles";
import {
  useCancelPlanned,
  usePlannedPurchases,
  useUpdatePlanned,
  type PlannedPurchase,
} from "@/api/planned";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { useLookups, type Lookups } from "@/components/transactions/lookups";
import { cycleRange, localDate, startAtFor, type LocalDate } from "@/lib/cycles";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { PLANNED_PATH, chargeLink } from "@/lib/planned";

/** Whether the tab lists the charged and cancelled ones too, in this browser. */
const SHOW_CLOSED_KEY = "bucky.plannedShowClosed";

function loadShowClosed(): boolean {
  try {
    return localStorage.getItem(SHOW_CLOSED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveShowClosed(on: boolean) {
  try {
    localStorage.setItem(SHOW_CLOSED_KEY, String(on));
  } catch {
    // Not remembered; the next visit hides them.
  }
}

/**
 * The Planned tab of Transactions (#265): the open planned purchases, the
 * soonest expected first, each with the cycle it's set aside in, to record
 * its charge, move its date, edit or cancel. The closed ones show when
 * switched on.
 */
export function PlannedTab() {
  const { t } = useTranslation();
  const open = usePlannedPurchases("open");
  const names = useLookups();
  const cycles = useCycles().data ?? [];
  const [showClosed, setShowClosed] = useState(loadShowClosed);
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("planned.intro")}
      </Text>
      <Group justify="space-between" gap="sm">
        <Checkbox
          label={t("planned.showClosed")}
          checked={showClosed}
          onChange={(e) => {
            setShowClosed(e.currentTarget.checked);
            saveShowClosed(e.currentTarget.checked);
          }}
        />
        <Button component={Link} to={`${PLANNED_PATH}/new`} leftSection={<IconPlus size={16} />}>
          {t("planned.new")}
        </Button>
      </Group>
      <QueryState query={open}>
        {(list) =>
          list.length === 0 ? (
            <Text c="dimmed">{t("planned.empty")}</Text>
          ) : (
            <Card withBorder padding={0}>
              {list.map((p) => (
                <PlannedRow key={p.id} plan={p} names={names} cycles={cycles} />
              ))}
            </Card>
          )
        }
      </QueryState>
      {showClosed && <ClosedList names={names} />}
    </Stack>
  );
}

function ClosedList({ names }: { names: Lookups }) {
  const { t } = useTranslation();
  const closed = usePlannedPurchases("closed");
  return (
    <Stack gap="xs" component="section" aria-label={t("planned.closed")}>
      <Text fw={600}>{t("planned.closed")}</Text>
      <QueryState query={closed}>
        {(list) =>
          list.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("planned.noneClosed")}
            </Text>
          ) : (
            <Card withBorder padding={0}>
              {list.map((p) => (
                <Group
                  key={p.id}
                  justify="space-between"
                  gap="sm"
                  wrap="nowrap"
                  px="md"
                  py={10}
                  style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
                >
                  <Box style={{ minWidth: 0 }}>
                    <Text fw={600} truncate c="dimmed">
                      {p.name}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {p.status === "charged" && p.transaction_id ? (
                        <Anchor component={Link} to={`/transactions?open=${p.transaction_id}`}>
                          {t("planned.charged")}
                        </Anchor>
                      ) : (
                        t("planned.cancelled")
                      )}{" "}
                      · {names.accountName(p.account_id)}
                    </Text>
                  </Box>
                  <Text c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {formatMoney(p.amount, p.currency)}
                  </Text>
                </Group>
              ))}
            </Card>
          )
        }
      </QueryState>
    </Stack>
  );
}

function PlannedRow({
  plan: p,
  names,
  cycles,
}: {
  plan: PlannedPurchase;
  names: Lookups;
  cycles: Cycle[];
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const editLink = `${PLANNED_PATH}/${p.id}/edit`;
  const cycle = cycles.find((c) => c.id === p.cycle_id);
  const money = (amount: string) => formatMoney(amount, p.currency);
  const buckets = p.bucket_lines
    .map((l) => `${names.bucketName(l.bucket_id)} ${money(l.amount)}`)
    .join(", ");
  const cancel = useCancelPlanned(() => {
    notifications.show({ color: "green", message: t("planned.cancelledDone") });
  });

  return (
    <Box style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      <Group gap={0} wrap="nowrap" align="stretch">
        <UnstyledButton
          component={Link}
          to={editLink}
          px="md"
          py={10}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("planned.editName", { name: p.name })}
        >
          <Group justify="space-between" gap="sm" wrap="nowrap" align="flex-start">
            <Box style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {p.name}
              </Text>
              <Text size="sm" c={p.overdue ? "var(--mantine-color-orange-text)" : undefined}>
                {t("planned.expected", { date: formatDate(p.expected_at) })}
              </Text>
              <Text size="sm" c="dimmed">
                {cycle ? t("planned.inCycle", { range: cycleRange(cycle) }) : t("planned.noCycle")}{" "}
                · {names.accountName(p.account_id)}
              </Text>
              {buckets && (
                <Text size="sm" c="dimmed">
                  {t("planned.setAsideIn", { buckets })}
                </Text>
              )}
            </Box>
            <Stack gap={4} align="flex-end">
              <Text fw={600} style={{ whiteSpace: "nowrap" }}>
                {money(p.amount)}
              </Text>
              {p.overdue && (
                <Badge variant="light" color="orange" size="sm" radius="sm">
                  {t("planned.overdue")}
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
                aria-label={t("planned.actions", { name: p.name })}
              >
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                component={Link}
                to={chargeLink(p.id)}
                leftSection={<IconReceipt size={16} />}
              >
                {t("planned.recordCharge")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconCalendarEvent size={16} />}
                onClick={() => {
                  setMoving(true);
                }}
              >
                {t("planned.moveDate")}
              </Menu.Item>
              <Menu.Item component={Link} to={editLink} leftSection={<IconPencil size={16} />}>
                {t("planned.edit")}
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t("planned.cancel")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      </Group>
      {confirming && (
        <Alert color="red" p="sm" mx="md" mb="sm">
          <Stack gap="sm">
            <Text size="sm">{t("planned.cancelConfirm")}</Text>
            {cancel.error && <ErrorAlert error={cancel.error} />}
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t("planned.keep")}
              </Button>
              <Button
                color="red"
                size="xs"
                loading={cancel.isPending}
                aria-label={t("planned.cancelName", { name: p.name })}
                onClick={() => {
                  cancel.mutate(p.id);
                }}
              >
                {t("planned.cancel")}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      <ResponsiveModal
        opened={moving}
        onClose={() => {
          setMoving(false);
        }}
        title={t("planned.moveTitle", { name: p.name })}
      >
        <MoveDate
          plan={p}
          cycles={cycles}
          onDone={() => {
            setMoving(false);
          }}
        />
      </ResponsiveModal>
    </Box>
  );
}

/** Move date: a new expected day, and the cycle it then counts in. */
function MoveDate({
  plan,
  cycles,
  onDone,
}: {
  plan: PlannedPurchase;
  cycles: Cycle[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [day, setDay] = useState<LocalDate>(localDate(plan.expected_at));
  const move = useUpdatePlanned((saved) => {
    notifications.show({
      color: "green",
      message: t("planned.moved", { date: formatDate(saved.expected_at) }),
    });
    onDone();
  });
  const at = new Date(startAtFor(day)).getTime();
  const lands = cycles.find(
    (c) => new Date(c.start_at).getTime() <= at && at < new Date(c.end_at).getTime(),
  );
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate({ id: plan.id, body: { expected_at: startAtFor(day) } });
      }}
    >
      <Stack gap="md">
        <DatePickerInput
          label={t("planned.form.expected")}
          valueFormat="D MMM YYYY"
          value={day}
          onChange={(v) => {
            if (v) setDay(v);
          }}
          popoverProps={{ withinPortal: false }}
          data-autofocus
        />
        <Text size="sm" c="dimmed">
          {lands
            ? lands.state === "finished"
              ? t("planned.movesActive")
              : t("planned.inCycle", { range: cycleRange(lands) })
            : t("planned.noCycle")}
        </Text>
        {move.error && <ErrorAlert error={move.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={move.isPending}>
            {t("planned.moveDate")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
