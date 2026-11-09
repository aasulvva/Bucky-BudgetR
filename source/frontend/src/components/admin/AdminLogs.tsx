import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Code,
  Drawer,
  Group,
  Loader,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { useDebouncedCallback, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconClockHour4,
  IconInfoCircle,
  IconShield,
} from "@tabler/icons-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import {
  useAdminUsers,
  useLogPages,
  useLogSettings,
  useUpdateLogSettings,
  type LogEntry,
  type LogSettings,
} from "@/api/admin";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import i18n from "@/i18n";
import { formatDateTime } from "@/lib/dates";
import { isTouch } from "@/lib/device";
import {
  activeFilters,
  DEFAULT_LOG_FILTERS,
  eventKey,
  filtersFromSearch,
  filtersToSearch,
  LOG_PERIODS,
  LOG_SHOWS,
  logQuery,
  REFERENCE_PATTERN,
  type LogFilters,
} from "@/lib/logs";

/**
 * The Logs tab on Admin (#93): the warnings, errors, app events and admin
 * actions the app keeps, newest first, with filters in the URL. An error's
 * reference (`?request=`) shows everything for that request.
 */
export function AdminLogs() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawer] = useState(false);
  const [retention, setRetention] = useState(false);

  const search = params.toString();
  const filters = useMemo(() => filtersFromSearch(new URLSearchParams(search)), [search]);
  // The period ends when the filters change, not on every render.
  const query = useMemo(() => logQuery(filters, new Date()), [filters]);
  const pages = useLogPages(query);
  const change = (f: LogFilters) => {
    setParams(filtersToSearch(f), { replace: true });
  };

  const controls = <LogFilterControls value={filters} onChange={change} />;
  const count = activeFilters(filters);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text c="dimmed" size="sm">
          {t("admin.logs.intro")}
        </Text>
        <Button
          variant="default"
          leftSection={<IconClockHour4 size={16} />}
          style={{ flexShrink: 0 }}
          onClick={() => {
            setRetention(true);
          }}
        >
          {t("admin.logs.retention.open")}
        </Button>
      </Group>
      {isDesktop ? (
        <Paper withBorder p="md">
          {controls}
        </Paper>
      ) : (
        <Group justify="flex-end">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconAdjustmentsHorizontal size={16} />}
            onClick={() => {
              setDrawer(true);
            }}
          >
            {count > 0 ? `${t("admin.logs.filters")} (${String(count)})` : t("admin.logs.filters")}
          </Button>
        </Group>
      )}
      {pages.error ? (
        <ErrorAlert error={pages.error} onRetry={() => void pages.refetch()} />
      ) : (
        <LogList
          entries={pages.data?.pages.flatMap((p) => p.entries) ?? null}
          isDesktop={isDesktop}
          onReference={(request) => {
            change({ ...filters, request });
          }}
        />
      )}
      {pages.hasNextPage && (
        <Group justify="center">
          <Button
            variant="default"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {t("admin.logs.loadMore")}
          </Button>
        </Group>
      )}
      {!isDesktop && (
        <Drawer
          opened={drawer}
          onClose={() => {
            setDrawer(false);
          }}
          position="bottom"
          size="90%"
          title={t("admin.logs.filters")}
        >
          {controls}
        </Drawer>
      )}
      <ResponsiveModal
        opened={retention}
        onClose={() => {
          setRetention(false);
        }}
        title={t("admin.logs.retention.title")}
      >
        <Retention
          onDone={() => {
            setRetention(false);
          }}
        />
      </ResponsiveModal>
    </Stack>
  );
}

function LogFilterControls({
  value,
  onChange,
}: {
  value: LogFilters;
  onChange: (f: LogFilters) => void;
}) {
  const { t } = useTranslation();
  const users = useAdminUsers(true).data ?? [];
  // Inside a drawer, a portalled dropdown closes at once on touch screens.
  const comboboxProps = isTouch() ? { withinPortal: false } : undefined;
  const [q, setQ] = useState(value.q);
  const [reference, setReference] = useState(value.request ?? "");
  const [shown, setShown] = useState({ q: value.q, request: value.request });
  // Follow the URL when it changes elsewhere (a reference clicked, Clear).
  if (shown.q !== value.q || shown.request !== value.request) {
    setShown({ q: value.q, request: value.request });
    setQ(value.q);
    setReference(value.request ?? "");
  }
  const searchLater = useDebouncedCallback((text: string) => {
    onChange({ ...value, q: text });
  }, 400);
  const referenceValid = reference.trim() === "" || REFERENCE_PATTERN.test(reference.trim());

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <Select
          label={t("admin.logs.show")}
          data={LOG_SHOWS.map((s) => ({ value: s, label: t(`admin.logs.shows.${s}`) }))}
          value={value.show}
          allowDeselect={false}
          comboboxProps={comboboxProps}
          onChange={(v) => {
            const show = LOG_SHOWS.find((s) => s === v);
            if (show) onChange({ ...value, show });
          }}
        />
        <Select
          label={t("admin.logs.period")}
          data={LOG_PERIODS.map((p) => ({ value: p, label: t(`admin.logs.periods.${p}`) }))}
          value={value.period}
          allowDeselect={false}
          comboboxProps={comboboxProps}
          onChange={(v) => {
            const period = LOG_PERIODS.find((p) => p === v);
            if (period) onChange({ ...value, period });
          }}
        />
        <Select
          label={t("admin.logs.user")}
          placeholder={t("admin.logs.anyUser")}
          data={users.map((u) => ({ value: u.id, label: u.username }))}
          value={value.user}
          clearable
          searchable
          comboboxProps={comboboxProps}
          onChange={(user) => {
            onChange({ ...value, user });
          }}
        />
      </SimpleGrid>
      {value.period === "custom" && (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <DateTimeInput
            label={t("admin.logs.from")}
            placeholder=""
            maxDate={undefined}
            value={value.from}
            onChange={(from) => {
              onChange({ ...value, from });
            }}
          />
          <DateTimeInput
            label={t("admin.logs.to")}
            placeholder=""
            maxDate={undefined}
            value={value.to}
            onChange={(to) => {
              onChange({ ...value, to });
            }}
          />
        </SimpleGrid>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <TextInput
          label={t("admin.logs.reference")}
          placeholder={t("admin.logs.referencePlaceholder")}
          value={reference}
          maxLength={64}
          error={!referenceValid}
          onChange={(e) => {
            const text = e.currentTarget.value;
            setReference(text);
            const trimmed = text.trim();
            if (trimmed === "") onChange({ ...value, request: null });
            else if (REFERENCE_PATTERN.test(trimmed)) onChange({ ...value, request: trimmed });
          }}
        />
        <TextInput
          label={t("admin.logs.search")}
          placeholder={t("admin.logs.searchPlaceholder")}
          value={q}
          maxLength={200}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            searchLater(e.currentTarget.value);
          }}
        />
      </SimpleGrid>
      {activeFilters(value) > 0 && (
        <Group>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => {
              onChange(DEFAULT_LOG_FILTERS);
            }}
          >
            {t("admin.logs.clear")}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function LogList({
  entries,
  isDesktop,
  onReference,
}: {
  entries: LogEntry[] | null;
  isDesktop: boolean;
  onReference: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const toggle = (id: number) => {
    setOpen((o) => (o === id ? null : id));
  };
  if (entries === null) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }
  if (entries.length === 0) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        {t("admin.logs.empty")}
      </Text>
    );
  }
  if (!isDesktop) {
    return (
      <Card withBorder padding={0}>
        {entries.map((e) => (
          <Stack
            key={e.id}
            gap={4}
            p="sm"
            style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
          >
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <EntryBadge entry={e} />
              <Text size="xs" c="dimmed">
                {formatDateTime(e.at)}
              </Text>
            </Group>
            <Text size="sm" fw={500} style={{ wordBreak: "break-word" }}>
              {entryTitle(e)}
            </Text>
            <Group gap="xs" wrap="wrap">
              <Text size="xs" c="dimmed">
                {entryUser(e)}
              </Text>
              {e.request_id && <Reference id={e.request_id} onClick={onReference} />}
            </Group>
            <Group>
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={
                  open === e.id ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
                }
                onClick={() => {
                  toggle(e.id);
                }}
              >
                {open === e.id ? t("admin.logs.hideDetails") : t("admin.logs.showDetails")}
              </Button>
            </Group>
            {open === e.id && <EntryDetails entry={e} />}
          </Stack>
        ))}
      </Card>
    );
  }
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={720}>
        <Table verticalSpacing="xs" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36} />
              <Table.Th>{t("admin.logs.time")}</Table.Th>
              <Table.Th>{t("admin.logs.level")}</Table.Th>
              <Table.Th>{t("admin.logs.message")}</Table.Th>
              <Table.Th>{t("admin.logs.user")}</Table.Th>
              <Table.Th>{t("admin.logs.reference")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((e) => (
              <Fragment key={e.id}>
                <Table.Tr>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-expanded={open === e.id}
                      aria-label={
                        open === e.id ? t("admin.logs.hideDetails") : t("admin.logs.showDetails")
                      }
                      onClick={() => {
                        toggle(e.id);
                      }}
                    >
                      {open === e.id ? (
                        <IconChevronDown size={16} />
                      ) : (
                        <IconChevronRight size={16} />
                      )}
                    </ActionIcon>
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: "nowrap" }}>{formatDateTime(e.at)}</Table.Td>
                  <Table.Td>
                    <EntryBadge entry={e} />
                  </Table.Td>
                  <Table.Td style={{ wordBreak: "break-word" }}>{entryTitle(e)}</Table.Td>
                  <Table.Td>{entryUser(e)}</Table.Td>
                  <Table.Td>
                    {e.request_id && <Reference id={e.request_id} onClick={onReference} />}
                  </Table.Td>
                </Table.Tr>
                {open === e.id && (
                  <Table.Tr>
                    <Table.Td />
                    <Table.Td colSpan={5}>
                      <EntryDetails entry={e} />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

/** A level or kind badge, with an icon and a label so it isn't colour alone. */
function EntryBadge({ entry }: { entry: LogEntry }) {
  const { t } = useTranslation();
  let color: string, icon: ReactNode, label: string;
  if (entry.level === "error") {
    [color, icon, label] = ["red", <IconAlertTriangle size={12} />, t("admin.logs.levels.error")];
  } else if (entry.level === "warn") {
    [color, icon, label] = ["yellow", <IconAlertCircle size={12} />, t("admin.logs.levels.warn")];
  } else if (entry.kind === "audit") {
    [color, icon, label] = ["grape", <IconShield size={12} />, t("admin.logs.kinds.audit")];
  } else {
    [color, icon, label] = ["blue", <IconInfoCircle size={12} />, t("admin.logs.kinds.event")];
  }
  return (
    <Badge variant="light" color={color} leftSection={icon} style={{ flexShrink: 0 }}>
      {label}
    </Badge>
  );
}

/** A known event's label, and whom an admin action was for; else the message. */
function entryTitle(e: LogEntry): string {
  const key = eventKey(e.event);
  const title = key ? i18n.t(`admin.logs.events.${key}`) : e.message;
  const target = e.attrs["target.username"];
  return typeof target === "string" && target
    ? `${title} ${i18n.t("admin.logs.target", { name: target })}`
    : title;
}

function entryUser(e: LogEntry): string {
  if (e.username) return e.username;
  return e.user_id ? `#${e.user_id}` : i18n.t("admin.logs.system");
}

function Reference({ id, onClick }: { id: string; onClick: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <Anchor
      component="button"
      type="button"
      size="xs"
      ff="monospace"
      aria-label={t("admin.logs.showRequest", { id })}
      onClick={() => {
        onClick(id);
      }}
    >
      {id}
    </Anchor>
  );
}

function EntryDetails({ entry }: { entry: LogEntry }) {
  const { t } = useTranslation();
  const { stack, ...rest } = entry.attrs;
  const rows: [string, string][] = [
    ...(entry.event ? [[t("admin.logs.rawEvent"), entry.event] as [string, string]] : []),
    ...(eventKey(entry.event) || entry.event
      ? [[t("admin.logs.message"), entry.message] as [string, string]]
      : []),
    ...Object.entries(rest)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  ];
  return (
    <Stack gap="xs" data-testid="log-details">
      {rows.length === 0 && stack === undefined ? (
        <Text size="sm" c="dimmed">
          {t("admin.logs.noDetails")}
        </Text>
      ) : (
        <Table withRowBorders={false} verticalSpacing={2} fz="sm">
          <Table.Tbody>
            {rows.map(([k, v]) => (
              <Table.Tr key={k}>
                <Table.Td c="dimmed" w="30%" style={{ verticalAlign: "top" }}>
                  {k}
                </Table.Td>
                <Table.Td style={{ wordBreak: "break-word" }}>{v}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {typeof stack === "string" && (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t("admin.logs.stack")}
          </Text>
          <Code block style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre" }}>
            {stack}
          </Code>
        </Stack>
      )}
    </Stack>
  );
}

const RETENTION_FIELDS = [
  ["event_days", "events"],
  ["error_days", "errors"],
  ["audit_days", "audit"],
] as const;

function Retention({ onDone }: { onDone: () => void }) {
  const settings = useLogSettings();
  return (
    <QueryState query={settings}>{(s) => <RetentionForm initial={s} onDone={onDone} />}</QueryState>
  );
}

function RetentionForm({ initial, onDone }: { initial: LogSettings; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateLogSettings();
  const [values, setValues] = useState<Record<keyof LogSettings, number | string>>(initial);
  const valid = (v: number | string) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 3650;
  const allValid = RETENTION_FIELDS.every(([k]) => valid(values[k]));
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("admin.logs.retention.intro")}
      </Text>
      {RETENTION_FIELDS.map(([key, label]) => (
        <NumberInput
          key={key}
          label={t(`admin.logs.retention.${label}`)}
          rightSection={
            <Text size="sm" c="dimmed" pr="xs">
              {t("admin.logs.retention.days")}
            </Text>
          }
          rightSectionWidth={64}
          min={1}
          max={3650}
          allowDecimal={false}
          allowNegative={false}
          value={values[key]}
          error={valid(values[key]) ? undefined : t("admin.logs.retention.invalid")}
          onChange={(v) => {
            setValues((vs) => ({ ...vs, [key]: v }));
          }}
        />
      ))}
      {update.error && <ErrorAlert error={update.error} />}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!allValid}
          loading={update.isPending}
          onClick={() => {
            if (!allValid) return;
            update.mutate(
              {
                event_days: Number(values.event_days),
                error_days: Number(values.error_days),
                audit_days: Number(values.audit_days),
              },
              {
                onSuccess: () => {
                  notifications.show({ color: "green", message: t("admin.logs.retention.saved") });
                  onDone();
                },
              },
            );
          }}
        >
          {t("common.save")}
        </Button>
      </Group>
    </Stack>
  );
}
