import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowsShuffle,
  IconLayoutGrid,
  IconList,
  IconHistory,
  IconSettings,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  refillModeLabel,
  useAccounts,
  useBucketFigures,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
  type BucketFigures,
} from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { AdjustButton } from "@/components/buckets/AdjustFunds";
import { BucketHistory } from "@/components/buckets/BucketHistory";
import {
  BucketName,
  LeftFunds,
  UsedThisCycle,
  type BucketProps,
} from "@/components/buckets/BucketParts";
import { QueryState } from "@/components/QueryState";
import i18n from "@/i18n";
import type { HistoryKind } from "@/lib/bucketHistory";
import { accountSummary, coverage, refillOf, toneStyle } from "@/lib/buckets";
import { cycleRange, daysLeftLabel, isOverdue } from "@/lib/cycles";
import { compareAmounts, formatMoney } from "@/lib/money";

type View = "list" | "grid";

/** Remembers the desktop layout in this browser. */
const VIEW_KEY = "bucky.bucketsView";

function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  return [
    view,
    (next) => {
      setView(next);
      try {
        localStorage.setItem(VIEW_KEY, next);
      } catch {
        // Not remembered; the list is the default.
      }
    },
  ];
}

/**
 * Buckets (spec §9, canvas "Buckets"): per source account, each bucket's
 * spending this cycle out of its budget, what's left (TF) and what the
 * account covers (CAF), with a refill button for manual buckets and each
 * bucket's Adjust funds.
 */
export default function Buckets() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const active = useCurrentCycles().data?.active ?? null;
  const figures = useBucketFigures(active?.id);
  const [view, setView] = useView();
  // The bucket whose transactions are open, and what they show.
  const [history, setHistory] = useState<{ bucket: Bucket; kind: HistoryKind } | null>(null);
  const openHistory = (bucket: Bucket, kind: HistoryKind) => {
    setHistory({ bucket, kind });
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Title order={2}>{t("nav.items.buckets")}</Title>
        <Group gap="md">
          {active && (
            <Anchor component={Link} to="/cycles" size="sm">
              {t("cycles.statusLabel", {
                range: cycleRange(active),
                status: daysLeftLabel(active).toLowerCase(),
              })}
            </Anchor>
          )}
          {isDesktop && (
            <SegmentedControl
              aria-label={t("buckets.layout")}
              value={view}
              onChange={(v) => {
                setView(v === "grid" ? "grid" : "list");
              }}
              data={[
                {
                  value: "list",
                  label: <IconList size={18} aria-label={t("buckets.listView")} />,
                },
                {
                  value: "grid",
                  label: <IconLayoutGrid size={18} aria-label={t("buckets.gridView")} />,
                },
              ]}
            />
          )}
        </Group>
      </Group>

      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => {
              if (bucketList.length === 0) {
                return (
                  <Text c="dimmed">
                    <Trans
                      i18nKey={accountList.length === 0 ? "accounts.empty" : "buckets.noBuckets"}
                      components={{
                        setup: (
                          <Anchor
                            component={Link}
                            to={accountList.length === 0 ? "/accounts/setup" : "/buckets/setup"}
                          />
                        ),
                      }}
                    />
                  </Text>
                );
              }
              const byId = new Map(figures.data?.map((f) => [f.bucket_id, f]));
              return accountList
                .filter((a) => bucketList.some((b) => b.source_account_id === a.id))
                .map((a) => (
                  <AccountSection
                    key={a.id}
                    account={a}
                    buckets={bucketList.filter((b) => b.source_account_id === a.id)}
                    figures={byId}
                    active={active}
                    view={isDesktop ? view : "cards"}
                    onHistory={openHistory}
                  />
                ));
            }}
          </QueryState>
        )}
      </QueryState>
      <BucketHistory
        bucket={history?.bucket ?? null}
        kind={history?.kind ?? "all"}
        onClose={() => {
          setHistory(null);
        }}
      />
    </Stack>
  );
}

function AccountSection({
  account,
  buckets,
  figures,
  active,
  view,
  onHistory,
}: {
  account: Account;
  buckets: Bucket[];
  figures: Map<string, BucketFigures>;
  active: Cycle | null;
  view: View | "cards";
  onHistory: OnHistory;
}) {
  const { t } = useTranslation();
  const summary = accountSummary(account, buckets);
  const isShort = compareAmounts(summary.short, "0") > 0;
  // Reallocating only matters while some bucket isn't fully covered.
  const uncovered =
    isShort ||
    buckets.some(
      (b) => b.source_account_id === account.id && compareAmounts(coverage(b).gap, "0") > 0,
    );
  const money = (amount: string) => formatMoney(amount, account.currency);

  return (
    <Stack gap="sm" component="section" aria-label={account.name}>
      <Group justify="space-between" align="baseline" gap="md" wrap="wrap" px={4}>
        <Title order={3} size="h4">
          {account.name}
        </Title>
        <Group gap="lg" wrap="wrap">
          <Figure label={t("buckets.balance")} value={money(account.balance)} />
          <Figure label={t("buckets.leftInBuckets")} value={money(summary.left)} />
          {isShort ? (
            <Figure label={t("buckets.short")} value={money(summary.short)} />
          ) : (
            <Figure label={t("buckets.unallocated")} value={money(summary.unallocated)} />
          )}
          {uncovered && <ReallocateButton account={account} />}
        </Group>
      </Group>
      {isShort && (
        <Alert
          color={summary.tone === "alert" ? "red" : "yellow"}
          icon={<IconAlertTriangle size={20} />}
          p="sm"
        >
          <Stack gap={4}>
            <Text size="sm">
              {t(summary.tone === "alert" ? "buckets.shortAlert" : "buckets.shortWarn", {
                amount: money(summary.short),
              })}
            </Text>
            <Text size="xs" c="dimmed">
              {t("buckets.reallocateHint")}
            </Text>
          </Stack>
        </Alert>
      )}
      {view === "list" ? (
        <BucketTable buckets={buckets} figures={figures} active={active} onHistory={onHistory} />
      ) : (
        <Box
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "var(--mantine-spacing-md)",
          }}
        >
          {buckets.map((b) => (
            <BucketCard
              key={b.id}
              bucket={b}
              figures={figures.get(b.id)}
              active={active}
              mobile={view === "cards"}
              onHistory={onHistory}
            />
          ))}
        </Box>
      )}
    </Stack>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Text size="sm" c="dimmed">
      {label}{" "}
      <Text span fw={700} c="var(--mantine-color-text)">
        {value}
      </Text>
    </Text>
  );
}

/** Opens a bucket's transactions, showing a kind. */
type OnHistory = (bucket: Bucket, kind: HistoryKind) => void;

function BucketTable({
  buckets,
  figures,
  active,
  onHistory,
}: {
  buckets: Bucket[];
  figures: Map<string, BucketFigures>;
  active: Cycle | null;
  onHistory: OnHistory;
}) {
  const { t } = useTranslation();
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={860}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("buckets.bucket")}</Table.Th>
              <Table.Th w="30%">{t("buckets.usedThisCycle")}</Table.Th>
              <Table.Th w="22%">{t("buckets.left")}</Table.Th>
              <Table.Th>{t("buckets.refill")}</Table.Th>
              <Table.Th w={124}>
                <span className="mantine-visually-hidden">{t("buckets.actions")}</span>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {buckets.map((b) => {
              const { tone } = coverage(b);
              return (
                <Table.Tr key={b.id} style={toneStyle(tone)}>
                  <Table.Td>
                    <BucketName bucket={b} />
                  </Table.Td>
                  <Table.Td>
                    <UsedThisCycle
                      bucket={b}
                      figures={figures.get(b.id)}
                      active={active}
                      onPart={(kind) => {
                        onHistory(b, kind);
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <LeftFunds bucket={b} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="wrap">
                      <Text size="sm" c="dimmed">
                        {modeText(b, active)}
                      </Text>
                      <RefillButton bucket={b} active={active} />
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <HistoryButton bucket={b} size={32} onHistory={onHistory} />
                      <AdjustButton bucket={b} size={32} />
                      <SetupLink bucket={b} size={32} />
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function BucketCard({
  bucket,
  figures,
  active,
  mobile,
  onHistory,
}: BucketProps & { mobile: boolean; onHistory: OnHistory }) {
  const { t } = useTranslation();
  const { tone } = coverage(bucket);
  return (
    <Card withBorder component="article" aria-label={bucket.name} style={toneStyle(tone)}>
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <BucketName bucket={bucket} />
          <Group gap={4} wrap="nowrap">
            <HistoryButton bucket={bucket} size={mobile ? 44 : 32} onHistory={onHistory} />
            <AdjustButton bucket={bucket} size={mobile ? 44 : 32} />
            <SetupLink bucket={bucket} size={mobile ? 44 : 32} />
          </Group>
        </Group>
        <div>
          <Text size="xs" c="dimmed">
            {t("buckets.leftThisCycle")}
          </Text>
          <LeftFunds bucket={bucket} large />
        </div>
        <UsedThisCycle
          bucket={bucket}
          figures={figures}
          active={active}
          long
          onPart={(kind) => {
            onHistory(bucket, kind);
          }}
        />
        <Group
          justify="space-between"
          gap="xs"
          mih={32}
          pt="xs"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          <Text size="sm" c="dimmed">
            {modeText(bucket, active)}
          </Text>
          {!mobile && <RefillButton bucket={bucket} active={active} />}
        </Group>
        {mobile && <RefillButton bucket={bucket} active={active} full />}
      </Stack>
    </Card>
  );
}

/** "Manual · not refilled · keeps funds". */
function modeText(bucket: Bucket, active: Cycle | null): string {
  const { t } = i18n;
  return [
    refillModeLabel(bucket.refill_mode),
    active && (bucket.refilled ? t("buckets.refilled") : t("buckets.notRefilled")),
    bucket.keep_funds && t("buckets.keepsFunds"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function HistoryButton({
  bucket,
  size,
  onHistory,
}: {
  bucket: Bucket;
  size: number;
  onHistory: OnHistory;
}) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size={size}
      aria-label={t("buckets.history.open", { name: bucket.name })}
      title={t("buckets.history.button")}
      onClick={() => {
        onHistory(bucket, "all");
      }}
    >
      <IconHistory size={18} />
    </ActionIcon>
  );
}

function SetupLink({ bucket, size }: { bucket: Bucket; size: number }) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      component={Link}
      to={`/buckets/setup?edit=${bucket.id}`}
      variant="subtle"
      color="gray"
      size={size}
      aria-label={t("buckets.setupFor", { name: bucket.name })}
      title={t("nav.items.bucketSetup")}
    >
      <IconSettings size={18} />
    </ActionIcon>
  );
}

/**
 * Shares an underfunded account's money out again now. The allocation routine
 * only does it on its own triggers (spec §7), so after a refill, for example,
 * a bucket can stay uncovered.
 */
function ReallocateButton({ account }: { account: Account }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const reallocate = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/reallocate", {
          params: { path: { accountId: account.id } },
        }),
      ),
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("buckets.reallocatedDone", { name: account.name }),
      });
      await refresh();
    },
  });
  return (
    <Button
      variant="light"
      size="xs"
      leftSection={<IconArrowsShuffle size={14} />}
      loading={reallocate.isPending}
      aria-label={t("buckets.reallocateName", { name: account.name })}
      onClick={() => {
        reallocate.mutate();
      }}
    >
      {t("buckets.reallocate")}
    </Button>
  );
}

/** Refills a manual bucket by hand, once per cycle, while the cycle runs. */
function RefillButton({
  bucket,
  active,
  full,
}: {
  bucket: Bucket;
  active: Cycle | null;
  full?: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const { amount } = refillOf(bucket);
  const signed = `${compareAmounts(amount, "0") > 0 ? "+" : ""}${formatMoney(amount, bucket.currency)}`;
  const refill = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/buckets/{bucketId}/refill", {
          params: { path: { bucketId: bucket.id } },
        }),
      ),
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("buckets.refilledDone", { name: bucket.name, amount: signed }),
      });
      await refresh();
    },
  });

  if (bucket.refill_mode !== "manual" || bucket.refilled || !active || isOverdue(active)) {
    return null;
  }
  return (
    <Button
      variant="outline"
      size={full ? "md" : "xs"}
      fullWidth={full}
      loading={refill.isPending}
      aria-label={t("buckets.refillName", { name: bucket.name })}
      onClick={() => {
        refill.mutate();
      }}
    >
      {full ? t("buckets.refillWithAmount", { amount: signed }) : t("buckets.refill")}
    </Button>
  );
}
