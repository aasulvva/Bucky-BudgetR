import { Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAccountFlows, useAccounts, type Account } from "@/api/accounts";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { QueryState } from "@/components/QueryState";
import { signedMoney } from "@/components/transactions/lookups";
import { endAtFor, formatDateRange, startAtFor } from "@/lib/cycles";
import type { WidgetInstance } from "@/lib/dashboard";
import { flowLink, flowTotals, periodSpan, type DateSpan, type FlowFigure } from "@/lib/flows";
import { compareAmounts, formatMoney } from "@/lib/money";

import { FlowFigures } from "./FlowFigures";
import { Gone, NoBuckets, WidgetCard } from "./Widget";

/**
 * Income, expenses and their balance over a period (#90), on one account
 * or on all accounts in the app's currency. Each figure opens its
 * transactions.
 */
export function InOutWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"in_out">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const active = useCurrentCycles().data?.active ?? null;
  const { period, days } = widget.settings;
  const span = periodSpan(period, days, active);
  const flows = useAccountFlows(span && { from: startAtFor(span.from), to: endAtFor(span.to) });
  return (
    <WidgetCard
      title={t("dashboard.inOut.title")}
      link={{ to: "/transactions", label: t("nav.items.transactions") }}
      action={action}
    >
      <QueryState query={accounts}>
        {(list) => {
          if (list.length === 0) return <NoBuckets accounts={list} />;
          // Its account was deleted (#135): say so rather than show them all.
          const { accountId } = widget.settings;
          if (accountId !== null && !list.some((a) => a.id === accountId)) {
            return <Gone what="account" />;
          }
          if (!span) {
            return (
              <Text size="sm" c="dimmed">
                {t("cycles.noActive")}
              </Text>
            );
          }
          return (
            <QueryState query={flows}>
              {(rows) => (
                <Figures widget={widget} accounts={list} span={span} active={active} rows={rows} />
              )}
            </QueryState>
          );
        }}
      </QueryState>
    </WidgetCard>
  );
}

function Figures({
  widget,
  accounts,
  span,
  active,
  rows,
}: {
  widget: WidgetInstance<"in_out">;
  accounts: Account[];
  span: DateSpan;
  active: Cycle | null;
  rows: Parameters<typeof flowTotals>[0];
}) {
  const { t } = useTranslation();
  const { figures, period, days } = widget.settings;
  const account = accounts.find((a) => a.id === widget.settings.accountId) ?? null;
  const totals = flowTotals(rows, accounts, account?.id ?? null);
  const periodLabel =
    period === "days"
      ? t("dashboard.inOut.lastDays", { count: days })
      : t(`dashboard.inOut.periodOptions.${period}`);
  const amountOf = (figure: FlowFigure) =>
    figure === "balance"
      ? signedMoney({ amount: totals.balance, signed: true }, totals.currency)
      : formatMoney(totals[figure], totals.currency);
  const color = (figure: FlowFigure) => {
    if (figure !== "balance") return undefined;
    const sign = compareAmounts(totals.balance, "0");
    return sign > 0
      ? "var(--mantine-color-green-text)"
      : sign < 0
        ? "var(--mantine-color-red-text)"
        : undefined;
  };

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t("dashboard.inOut.subtitle", {
          period: periodLabel,
          range: formatDateRange(span.from, span.to),
          accounts: account?.name ?? t("dashboard.accounts.modes.all"),
        })}
      </Text>
      <FlowFigures
        figures={figures.map((figure) => {
          const label = t(`dashboard.inOut.figures.${figure}`);
          const amount = amountOf(figure);
          return {
            key: figure,
            label,
            amount,
            color: color(figure),
            link: {
              to: flowLink(figure, period, span, active, account?.id ?? null),
              label: t("dashboard.inOut.open", { figure: label, amount }),
            },
          };
        })}
      />
      {totals.leftOut > 0 && (
        <Text size="xs" c="dimmed">
          {t("dashboard.inOut.leftOut", { count: totals.leftOut })}
        </Text>
      )}
    </Stack>
  );
}
