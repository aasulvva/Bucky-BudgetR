// BSU accounts (#214, spec §2.1).

import type { Account } from "@/api/accounts";
import type { BsuHistory, BsuRule } from "@/api/bsu";
import { ApiError } from "@/api/errors";
import i18n from "@/i18n";

import { addAmounts, compareAmounts, formatMoney, subtractAmounts } from "./money";

/** What the server asks to confirm before recording a transaction. */
export type BsuAsk = "bsu_over_limit" | "bsu_withdrawal";

/** What the server asks to confirm, if error is a BSU 409. */
export function bsuAsk(error: unknown): BsuAsk | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.code === "bsu_over_limit" || error.code === "bsu_withdrawal"
    ? error.code
    : undefined;
}

/** The earliest year a BSU can say it was opened, as the API checks. */
export const MIN_OPENED_YEAR = 1990;

/** Only a BSU in this currency can be set up. */
export const BSU_CURRENCY = "NOK";

/** Whether the account is a BSU locked until its history is set up. */
export function isLockedBsu(account: Account | undefined): boolean {
  return account?.bsu?.locked === true;
}

/** The short line for a list row: what's left this year, or locked. */
export function bsuShort(account: Account): string | null {
  const st = account.bsu;
  if (!st) return null;
  if (st.locked) return i18n.t("bsu.locked.title");
  return i18n.t("bsu.leftHint", { amount: formatMoney(st.left_year, account.currency) });
}

/**
 * The rule for year: the latest from-year at or before it, or the first
 * for years before them all. rules is oldest first.
 */
export function ruleFor(rules: BsuRule[], year: number): BsuRule | undefined {
  let out = rules[0];
  for (const r of rules) if (r.from_year <= year) out = r;
  return out;
}

/** One year of the setup: what the bank shows, and what the app has. */
export interface SetupRow {
  year: number;
  deposits: string | null;
  interest: string | null;
  withdrawals: string | null;
  /** What's recorded: each amount's minimum. */
  min: { deposits: string; interest: string; withdrawals: string };
  /** How many transactions make up each of min. */
  count: { deposits: number; interest: number; withdrawals: number };
}

export type SetupField = "deposits" | "interest" | "withdrawals";
export const SETUP_FIELDS: SetupField[] = ["deposits", "interest", "withdrawals"];

const ZERO = { deposits: "0.00", interest: "0.00", withdrawals: "0.00" };
const NONE = { deposits: 0, interest: 0, withdrawals: 0 };

/** This year: the history's last year. */
export function thisYear(history: BsuHistory): number {
  return history.years.at(-1)?.year ?? history.latest_opened_year;
}

/**
 * The rows from openedYear to this year, each prefilled with what's
 * recorded, or what was entered in prev.
 */
export function setupRows(
  history: BsuHistory,
  openedYear: number,
  prev: SetupRow[] = [],
): SetupRow[] {
  const rows: SetupRow[] = [];
  for (let year = openedYear; year <= thisYear(history); year++) {
    const had = history.years.find((y) => y.year === year);
    const min = had?.recorded ?? ZERO;
    const old = prev.find((r) => r.year === year);
    rows.push(old ?? { year, ...min, min, count: had?.recorded_count ?? NONE });
  }
  return rows;
}

/** Why a field is wrong, or undefined: empty, or below what's recorded. */
export function fieldProblem(
  row: SetupRow,
  field: SetupField,
): "empty" | "belowRecorded" | undefined {
  const v = row[field];
  if (v === null) return "empty";
  if (compareAmounts(v, row.min[field]) < 0) return "belowRecorded";
  return undefined;
}

/** A year's deposits above its yearly limit, or undefined. */
export function overYear(row: SetupRow, rules: BsuRule[]): string | undefined {
  const rule = ruleFor(rules, row.year);
  if (!rule || row.deposits === null) return undefined;
  return compareAmounts(row.deposits, rule.yearly_limit) > 0
    ? subtractAmounts(row.deposits, rule.yearly_limit)
    : undefined;
}

/** All deposits above this year's total limit, or undefined. */
export function overTotal(history: BsuHistory, rows: SetupRow[]): string | undefined {
  const rule = ruleFor(history.rules, thisYear(history));
  if (!rule) return undefined;
  const total = addAmounts("0", ...rows.map((r) => r.deposits ?? "0"));
  return compareAmounts(total, rule.total_limit) > 0
    ? subtractAmounts(total, rule.total_limit)
    : undefined;
}

/** What the setup records, as the server will (spec §2.1). */
export interface SetupPlan {
  /** The opening balances' correction to 0, if they aren't 0. */
  opening: string | null;
  /** Per year what's added: the difference to what's recorded. */
  years: { year: number; deposits: string; interest: string; withdrawals: string }[];
  /** The balance adjustment to today's balance, if needed. */
  adjustment: string | null;
}

export function setupPlan(history: BsuHistory, rows: SetupRow[], balance: string): SetupPlan {
  const opening =
    compareAmounts(history.opening, "0") !== 0 ? subtractAmounts("0", history.opening) : null;
  let after = subtractAmounts(history.balance, history.opening);
  const years: SetupPlan["years"] = [];
  for (const r of rows) {
    const add = {
      year: r.year,
      deposits: subtractAmounts(r.deposits ?? r.min.deposits, r.min.deposits),
      interest: subtractAmounts(r.interest ?? r.min.interest, r.min.interest),
      withdrawals: subtractAmounts(r.withdrawals ?? r.min.withdrawals, r.min.withdrawals),
    };
    after = subtractAmounts(addAmounts(after, add.deposits, add.interest), add.withdrawals);
    if ([add.deposits, add.interest, add.withdrawals].some((a) => compareAmounts(a, "0") !== 0)) {
      years.push(add);
    }
  }
  const diff = subtractAmounts(balance, after);
  return { opening, years, adjustment: compareAmounts(diff, "0") !== 0 ? diff : null };
}
