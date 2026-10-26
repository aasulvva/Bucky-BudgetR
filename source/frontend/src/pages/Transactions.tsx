import {
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDebouncedCallback, useMediaQuery } from "@mantine/hooks";
import { IconAdjustmentsHorizontal, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import { useAccounts, useBuckets } from "@/api/accounts";
import { useCurrentCycles, useCycles, type Cycle } from "@/api/cycles";
import { useTags, useTransactionPages } from "@/api/transactions";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { TransactionDetail } from "@/components/transactions/TransactionDetail";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import { useLookups, type Lookups } from "@/components/transactions/lookups";
import { cycleRange, formatDateRange } from "@/lib/cycles";
import { formatDay } from "@/lib/dates";
import {
  ALL_CYCLES,
  SYSTEM_TYPES,
  USER_TYPES,
  groupByDay,
  isFiltered,
  listQuery,
  readFilter,
  shownCycle,
  withFilter,
  type TransactionFilter,
} from "@/lib/transactionList";

type FilterChange = (change: Partial<TransactionFilter>) => void;

/**
 * Transactions (spec §9, canvas "Transactions"): the list, newest first and
 * grouped by day, with filters in the URL, and a transaction's detail beside
 * it (full screen on mobile) to edit or reverse it.
 */
export default function Transactions() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params);
  const current = useCurrentCycles();
  const active = current.data?.active ?? null;
  // The default cycle is the active one, so wait until it's known.
  const pages = useTransactionPages(listQuery(filter, active), !current.isPending);
  const names = useLookups();
  const open = params.get("open");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const change: FilterChange = (c) => {
    setParams((prev) => withFilter(prev, c), { replace: true });
  };
  const openLink = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("open", id);
    return `?${next.toString()}`;
  };
  const close = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    });
  };

  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const list = (
    // The flex sizes are for the desktop row; in the mobile column they'd set heights.
    <Card
      withBorder
      padding={0}
      style={isDesktop ? { flex: "999 1 460px", minWidth: 0 } : undefined}
    >
      {pages.isPending ? (
        <Center py="xl">
          <Loader size="sm" />
        </Center>
      ) : pages.isError ? (
        <Box p="md">
          <ErrorAlert
            error={pages.error}
            onRetry={() => {
              void pages.refetch();
            }}
          />
        </Box>
      ) : items.length === 0 ? (
        <Empty filter={filter} active={active} onChange={change} />
      ) : (
        <>
          {groupByDay(items).map((g) => (
            <Box key={g.day} component="section" aria-label={formatDay(g.day)}>
              <Text
                component="h2"
                m={0}
                px="md"
                py={8}
                size="sm"
                fw={600}
                c="dimmed"
                bg="var(--mantine-color-default-hover)"
              >
                {formatDay(g.day)}
              </Text>
              {g.items.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  names={names}
                  filter={filter}
                  to={openLink(tx.id)}
                  selected={tx.id === open}
                  badge={isDesktop}
                />
              ))}
            </Box>
          ))}
          {pages.hasNextPage && (
            <Group justify="center" p="sm">
              <Button
                variant="default"
                loading={pages.isFetchingNextPage}
                onClick={() => {
                  void pages.fetchNextPage();
                }}
              >
                {t("transactions.loadMore")}
              </Button>
            </Group>
          )}
        </>
      )}
    </Card>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="md">
        <Title order={2}>{t("nav.items.transactions")}</Title>
        {isDesktop && (
          <Button component={Link} to="/transactions/new" leftSection={<IconPlus size={16} />}>
            {t("transactions.new")}
          </Button>
        )}
      </Group>

      {isDesktop ? (
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Search filter={filter} onChange={change} style={{ flex: "1 1 200px" }} />
          <FilterFields filter={filter} active={active} onChange={change} inline />
        </Group>
      ) : (
        <Stack gap="xs">
          <Search filter={filter} onChange={change} />
          <Chips
            filter={filter}
            active={active}
            names={names}
            onChange={change}
            onMore={() => {
              setFiltersOpen(true);
            }}
          />
          <ResponsiveModal
            opened={filtersOpen}
            onClose={() => {
              setFiltersOpen(false);
            }}
            title={t("transactions.filters.title")}
          >
            <Stack gap="md">
              <FilterFields filter={filter} active={active} onChange={change} />
              <Button
                onClick={() => {
                  setFiltersOpen(false);
                }}
              >
                {t("transactions.filters.done")}
              </Button>
            </Stack>
          </ResponsiveModal>
        </Stack>
      )}

      {isDesktop ? (
        <Group align="flex-start" gap="lg" wrap="wrap">
          {list}
          {open && (
            <Card
              withBorder
              padding="lg"
              component="aside"
              style={{ flex: "1 1 300px", maxWidth: 380, position: "sticky", top: 16 }}
            >
              <TransactionDetail key={open} id={open} onClose={close} openLink={openLink} />
            </Card>
          )}
        </Group>
      ) : (
        <>
          {list}
          <ResponsiveModal opened={open !== null} onClose={close} title={t("transactions.detail")}>
            {open && <TransactionDetail key={open} id={open} openLink={openLink} />}
          </ResponsiveModal>
        </>
      )}
    </Stack>
  );
}

/** The counterparty search, debounced into the URL. */
function Search({
  filter,
  onChange,
  style,
}: {
  filter: TransactionFilter;
  onChange: FilterChange;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(filter.q);
  // Follow the URL when it changes from outside, e.g. Back.
  const [prev, setPrev] = useState(filter.q);
  if (filter.q !== prev) {
    setPrev(filter.q);
    if (filter.q !== text.trim()) setText(filter.q);
  }
  const apply = useDebouncedCallback((q: string) => {
    onChange({ q: q.trim() });
  }, 300);
  return (
    <TextInput
      aria-label={t("transactions.search")}
      placeholder={t("transactions.searchPlaceholder")}
      leftSection={<IconSearch size={16} />}
      value={text}
      maxLength={200}
      onChange={(e) => {
        setText(e.currentTarget.value);
        apply(e.currentTarget.value);
      }}
      style={style}
    />
  );
}

/** The cycles to filter by, newest first, with All. */
function cycleOptions(
  cycles: Cycle[],
  active: Cycle | null,
  allLabel: string,
  activeLabel: (range: string) => string,
) {
  return [
    { value: ALL_CYCLES, label: allLabel },
    ...[...cycles]
      .filter((c) => c.state !== "future")
      .reverse()
      .map((c) => ({
        value: c.id,
        label: c.id === active?.id ? activeLabel(cycleRange(c)) : cycleRange(c),
      })),
  ];
}

function FilterFields({
  filter,
  active,
  onChange,
  inline,
}: {
  filter: TransactionFilter;
  active: Cycle | null;
  onChange: FilterChange;
  /** In a row on desktop, rather than stacked. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const cycles = useCycles().data ?? [];
  const tags = useTags().data ?? [];
  const width = inline ? 170 : undefined;
  const types = filter.system ? [...USER_TYPES, ...SYSTEM_TYPES] : USER_TYPES;
  const shown = shownCycle(filter, active);
  const [range, setRange] = useState<[string | null, string | null]>([filter.from, filter.to]);
  const [prevRange, setPrevRange] = useState(`${filter.from ?? ""}/${filter.to ?? ""}`);
  if (`${filter.from ?? ""}/${filter.to ?? ""}` !== prevRange) {
    setPrevRange(`${filter.from ?? ""}/${filter.to ?? ""}`);
    setRange([filter.from, filter.to]);
  }

  return (
    <>
      <Select
        label={t("transactions.filters.account")}
        placeholder={t("transactions.filters.all")}
        data={accounts.map((a) => ({ value: a.id, label: a.name }))}
        value={filter.accountId}
        onChange={(v) => {
          onChange({ accountId: v });
        }}
        clearable
        w={width}
      />
      <Select
        label={t("transactions.filters.bucket")}
        placeholder={t("transactions.filters.all")}
        data={buckets.map((b) => ({ value: b.id, label: b.name }))}
        value={filter.bucketId}
        onChange={(v) => {
          onChange({ bucketId: v });
        }}
        clearable
        searchable
        w={width}
      />
      <Select
        label={t("transactions.filters.cycle")}
        data={cycleOptions(cycles, active, t("transactions.filters.allCycles"), (r) =>
          t("transactions.filters.activeCycle", { range: r }),
        )}
        value={shown ?? ALL_CYCLES}
        allowDeselect={false}
        onChange={(v) => {
          // The active cycle is the default, so it needs no parameter.
          onChange({ cycleId: v === null || v === active?.id ? null : v });
        }}
        w={inline ? 220 : undefined}
      />
      <Select
        label={t("transactions.filters.type")}
        placeholder={t("transactions.filters.all")}
        data={types.map((x) => ({ value: x, label: t(`transactionTypes.${x}`) }))}
        value={filter.type}
        onChange={(v) => {
          onChange({ type: types.find((x) => x === v) ?? null });
        }}
        clearable
        w={width}
      />
      <Select
        label={t("transactions.filters.tag")}
        placeholder={t("transactions.filters.any")}
        data={tags.map((x) => x.name)}
        value={filter.tag}
        onChange={(v) => {
          onChange({ tag: v });
        }}
        clearable
        searchable
        w={width}
      />
      <DatePickerInput
        type="range"
        label={t("transactions.filters.dates")}
        placeholder={t("transactions.filters.any")}
        valueFormat="D MMM YYYY"
        value={range}
        onChange={(v) => {
          setRange(v);
          // A range applies once both ends are picked, or when cleared.
          if ((v[0] && v[1]) || (!v[0] && !v[1])) onChange({ from: v[0], to: v[1] });
        }}
        clearable
        w={inline ? 240 : undefined}
      />
      <Checkbox
        label={t("transactions.filters.system")}
        checked={filter.system}
        onChange={(e) => {
          const system = e.currentTarget.checked;
          onChange({
            system,
            ...(!system && filter.type && SYSTEM_TYPES.includes(filter.type) ? { type: null } : {}),
          });
        }}
        style={inline ? { alignSelf: "center", paddingTop: 22 } : undefined}
      />
    </>
  );
}

/** Mobile: the active filters as chips, and a button for the rest. */
function Chips({
  filter,
  active,
  names,
  onChange,
  onMore,
}: {
  filter: TransactionFilter;
  active: Cycle | null;
  names: Lookups;
  onChange: FilterChange;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const cycles = useCycles().data ?? [];
  const shown = shownCycle(filter, active);
  const cycle = cycles.find((c) => c.id === shown) ?? (active?.id === shown ? active : null);
  const chips: { key: string; label: string; clear: Partial<TransactionFilter> }[] = [];
  if (shown) {
    chips.push({
      key: "cycle",
      label: cycle ? cycleRange(cycle) : t("transactions.filters.cycle"),
      clear: { cycleId: ALL_CYCLES },
    });
  }
  if (filter.accountId) {
    chips.push({
      key: "account",
      label: names.accountName(filter.accountId),
      clear: { accountId: null },
    });
  }
  if (filter.bucketId) {
    chips.push({
      key: "bucket",
      label: names.bucketName(filter.bucketId),
      clear: { bucketId: null },
    });
  }
  if (filter.type) {
    chips.push({ key: "type", label: t(`transactionTypes.${filter.type}`), clear: { type: null } });
  }
  if (filter.tag) chips.push({ key: "tag", label: filter.tag, clear: { tag: null } });
  if (filter.from && filter.to) {
    chips.push({
      key: "dates",
      label: formatDateRange(filter.from, filter.to),
      clear: { from: null, to: null },
    });
  }
  if (filter.system) {
    chips.push({
      key: "system",
      label: t("transactions.filters.system"),
      clear: { system: false },
    });
  }
  return (
    <Group gap={8} wrap="nowrap" style={{ overflowX: "auto" }}>
      {chips.map((c) => (
        <Button
          key={c.key}
          size="compact-sm"
          radius="xl"
          variant="light"
          rightSection={<IconX size={12} />}
          aria-label={t("transactions.filters.remove", { name: c.label })}
          onClick={() => {
            onChange(c.clear);
          }}
          style={{ flex: "none" }}
        >
          {c.label}
        </Button>
      ))}
      <Button
        size="compact-sm"
        radius="xl"
        variant="default"
        leftSection={<IconAdjustmentsHorizontal size={14} />}
        onClick={onMore}
        style={{ flex: "none" }}
      >
        {t("transactions.filters.more")}
      </Button>
    </Group>
  );
}

/** Nothing to show: offer to widen the filters. */
function Empty({
  filter,
  active,
  onChange,
}: {
  filter: TransactionFilter;
  active: Cycle | null;
  onChange: FilterChange;
}) {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  const filtered = isFiltered(filter);
  const inCycle = !filtered && shownCycle(filter, active) !== null;
  return (
    <Stack p="lg" gap="sm" align="flex-start">
      <Text c="dimmed">{t(inCycle ? "transactions.emptyCycle" : "transactions.empty")}</Text>
      {filtered && (
        <Button
          variant="default"
          size="xs"
          onClick={() => {
            setParams(new URLSearchParams(), { replace: true });
          }}
        >
          {t("transactions.filters.clear")}
        </Button>
      )}
      {inCycle && (
        <Button
          variant="default"
          size="xs"
          onClick={() => {
            onChange({ cycleId: ALL_CYCLES });
          }}
        >
          {t("transactions.showAllCycles")}
        </Button>
      )}
    </Stack>
  );
}
