// Reports on Stats & reports (#125): a period, filters for the whole
// report, and modules: graphs that may compare with the previous period or
// break down by month or cycle, transaction lists, in/out/balance tables and
// budget vs spending per cycle (#126). What's here is
// pure: the settings, the built-in starters, the previous period and the
// sub-periods.

import dayjs from "dayjs";

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { components } from "@/api/schema";
import type { BucketFlowValues, FlowsQuery, StatsFlows } from "@/api/stats";
import type { Transaction, TransactionQuery } from "@/api/transactions";
import i18n from "@/i18n";

import {
  addDays,
  endAtFor,
  formatDateRange,
  localDate,
  startAtFor,
  type LocalDate,
} from "./cycles";
import { formatDay } from "./dates";
import {
  cleanGraph,
  groupBy,
  maxIntervals,
  periodLabel,
  specificLabel,
  type GraphSettings,
} from "./graphs";
import { addAmounts, compareAmounts, percentOf, subtractAmounts } from "./money";
import {
  defaultResolution,
  formatPeriod,
  intervalCount,
  parsePeriod,
  resolvePeriod,
  stepSpecific,
  wholePeriod,
  type Period,
  type PeriodChoice,
  type Resolution,
  type SpecificUnit,
  weekStart,
} from "./periods";
import { ALL_CYCLES, SYSTEM_TYPES, USER_TYPES, withFilter } from "./transactionList";
import { DEFAULT_COLUMNS } from "./transactionTable";

type ApiModule = components["schemas"]["ReportModule"];
type ApiReport = components["schemas"]["ReportSettings"];
type ApiTemplate = components["schemas"]["ReportTemplate"];
export type ReportGraph = components["schemas"]["ReportGraph"];
export type ReportTransactions = components["schemas"]["ReportTransactions"];
export type ReportFlows = components["schemas"]["ReportFlows"];
export type ReportBudget = components["schemas"]["ReportBudget"];
export type CompareTo = NonNullable<ApiReport["compare_to"]>;
export type ModuleCompare = NonNullable<ApiModule["compare"]>;
export type Breakdown = NonNullable<ApiModule["breakdown"]>;
export type ModuleType = ApiModule["type"];

/** A graph module (#125). */
export interface GraphModule {
  id: string;
  type: "graph";
  title?: string;
  graph: ReportGraph;
  compare?: ModuleCompare;
  breakdown?: Breakdown;
}

/** A transactions module (#126): the period's transactions, as the Transactions list shows them. */
export interface TransactionsModule {
  id: string;
  type: "transactions";
  title?: string;
  transactions: ReportTransactions;
}

/** An In/out/balance module (#126): the buckets' and accounts' money in and out. */
export interface FlowsModule {
  id: string;
  type: "flows";
  title?: string;
  flows: ReportFlows;
}

/** A budget vs spending module (#126): each bucket's budget, used and left per cycle. */
export interface BudgetModule {
  id: string;
  type: "budget";
  title?: string;
  budget: ReportBudget;
}

/** The API's module, by its type: each has its own settings. */
export type ReportModule = GraphModule | TransactionsModule | FlowsModule | BudgetModule;
export type ReportSettings = Omit<ApiReport, "modules"> & { modules: ReportModule[] };
export type ReportTemplate = Omit<ApiTemplate, "report"> & { report: ReportSettings };

export const MODULE_TYPES: ModuleType[] = ["graph", "transactions", "flows", "budget"];
export type FlowsShow = NonNullable<ReportFlows["show"]>;
export const FLOWS_SHOWS: FlowsShow[] = ["buckets", "accounts", "both"];
export type FlowsView = NonNullable<ReportFlows["view"]>;
export const FLOWS_VIEWS: FlowsView[] = ["table", "grid"];
export type TransactionsGroup = NonNullable<ReportTransactions["group_by"]>;
export type TransactionsOrder = NonNullable<ReportTransactions["order"]>;
export const TRANSACTIONS_GROUPS: TransactionsGroup[] = ["day", "week", "month", "cycle"];
export const TRANSACTIONS_ORDERS: TransactionsOrder[] = ["newest", "oldest"];
export type TransactionsSections = NonNullable<ReportTransactions["sections"]>;
export const TRANSACTIONS_SECTIONS: TransactionsSections[] = ["off", "month", "cycle"];

/** The units a report's period can have, besides custom dates. */
export const REPORT_UNITS = ["cycle", "month", "quarter", "half_year", "year"] as const;
export type ReportUnit = (typeof REPORT_UNITS)[number];
export const COMPARE_TOS: CompareTo[] = ["previous", "last_year"];
export const MODULE_COMPARES: ModuleCompare[] = ["off", "both", "difference"];
export const BREAKDOWNS: Breakdown[] = ["none", "month", "cycle"];
/** The most templates and modules (the API's limits). */
export const MAX_TEMPLATES = 20;
export const MAX_MODULES = 20;
/** A breakdown needs a period this long, in days. */
export const BREAKDOWN_MIN_DAYS = 60;
/** The most small graphs a breakdown draws. */
export const MAX_SUB_PERIODS = 24;

interface CycleTimes {
  id?: string;
  start_at: string;
  end_at: string;
  state: string;
}

function isReportUnit(unit: string): unit is ReportUnit {
  return (REPORT_UNITS as readonly string[]).includes(unit);
}

/** Whether a report can have this period: no "last N", days or weeks. */
export function isReportPeriod(choice: PeriodChoice): boolean {
  return choice.kind === "custom" || (choice.kind !== "last" && isReportUnit(choice.unit));
}

export function parseReportPeriod(s: string | null | undefined): PeriodChoice | null {
  const choice = parsePeriod(s);
  return choice && isReportPeriod(choice) ? choice : null;
}

/** The built-in templates, which aren't stored; Save as keeps a copy. */
export const STARTERS = {
  yearly: {
    period: "previous-year",
    modules: [
      {
        id: "m-1",
        type: "graph",
        graph: { kind: "pie", metric: "spending", resolution: "month", group_by: "bucket" },
      },
      {
        id: "m-2",
        type: "graph",
        graph: { kind: "bar", metric: "spending", resolution: "month" },
        compare: "both",
      },
      {
        id: "m-3",
        type: "graph",
        graph: { kind: "line", metric: "balance", resolution: "month", group_by: "account" },
      },
    ],
  },
  cycle: {
    period: "previous-cycle",
    modules: [
      {
        id: "m-1",
        type: "graph",
        graph: { kind: "pie", metric: "spending", resolution: "day", group_by: "bucket" },
      },
      {
        id: "m-2",
        type: "graph",
        graph: {
          kind: "bar",
          metric: "spending",
          resolution: "total",
          group_by: "bucket",
          side_by_side: true,
        },
        compare: "both",
      },
      {
        id: "m-3",
        type: "graph",
        graph: { kind: "line", metric: "balance", resolution: "day" },
      },
    ],
  },
} as const satisfies Record<string, ReportSettings>;
export type StarterId = keyof typeof STARTERS;
export const STARTER_IDS = Object.keys(STARTERS) as StarterId[];

/** A deep copy of a starter, to change. */
export function starter(id: StarterId): ReportSettings {
  return structuredClone(STARTERS[id]);
}

/** A module from the API, by its type; null without its type's settings, which the server refuses. */
function readModule(m: ApiModule): ReportModule | null {
  const base = { id: m.id, ...(m.title === undefined ? {} : { title: m.title }) };
  if (m.type === "transactions") {
    return m.transactions ? { ...base, type: "transactions", transactions: m.transactions } : null;
  }
  if (m.type === "flows") {
    return m.flows ? { ...base, type: "flows", flows: m.flows } : null;
  }
  if (m.type === "budget") {
    return m.budget ? { ...base, type: "budget", budget: m.budget } : null;
  }
  if (!m.graph) return null;
  return {
    ...base,
    type: "graph",
    graph: m.graph,
    ...(m.compare === undefined ? {} : { compare: m.compare }),
    ...(m.breakdown === undefined ? {} : { breakdown: m.breakdown }),
  };
}

/** The saved templates from the preferences, with their modules by type. */
export function readTemplates(list: ApiTemplate[]): ReportTemplate[] {
  return list.map((x) => ({
    ...x,
    report: {
      ...x.report,
      modules: x.report.modules.flatMap((m) => readModule(m) ?? []),
    },
  }));
}

/** The module's filters where it sets them, else the report's (#125). */
function effectiveFilters<
  T extends Pick<ReportSettings, "account_ids" | "bucket_ids" | "tags" | "counterparty">,
>(report: ReportSettings, own: T): T {
  const pick = <V>(list: V[] | undefined, fallback: V[] | undefined) =>
    list?.length ? list : fallback;
  return {
    ...own,
    account_ids: pick(own.account_ids, report.account_ids),
    bucket_ids: pick(own.bucket_ids, report.bucket_ids),
    tags: pick(own.tags, report.tags),
    counterparty: own.counterparty?.trim() ? own.counterparty : report.counterparty,
  };
}

/**
 * The graph a module draws: its own settings with the report's period, and
 * the report's filters where the module doesn't set its own.
 */
export function moduleGraph(report: ReportSettings, module: GraphModule): GraphSettings {
  return cleanGraph({ ...effectiveFilters(report, module.graph), period: report.period });
}

/** A transactions module's settings, with the report's filters where it doesn't set its own. */
export function moduleTransactions(
  report: ReportSettings,
  module: TransactionsModule,
): ReportTransactions {
  return effectiveFilters(report, module.transactions);
}

/** An In/out/balance module's settings, with the report's accounts and buckets where it sets none. */
export function moduleFlows(report: ReportSettings, module: FlowsModule): ReportFlows {
  const f = module.flows;
  return {
    ...f,
    account_ids: f.account_ids?.length ? f.account_ids : report.account_ids,
    bucket_ids: f.bucket_ids?.length ? f.bucket_ids : report.bucket_ids,
  };
}

/** A budget vs spending module's settings, with the report's accounts and buckets where it sets none. */
export function moduleBudget(report: ReportSettings, module: BudgetModule): ReportBudget {
  const b = module.budget;
  return {
    ...b,
    account_ids: b.account_ids?.length ? b.account_ids : report.account_ids,
    bucket_ids: b.bucket_ids?.length ? b.bucket_ids : report.bucket_ids,
  };
}

/** The flows API's query for a module over a period, per month, cycle or in total. */
export function flowsQuery(
  f: ReportFlows,
  period: Period,
  resolution: FlowsQuery["resolution"],
): FlowsQuery {
  return {
    from: period.fromAt,
    to: period.toAt,
    resolution,
    ...(f.account_ids?.length ? { account_id: f.account_ids } : {}),
    ...(f.bucket_ids?.length ? { bucket_id: f.bucket_ids } : {}),
  };
}

/** The bucket table's amount columns, and those added by Show details. */
export const BUCKET_FIGURES = ["start", "in", "out", "end"] as const;
export const BUCKET_DETAILS = [
  "start",
  "refills",
  "income",
  "opening_funds",
  "adjustments_in",
  "transfers_in",
  "in",
  "spent",
  "overflow",
  "adjustments_out",
  "transfers_out",
  "out",
  "end",
] as const satisfies readonly (keyof BucketFlowValues)[];
export type BucketFigure = (typeof BUCKET_DETAILS)[number];
/**
 * The accounts table's columns: in and out with or without transfers, and
 * the net; with balances (#187), the start, what else moved it (opening
 * balances, adjustments, uncounted transfers) and the end.
 */
export const ACCOUNT_FIGURES = ["in", "out", "net"] as const;
export const ACCOUNT_DETAILS = [
  "income",
  "transfers_in",
  "in",
  "expenses",
  "transfers_out",
  "out",
  "net",
] as const;
export const ACCOUNT_BALANCE_FIGURES = ["start", "in", "out", "net", "other", "end"] as const;
export const ACCOUNT_BALANCE_DETAILS = [
  "start",
  "income",
  "transfers_in",
  "in",
  "expenses",
  "transfers_out",
  "out",
  "net",
  "other",
  "end",
] as const;
export type AccountFigure = (typeof ACCOUNT_BALANCE_DETAILS)[number];

/** An account figure's name: its transfers are between accounts. */
export function accountFigureLabel(c: AccountFigure): string {
  return c === "transfers_in" || c === "transfers_out"
    ? i18n.t(`stats.reports.flows.accountColumns.${c}`)
    : i18n.t(`stats.reports.flows.columns.${c}`);
}

/** The accounts' columns for the module's settings. */
export function accountColumns(details: boolean, balances: boolean): readonly AccountFigure[] {
  if (balances) return details ? ACCOUNT_BALANCE_DETAILS : ACCOUNT_BALANCE_FIGURES;
  return details ? ACCOUNT_DETAILS : ACCOUNT_FIGURES;
}

export interface FlowRow<F extends string> {
  /** The bucket's or account's id; "" for a total. */
  id: string;
  name: string;
  currency: string;
  values: Record<F, string>;
  /**
   * When it opened, if in this interval (#187): its start is its opening
   * balance or funds, as nothing is known from before.
   */
  openedAt?: string;
}

export interface FlowTables {
  buckets: { rows: FlowRow<BucketFigure>[]; totals: FlowRow<BucketFigure>[] };
  accounts: { rows: FlowRow<AccountFigure>[]; totals: FlowRow<AccountFigure>[] };
}

const isZero = (a: string) => compareAmounts(a, "0") === 0;

/** Totals per currency, in the order the currencies first come. */
function totals<F extends string>(rows: FlowRow<F>[], keys: readonly F[]): FlowRow<F>[] {
  const out = new Map<string, FlowRow<F>>();
  for (const r of rows) {
    const t = out.get(r.currency);
    if (!t) {
      out.set(r.currency, { id: "", name: "", currency: r.currency, values: { ...r.values } });
      continue;
    }
    for (const k of keys) t.values[k] = addAmounts(t.values[k], r.values[k]);
  }
  return [...out.values()];
}

/**
 * One interval of the flows as table rows: a row per bucket and per account,
 * by name, without the ones where nothing happened, and a total per
 * currency. With `transfers`, an account's transfers count as in and out.
 * With `balances` (#187), an account with a balance at the start or end
 * counts as something happening.
 */
export function flowTables(
  result: StatsFlows,
  index: number,
  accounts: Account[],
  buckets: Bucket[],
  { transfers, balances }: { transfers: boolean; balances: boolean },
  locale?: string,
): FlowTables {
  const shown = balances ? ACCOUNT_BALANCE_DETAILS : ACCOUNT_DETAILS;
  const interval = result.intervals[index];
  const openedIn = (at: string | undefined) =>
    at !== undefined &&
    interval !== undefined &&
    Date.parse(at) >= Date.parse(interval.start) &&
    Date.parse(at) < Date.parse(interval.end)
      ? { openedAt: at }
      : {};
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, locale);
  const bucketRows: FlowRow<BucketFigure>[] = result.buckets
    .flatMap((b) => {
      const v = b.values[index];
      if (!v || BUCKET_DETAILS.every((k) => isZero(v[k]))) return [];
      const name = buckets.find((x) => x.id === b.bucket_id)?.name ?? b.bucket_id;
      const values = Object.fromEntries(BUCKET_DETAILS.map((k) => [k, v[k]])) as Record<
        BucketFigure,
        string
      >;
      return [{ id: b.bucket_id, name, currency: b.currency, values, ...openedIn(b.opened_at) }];
    })
    .sort(byName);
  const accountRows: FlowRow<AccountFigure>[] = result.accounts
    .flatMap((a) => {
      const v = a.values[index];
      if (!v) return [];
      const tin = transfers ? v.transfers_in : "0.00";
      const tout = transfers ? v.transfers_out : "0.00";
      const into = addAmounts(v.income, tin);
      const out = addAmounts(v.expenses, tout);
      const net = subtractAmounts(into, out);
      const values: Record<AccountFigure, string> = {
        start: v.start,
        income: v.income,
        transfers_in: tin,
        in: into,
        expenses: v.expenses,
        transfers_out: tout,
        out,
        net,
        // Whatever else moved the balance, so start + net + other = end.
        other: subtractAmounts(subtractAmounts(v.end, v.start), net),
        end: v.end,
      };
      if (shown.every((k) => isZero(values[k]))) return [];
      const name = accounts.find((x) => x.id === a.account_id)?.name ?? a.account_id;
      return [{ id: a.account_id, name, currency: a.currency, values, ...openedIn(a.opened_at) }];
    })
    .sort(byName);
  return {
    buckets: { rows: bucketRows, totals: totals(bucketRows, BUCKET_DETAILS) },
    accounts: { rows: accountRows, totals: totals(accountRows, ACCOUNT_BALANCE_DETAILS) },
  };
}

/** A budget vs spending table's amount columns. */
export const BUDGET_FIGURES = ["budget", "used", "unspent", "carried"] as const;
export type BudgetFigure = (typeof BUDGET_FIGURES)[number];

export interface BudgetRow extends FlowRow<BudgetFigure> {
  /** Used as a share of the budget; null while the budget isn't above 0. */
  usedPct: number | null;
}

function withPct(r: FlowRow<BudgetFigure>): BudgetRow {
  const pct =
    compareAmounts(r.values.budget, "0") > 0 ? percentOf(r.values.used, r.values.budget) : null;
  return { ...r, usedPct: pct };
}

/**
 * One cycle's bucket figures as table rows: the buckets the module's
 * filters match (an account filter by the bucket's source account), by
 * name, without the ones where nothing happened, and a total per currency.
 *
 * Budget is what could be spent: without what a refill's overflow capped
 * at BC (Keep funds). Unspent is Budget − Used, below 0 when overspent.
 * Carried over is what went into the next cycle (Left): 0 or the overspent
 * part for a bucket without Keep funds, whose unspent part is swept at the
 * cycle's end.
 */
export function budgetRows(
  figures: BucketFigures[],
  buckets: Bucket[],
  filters: ReportBudget,
  locale?: string,
): { rows: BudgetRow[]; totals: BudgetRow[] } {
  const accountIds = filters.account_ids?.length ? new Set(filters.account_ids) : null;
  const bucketIds = filters.bucket_ids?.length ? new Set(filters.bucket_ids) : null;
  const rows: FlowRow<BudgetFigure>[] = figures
    .flatMap((f) => {
      const b = buckets.find((x) => x.id === f.bucket_id);
      if (!b) return [];
      if (bucketIds && !bucketIds.has(b.id)) return [];
      if (accountIds && !accountIds.has(b.source_account_id)) return [];
      if ([f.start, f.budget, f.used, f.overflow, f.left].every(isZero)) return [];
      const budget = subtractAmounts(f.budget, f.capped);
      return [
        {
          id: b.id,
          name: b.name,
          currency: b.currency,
          values: {
            budget,
            used: f.used,
            unspent: subtractAmounts(budget, f.used),
            carried: f.left,
          },
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  return { rows: rows.map(withPct), totals: totals(rows, BUDGET_FIGURES).map(withPct) };
}

const SUMMED_PARTS = [
  "refills",
  "income",
  "opening_funds",
  "adjustments",
  "transfers",
  "used",
  "overflow",
  "capped",
  "swept",
] as const;

/**
 * The bucket figures of several cycles, oldest first, as one: the first
 * cycle's start, what was put in, used and overflowed in them all, and the
 * last one's left. A later cycle's budget counts without the funds it
 * brought along, which the cycle before counted already. What it brought
 * along overspent stays in, as in that cycle's own budget: the refill that
 * tops up a bucket without Keep funds isn't more to spend.
 */
export function budgetSummary(perCycle: BucketFigures[][]): BucketFigures[] {
  const out = new Map<string, BucketFigures>();
  for (const cycle of perCycle) {
    for (const f of cycle) {
      const s = out.get(f.bucket_id);
      if (!s) {
        out.set(f.bucket_id, { ...f });
        continue;
      }
      for (const k of SUMMED_PARTS) s[k] = addAmounts(s[k], f[k]);
      const brought = compareAmounts(f.start, "0") > 0 ? f.start : "0.00";
      s.budget = addAmounts(s.budget, subtractAmounts(f.budget, brought));
      s.left = f.left;
    }
  }
  return [...out.values()];
}

/** A transactions module shows this many at first, and as many more on Load more. */
export const TRANSACTIONS_PAGE = 50;

/** The list API's query for a transactions module over the period. */
export function transactionsQuery(t: ReportTransactions, period: Period): TransactionQuery {
  const types = t.types?.length ? t.types : USER_TYPES;
  const counterparty = t.counterparty?.trim();
  return {
    type: t.system ? [...new Set([...types, ...SYSTEM_TYPES])] : [...types],
    from: period.fromAt,
    to: period.toAt,
    ...(t.account_ids?.length ? { account_id: t.account_ids } : {}),
    ...(t.bucket_ids?.length ? { bucket_id: t.bucket_ids } : {}),
    ...(t.tags?.length ? { tag: t.tags } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(t.reversed ? {} : { reversed: false }),
    ...(t.order === "oldest" ? { order: "oldest" as const } : {}),
    limit: TRANSACTIONS_PAGE,
  };
}

export interface TransactionGroup {
  /** The day, the week's or month's first day, or the cycle's id ("" outside any). */
  key: string;
  label: string;
  items: Transaction[];
}

/**
 * Transactions under a heading per day, week (from the locale's first day),
 * month or cycle, in the order given (newest or oldest first).
 */
export function groupTransactions(
  items: Transaction[],
  by: TransactionsGroup,
  cycles: CycleTimes[],
  locale?: string,
): TransactionGroup[] {
  const keyOf = (tx: Transaction): string => {
    const day = localDate(tx.at);
    switch (by) {
      case "day":
        return day;
      case "week": {
        // dayjs: 0 = Sunday; the locale's week: 1 = Monday … 7 = Sunday.
        const d = dayjs(day).day();
        const weekday = d === 0 ? 7 : d;
        return addDays(day, -((weekday - weekStart(locale) + 7) % 7));
      }
      case "month":
        return `${day.slice(0, 7)}-01`;
      case "cycle": {
        const at = Date.parse(tx.at);
        const c = cycles.find((x) => Date.parse(x.start_at) <= at && at < Date.parse(x.end_at));
        return c?.id ?? "";
      }
    }
  };
  const labelOf = (key: string): string => {
    if (by === "day") return formatDay(key, locale);
    if (by === "cycle" && key === "") return i18n.t("stats.reports.transactions.noCycle");
    return specificLabel({ kind: "specific", unit: by, at: key }, cycles, locale);
  };
  const out: TransactionGroup[] = [];
  for (const tx of items) {
    const key = keyOf(tx);
    const last = out.at(-1);
    if (last?.key === key) last.items.push(tx);
    else out.push({ key, label: labelOf(key), items: [tx] });
  }
  return out;
}

export interface TransactionSection {
  /** The month's first day or the cycle's id; "" for those outside any cycle. */
  key: string;
  /** The month or cycle; null for those outside any cycle. */
  part: SubPeriod | null;
  items: Transaction[];
  /** All of its transactions are loaded, so its summary is whole. */
  complete: boolean;
}

/**
 * A transactions module's sections (#191): each of the period's months or
 * cycles (`parts`, oldest first) in the module's order, empty ones too, and
 * those outside any cycle last. While more pages are left, only the
 * sections up to the last loaded transaction, since those after it aren't
 * known yet, and the one it's in isn't complete.
 */
export function transactionSections(
  items: Transaction[],
  parts: SubPeriod[],
  order: TransactionsOrder,
  hasNextPage: boolean,
): TransactionSection[] {
  const ordered = order === "oldest" ? parts : [...parts].reverse();
  const range = (p: SubPeriod) => [Date.parse(p.period.fromAt), Date.parse(p.period.toAt)];
  const sections: TransactionSection[] = ordered.map((p) => ({
    key: p.choice.at,
    part: p,
    items: [],
    complete: true,
  }));
  const outside: TransactionSection = { key: "", part: null, items: [], complete: !hasNextPage };
  for (const tx of items) {
    const at = Date.parse(tx.at);
    const s = sections.find((x) => {
      if (!x.part) return false;
      const [from = 0, to = 0] = range(x.part);
      return from <= at && at < to;
    });
    (s ?? outside).items.push(tx);
  }
  if (outside.items.length > 0) sections.push(outside);
  const last = items.at(-1);
  if (!hasNextPage || !last) return sections;
  // The last one loaded; those at its time may go on on the next page.
  const at = Date.parse(last.at);
  return sections.flatMap((x) => {
    if (!x.part) return [x];
    const [from = 0, to = 0] = range(x.part);
    const after = order === "oldest" ? to <= at : from > at;
    const holds = from <= at && at < to;
    if (after) return [x];
    if (holds) return [{ ...x, complete: false }];
    return [];
  });
}

/**
 * The Transactions screen with the same list: the period, and the filters.
 * Null while a filter has several values, which that screen can't show yet
 * (#162). `open` opens a transaction there.
 */
export function transactionsLink(
  t: ReportTransactions,
  period: Period,
  open?: string,
): string | null {
  // null: not filtered; undefined: several values.
  const one = <V>(list: V[] | undefined): V | null | undefined =>
    !list?.length ? null : list.length === 1 ? list[0] : undefined;
  const accountId = one(t.account_ids);
  const bucketId = one(t.bucket_ids);
  const tag = one(t.tags);
  const type = one(t.types);
  const several = [accountId, bucketId, tag, type].some((x) => x === undefined);
  // One type and the system types too isn't one of that screen's choices.
  if (several || (type && t.system)) return open ? periodLink(period, open) : null;
  const params = withFilter(new URLSearchParams(), {
    cycleId: ALL_CYCLES,
    from: period.from,
    to: period.to,
    accountId: accountId ?? null,
    bucketId: bucketId ?? null,
    tag: tag ?? null,
    type: type ?? null,
    q: t.counterparty?.trim() ?? "",
    system: t.system ?? false,
    reversed: t.reversed ?? false,
  });
  if (open) params.set("open", open);
  return `/transactions?${params.toString()}`;
}

/** The Transactions screen over the period, opening one transaction. */
function periodLink(period: Period, open: string): string {
  const params = withFilter(new URLSearchParams(), {
    cycleId: ALL_CYCLES,
    from: period.from,
    to: period.to,
  });
  params.set("open", open);
  return `/transactions?${params.toString()}`;
}

/** Which of the report's filters a module sets itself. */
export function ownFilters(
  module: ReportModule,
): ("accounts" | "buckets" | "tags" | "counterparty")[] {
  const g: Pick<ReportTransactions, "account_ids" | "bucket_ids" | "tags" | "counterparty"> =
    module.type === "graph"
      ? module.graph
      : module.type === "transactions"
        ? module.transactions
        : module.type === "flows"
          ? module.flows
          : module.budget;
  const out: ("accounts" | "buckets" | "tags" | "counterparty")[] = [];
  if (g.account_ids?.length) out.push("accounts");
  if (g.bucket_ids?.length) out.push("buckets");
  if (g.tags?.length) out.push("tags");
  if (g.counterparty?.trim()) out.push("counterparty");
  return out;
}

type Specific = Extract<PeriodChoice, { kind: "specific" }>;

/** The specific period a resolved choice is now; null for custom dates. */
function asSpecific(choice: PeriodChoice, period: Period, cycles: CycleTimes[]): Specific | null {
  if (choice.kind === "specific") return choice;
  if (choice.kind !== "current" && choice.kind !== "previous") return null;
  if (choice.unit === "cycle") {
    const c = cycles.find((x) => Date.parse(x.start_at) === Date.parse(period.fromAt));
    return c?.id ? { kind: "specific", unit: "cycle", at: c.id } : null;
  }
  return { kind: "specific", unit: choice.unit as SpecificUnit, at: period.from };
}

/** Whether a period is still going: it was cut at now. */
export function inProgress(period: Period): boolean {
  return Date.parse(period.toAt) < Date.parse(endAtFor(period.to));
}

/** What a report compares with, when it can: the period and its name. */
export interface ReportCompare {
  period: Period;
  label: string;
  /** The report's own period's name, beside it. */
  currentLabel: string;
}

/**
 * The report's period (#125): the choice, the period it resolves to now
 * (null without a cycle), its label ("Previous month"), its name now
 * ("October 2026", for a PDF, #127) and what it compares with.
 */
export function reportPeriods(
  report: ReportSettings,
  cycles: CycleTimes[],
): {
  choice: PeriodChoice;
  period: Period | null;
  label: string;
  name: string;
  compare: ReportCompare | null;
} {
  const choice = parseReportPeriod(report.period) ?? { kind: "previous", unit: "year" };
  const period = resolvePeriod(choice, cycles);
  const previous = period
    ? previousPeriod(choice, period, report.compare_to ?? "previous", cycles)
    : null;
  const label = periodLabel(choice, cycles);
  const compare =
    previous && period
      ? {
          period: previous.period,
          label: inProgress(period)
            ? formatDateRange(previous.period.from, previous.period.to)
            : specificLabel(previous.choice, cycles),
          currentLabel: label,
        }
      : null;
  const specific = period ? asSpecific(choice, period, cycles) : null;
  const name = specific
    ? specificLabel(specific, cycles)
    : period
      ? formatDateRange(period.from, period.to)
      : label;
  return { choice, period, label, name, compare };
}

/**
 * The period a report compares with: the one right before, or the same one
 * a year earlier (a cycle: always the one before). While this period is
 * still going, the previous one is cut to as long as this one has run, so
 * 1–9 November compares with 1–9 October. Null for custom dates, or when
 * there is no period before (the first cycle).
 */
export function previousPeriod(
  choice: PeriodChoice,
  period: Period,
  compareTo: CompareTo,
  cycles: CycleTimes[],
  now?: Date,
): { choice: Specific; period: Period } | null {
  const specific = asSpecific(choice, period, cycles);
  if (!specific) return null;
  const before: Specific | null =
    compareTo === "last_year" && specific.unit !== "cycle"
      ? { ...specific, at: dayjs(specific.at).subtract(1, "year").format("YYYY-MM-DD") }
      : (stepSpecific(specific, -1, cycles, now) as Specific | null);
  if (!before) return null;
  const whole = resolvePeriod(before, cycles, now);
  if (!whole) return null;
  if (!inProgress(period)) return { choice: before, period: whole };
  const ran = Date.parse(period.toAt) - Date.parse(period.fromAt);
  const end = Math.min(Date.parse(whole.fromAt) + ran, Date.parse(whole.toAt));
  const toAt = new Date(end).toISOString();
  return {
    choice: before,
    period: { ...whole, toAt, to: localDate(new Date(end - 1)) },
  };
}

export interface SubPeriod {
  choice: Specific;
  period: Period;
  /** Cut by the report period's edges, or still going. */
  partial: boolean;
}

export type SubPeriods =
  { ok: true; parts: SubPeriod[] } | { ok: false; reason: "short" | "many" | "none" };

/**
 * The months or cycles a module breaks its period down into, clipped to
 * it. Only for periods of at least 60 days (counted as the whole period, so
 * This year counts even in January), and at most 24 parts.
 */
export function subPeriods(
  choice: PeriodChoice,
  period: Period,
  by: Exclude<Breakdown, "none">,
  cycles: CycleTimes[],
  now?: Date,
): SubPeriods {
  const whole = wholePeriod(choice, cycles, now) ?? period;
  if (dayjs(whole.to).diff(dayjs(whole.from), "day") + 1 < BREAKDOWN_MIN_DAYS) {
    return { ok: false, reason: "short" };
  }
  return periodParts(period, by, cycles);
}

/**
 * The months or cycles of a period, oldest first and clipped to it, at
 * most MAX_SUB_PERIODS, for any length of period: a breakdown's parts, or a
 * transactions module's sections (#191).
 */
export function periodParts(
  period: Period,
  by: Exclude<Breakdown, "none">,
  cycles: CycleTimes[],
): SubPeriods {
  const from = Date.parse(period.fromAt);
  const to = Date.parse(period.toAt);
  const parts: SubPeriod[] = [];
  if (by === "month") {
    for (let m = dayjs(period.from).startOf("month"); m.format("YYYY-MM-DD") <= period.to;) {
      const first: LocalDate = m.format("YYYY-MM-DD");
      const last: LocalDate = m.endOf("month").format("YYYY-MM-DD");
      const f = first < period.from ? period.from : first;
      const t = last > period.to ? period.to : last;
      const p: Period = {
        from: f,
        to: t,
        fromAt: f === period.from ? period.fromAt : startAtFor(f),
        toAt: t === period.to ? period.toAt : endAtFor(t),
      };
      parts.push({
        choice: { kind: "specific", unit: "month", at: first },
        period: p,
        partial: f !== first || t !== last || inProgress(p),
      });
      if (parts.length > MAX_SUB_PERIODS) return { ok: false, reason: "many" };
      m = m.add(1, "month");
    }
  } else {
    const overlapping = overlappingCycles(cycles, from, to);
    if (overlapping.length > MAX_SUB_PERIODS) return { ok: false, reason: "many" };
    for (const c of overlapping) {
      const start = Math.max(Date.parse(c.start_at), from);
      const end = Math.min(Date.parse(c.end_at), to);
      parts.push({
        choice: { kind: "specific", unit: "cycle", at: c.id ?? "" },
        period: {
          from: localDate(new Date(start)),
          to: localDate(new Date(end - 1)),
          fromAt: new Date(start).toISOString(),
          toAt: new Date(end).toISOString(),
        },
        partial: start !== Date.parse(c.start_at) || end !== Date.parse(c.end_at),
      });
    }
  }
  return parts.length > 0 ? { ok: true, parts } : { ok: false, reason: "none" };
}

/** The cycles that have begun and overlap [from, to), oldest first. */
function overlappingCycles<C extends CycleTimes>(cycles: C[], from: number, to: number): C[] {
  return cycles
    .filter(
      (c) =>
        c.id && c.state !== "future" && Date.parse(c.start_at) < to && Date.parse(c.end_at) > from,
    )
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}

export interface PeriodCycle {
  id: string;
  /** The whole cycle, which a budget module shows even where the period cuts it. */
  period: Period;
  /** Runs past the report period's edges, by less than half its days. */
  partial: boolean;
  /** Still going. */
  active: boolean;
}

export type PeriodCycles =
  { ok: true; cycles: PeriodCycle[] } | { ok: false; reason: "many" | "none" };

/**
 * The cycles a budget module shows, whole and oldest first, at most
 * MAX_SUB_PERIODS: those that have begun and have most of their days in
 * the period, so that each cycle counts in one year's, quarter's or
 * month's report. Half its days count where the cycle starts. A period
 * shorter than that (a few custom days) gets the cycle with the most of
 * its days. Planned cycles have no figures yet.
 */
export function periodCycles(period: Period, cycles: CycleTimes[]): PeriodCycles {
  const days = (a: LocalDate, b: LocalDate) => dayjs(b).diff(dayjs(a), "day") + 1;
  const overlapping = overlappingCycles(
    cycles,
    Date.parse(period.fromAt),
    Date.parse(period.toAt),
  ).map((c) => {
    const from = localDate(c.start_at);
    const to = localDate(new Date(Date.parse(c.end_at) - 1));
    const inside = days(from < period.from ? period.from : from, to > period.to ? period.to : to);
    const total = days(from, to);
    return {
      cycle: c,
      from,
      to,
      inside,
      counts: inside * 2 > total || (inside * 2 === total && from >= period.from),
    };
  });
  let shown = overlapping.filter((c) => c.counts);
  if (shown.length === 0 && overlapping.length > 0) {
    const most = overlapping.reduce((a, b) => (b.inside > a.inside ? b : a));
    shown = [most];
  }
  if (shown.length === 0) return { ok: false, reason: "none" };
  if (shown.length > MAX_SUB_PERIODS) return { ok: false, reason: "many" };
  return {
    ok: true,
    cycles: shown.map(({ cycle: c, from, to }) => ({
      id: c.id ?? "",
      period: { from, to, fromAt: c.start_at, toAt: c.end_at },
      partial: from < period.from || to > period.to,
      active: c.state === "active",
    })),
  };
}

/** A graph's settings as a report module's: without the period, which is the report's. */
export function withoutPeriod(g: GraphSettings): ReportGraph {
  const out: Partial<GraphSettings> = { ...g };
  delete out.period;
  return out as ReportGraph;
}

/** Where the report on screen comes from: a built-in starter or a saved template. */
export type ReportSource = { kind: "starter"; id: StarterId } | { kind: "template"; id: string };

export function sourceValue(source: ReportSource): string {
  return `${source.kind}:${source.id}`;
}

/** The report without defaults and empty fields: what's saved and compared. */
export function cleanReport(r: ReportSettings): ReportSettings {
  const out: ReportSettings = { period: r.period, modules: [] };
  if (r.compare_to && r.compare_to !== "previous") out.compare_to = r.compare_to;
  if (r.account_ids?.length) out.account_ids = [...r.account_ids];
  if (r.bucket_ids?.length) out.bucket_ids = [...r.bucket_ids];
  if (r.tags?.length) out.tags = [...r.tags];
  if (r.counterparty?.trim()) out.counterparty = r.counterparty.trim();
  out.modules = r.modules.map((m): ReportModule => {
    const title = m.title?.trim() ? { title: m.title.trim() } : {};
    if (m.type === "transactions") {
      return { id: m.id, type: m.type, ...title, transactions: cleanTransactions(m.transactions) };
    }
    if (m.type === "flows") {
      return { id: m.id, type: m.type, ...title, flows: cleanFlows(m.flows) };
    }
    if (m.type === "budget") {
      const budget: ReportBudget = {};
      if (m.budget.account_ids?.length) budget.account_ids = [...m.budget.account_ids];
      if (m.budget.bucket_ids?.length) budget.bucket_ids = [...m.budget.bucket_ids];
      if (m.budget.per_cycle === false) budget.per_cycle = false;
      return { id: m.id, type: m.type, ...title, budget };
    }
    const graph = withoutPeriod(cleanGraph({ ...m.graph, period: r.period }));
    const clean: GraphModule = { id: m.id, type: m.type, ...title, graph };
    if (m.compare && m.compare !== "off") clean.compare = m.compare;
    if (m.breakdown && m.breakdown !== "none") clean.breakdown = m.breakdown;
    return clean;
  });
  return out;
}

/** An In/out/balance module's settings without defaults and empty fields. */
function cleanFlows(f: ReportFlows): ReportFlows {
  const out: ReportFlows = {};
  if (f.account_ids?.length) out.account_ids = [...f.account_ids];
  if (f.bucket_ids?.length) out.bucket_ids = [...f.bucket_ids];
  if (f.view === "grid") out.view = "grid";
  if (f.show && f.show !== "buckets") out.show = f.show;
  if (f.transfers) out.transfers = true;
  if (f.balances) out.balances = true;
  if (f.details) out.details = true;
  if (f.breakdown && f.breakdown !== "none") out.breakdown = f.breakdown;
  return out;
}

/** A transactions module's settings without defaults and empty fields. */
function cleanTransactions(t: ReportTransactions): ReportTransactions {
  const out: ReportTransactions = {};
  if (t.account_ids?.length) out.account_ids = [...t.account_ids];
  if (t.bucket_ids?.length) out.bucket_ids = [...t.bucket_ids];
  if (t.tags?.length) out.tags = [...t.tags];
  if (t.counterparty?.trim()) out.counterparty = t.counterparty.trim();
  if (t.types?.length) out.types = [...t.types];
  if (t.system) out.system = true;
  if (t.reversed) out.reversed = true;
  if (t.group_by && t.group_by !== "day") out.group_by = t.group_by;
  if (t.order === "oldest") out.order = t.order;
  if (t.sections && t.sections !== "off") out.sections = t.sections;
  if (t.view === "table") out.view = t.view;
  // The defaults are left out, so a table that keeps them stays unchanged.
  if (t.columns?.length && t.columns.join() !== DEFAULT_COLUMNS.join()) {
    out.columns = [...t.columns];
  }
  if (t.rows === "bucket_line") out.rows = t.rows;
  return out;
}

export function sameReport(a: ReportSettings, b: ReportSettings): boolean {
  return JSON.stringify(cleanReport(a)) === JSON.stringify(cleanReport(b));
}

/** A new id, not one of `used`: "<prefix>-<n>". */
export function newId(prefix: string, used: string[]): string {
  const taken = new Set(used);
  for (let i = used.length + 1; ; i++) {
    const id = `${prefix}-${String(i)}`;
    if (!taken.has(id)) return id;
  }
}

/** A module to add: spending this period as bars by month, or the period's transactions. */
export function newModule(report: ReportSettings, type: ModuleType = "graph"): ReportModule {
  const id = newId(
    "m",
    report.modules.map((m) => m.id),
  );
  if (type === "transactions") return { id, type, transactions: {} };
  if (type === "flows") return { id, type, flows: {} };
  if (type === "budget") return { id, type, budget: {} };
  return { id, type, graph: { kind: "bar", metric: "spending", resolution: "month" } };
}

/** The report's period with a different choice. */
export function withPeriod(report: ReportSettings, choice: PeriodChoice): ReportSettings {
  return { ...report, period: formatPeriod(choice) };
}

/**
 * The resolution of a breakdown's small graph: the module's, unless that
 * gives one interval at most in the part (months in a month), then one that
 * suits the part. A pie per bucket or account sums the part: no change.
 */
export function partResolution(
  graph: GraphSettings,
  part: SubPeriod,
  cycles: CycleTimes[],
  now?: Date,
): Resolution {
  if (graph.kind === "pie" && groupBy(graph) !== "none") return graph.resolution;
  if (intervalCount(part.period, graph.resolution, cycles, undefined, 2) >= 2) {
    return graph.resolution;
  }
  return defaultResolution(part.choice, cycles, maxIntervals(graph.kind), now);
}

/** A module's name: its title, or what it shows ("Spending · Month · Per bucket"). */
export function moduleTitle(module: ReportModule): string {
  if (module.title?.trim()) return module.title.trim();
  if (module.type === "transactions") return i18n.t("stats.reports.transactions.title");
  if (module.type === "flows") return i18n.t("stats.reports.flows.title");
  if (module.type === "budget") return i18n.t("stats.reports.budget.title");
  const g = module.graph;
  const group = groupBy({ ...g, period: "" });
  return [
    i18n.t(`stats.graphs.metrics.${g.metric}`),
    i18n.t(`stats.graphs.kinds.${g.kind}`),
    ...(g.kind === "pie" && group !== "none"
      ? []
      : [i18n.t(`stats.resolution.options.${g.resolution}`)]),
    ...(group === "none" ? [] : [i18n.t(`stats.graphs.groups.${group}`)]),
  ].join(" · ");
}
