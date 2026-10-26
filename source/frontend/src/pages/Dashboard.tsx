import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  accountTypeLabel,
  useAccounts,
  useBucketFigures,
  useBuckets,
  type Account,
  type Bucket,
  type BucketFigures,
} from "@/api/accounts";
import { useCycles, useCurrentCycles, type Cycle } from "@/api/cycles";
import { useTransactionPages } from "@/api/transactions";
import { useSession, useUpdatePreferences } from "@/app/session";
import { BucketName, LeftFunds, UsedThisCycle } from "@/components/buckets/BucketParts";
import { StartCycleDialog } from "@/components/cycles/StartCycleDialog";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { useLookups } from "@/components/transactions/lookups";
import { TransactionRow } from "@/components/transactions/TransactionRow";
import { TONE_COLOR, accountSummary, coverage, toneText, usageColor } from "@/lib/buckets";
import { cycleRange, daysLeftLabel, isOverdue, lastDay } from "@/lib/cycles";
import {
  ACCOUNTS_MODES,
  BUCKET_STATUS_MODES,
  TRANSACTION_COUNTS,
  accountHealth,
  dashboardSettings,
  mostUsed,
  needsAttention,
  shownAccounts,
  shownBucketStatus,
  toPreferences,
  usedPct,
  type AccountsMode,
  type BucketStatusMode,
  type DashboardSettings,
} from "@/lib/dashboard";
import { formatDate } from "@/lib/dates";
import { addAmounts, compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import { USER_TYPES } from "@/lib/transactionList";

/** Neither the Transactions list's account nor its bucket: amounts as they are. */
const NO_FOCUS = { accountId: null, bucketId: null };

/**
 * Dashboard (spec §9): the active cycle, the budget's health per account,
 * the buckets, the account balances and the latest transactions. The
 * widgets are fixed for now (#37 makes them customisable); their settings
 * are kept in the user's preferences.
 */
export default function Dashboard() {
  const { t } = useTranslation();
  const preferences = useSession().data?.preferences ?? {};
  const settings = dashboardSettings(preferences);
  const active = useCurrentCycles().data?.active ?? null;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Title order={2}>{t("nav.items.dashboard")}</Title>
        <Button component={Link} to="/transactions/new" leftSection={<IconPlus size={16} />}>
          {t("transactions.new")}
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <CycleWidget settings={settings} />
        <HealthWidget />
        <BucketStatusWidget settings={settings} active={active} />
        <AccountsWidget settings={settings} />
      </SimpleGrid>
      <RecentWidget settings={settings} />
    </Stack>
  );
}

/** A widget's card: its title, a link to its screen, and its settings button. */
function Widget({
  title,
  link,
  action,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card withBorder component="section" aria-label={title}>
      <Stack gap="sm">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Title order={3} size="h5">
            {title}
          </Title>
          <Group gap="xs" wrap="nowrap">
            {link && (
              <Anchor component={Link} to={link.to} size="sm">
                {link.label}
              </Anchor>
            )}
            {action}
          </Group>
        </Group>
        {children}
      </Stack>
    </Card>
  );
}

/** Saves the Dashboard's settings, replacing what's saved (the API merges shallowly). */
function SettingsDialog({
  title,
  opened,
  onClose,
  canSave,
  next,
  children,
}: {
  title: string;
  opened: boolean;
  onClose: () => void;
  canSave: boolean;
  next: DashboardSettings;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  return (
    <ResponsiveModal
      opened={opened}
      onClose={() => {
        update.reset();
        onClose();
      }}
      title={t("dashboard.settingsTitle", { widget: title })}
    >
      <Stack gap="md">
        {children}
        {update.error && <ErrorAlert error={update.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={update.isPending}
            disabled={!canSave}
            onClick={() => {
              update.mutate({ dashboard: toPreferences(next) }, { onSuccess: onClose });
            }}
          >
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </ResponsiveModal>
  );
}

function SettingsButton({ widget, onClick }: { widget: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      aria-label={t("dashboard.settingsFor", { widget })}
      title={t("dashboard.settings")}
      onClick={onClick}
    >
      <IconSettings size={18} />
    </ActionIcon>
  );
}

function CycleWidget({ settings }: { settings: DashboardSettings }) {
  const { t } = useTranslation();
  const current = useCurrentCycles();
  const cycles = useCycles();
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showNext, setShowNext] = useState(settings.cycle.showNext);
  const title = t("dashboard.cycle.title");
  return (
    <Widget
      title={title}
      link={{ to: "/cycles", label: t("dashboard.cycle.manage") }}
      action={
        <SettingsButton
          widget={title}
          onClick={() => {
            setShowNext(settings.cycle.showNext);
            setEditing(true);
          }}
        />
      }
    >
      <QueryState query={current}>
        {({ active, next }) => {
          const planned = settings.cycle.showNext && next && (
            <Text size="sm" c="dimmed">
              {t("dashboard.cycle.next", { range: cycleRange(next) })}
            </Text>
          );
          return active ? (
            <Stack gap={4}>
              <ActiveCycle active={active} />
              {planned}
            </Stack>
          ) : (
            <>
              <Stack gap={4}>
                <Text fw={600}>{t("cycles.noActive")}</Text>
                <Text size="sm" c="dimmed">
                  {t("cycles.needed")}
                </Text>
                {planned}
              </Stack>
              <Button
                variant="light"
                style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  setStarting(true);
                }}
              >
                {t("cycles.start")}
              </Button>
              <StartCycleDialog
                opened={starting}
                onClose={() => {
                  setStarting(false);
                }}
                next={next}
                cycles={cycles.data ?? []}
              />
            </>
          );
        }}
      </QueryState>
      <SettingsDialog
        title={title}
        opened={editing}
        onClose={() => {
          setEditing(false);
        }}
        canSave
        next={{ ...settings, cycle: { showNext } }}
      >
        <Checkbox
          label={t("dashboard.cycle.showNext")}
          checked={showNext}
          onChange={(e) => {
            setShowNext(e.currentTarget.checked);
          }}
        />
      </SettingsDialog>
    </Widget>
  );
}

function ActiveCycle({ active }: { active: Cycle }) {
  const { t } = useTranslation();
  const overdue = isOverdue(active);
  return (
    <>
      <Text fz={20} fw={700}>
        {cycleRange(active)}
      </Text>
      <Text size="sm" c={overdue ? "orange.8" : "dimmed"}>
        {overdue
          ? t("cycles.overdueSince", { date: formatDate(lastDay(active)) })
          : daysLeftLabel(active)}
      </Text>
    </>
  );
}

/** Loads the accounts and buckets for a widget. */
function MoneyState({
  children,
}: {
  children: (accounts: Account[], buckets: Bucket[]) => ReactNode;
}) {
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={accounts}>
      {(accountList) => (
        <QueryState query={buckets}>{(bucketList) => children(accountList, bucketList)}</QueryState>
      )}
    </QueryState>
  );
}

/** Points to Bucket setup (or Account setup) while there are no buckets. */
function NoBuckets({ accounts }: { accounts: Account[] }) {
  return (
    <Text size="sm" c="dimmed">
      <Trans
        i18nKey={accounts.length === 0 ? "accounts.empty" : "buckets.noBuckets"}
        components={{
          setup: (
            <Anchor
              component={Link}
              to={accounts.length === 0 ? "/accounts/setup" : "/buckets/setup"}
            />
          ),
        }}
      />
    </Text>
  );
}

function HealthWidget() {
  const { t } = useTranslation();
  return (
    <Widget
      title={t("dashboard.health.title")}
      link={{ to: "/buckets", label: t("nav.items.buckets") }}
    >
      <MoneyState>
        {(accounts, buckets) => {
          const sources = accounts.filter((a) => buckets.some((b) => b.source_account_id === a.id));
          if (sources.length === 0) return <NoBuckets accounts={accounts} />;
          return (
            <Stack gap="md">
              {sources.map((a) => (
                <AccountHealthRow key={a.id} account={a} buckets={buckets} />
              ))}
            </Stack>
          );
        }}
      </MoneyState>
    </Widget>
  );
}

function AccountHealthRow({ account, buckets }: { account: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const health = accountHealth(account, buckets);
  const money = (amount: string) => formatMoney(amount, account.currency);
  const isShort = compareAmounts(health.short, "0") > 0;
  const problems = [
    health.uncovered > 0 && t("dashboard.health.uncovered", { count: health.uncovered }),
    health.overspent > 0 && t("dashboard.health.overspent", { count: health.overspent }),
  ].filter(Boolean);
  return (
    <Stack gap={4} component="article" aria-label={account.name}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text fw={600}>{account.name}</Text>
        <Text size="sm" c={isShort ? toneText(health.tone) : "dimmed"}>
          {isShort
            ? t("dashboard.health.short", { amount: money(health.short) })
            : t("dashboard.health.unallocated", { amount: money(health.unallocated) })}
        </Text>
      </Group>
      <Progress
        value={health.pct}
        color={TONE_COLOR[health.tone]}
        aria-label={t("buckets.coveredOf", {
          covered: money(health.covered),
          target: money(health.needed),
        })}
      />
      <Text size="xs" c="dimmed">
        {t("dashboard.health.covered", {
          pct: health.pct,
          covered: money(health.covered),
          needed: money(health.needed),
        })}
        {problems.length > 0 && ` · ${problems.join(" · ")}`}
      </Text>
    </Stack>
  );
}

function BucketStatusWidget({
  settings,
  active,
}: {
  settings: DashboardSettings;
  active: Cycle | null;
}) {
  const { t } = useTranslation();
  const figures = useBucketFigures(active?.id);
  const [editing, setEditing] = useState(false);
  const title = t("dashboard.bucketStatus.title");
  const byId = new Map(figures.data?.map((f) => [f.bucket_id, f]));
  return (
    <Widget
      title={title}
      link={{ to: "/buckets", label: t("nav.items.buckets") }}
      action={
        <SettingsButton
          widget={title}
          onClick={() => {
            setEditing(true);
          }}
        />
      }
    >
      <MoneyState>
        {(accounts, buckets) => {
          if (buckets.length === 0) return <NoBuckets accounts={accounts} />;
          const shown = shownBucketStatus(settings, buckets);
          return (
            <>
              <Text size="xs" c="dimmed">
                {t(`dashboard.bucketStatus.modes.${shown.mode}`)}
              </Text>
              {shown.mode === "attention" && <Attention buckets={buckets} figures={byId} />}
              {shown.mode === "all" && (
                <AllBuckets accounts={accounts} buckets={buckets} figures={byId} />
              )}
              {shown.mode === "most_used" && (
                <MostUsed buckets={buckets} figures={byId} active={active} />
              )}
              {shown.mode === "bucket" && (
                <OneBucket
                  bucket={shown.bucket}
                  figures={byId.get(shown.bucket.id)}
                  active={active}
                />
              )}
              <BucketStatusSettings
                key={String(editing)}
                opened={editing}
                onClose={() => {
                  setEditing(false);
                }}
                title={title}
                settings={settings}
                accounts={accounts}
                buckets={buckets}
              />
            </>
          );
        }}
      </MoneyState>
    </Widget>
  );
}

function BucketStatusSettings({
  opened,
  onClose,
  title,
  settings,
  accounts,
  buckets,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  settings: DashboardSettings;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<BucketStatusMode>(settings.bucketStatus.mode);
  const [bucketId, setBucketId] = useState<string | null>(
    buckets.some((b) => b.id === settings.bucketStatus.bucketId)
      ? settings.bucketStatus.bucketId
      : null,
  );
  const groups = accounts
    .map((a) => ({
      group: a.name,
      items: buckets
        .filter((b) => b.source_account_id === a.id)
        .map((b) => ({ value: b.id, label: b.name })),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <SettingsDialog
      title={title}
      opened={opened}
      onClose={onClose}
      canSave={mode !== "bucket" || bucketId !== null}
      next={{ ...settings, bucketStatus: { mode, bucketId: mode === "bucket" ? bucketId : null } }}
    >
      <Select
        label={t("dashboard.bucketStatus.show")}
        data={BUCKET_STATUS_MODES.map((m) => ({
          value: m,
          label: t(`dashboard.bucketStatus.modes.${m}`),
        }))}
        value={mode}
        allowDeselect={false}
        onChange={(v) => {
          const next = BUCKET_STATUS_MODES.find((m) => m === v);
          if (next) setMode(next);
        }}
      />
      {mode === "bucket" && (
        <Select
          label={t("dashboard.bucketStatus.bucket")}
          placeholder={t("dashboard.bucketStatus.pickBucket")}
          data={groups}
          value={bucketId}
          onChange={setBucketId}
          searchable
        />
      )}
    </SettingsDialog>
  );
}

interface FiguresProps {
  buckets: Bucket[];
  figures: Map<string, BucketFigures>;
}

function Attention({ buckets, figures }: FiguresProps) {
  const { t } = useTranslation();
  const list = needsAttention(buckets, figures);
  if (list.length === 0) {
    return <Text size="sm">{t("dashboard.bucketStatus.allFine")}</Text>;
  }
  return (
    <Stack gap="xs">
      {list.map(({ bucket, reason }) => {
        const money = (amount: string) => formatMoney(amount, bucket.currency);
        const { gap, tone } = coverage(bucket);
        const text =
          reason === "overspent"
            ? t("dashboard.bucketStatus.overspentBy", {
                amount: money(subtractAmounts("0", bucket.target_funds)),
              })
            : reason === "uncovered"
              ? t("buckets.notCovered", { amount: money(gap) })
              : t("dashboard.bucketStatus.used", { pct: usedPct(figures.get(bucket.id)) ?? 0 });
        return (
          <Group key={bucket.id} justify="space-between" gap="xs" wrap="nowrap">
            <BucketName bucket={bucket} />
            <Text
              size="sm"
              c={reason === "mostlyUsed" ? "var(--mantine-color-yellow-text)" : toneText(tone)}
              style={{ whiteSpace: "nowrap" }}
            >
              {text}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

/** A bucket on one line, with what's left and its usage bar below. */
function CompactBucket({
  bucket,
  pct,
  right,
}: {
  bucket: Bucket;
  pct: number | null;
  right: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <BucketName bucket={bucket} />
        {right}
      </Group>
      {pct !== null && (
        <Progress
          size="sm"
          value={Math.min(pct, 100)}
          color={usageColor(pct)}
          aria-label={t("dashboard.bucketStatus.usedOf", { name: bucket.name, pct })}
        />
      )}
    </Stack>
  );
}

function AllBuckets({ accounts, buckets, figures }: FiguresProps & { accounts: Account[] }) {
  return (
    <Stack gap="md">
      {accounts
        .filter((a) => buckets.some((b) => b.source_account_id === a.id))
        .map((a) => (
          <Stack key={a.id} gap="xs" component="article" aria-label={a.name}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              {a.name}
            </Text>
            {buckets
              .filter((b) => b.source_account_id === a.id)
              .map((b) => (
                <CompactBucket
                  key={b.id}
                  bucket={b}
                  pct={usedPct(figures.get(b.id))}
                  right={<LeftAmount bucket={b} />}
                />
              ))}
          </Stack>
        ))}
    </Stack>
  );
}

/** What's left in a bucket: what the account backs, or its negative TF. */
function LeftAmount({ bucket }: { bucket: Bucket }) {
  const { tone, overspent, gap } = coverage(bucket);
  const shown = overspent ? bucket.target_funds : bucket.current_available_funds;
  return (
    <Text
      size="sm"
      fw={600}
      c={overspent || compareAmounts(gap, "0") > 0 ? toneText(tone) : undefined}
      style={{ whiteSpace: "nowrap" }}
    >
      {formatMoney(shown, bucket.currency)}
    </Text>
  );
}

function MostUsed({ buckets, figures, active }: FiguresProps & { active: Cycle | null }) {
  const { t } = useTranslation();
  const list = mostUsed(buckets, figures);
  if (list.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {active ? t("dashboard.bucketStatus.noneUsed") : t("buckets.noCycleFigures")}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {list.map(({ bucket, pct }) => (
        <CompactBucket
          key={bucket.id}
          bucket={bucket}
          pct={pct}
          right={
            <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {pct}%
            </Text>
          }
        />
      ))}
    </Stack>
  );
}

function OneBucket({
  bucket,
  figures,
  active,
}: {
  bucket: Bucket;
  figures: BucketFigures | undefined;
  active: Cycle | null;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <BucketName bucket={bucket} />
      <div>
        <Text size="xs" c="dimmed">
          {t("buckets.leftThisCycle")}
        </Text>
        <LeftFunds bucket={bucket} large />
      </div>
      <UsedThisCycle bucket={bucket} figures={figures} active={active} long />
    </Stack>
  );
}

function AccountsWidget({ settings }: { settings: DashboardSettings }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const title = t("dashboard.accounts.title");
  return (
    <Widget
      title={title}
      link={{ to: "/accounts", label: t("nav.items.accounts") }}
      action={
        <SettingsButton
          widget={title}
          onClick={() => {
            setEditing(true);
          }}
        />
      }
    >
      <MoneyState>
        {(accounts, buckets) => {
          if (accounts.length === 0) return <NoBuckets accounts={accounts} />;
          const shown = shownAccounts(settings, accounts);
          return (
            <>
              {shown.mode === "account" ? (
                <OneAccount account={shown.account} buckets={buckets} />
              ) : (
                <AllAccounts accounts={accounts} buckets={buckets} />
              )}
              <AccountsSettings
                key={String(editing)}
                opened={editing}
                onClose={() => {
                  setEditing(false);
                }}
                title={title}
                settings={settings}
                accounts={accounts}
              />
            </>
          );
        }}
      </MoneyState>
    </Widget>
  );
}

function AccountsSettings({
  opened,
  onClose,
  title,
  settings,
  accounts,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  settings: DashboardSettings;
  accounts: Account[];
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AccountsMode>(settings.accounts.mode);
  const [accountId, setAccountId] = useState<string | null>(
    accounts.some((a) => a.id === settings.accounts.accountId) ? settings.accounts.accountId : null,
  );
  return (
    <SettingsDialog
      title={title}
      opened={opened}
      onClose={onClose}
      canSave={mode !== "account" || accountId !== null}
      next={{
        ...settings,
        accounts: { mode, accountId: mode === "account" ? accountId : null },
      }}
    >
      <Select
        label={t("dashboard.accounts.show")}
        data={ACCOUNTS_MODES.map((m) => ({ value: m, label: t(`dashboard.accounts.modes.${m}`) }))}
        value={mode}
        allowDeselect={false}
        onChange={(v) => {
          const next = ACCOUNTS_MODES.find((m) => m === v);
          if (next) setMode(next);
        }}
      />
      {mode === "account" && (
        <Select
          label={t("dashboard.accounts.account")}
          placeholder={t("dashboard.accounts.pickAccount")}
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={accountId}
          onChange={setAccountId}
          searchable
        />
      )}
    </SettingsDialog>
  );
}

function AccountLink({ account }: { account: Account }) {
  return (
    <Anchor
      component={Link}
      to={`/transactions?account_id=${account.id}`}
      fw={600}
      c="var(--mantine-color-text)"
    >
      {account.name}
    </Anchor>
  );
}

function AllAccounts({ accounts, buckets }: { accounts: Account[]; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const currencies = [...new Set(accounts.map((a) => a.currency))];
  return (
    <Stack gap="xs">
      {accounts.map((a) => (
        <Group key={a.id} justify="space-between" gap="xs" wrap="nowrap">
          <Box style={{ minWidth: 0 }}>
            <AccountLink account={a} />
            {buckets.some((b) => b.source_account_id === a.id) && (
              <Text size="xs" c="dimmed">
                {t("dashboard.health.unallocated", {
                  amount: formatMoney(a.unallocated, a.currency),
                })}
              </Text>
            )}
          </Box>
          <Text fw={600} style={{ whiteSpace: "nowrap" }}>
            {formatMoney(a.balance, a.currency)}
          </Text>
        </Group>
      ))}
      <Group
        justify="space-between"
        gap="xs"
        pt="xs"
        style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      >
        <Text size="sm" c="dimmed">
          {t("accounts.total")}
        </Text>
        <Stack gap={0} align="flex-end">
          {currencies.map((currency) => (
            <Text key={currency} fw={700}>
              {formatMoney(
                addAmounts(
                  ...accounts.filter((a) => a.currency === currency).map((a) => a.balance),
                ),
                currency,
              )}
            </Text>
          ))}
        </Stack>
      </Group>
    </Stack>
  );
}

/** One account: its balance, and what its buckets hold of it. */
function OneAccount({ account, buckets }: { account: Account; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const money = (amount: string) => formatMoney(amount, account.currency);
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const summary = accountSummary(account, buckets);
  const isShort = compareAmounts(summary.short, "0") > 0;
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        <AccountLink account={account} />
        <Text size="sm" c="dimmed">
          {accountTypeLabel(account.type)}
        </Text>
      </Group>
      <div>
        <Text size="xs" c="dimmed">
          {t("buckets.balance")}
        </Text>
        <Text fz={22} fw={700}>
          {money(account.balance)}
        </Text>
      </div>
      {own.length > 0 && (
        <Group gap="lg" wrap="wrap">
          <Text size="sm" c="dimmed">
            {t("buckets.leftInBuckets")}{" "}
            <Text span fw={700} c="var(--mantine-color-text)">
              {money(summary.left)}
            </Text>
          </Text>
          <Text size="sm" c={isShort ? toneText(summary.tone) : "dimmed"}>
            {isShort ? t("buckets.short") : t("buckets.unallocated")}{" "}
            <Text span fw={700} c={isShort ? undefined : "var(--mantine-color-text)"}>
              {money(isShort ? summary.short : summary.unallocated)}
            </Text>
          </Text>
        </Group>
      )}
    </Stack>
  );
}

function RecentWidget({ settings }: { settings: DashboardSettings }) {
  const { t } = useTranslation();
  const names = useLookups();
  const pages = useTransactionPages({ type: USER_TYPES, limit: settings.recentCount });
  const [editing, setEditing] = useState(false);
  const [count, setCount] = useState(settings.recentCount);
  const title = t("dashboard.recent.title");
  const items = pages.data?.pages[0]?.items ?? [];
  return (
    <Widget
      title={title}
      link={{ to: "/transactions", label: t("dashboard.recent.all") }}
      action={
        <SettingsButton
          widget={title}
          onClick={() => {
            setCount(settings.recentCount);
            setEditing(true);
          }}
        />
      }
    >
      <QueryState query={pages}>
        {() =>
          items.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("dashboard.recent.empty")}
            </Text>
          ) : (
            <Box
              mx="calc(var(--mantine-spacing-md) * -1)"
              mb="calc(var(--mantine-spacing-md) * -1)"
            >
              {items.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  names={names}
                  filter={NO_FOCUS}
                  to={`/transactions?open=${tx.id}`}
                  selected={false}
                  badge={false}
                />
              ))}
            </Box>
          )
        }
      </QueryState>
      <SettingsDialog
        title={title}
        opened={editing}
        onClose={() => {
          setEditing(false);
        }}
        canSave
        next={{ ...settings, recentCount: count }}
      >
        <Select
          label={t("dashboard.recent.count")}
          data={TRANSACTION_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
          value={String(count)}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setCount(Number(v));
          }}
        />
      </SettingsDialog>
    </Widget>
  );
}
