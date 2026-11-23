import { Anchor, Box, Button, Group, Progress, Stack, Text } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts } from "@/api/accounts";
import {
  useSavingsDistributor,
  useSavingsTargets,
  type SavingsDistributor,
  type SavingsTarget,
} from "@/api/savings";
import { QueryState } from "@/components/QueryState";
import { DistributorDialog, type DistributorAction } from "@/components/savings/DistributorDialog";
import { pickTargets, type WidgetInstance } from "@/lib/dashboard";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import { bsuRoom, progress } from "@/lib/savings";

import { Gone, WidgetCard } from "./Widget";

export const SAVINGS_PATH = "/savings";

/**
 * Savings (#237): each target's progress, the held part striped as on
 * Savings, and what the distributor holds, with Distribute now.
 */
export function SavingsWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"savings">;
  action?: ReactNode;
}) {
  const targets = useSavingsTargets();
  const distributor = useSavingsDistributor();
  const { showDistributor } = widget.settings;
  return (
    <SavingsShell action={action}>
      <QueryState query={targets}>
        {(list) => (
          <Stack gap="md">
            {showDistributor && distributor.data && distributor.data.held.length > 0 && (
              <DistributorPart distributor={distributor.data} targets={list} />
            )}
            <TargetRows widget={widget} targets={list} />
          </Stack>
        )}
      </QueryState>
    </SavingsShell>
  );
}

/** The card both savings widgets share, linking to Savings. */
export function SavingsShell({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <WidgetCard
      title={title ?? t("dashboard.savings.title")}
      link={{ to: SAVINGS_PATH, label: t("dashboard.savings.all") }}
      action={action}
    >
      {children}
    </WidgetCard>
  );
}

/** Without targets: where to make one. */
export function NoTargets() {
  return (
    <Text size="sm" c="dimmed">
      <Trans
        i18nKey="dashboard.savings.none"
        components={{ setup: <Anchor component={Link} to="/savings/setup" size="sm" /> }}
      />
    </Text>
  );
}

function TargetRows({
  widget,
  targets,
}: {
  widget: WidgetInstance<"savings">;
  targets: SavingsTarget[];
}) {
  const { t } = useTranslation();
  if (targets.length === 0) return <NoTargets />;
  const { shown, gone } = pickTargets(widget.settings, targets);
  if (gone) return <Gone what="target" />;
  if (shown.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("dashboard.savings.noneChosen")}
      </Text>
    );
  }
  const rows = shown.slice(0, widget.settings.count);
  const more = shown.length - rows.length;
  return (
    <Stack gap="sm">
      {rows.map((g) => (
        <TargetRow key={g.id} target={g} />
      ))}
      {more > 0 && (
        <Anchor component={Link} to={SAVINGS_PATH} size="sm">
          {t("dashboard.savings.more", { count: more })}
        </Anchor>
      )}
    </Stack>
  );
}

function TargetRow({ target }: { target: SavingsTarget }) {
  const { t } = useTranslation();
  const p = progress(target);
  const room = bsuRoom(target);
  const money = (a: string) => formatMoney(a, target.currency);
  const color = p.reached ? "green" : "blue";
  return (
    <Box data-testid="widget-savings-row">
      <Group justify="space-between" gap="xs" wrap="nowrap" align="baseline">
        <Text size="sm" fw={500} truncate>
          {target.name}
        </Text>
        <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {t("savings.progress", { saved: money(p.saved), goal: money(target.goal) })}
        </Text>
      </Group>
      <Progress.Root size="sm" mt={4} aria-label={t("savings.progressLabel", { pct: p.pct })}>
        <Progress.Section value={p.currentPct} color={color} />
        <Progress.Section value={p.heldPct} color={color} striped />
      </Progress.Root>
      {(compareAmounts(target.held_total, "0") > 0 || room) && (
        <Text size="xs" c={room?.full ? "var(--mantine-color-orange-text)" : "dimmed"} mt={2}>
          {[
            compareAmounts(target.held_total, "0") > 0
              ? t("dashboard.savings.held", { amount: money(target.held_total) })
              : null,
            room?.text ?? null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
    </Box>
  );
}

/** What the distributor holds per account, each with Distribute now. */
function DistributorPart({
  distributor,
  targets,
}: {
  distributor: SavingsDistributor;
  targets: SavingsTarget[];
}) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const [action, setAction] = useState<DistributorAction | null>(null);
  const account = (id: string) => accounts.find((a) => a.id === id);
  const name = (id: string) => account(id)?.name ?? `#${id}`;
  return (
    <Stack gap={4} component="section" aria-label={t("dashboard.savings.distributor")}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        {t("dashboard.savings.distributor")}
      </Text>
      {distributor.held.map((h) => {
        const money = (a: string) => formatMoney(a, account(h.account_id)?.currency);
        const uncovered = subtractAmounts(h.amount, h.covered);
        return (
          <Group key={h.account_id} justify="space-between" gap="xs" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text size="sm">
                {t("savings.distributor.waiting", {
                  amount: money(h.amount),
                  account: name(h.account_id),
                })}
              </Text>
              {compareAmounts(uncovered, "0") > 0 && (
                <Text size="xs" c="var(--mantine-color-orange-text)">
                  {t("savings.notCovered", { amount: money(uncovered) })}
                </Text>
              )}
            </div>
            <Button
              size="xs"
              variant="light"
              aria-label={t("savings.distributor.distribute.name", { account: name(h.account_id) })}
              onClick={() => {
                setAction({ kind: "distribute", accountId: h.account_id });
              }}
            >
              {t("savings.distributor.distribute.submit")}
            </Button>
          </Group>
        );
      })}
      <DistributorDialog
        distributor={distributor}
        targets={targets}
        action={action}
        onClose={() => {
          setAction(null);
        }}
      />
    </Stack>
  );
}
