import { Box, Group, Select, Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useBucketFigures, type Bucket } from "@/api/accounts";
import { useCycles, type Cycle } from "@/api/cycles";
import { useBucketTransactions } from "@/api/transactions";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  signedMoney,
  transactionTitle,
  useLookups,
  type Lookups,
} from "@/components/transactions/lookups";
import {
  historyRows,
  KIND_TYPES,
  ofKind,
  type HistoryKind,
  type HistoryRow,
} from "@/lib/bucketHistory";
import { cycleRange } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { compareAmounts, formatMoney } from "@/lib/money";

interface BucketHistoryProps {
  /** The bucket to show; null keeps the dialog closed. */
  bucket: Bucket | null;
  /** What to show at first. */
  kind: HistoryKind;
  onClose: () => void;
}

/**
 * A bucket's transactions in a cycle, with its TF after each (#84): every
 * line from the cycle's start TF to what it has now (or had at the end).
 */
export function BucketHistory({ bucket, kind, onClose }: BucketHistoryProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal
      opened={bucket !== null}
      onClose={onClose}
      title={bucket ? t("buckets.history.title", { name: bucket.name }) : ""}
      size="lg"
    >
      {bucket && <HistoryBody key={`${bucket.id}/${kind}`} bucket={bucket} initialKind={kind} />}
    </ResponsiveModal>
  );
}

/** The cycles with lines: the active one and the finished ones, newest first. */
function shownCycles(cycles: Cycle[]): Cycle[] {
  return cycles.filter((c) => c.state !== "future").reverse();
}

function HistoryBody({ bucket, initialKind }: { bucket: Bucket; initialKind: HistoryKind }) {
  const { t } = useTranslation();
  const cycles = shownCycles(useCycles().data ?? []);
  const [picked, setCycle] = useState<string | null>(null);
  const cycle = cycles.find((c) => c.id === picked) ?? cycles[0];
  const [kind, setKind] = useState<HistoryKind>(initialKind);

  const kinds: { value: HistoryKind; label: string }[] = [
    { value: "all", label: t("buckets.history.kinds.all") },
    { value: "bucket", label: t("buckets.history.kinds.bucket") },
    ...KIND_TYPES.map((type) => ({ value: type, label: t(`transactionTypes.${type}`) })),
  ];

  return (
    <Stack gap="md">
      <Group grow align="flex-start" gap="sm">
        <Select
          label={t("buckets.history.cycle")}
          data={cycles.map((c) => ({
            value: c.id,
            label:
              c.state === "active"
                ? t("buckets.history.activeCycle", { range: cycleRange(c) })
                : cycleRange(c),
          }))}
          value={cycle?.id ?? null}
          allowDeselect={false}
          disabled={cycles.length === 0}
          onChange={setCycle}
        />
        <Select
          label={t("buckets.history.show")}
          data={kinds}
          value={kind}
          allowDeselect={false}
          onChange={(v) => {
            const next = kinds.find((k) => k.value === v);
            if (next) setKind(next.value);
          }}
        />
      </Group>
      {cycle ? (
        <CycleHistory bucket={bucket} cycle={cycle} kind={kind} />
      ) : (
        <Text size="sm" c="dimmed">
          {t("buckets.history.noCycles")}
        </Text>
      )}
    </Stack>
  );
}

function CycleHistory({
  bucket,
  cycle,
  kind,
}: {
  bucket: Bucket;
  cycle: Cycle;
  kind: HistoryKind;
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const figures = useBucketFigures(cycle.id);
  const transactions = useBucketTransactions(bucket.id, cycle.id);
  const money = (amount: string) => formatMoney(amount, bucket.currency);

  return (
    <QueryState query={figures}>
      {(all) => {
        const own = all.find((f) => f.bucket_id === bucket.id);
        const start = own?.start ?? "0.00";
        const now = own?.left ?? start;
        return (
          <QueryState query={transactions}>
            {({ items, truncated }) => {
              const rows = historyRows(items, bucket.id, cycle.id, now).filter((r) =>
                ofKind(r, kind),
              );
              // The rows are TF. While the account doesn't back all of it,
              // Buckets shows less left (CAF); say why they differ.
              const uncovered =
                cycle.state === "active" &&
                compareAmounts(bucket.current_available_funds, bucket.target_funds) < 0;
              return (
                <Stack gap="sm">
                  {uncovered && (
                    <Text size="sm" c="dimmed">
                      {t("buckets.history.covered", {
                        caf: money(bucket.current_available_funds),
                        tf: money(bucket.target_funds),
                      })}
                    </Text>
                  )}
                  {truncated && (
                    <Text size="sm" c="dimmed">
                      {t("buckets.history.truncated", { count: items.length })}
                    </Text>
                  )}
                  <Box
                    component="ul"
                    aria-label={t("buckets.history.list")}
                    m={0}
                    p={0}
                    style={{
                      listStyle: "none",
                      border: "1px solid var(--mantine-color-default-border)",
                      borderRadius: "var(--mantine-radius-md)",
                    }}
                  >
                    {rows.length === 0 && (
                      <Text component="li" size="sm" c="dimmed" px="md" py={10}>
                        {kind === "all"
                          ? t("buckets.history.empty")
                          : t("buckets.history.emptyKind")}
                      </Text>
                    )}
                    {rows.map((row) => (
                      <li key={row.tx.id}>
                        <HistoryLine row={row} bucket={bucket} cycle={cycle} names={names} />
                      </li>
                    ))}
                    {/* Without Keep funds a cycle starts at 0, unless an overspend carried over. */}
                    {kind === "all" && !truncated && compareAmounts(start, "0") !== 0 && (
                      <Group component="li" justify="space-between" px="md" py={10} gap="sm">
                        <Text size="sm" c="dimmed">
                          {t("buckets.history.startRow")}
                        </Text>
                        <Text size="sm" fw={600}>
                          {money(start)}
                        </Text>
                      </Group>
                    )}
                  </Box>
                </Stack>
              );
            }}
          </QueryState>
        );
      }}
    </QueryState>
  );
}

function HistoryLine({
  row,
  bucket,
  cycle,
  names,
}: {
  row: HistoryRow;
  bucket: Bucket;
  cycle: Cycle;
  names: Lookups;
}) {
  const { t } = useTranslation();
  const { tx, amount, tf, otherBucketId } = row;
  const title = otherBucketId
    ? t(amount.startsWith("-") ? "buckets.history.to" : "buckets.history.from", {
        name: names.bucketName(otherBucketId),
      })
    : transactionTitle(tx, names);
  const positive = !amount.startsWith("-");
  // The Transactions screen, filtered to this bucket and cycle, with it open.
  const to = `/transactions?bucket_id=${bucket.id}&cycle_id=${cycle.id}&system=1&open=${tx.id}`;
  return (
    <UnstyledButton
      component={Link}
      to={to}
      px="md"
      py={10}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        width: "100%",
        borderBottom: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Box style={{ minWidth: 0 }}>
        <Text fw={600} truncate>
          {title}
        </Text>
        <Text size="sm" c="dimmed" truncate>
          {t(`transactionTypes.${tx.type}`)} · {formatDateTime(tx.at)}
        </Text>
      </Box>
      <Box ta="right">
        <Text
          fw={600}
          style={{ whiteSpace: "nowrap" }}
          c={positive ? "var(--mantine-color-blue-text)" : undefined}
        >
          {signedMoney({ amount, signed: true }, bucket.currency)}
        </Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {t("buckets.history.tfAfter", { amount: formatMoney(tf, bucket.currency) })}
        </Text>
      </Box>
    </UnstyledButton>
  );
}
