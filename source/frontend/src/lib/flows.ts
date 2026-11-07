// The In/out widget's logic (#90): the period's local dates, the totals
// from the API's per-account flows, and links to the matching transactions.

import dayjs from "dayjs";

import type { Account, AccountFlow } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";

import { now as clockNow } from "./clock";
import { addDays, firstDay, lastDay, today, type LocalDate } from "./cycles";
import { CURRENCY, getLocale } from "./locale";
import { addAmounts, subtractAmounts } from "./money";
import { ALL_CYCLES } from "./transactionList";

export type FlowFigure = "income" | "expenses" | "balance";
export type FlowPeriod = "days" | "today" | "week" | "cycle" | "month" | "year";

export const FLOW_FIGURES: FlowFigure[] = ["income", "expenses", "balance"];
export const FLOW_PERIODS: FlowPeriod[] = ["days", "today", "week", "cycle", "month", "year"];
export const MAX_DAYS = 366;

export interface DateSpan {
  from: LocalDate;
  /** The last day, inclusive. */
  to: LocalDate;
}

interface WeekInfo {
  firstDay?: number;
}

/** The locale's first day of the week, 1 (Monday) to 7 (Sunday); Monday if unknown. */
export function weekStart(locale = getLocale()): number {
  try {
    const l = new Intl.Locale(
      locale ?? new Intl.DateTimeFormat().resolvedOptions().locale,
    ) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    return info?.firstDay ?? 1;
  } catch {
    return 1;
  }
}

/**
 * The local days a period covers: the last `days` days (today included),
 * today, this week, the active cycle, this month or this year. Null for
 * This cycle without an active cycle.
 */
export function periodSpan(
  period: FlowPeriod,
  days: number,
  active: Cycle | null,
  now = clockNow(),
  locale = getLocale(),
): DateSpan | null {
  const day = today(now);
  const d = dayjs(day);
  switch (period) {
    case "days":
      return { from: addDays(day, -(Math.max(1, Math.min(days, MAX_DAYS)) - 1)), to: day };
    case "today":
      return { from: day, to: day };
    case "week": {
      // dayjs: 0 = Sunday; the locale's week: 1 = Monday … 7 = Sunday.
      const weekday = d.day() === 0 ? 7 : d.day();
      const from = addDays(day, -((weekday - weekStart(locale) + 7) % 7));
      return { from, to: addDays(from, 6) };
    }
    case "cycle":
      return active ? { from: firstDay(active), to: lastDay(active) } : null;
    case "month":
      return {
        from: d.startOf("month").format("YYYY-MM-DD"),
        to: d.endOf("month").format("YYYY-MM-DD"),
      };
    case "year":
      return {
        from: d.startOf("year").format("YYYY-MM-DD"),
        to: d.endOf("year").format("YYYY-MM-DD"),
      };
  }
}

export interface FlowTotals {
  currency: string;
  income: string;
  expenses: string;
  /** Income − expenses. */
  balance: string;
  /** All accounts: how many in other currencies aren't counted. */
  leftOut: number;
}

/**
 * The widget's figures. With one account (that still exists), transfers in
 * and out count as income and expenses, in its currency. With all accounts,
 * transfers cancel out and are left out, and only accounts in the app's
 * currency count.
 */
export function flowTotals(
  flows: AccountFlow[],
  accounts: Account[],
  accountId: string | null,
): FlowTotals {
  const totals = (currency: string, income: string, expenses: string, leftOut: number) => ({
    currency,
    income,
    expenses,
    balance: subtractAmounts(income, expenses),
    leftOut,
  });
  const one = accounts.find((a) => a.id === accountId);
  if (one) {
    const f = flows.find((x) => x.account_id === one.id);
    return totals(
      one.currency,
      addAmounts(f?.income ?? "0", f?.transfers_in ?? "0"),
      addAmounts(f?.expenses ?? "0", f?.transfers_out ?? "0"),
      0,
    );
  }
  const counted = new Set(accounts.filter((a) => a.currency === CURRENCY).map((a) => a.id));
  const own = flows.filter((f) => counted.has(f.account_id));
  return totals(
    CURRENCY,
    addAmounts("0", ...own.map((f) => f.income)),
    addAmounts("0", ...own.map((f) => f.expenses)),
    accounts.length - counted.size,
  );
}

/**
 * The Transactions screen with a figure's transactions: income (INC) or
 * expenses (EXP), or everything for the balance, in the period and account.
 */
export function flowLink(
  figure: FlowFigure,
  period: FlowPeriod,
  span: DateSpan,
  active: Cycle | null,
  accountId: string | null,
): string {
  const params = new URLSearchParams();
  if (period === "cycle" && active) {
    params.set("cycle_id", active.id);
  } else {
    params.set("cycle_id", ALL_CYCLES);
    params.set("from", span.from);
    params.set("to", span.to);
  }
  if (figure === "income") params.set("type", "INC");
  if (figure === "expenses") params.set("type", "EXP");
  if (accountId) params.set("account_id", accountId);
  return `/transactions?${params.toString()}`;
}
