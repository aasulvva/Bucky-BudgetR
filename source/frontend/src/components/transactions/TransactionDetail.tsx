import { ActionIcon, Alert, Anchor, Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBucket, IconBuildingBank, IconRepeat, IconX, type Icon } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useRefreshMoney } from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { useSchedules } from "@/api/schedules";
import { useTransaction, type Transaction } from "@/api/transactions";
import { useSession } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { cycleRange } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { isSchedulable, scheduleTitle } from "@/lib/schedules";
import { bucketLinesLocked, isCorrectable, linesAmount, shownLines } from "@/lib/transactionList";

import { signedMoney, transactionTitle, useLookups, type Lookups } from "./lookups";

/**
 * A transaction's detail (spec §9, canvas "Transactions"): its lines, its
 * history of corrections, and Edit and Reverse while it can change.
 */
export function TransactionDetail({
  id,
  onClose,
  openLink,
}: {
  id: string;
  /** Shows a close button; on mobile the dialog has its own. */
  onClose?: () => void;
  /** Where a link to another transaction goes (the list with it open). */
  openLink: (id: string) => string;
}) {
  const transaction = useTransaction(id);
  return (
    <QueryState query={transaction}>
      {(tx) => <Detail tx={tx} onClose={onClose} openLink={openLink} />}
    </QueryState>
  );
}

function Detail({
  tx,
  onClose,
  openLink,
}: {
  tx: Transaction;
  onClose?: () => void;
  openLink: (id: string) => string;
}) {
  const { t } = useTranslation();
  const names = useLookups();
  const me = useSession().data?.id;
  const active = useCurrentCycles().data?.active ?? null;
  const currency = names.currencyOf(tx);
  const lines = shownLines(tx);
  const locked = bucketLinesLocked(tx, active);
  const who = (by: string | null) =>
    by === null
      ? t("transactions.system")
      : by === me
        ? t("transactions.you")
        : t("transactions.user", { id: by });

  return (
    <Stack gap="md" aria-label={transactionTitle(tx, names)} component="article">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Title order={3} size="h4">
            {transactionTitle(tx, names)}{" "}
            <Text span inherit c="dimmed" fw={400}>
              (#{tx.id})
            </Text>
          </Title>
          <Text size="sm" c="dimmed">
            {[t(`transactionTypes.${tx.type}`), formatDateTime(tx.at), ...tx.tags].join(" · ")}
          </Text>
          {tx.schedule_id && <FromSchedule id={tx.schedule_id} names={names} />}
        </div>
        {onClose && (
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <IconX size={18} />
          </ActionIcon>
        )}
      </Group>

      <Text
        fz={26}
        fw={600}
        c={tx.reversed ? "dimmed" : undefined}
        td={tx.reversed ? "line-through" : undefined}
      >
        {signedMoney(linesAmount(lines), currency)}
      </Text>

      {tx.reversed && (
        <Text size="sm" c="dimmed">
          {t("transactions.reversedLines")}
        </Text>
      )}
      {lines.bank_lines.length > 0 && (
        <Section
          title={t("transactions.accountLines", { count: lines.bank_lines.length })}
          icon={IconBuildingBank}
        >
          {lines.bank_lines.map((l) => {
            const balance = tx.balances_after.find((b) => b.account_id === l.account_id)?.balance;
            return (
              <Row
                key={l.account_id}
                label={names.accountName(l.account_id)}
                note={
                  balance === undefined
                    ? undefined
                    : t("transactions.balanceAfterDetail", {
                        amount: formatMoney(
                          balance,
                          names.accountCurrency(l.account_id) ?? currency,
                        ),
                      })
                }
              >
                {signedMoney({ amount: l.amount, signed: true }, currency)}
              </Row>
            );
          })}
        </Section>
      )}
      {lines.bucket_lines.length > 0 && (
        <Section
          title={t("transactions.bucketLines", { count: lines.bucket_lines.length })}
          icon={IconBucket}
        >
          {lines.bucket_lines.map((l) => (
            <Row key={l.bucket_id} label={names.bucketName(l.bucket_id)}>
              {signedMoney({ amount: l.amount, signed: true }, currency)}
            </Row>
          ))}
        </Section>
      )}

      {tx.history && tx.history.length > 0 && (
        <Section title={t("transactions.history")}>
          {tx.history.map((v) => {
            const key =
              v.correction_type === "reversal"
                ? "reversedAt"
                : v.correction_type === "adjustment"
                  ? "corrected"
                  : "recorded";
            return (
              <Row
                key={v.id}
                label={t(`transactions.${key}`, {
                  date: formatDateTime(v.created_at),
                  who: who(v.created_by),
                })}
              >
                {signedMoney(linesAmount(v), currency)}
              </Row>
            );
          })}
        </Section>
      )}

      {tx.replaced_by && (
        <Text size="sm">
          <Trans
            i18nKey="transactions.movedTo"
            components={{ link: <Anchor component={Link} to={openLink(tx.replaced_by)} /> }}
          />
        </Text>
      )}
      {tx.replaces && (
        <Text size="sm">
          <Trans
            i18nKey="transactions.movedFrom"
            components={{ link: <Anchor component={Link} to={openLink(tx.replaces)} /> }}
          />
        </Text>
      )}

      {isCorrectable(tx) ? (
        <Actions tx={tx} locked={locked} names={names} />
      ) : (
        <Text size="sm" c="dimmed">
          {t(tx.reversed ? "transactions.reversedNote" : "transactions.systemNote")}
        </Text>
      )}
      {isCorrectable(tx) &&
        (locked ? (
          <Text size="sm" c="dimmed">
            {t("transactions.locked")}
          </Text>
        ) : (
          tx.bucket_lines.length > 0 &&
          active && (
            <Text size="sm" c="dimmed">
              {t("transactions.editableUntil", { range: cycleRange(active) })}
            </Text>
          )
        ))}
    </Stack>
  );
}

/** Edit, and Reverse after a confirmation. */
function Actions({ tx, locked, names }: { tx: Transaction; locked: boolean; names: Lookups }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [confirming, setConfirming] = useState(false);
  const reverse = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/transactions/{transactionId}/reversal", {
          params: { path: { transactionId: tx.id } },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      setConfirming(false);
      notifications.show({ color: "green", message: t("transactions.reverseDone") });
      await refresh();
    },
  });

  return (
    <Stack gap="sm" pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
      {confirming ? (
        <Alert color="red" p="sm">
          <Stack gap="sm">
            <Text size="sm">
              {t("transactions.reverseConfirm")}
              {tx.triggers_refill ? ` ${t("transactions.reverseRefills")}` : ""}
            </Text>
            {reverse.error && <ErrorAlert error={reverse.error} />}
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
                loading={reverse.isPending}
                aria-label={t("transactions.reverseName", { name: transactionTitle(tx, names) })}
                onClick={() => {
                  reverse.mutate();
                }}
              >
                {t("transactions.reverse")}
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : (
        <Group gap="xs">
          <Button variant="outline" component={Link} to={`/transactions/${tx.id}/edit`}>
            {t("transactions.edit")}
          </Button>
          {isSchedulable(tx) && (
            <Button
              variant="default"
              component={Link}
              to={`/transactions/scheduled/new?from=${tx.id}`}
              leftSection={<IconRepeat size={16} />}
            >
              {t("transactions.makeRecurring")}
            </Button>
          )}
          <Button
            variant="default"
            disabled={locked}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t("transactions.reverse")}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** The schedule that recorded the transaction, linking to it. */
function FromSchedule({ id, names }: { id: string; names: Lookups }) {
  const { t } = useTranslation();
  const schedule = useSchedules().data?.find((s) => s.id === id);
  return (
    <Text size="sm" c="dimmed">
      <IconRepeat size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} aria-hidden />
      <Trans
        i18nKey="transactions.fromSchedule"
        values={{ name: schedule ? scheduleTitle(schedule, t, names.accountName) : `#${id}` }}
        components={{
          schedule: <Anchor component={Link} to={`/transactions/scheduled/${id}/edit`} />,
        }}
      />
    </Text>
  );
}

function Section({
  title,
  icon: SectionIcon,
  children,
}: {
  title: string;
  icon?: Icon;
  children: ReactNode;
}) {
  return (
    <Stack gap={6} component="section" aria-label={title}>
      <Group gap={6} c="dimmed">
        {SectionIcon && <SectionIcon size={16} aria-hidden />}
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.04em" }}>
          {title}
        </Text>
      </Group>
      {children}
    </Stack>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <Group justify="space-between" gap="sm" wrap="nowrap" align="flex-start">
      <Text size="sm" style={{ minWidth: 0 }}>
        {label}
      </Text>
      <Box ta="right">
        <Text size="sm" style={{ whiteSpace: "nowrap" }}>
          {children}
        </Text>
        {note && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {note}
          </Text>
        )}
      </Box>
    </Group>
  );
}
