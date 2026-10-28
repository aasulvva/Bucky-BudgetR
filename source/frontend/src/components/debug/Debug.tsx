import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  FileButton,
  Group,
  Menu,
  Paper,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import {
  IconBug,
  IconClock,
  IconDots,
  IconDownload,
  IconPencil,
  IconRestore,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import dayjs from "dayjs";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useCurrentCycles } from "@/api/cycles";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { now, setServerClock } from "@/lib/clock";
import { formatDateTime } from "@/lib/dates";
import { autofocusField } from "@/lib/device";

import {
  exportUrl,
  useDeleteSnapshot,
  useDevClock,
  useImportSnapshot,
  useRenameSnapshot,
  useRestoreSnapshot,
  useSaveSnapshot,
  useSetDevClock,
  useSnapshots,
  type Snapshot,
} from "./devApi";

// The debug settings (#100), development only: a fake clock for the whole
// server and snapshots of the user's data. index.tsx loads this module only
// in development builds, and everything here renders nothing unless the
// server has the debug routes.

let drawerOpen = false;
const listeners = new Set<() => void>();

function setDrawer(open: boolean) {
  drawerOpen = open;
  for (const l of listeners) l();
}

function useDrawerOpen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => drawerOpen,
  );
}

/** Whether the server has the debug settings; follows its clock. */
function useDebugAvailable() {
  const clock = useDevClock();
  useEffect(() => {
    setServerClock(clock.data ?? null);
  }, [clock.data]);
  return clock.data ?? null;
}

/** The fake time banner and the debug drawer. Rendered once, in the shell. */
export function DebugRoot() {
  const clock = useDebugAvailable();
  const opened = useDrawerOpen();
  if (!clock) return null;
  return (
    <>
      {clock.mode !== "real" && <FakeTimeBanner frozen={clock.mode === "frozen"} />}
      <DebugDrawer
        opened={opened}
        onClose={() => {
          setDrawer(false);
        }}
      />
    </>
  );
}

/** The bug icon next to the user block in the side menu. */
export function DebugButton() {
  const { t } = useTranslation();
  const clock = useDevClock().data;
  if (!clock) return null;
  return (
    <Tooltip label={t("debug.open")}>
      <ActionIcon
        variant="subtle"
        color={clock.mode === "real" ? "gray" : "violet"}
        size="lg"
        aria-label={t("debug.open")}
        onClick={() => {
          setDrawer(true);
        }}
      >
        <IconBug size={20} />
      </ActionIcon>
    </Tooltip>
  );
}

/** The same, as an item in the profile menu (mobile). */
export function DebugMenuItem() {
  const { t } = useTranslation();
  const clock = useDevClock().data;
  if (!clock) return null;
  return (
    <Menu.Item
      leftSection={<IconBug size={18} />}
      onClick={() => {
        setDrawer(true);
      }}
    >
      {t("debug.open")}
    </Menu.Item>
  );
}

function FakeTimeBanner({ frozen }: { frozen: boolean }) {
  const { t } = useTranslation();
  const set = useSetDevClock();
  // A running clock moves on; redraw now and then.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((n) => n + 1);
    }, 30_000);
    return () => {
      clearInterval(id);
    };
  }, []);

  const time = formatDateTime(now());
  return (
    <Alert color="violet" mb="md" icon={<IconClock size={20} />}>
      <Group justify="space-between" gap="sm">
        <Text size="sm">
          {frozen ? t("debug.bannerFrozen", { time }) : t("debug.banner", { time })}
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              setDrawer(true);
            }}
          >
            {t("debug.change")}
          </Button>
          <Button
            size="xs"
            loading={set.isPending}
            onClick={() => {
              set.mutate({ at: null, frozen: false });
            }}
          >
            {t("debug.time.reset")}
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}

function DebugDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Drawer opened={opened} onClose={onClose} position="right" title={t("debug.title")}>
      <Stack gap="md">
        <Text size="xs" c="dimmed">
          {t("debug.devOnly")}
        </Text>
        <Tabs defaultValue="time" keepMounted={false}>
          <Tabs.List grow>
            <Tabs.Tab value="time" leftSection={<IconClock size={16} />}>
              {t("debug.tabs.time")}
            </Tabs.Tab>
            <Tabs.Tab value="snapshots" leftSection={<IconRestore size={16} />}>
              {t("debug.tabs.snapshots")}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="time" pt="md">
            <TimePanel />
          </Tabs.Panel>
          <Tabs.Panel value="snapshots" pt="md">
            <SnapshotsPanel />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Drawer>
  );
}

function TimePanel() {
  const { t } = useTranslation();
  const clock = useDevClock().data;
  const active = useCurrentCycles().data?.active ?? null;
  const set = useSetDevClock();
  const [target, setTarget] = useState<string | null>(null);
  if (!clock) return null;
  const frozen = clock.mode === "frozen";
  const move = (at: Date, freeze = frozen) => {
    set.mutate({ at: at.toISOString(), frozen: freeze });
  };

  return (
    <Stack gap="md">
      <Paper withBorder p="sm">
        <Group justify="space-between" gap="xs">
          <Text size="sm" c="dimmed">
            {t("debug.time.now")}
          </Text>
          <Badge variant="light" color={clock.mode === "real" ? "gray" : "violet"}>
            {t(`debug.time.modes.${clock.mode}`)}
          </Badge>
        </Group>
        <Text fw={600}>{formatDateTime(now())}</Text>
        {clock.mode !== "real" && (
          <Text size="xs" c="dimmed">
            {t("debug.time.real", { time: formatDateTime(new Date(clock.real_now)) })}
          </Text>
        )}
      </Paper>

      <Text size="sm">{t("debug.time.affects")}</Text>

      <Group align="end" gap="xs" wrap="nowrap">
        <DateTimePicker
          label={t("debug.time.setTo")}
          placeholder={formatDateTime(now())}
          valueFormat="YYYY-MM-DD HH:mm"
          value={target}
          onChange={setTarget}
          style={{ flex: 1 }}
        />
        <Button
          disabled={target === null}
          loading={set.isPending}
          onClick={() => {
            if (target !== null) move(dayjs(target).toDate());
          }}
        >
          {t("debug.time.set")}
        </Button>
      </Group>

      <div>
        <Text size="sm" fw={500} mb={4}>
          {t("debug.time.jump")}
        </Text>
        <Group gap="xs">
          {(["hour", "day", "week", "month"] as const).map((unit) => (
            <Button
              key={unit}
              size="xs"
              variant="default"
              onClick={() => {
                move(dayjs(now()).add(1, unit).toDate());
              }}
            >
              {t(`debug.time.${unit}`)}
            </Button>
          ))}
          {active && (
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                move(new Date(active.end_at));
              }}
            >
              {t("debug.time.cycleEnd")}
            </Button>
          )}
        </Group>
      </div>

      <Switch
        label={t("debug.time.freeze")}
        description={t("debug.time.freezeHint")}
        checked={frozen}
        onChange={(e) => {
          move(now(), e.currentTarget.checked);
        }}
      />

      <Button
        variant="light"
        disabled={clock.mode === "real"}
        onClick={() => {
          set.mutate({ at: null, frozen: false });
        }}
      >
        {t("debug.time.reset")}
      </Button>
      {set.error && <ErrorAlert error={set.error} />}
    </Stack>
  );
}

type Dialog =
  | { kind: "restore"; snapshot: Snapshot }
  | { kind: "rename"; snapshot: Snapshot }
  | { kind: "delete"; snapshot: Snapshot };

function SnapshotsPanel() {
  const { t } = useTranslation();
  const snapshots = useSnapshots(true);
  const save = useSaveSnapshot();
  const importFile = useImportSnapshot();
  const [name, setName] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);

  return (
    <Stack gap="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() === "") return;
          save.mutate(name.trim(), {
            onSuccess: () => {
              setName("");
              notifications.show({ message: t("debug.snapshots.saved"), color: "green" });
            },
          });
        }}
      >
        <Group align="end" gap="xs" wrap="nowrap">
          <TextInput
            label={t("debug.snapshots.name")}
            placeholder={t("debug.snapshots.namePlaceholder")}
            value={name}
            maxLength={100}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
            style={{ flex: 1 }}
          />
          <Button type="submit" loading={save.isPending} disabled={name.trim() === ""}>
            {t("debug.snapshots.save")}
          </Button>
        </Group>
      </form>
      {save.error && <ErrorAlert error={save.error} />}

      <Group justify="space-between">
        <Text size="sm" fw={500}>
          {t("debug.tabs.snapshots")}
        </Text>
        <FileButton
          accept="application/json"
          onChange={(file) => {
            if (!file) return;
            importFile.mutate(file, {
              onSuccess: () => {
                notifications.show({ message: t("debug.snapshots.imported"), color: "green" });
              },
            });
          }}
        >
          {(props) => (
            <Button
              {...props}
              size="xs"
              variant="default"
              leftSection={<IconUpload size={14} />}
              loading={importFile.isPending}
            >
              {t("debug.snapshots.import")}
            </Button>
          )}
        </FileButton>
      </Group>
      {importFile.error && <ErrorAlert error={importFile.error} />}
      {snapshots.error && <ErrorAlert error={snapshots.error} />}

      {snapshots.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("debug.snapshots.empty")}
        </Text>
      )}
      {snapshots.data?.map((s) => (
        <Paper key={s.id} withBorder p="sm">
          <Group justify="space-between" gap="xs" wrap="nowrap" align="start">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text fw={600} size="sm" truncate>
                {s.name}
              </Text>
              <Text size="xs" c="dimmed">
                {t("debug.snapshots.takenAt", { time: formatDateTime(s.taken_at) })}
              </Text>
              <Group gap={4}>
                {!s.own && (
                  <Badge size="xs" variant="light">
                    {t("debug.snapshots.from", { user: s.username || s.user_id })}
                  </Badge>
                )}
                {!s.restorable && (
                  <Tooltip label={t("debug.snapshots.oldSchemaHint")} multiline w={220}>
                    <Badge size="xs" variant="light" color="orange">
                      {t("debug.snapshots.oldSchema")}
                    </Badge>
                  </Tooltip>
                )}
              </Group>
            </Stack>
            <Group gap={4} wrap="nowrap">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRestore size={14} />}
                disabled={!s.restorable}
                onClick={() => {
                  setDialog({ kind: "restore", snapshot: s });
                }}
              >
                {t("debug.snapshots.restore")}
              </Button>
              <Menu position="bottom-end">
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={t("debug.snapshots.more", { name: s.name })}
                  >
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<IconPencil size={16} />}
                    onClick={() => {
                      setDialog({ kind: "rename", snapshot: s });
                    }}
                  >
                    {t("debug.snapshots.rename")}
                  </Menu.Item>
                  <Menu.Item
                    component="a"
                    href={exportUrl(s.id)}
                    download
                    leftSection={<IconDownload size={16} />}
                  >
                    {t("debug.snapshots.export")}
                  </Menu.Item>
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={16} />}
                    onClick={() => {
                      setDialog({ kind: "delete", snapshot: s });
                    }}
                  >
                    {t("common.delete")}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
        </Paper>
      ))}

      <ResponsiveModal
        opened={dialog !== null}
        onClose={() => {
          setDialog(null);
        }}
        title={dialog && t(`debug.snapshots.${dialog.kind}Title`, { name: dialog.snapshot.name })}
      >
        {dialog?.kind === "restore" && (
          <RestoreForm
            key={dialog.snapshot.id}
            snapshot={dialog.snapshot}
            onDone={() => {
              setDialog(null);
            }}
          />
        )}
        {dialog?.kind === "rename" && (
          <RenameForm
            key={dialog.snapshot.id}
            snapshot={dialog.snapshot}
            onDone={() => {
              setDialog(null);
            }}
          />
        )}
        {dialog?.kind === "delete" && (
          <DeleteForm
            key={dialog.snapshot.id}
            snapshot={dialog.snapshot}
            onDone={() => {
              setDialog(null);
            }}
          />
        )}
      </ResponsiveModal>
    </Stack>
  );
}

function RestoreForm({ snapshot, onDone }: { snapshot: Snapshot; onDone: () => void }) {
  const { t } = useTranslation();
  const restore = useRestoreSnapshot();
  const [setClock, setSetClock] = useState(true);
  return (
    <Stack gap="md">
      <Text size="sm">{t("debug.snapshots.restoreText")}</Text>
      {!snapshot.own && (
        <Text size="sm">
          {t("debug.snapshots.cloneText", { user: snapshot.username || snapshot.user_id })}
        </Text>
      )}
      <Checkbox
        label={t("debug.snapshots.setClock", { time: formatDateTime(snapshot.taken_at) })}
        checked={setClock}
        onChange={(e) => {
          setSetClock(e.currentTarget.checked);
        }}
      />
      {restore.error && <ErrorAlert error={restore.error} />}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          loading={restore.isPending}
          onClick={() => {
            restore.mutate(
              { id: snapshot.id, setClock },
              {
                onSuccess: () => {
                  notifications.show({ message: t("debug.snapshots.restored"), color: "green" });
                  onDone();
                },
              },
            );
          }}
        >
          {t("debug.snapshots.restore")}
        </Button>
      </Group>
    </Stack>
  );
}

function RenameForm({ snapshot, onDone }: { snapshot: Snapshot; onDone: () => void }) {
  const { t } = useTranslation();
  const rename = useRenameSnapshot();
  const [name, setName] = useState(snapshot.name);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === "") return;
        rename.mutate({ id: snapshot.id, name: name.trim() }, { onSuccess: onDone });
      }}
    >
      <Stack gap="md">
        <TextInput
          label={t("debug.snapshots.name")}
          value={name}
          maxLength={100}
          {...autofocusField()}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        {rename.error && <ErrorAlert error={rename.error} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={name.trim() === ""}>
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function DeleteForm({ snapshot, onDone }: { snapshot: Snapshot; onDone: () => void }) {
  const { t } = useTranslation();
  const remove = useDeleteSnapshot();
  return (
    <Stack gap="md">
      <Text size="sm">{t("debug.snapshots.deleteText")}</Text>
      {remove.error && <ErrorAlert error={remove.error} />}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          loading={remove.isPending}
          onClick={() => {
            remove.mutate(snapshot.id, { onSuccess: onDone });
          }}
        >
          {t("common.delete")}
        </Button>
      </Group>
    </Stack>
  );
}
