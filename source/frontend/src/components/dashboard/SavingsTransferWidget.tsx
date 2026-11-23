import { Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccounts } from "@/api/accounts";
import { useSavingsTargets, type SavingsHeld, type SavingsTarget } from "@/api/savings";
import { QueryState } from "@/components/QueryState";
import { SavingsDialog } from "@/components/savings/SavingsDialog";
import { pickTargets, type WidgetInstance } from "@/lib/dashboard";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

import { NoTargets, SAVINGS_PATH, SavingsShell } from "./SavingsWidget";
import { Gone } from "./Widget";

/**
 * Savings to transfer (#237): money held for targets, waiting for the user
 * to move it at the bank, one row per target and account, each with Done.
 */
export function SavingsTransferWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"savings_transfer">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const targets = useSavingsTargets();
  return (
    <SavingsShell title={t("dashboard.savingsTransfer.title")} action={action}>
      <QueryState query={targets}>
        {(list) => <TransferRows widget={widget} targets={list} />}
      </QueryState>
    </SavingsShell>
  );
}

function TransferRows({
  widget,
  targets,
}: {
  widget: WidgetInstance<"savings_transfer">;
  targets: SavingsTarget[];
}) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const [done, setDone] = useState<{ target: SavingsTarget; accountId: string } | null>(null);
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
  const all = shown.flatMap((target) => target.held.map((held) => ({ target, held })));
  if (all.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("dashboard.savingsTransfer.nothing")}
      </Text>
    );
  }
  const rows = all.slice(0, widget.settings.count);
  const more = all.length - rows.length;
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  return (
    <Stack gap="xs">
      {rows.map(({ target, held }) => (
        <TransferRow
          key={`${target.id}:${held.account_id}`}
          target={target}
          held={held}
          from={name(held.account_id)}
          onDone={() => {
            setDone({ target, accountId: held.account_id });
          }}
        />
      ))}
      {more > 0 && (
        <Anchor component={Link} to={SAVINGS_PATH} size="sm">
          {t("dashboard.savingsTransfer.more", { count: more })}
        </Anchor>
      )}
      {done && (
        <SavingsDialog
          target={done.target}
          action={{ kind: "done", accountId: done.accountId }}
          onClose={() => {
            setDone(null);
          }}
        />
      )}
    </Stack>
  );
}

function TransferRow({
  target,
  held,
  from,
  onDone,
}: {
  target: SavingsTarget;
  held: SavingsHeld;
  from: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, target.currency);
  const uncovered = subtractAmounts(held.amount, held.covered);
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap" data-testid="widget-transfer-row">
      <div style={{ minWidth: 0 }}>
        <Text size="sm">
          {t("dashboard.savingsTransfer.row", {
            amount: money(held.amount),
            from,
            to: target.name,
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
        aria-label={t("savings.done.name", { name: target.name, account: from })}
        onClick={onDone}
      >
        {t("savings.done.submit")}
      </Button>
    </Group>
  );
}
