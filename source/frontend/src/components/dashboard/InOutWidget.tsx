import { Anchor, Box, Group, Stack, Text } from "@mantine/core";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useAccountFlows, useAccounts, type Account } from "@/api/accounts";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { QueryState } from "@/components/QueryState";
import { signedMoney } from "@/components/transactions/lookups";
import { endAtFor, formatDateRange, startAtFor } from "@/lib/cycles";
import type { WidgetInstance } from "@/lib/dashboard";
import { flowLink, flowTotals, periodSpan, type DateSpan, type FlowFigure } from "@/lib/flows";
import { compareAmounts, formatMoney } from "@/lib/money";

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

/** Side by side in large or small type, or one figure per row. */
type Layout = "large" | "small" | "rows";
const FONT_SIZE: Record<Layout, number> = { large: 20, small: 16, rows: 18 };
const GAP = 16;

/**
 * The layout the figures fit in: side by side while the widest amount fits
 * its column, at the large size or else the small one, and in rows when
 * neither fits. An amount's width scales with its font size, so measuring
 * it in any layout tells all three apart.
 */
function useFiguresLayout(count: number, amounts: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("large");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      // Width per pixel of font size, for the widest amount.
      const perPx = Math.max(
        0,
        ...[...el.querySelectorAll<HTMLElement>("[data-amount]")].map(
          (a) =>
            a.getBoundingClientRect().width /
            (Number.parseFloat(getComputedStyle(a).fontSize) || 1),
        ),
      );
      const column = (el.clientWidth - GAP * (count - 1)) / count;
      // Nothing measured (e.g. hidden): keep the large layout.
      const fits = (l: Layout) => perPx === 0 || perPx * FONT_SIZE[l] <= column;
      setLayout(fits("large") ? "large" : fits("small") ? "small" : "rows");
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [count, amounts]);
  return { ref, layout };
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

  const { ref, layout } = useFiguresLayout(figures.length, figures.map(amountOf).join("|"));
  const stacked = layout === "rows";

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {t("dashboard.inOut.subtitle", {
          period: periodLabel,
          range: formatDateRange(span.from, span.to),
          accounts: account?.name ?? t("dashboard.accounts.modes.all"),
        })}
      </Text>
      <Box
        ref={ref}
        data-layout={layout}
        style={
          stacked
            ? { display: "flex", flexDirection: "column", gap: 4 }
            : {
                display: "grid",
                gridTemplateColumns: `repeat(${String(figures.length)}, minmax(0, 1fr))`,
                gap: GAP,
              }
        }
      >
        {figures.map((figure) => {
          const label = t(`dashboard.inOut.figures.${figure}`);
          const amount = amountOf(figure);
          const value = (
            <Text
              data-amount
              fz={FONT_SIZE[layout]}
              fw={700}
              c={color(figure)}
              style={{ whiteSpace: "nowrap", width: "max-content" }}
            >
              {amount}
            </Text>
          );
          return (
            <Anchor
              key={figure}
              component={Link}
              to={flowLink(figure, period, span, active, account?.id ?? null)}
              underline="never"
              c="var(--mantine-color-text)"
              aria-label={t("dashboard.inOut.open", { figure: label, amount })}
            >
              {stacked ? (
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="sm" c="dimmed">
                    {label}
                  </Text>
                  {value}
                </Group>
              ) : (
                <>
                  <Text size="xs" c="dimmed">
                    {label}
                  </Text>
                  {value}
                </>
              )}
            </Anchor>
          );
        })}
      </Box>
      {totals.leftOut > 0 && (
        <Text size="xs" c="dimmed">
          {t("dashboard.inOut.leftOut", { count: totals.leftOut })}
        </Text>
      )}
    </Stack>
  );
}
