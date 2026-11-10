// Reports on Stats & reports (#125): a period, filters for the whole
// report, and modules: graphs that may compare with the previous period or
// break down by month or cycle, and transaction lists (#126). What's here is
// pure: the settings, the built-in starters, the previous period and the
// sub-periods.

import dayjs from "dayjs";

import type { components } from "@/api/schema";
import type { TransactionQuery } from "@/api/transactions";
import i18n from "@/i18n";

import { endAtFor, localDate, startAtFor, type LocalDate } from "./cycles";
import { cleanGraph, groupBy, maxIntervals, type GraphSettings } from "./graphs";
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
} from "./periods";
import { ALL_CYCLES, SYSTEM_TYPES, USER_TYPES, withFilter } from "./transactionList";

type ApiModule = components["schemas"]["ReportModule"];
type ApiReport = components["schemas"]["ReportSettings"];
type ApiTemplate = components["schemas"]["ReportTemplate"];
export type ReportGraph = components["schemas"]["ReportGraph"];
export type ReportTransactions = components["schemas"]["ReportTransactions"];
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

/** The API's module, by its type: each has its own settings. */
export type ReportModule = GraphModule | TransactionsModule;
export type ReportSettings = Omit<ApiReport, "modules"> & { modules: ReportModule[] };
export type ReportTemplate = Omit<ApiTemplate, "report"> & { report: ReportSettings };

export const MODULE_TYPES: ModuleType[] = ["graph", "transactions"];

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
    limit: TRANSACTIONS_PAGE,
  };
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
  const g = module.type === "graph" ? module.graph : module.transactions;
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
    const overlapping = cycles
      .filter(
        (c) =>
          c.id &&
          c.state !== "future" &&
          Date.parse(c.start_at) < to &&
          Date.parse(c.end_at) > from,
      )
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
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
    const graph = withoutPeriod(cleanGraph({ ...m.graph, period: r.period }));
    const clean: GraphModule = { id: m.id, type: m.type, ...title, graph };
    if (m.compare && m.compare !== "off") clean.compare = m.compare;
    if (m.breakdown && m.breakdown !== "none") clean.breakdown = m.breakdown;
    return clean;
  });
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
  return type === "transactions"
    ? { id, type, transactions: {} }
    : { id, type, graph: { kind: "bar", metric: "spending", resolution: "month" } };
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
