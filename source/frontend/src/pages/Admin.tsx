import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Menu,
  Radio,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconDots,
  IconKey,
  IconLock,
  IconPlus,
  IconShield,
  IconShieldOff,
  IconUserCheck,
  IconUserOff,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import {
  USERNAME_PATTERN,
  useAdminUsers,
  useRefreshUsers,
  type AdminUser,
  type Credential,
  type NewCredential,
} from "@/api/admin";
import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import { useSession } from "@/app/session";
import { AdminBsuRules } from "@/components/admin/AdminBsuRules";
import { AdminLogs } from "@/components/admin/AdminLogs";
import { NewCredentialView } from "@/components/admin/NewCredential";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { formatDateTime } from "@/lib/dates";
import { autofocusField } from "@/lib/device";

type Dialog =
  | { kind: "create" }
  | { kind: "deactivate" | "reset"; user: AdminUser }
  | { kind: "credential"; username: string; credential: NewCredential }
  | null;

const LOGS_PATH = "/admin/logs";
const BSU_PATH = "/admin/bsu";

/**
 * Admin (spec §1, §9), in tabs: Users, Logs (#93, `/admin/logs`) and BSU
 * rules (#214, `/admin/bsu`).
 */
export default function Admin() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useSession().data;
  const tab =
    location.pathname === LOGS_PATH ? "logs" : location.pathname === BSU_PATH ? "bsu" : "users";

  if (me?.admin !== true) {
    return (
      <Stack gap="lg">
        <Title order={2}>{t("nav.items.admin")}</Title>
        <Alert color="orange" icon={<IconLock />} title={t("admin.adminsOnly")}>
          {t("admin.adminsOnlyDetail")}
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Title order={2}>{t("nav.items.admin")}</Title>
      <Tabs
        value={tab}
        onChange={(v) => {
          void navigate(v === "logs" ? LOGS_PATH : v === "bsu" ? BSU_PATH : "/admin");
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="users">{t("admin.tabs.users")}</Tabs.Tab>
          <Tabs.Tab value="logs">{t("admin.tabs.logs")}</Tabs.Tab>
          <Tabs.Tab value="bsu">{t("admin.tabs.bsu")}</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === "logs" ? <AdminLogs /> : tab === "bsu" ? <AdminBsuRules /> : <Users meId={me.id} />}
    </Stack>
  );
}

/**
 * The users: create them, activate and deactivate them, grant and revoke
 * admin, and reset passwords. Users are never deleted. Admins don't change
 * their own account here, and the last active admin stays one (the API
 * refuses both).
 */
function Users({ meId }: { meId: string }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const users = useAdminUsers(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => {
    setDialog(null);
  };

  const actions = {
    onDeactivate: (user: AdminUser) => {
      setDialog({ kind: "deactivate", user });
    },
    onReset: (user: AdminUser) => {
      setDialog({ kind: "reset", user });
    },
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text c="dimmed">{t("admin.intro")}</Text>
        <Button
          style={{ flexShrink: 0 }}
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            setDialog({ kind: "create" });
          }}
        >
          {t("admin.newUser")}
        </Button>
      </Group>
      <QueryState query={users}>
        {(list) =>
          isDesktop ? (
            <UserTable users={list} meId={meId} {...actions} />
          ) : (
            <Card withBorder padding={0}>
              {list.map((u) => (
                <UserRow key={u.id} user={u} isMe={u.id === meId} {...actions} />
              ))}
            </Card>
          )
        }
      </QueryState>
      <ResponsiveModal
        opened={dialog !== null}
        onClose={close}
        title={dialog && dialogTitle(dialog)}
      >
        {dialog?.kind === "create" && (
          <CreateUser
            onCancel={close}
            onCreated={(username, credential) => {
              setDialog({ kind: "credential", username, credential });
            }}
          />
        )}
        {dialog?.kind === "deactivate" && <Deactivate user={dialog.user} onDone={close} />}
        {dialog?.kind === "reset" && (
          <ResetPassword
            user={dialog.user}
            onCancel={close}
            onReset={(credential) => {
              setDialog({ kind: "credential", username: dialog.user.username, credential });
            }}
          />
        )}
        {dialog?.kind === "credential" && (
          <NewCredentialView
            username={dialog.username}
            credential={dialog.credential}
            onDone={close}
          />
        )}
      </ResponsiveModal>
    </Stack>
  );
}

function dialogTitle(dialog: NonNullable<Dialog>): string {
  switch (dialog.kind) {
    case "create":
      return i18n.t("admin.newUser");
    case "deactivate":
      return i18n.t("admin.deactivate.title", { name: dialog.user.username });
    case "reset":
      return i18n.t("admin.reset.title", { name: dialog.user.username });
    case "credential":
      return dialog.credential.link
        ? i18n.t("admin.link.title", { name: dialog.username })
        : i18n.t("admin.password.title");
  }
}

interface ActionsProps {
  onDeactivate: (user: AdminUser) => void;
  onReset: (user: AdminUser) => void;
}

function UserTable({
  users,
  meId,
  ...actions
}: ActionsProps & { users: AdminUser[]; meId: string }) {
  const { t } = useTranslation();
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("admin.username")}</Table.Th>
              <Table.Th>{t("admin.created")}</Table.Th>
              <Table.Th>{t("admin.lastSeen")}</Table.Th>
              <Table.Th w={56}>
                <span className="mantine-visually-hidden">{t("admin.actions")}</span>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>
                  <UserName user={u} isMe={u.id === meId} />
                </Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{formatDateTime(u.created_at)}</Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>
                  {u.last_seen_at ? formatDateTime(u.last_seen_at) : t("admin.never")}
                </Table.Td>
                <Table.Td>
                  <UserMenu user={u} isMe={u.id === meId} size={36} {...actions} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function UserRow({ user, isMe, ...actions }: ActionsProps & { user: AdminUser; isMe: boolean }) {
  const { t } = useTranslation();
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      justify="space-between"
      py="xs"
      pl="md"
      pr={4}
      mih={64}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Stack gap={2} style={{ minWidth: 0 }}>
        <UserName user={user} isMe={isMe} />
        <Text size="sm" c="dimmed">
          {t("admin.lastSeenAt", {
            when: user.last_seen_at ? formatDateTime(user.last_seen_at) : t("admin.never"),
          })}
        </Text>
      </Stack>
      <UserMenu user={user} isMe={isMe} size={44} {...actions} />
    </Group>
  );
}

/** The username, its ID greyed, and what's special about the user. */
function UserName({ user, isMe }: { user: AdminUser; isMe: boolean }) {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="wrap">
      <Text span fw={600} c={user.active ? undefined : "dimmed"}>
        {user.username}
      </Text>
      <Text span c="dimmed">
        (#{user.id})
      </Text>
      {isMe && (
        <Badge variant="light" color="gray">
          {t("admin.badges.you")}
        </Badge>
      )}
      {user.admin && <Badge variant="light">{t("admin.badges.admin")}</Badge>}
      {!user.active && (
        <Badge variant="light" color="red">
          {t("admin.badges.inactive")}
        </Badge>
      )}
      {user.active && user.must_change_password && (
        <Badge variant="light" color="orange">
          {t("admin.badges.mustChange")}
        </Badge>
      )}
    </Group>
  );
}

/**
 * A user's actions. Making and removing admin, and activating, happen at
 * once; deactivating and resetting the password ask first.
 */
function UserMenu({
  user,
  isMe,
  size,
  onDeactivate,
  onReset,
}: ActionsProps & { user: AdminUser; isMe: boolean; size: number }) {
  const { t } = useTranslation();
  const refresh = useRefreshUsers();
  const update = useMutation({
    mutationFn: (body: { active?: boolean; admin?: boolean }) =>
      unwrap(
        api.PATCH("/api/v1/admin/users/{userId}", {
          params: { path: { userId: user.id } },
          body,
        }),
      ),
    onSuccess: async (updated, body) => {
      notifications.show({
        color: "green",
        message:
          body.admin === true
            ? t("admin.madeAdmin", { name: updated.username })
            : body.admin === false
              ? t("admin.removedAdmin", { name: updated.username })
              : t("admin.activated", { name: updated.username }),
      });
      await refresh();
    },
  });

  return (
    <Menu position="bottom-end" width={260}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={size}
          loading={update.isPending}
          aria-label={t("admin.actionsFor", { name: user.username })}
        >
          <IconDots size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {isMe && <Menu.Label style={{ whiteSpace: "normal" }}>{t("admin.ownAccount")}</Menu.Label>}
        {user.admin ? (
          <Menu.Item
            leftSection={<IconShieldOff size={18} />}
            disabled={isMe}
            onClick={() => {
              update.mutate({ admin: false });
            }}
          >
            {t("admin.removeAdmin")}
          </Menu.Item>
        ) : (
          <Menu.Item
            leftSection={<IconShield size={18} />}
            disabled={isMe}
            onClick={() => {
              update.mutate({ admin: true });
            }}
          >
            {t("admin.makeAdmin")}
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<IconKey size={18} />}
          disabled={isMe}
          onClick={() => {
            onReset(user);
          }}
        >
          {t("admin.resetPassword")}
        </Menu.Item>
        {user.active ? (
          <Menu.Item
            leftSection={<IconUserOff size={18} />}
            color="red"
            disabled={isMe}
            onClick={() => {
              onDeactivate(user);
            }}
          >
            {t("admin.deactivateUser")}
          </Menu.Item>
        ) : (
          <Menu.Item
            leftSection={<IconUserCheck size={18} />}
            onClick={() => {
              update.mutate({ active: true });
            }}
          >
            {t("admin.activate")}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** A problem that belongs on the username field, or undefined. */
function usernameProblem(error: unknown): string | undefined {
  if (error instanceof ApiError && error.code === "username_taken") {
    return i18n.t("errors.codes.username_taken");
  }
  return undefined;
}

function checkUsername(username: string): string | undefined {
  return USERNAME_PATTERN.test(username) ? undefined : i18n.t("admin.usernameRule");
}

/** How the user gets in: a link where they choose a password, or a temporary one. */
function CredentialChoice({
  value,
  onChange,
}: {
  value: Credential;
  onChange: (value: Credential) => void;
}) {
  const { t } = useTranslation();
  return (
    <Radio.Group
      label={t("admin.credential.label")}
      value={value}
      onChange={(v) => {
        onChange(v === "password" ? "password" : "link");
      }}
    >
      <Stack gap="xs" mt="xs">
        <Radio
          value="link"
          label={t("admin.credential.link")}
          description={t("admin.credential.linkHint")}
        />
        <Radio
          value="password"
          label={t("admin.credential.password")}
          description={t("admin.credential.passwordHint")}
        />
      </Stack>
    </Radio.Group>
  );
}

function CreateUser({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (username: string, credential: NewCredential) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshUsers();
  const [username, setUsername] = useState("");
  const [admin, setAdmin] = useState(false);
  const [credential, setCredential] = useState<Credential>("link");
  const [error, setError] = useState<string | undefined>();

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/admin/users", {
          body: { username: username.trim(), admin, credential },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async ({ user, ...given }) => {
      onCreated(user.username, given);
      await refresh();
    },
    onError: (err) => {
      setError(usernameProblem(err));
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const found = checkUsername(username.trim());
        setError(found);
        if (!found) create.mutate();
      }}
    >
      <Stack gap="md">
        <TextInput
          label={t("admin.username")}
          description={t("admin.usernameRule")}
          value={username}
          maxLength={32}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => {
            setUsername(e.currentTarget.value);
          }}
          error={error}
          required
          {...autofocusField()}
        />
        <Checkbox
          label={t("admin.makeAdminToo")}
          description={t("admin.makeAdminHint")}
          checked={admin}
          onChange={(e) => {
            setAdmin(e.currentTarget.checked);
          }}
        />
        <CredentialChoice value={credential} onChange={setCredential} />
        {create.error && !usernameProblem(create.error) && <ErrorAlert error={create.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("admin.create")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function Deactivate({ user, onDone }: { user: AdminUser; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshUsers();
  const deactivate = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/api/v1/admin/users/{userId}", {
          params: { path: { userId: user.id } },
          body: { active: false },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("admin.deactivate.done", { name: user.username }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="admin.deactivate.question"
          values={{ name: user.username }}
          components={{ b: <strong /> }}
        />
      </Text>
      {deactivate.error && <ErrorAlert error={deactivate.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          loading={deactivate.isPending}
          onClick={() => {
            deactivate.mutate();
          }}
        >
          {t("admin.deactivateUser")}
        </Button>
      </Group>
    </Stack>
  );
}

function ResetPassword({
  user,
  onCancel,
  onReset,
}: {
  user: AdminUser;
  onCancel: () => void;
  onReset: (credential: NewCredential) => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshUsers();
  const [credential, setCredential] = useState<Credential>("link");
  const reset = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/admin/users/{userId}/reset-password", {
          params: { path: { userId: user.id } },
          body: { credential },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (result) => {
      onReset(result);
      await refresh();
    },
  });

  return (
    <Stack gap="md">
      <Text>
        <Trans
          i18nKey="admin.reset.question"
          values={{ name: user.username }}
          components={{ b: <strong /> }}
        />
      </Text>
      <CredentialChoice value={credential} onChange={setCredential} />
      {reset.error && <ErrorAlert error={reset.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={reset.isPending}
          onClick={() => {
            reset.mutate();
          }}
        >
          {t("admin.resetPassword")}
        </Button>
      </Group>
    </Stack>
  );
}
