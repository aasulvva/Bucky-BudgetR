// Reports on Stats & reports (#125): a period, filters for the whole
// report, and modules (graphs) that may compare with the previous period or
// break down by month or cycle. What's here is pure: the settings, the
// built-in starters, the previous period and the sub-periods.

import dayjs from "dayjs";

import type { components } from "@/api/schema";
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

export type ReportSettings = components["schemas"]["ReportSettings"];
export type ReportModule = components["schemas"]["ReportModule"];
export type ReportGraph = components["schemas"]["ReportGraph"];
export type ReportTemplate = components["schemas"]["ReportTemplate"];
export type CompareTo = NonNullable<ReportSettings["compare_to"]>;
export type ModuleCompare = NonNullable<ReportModule["compare"]>;
export type Breakdown = NonNullable<ReportModule["breakdown"]>;

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

/**
 * The graph a module draws: its own settings with the report's period, and
 * the report's filters where the module doesn't set its own.
 */
export function moduleGraph(report: ReportSettings, module: ReportModule): GraphSettings {
  const g = module.graph;
  const own = <T>(list: T[] | undefined, fallback: T[] | undefined) =>
    list?.length ? list : fallback;
  const counterparty = g.counterparty?.trim() ? g.counterparty : report.counterparty;
  return cleanGraph({
    ...g,
    period: report.period,
    account_ids: own(g.account_ids, report.account_ids),
    bucket_ids: own(g.bucket_ids, report.bucket_ids),
    tags: own(g.tags, report.tags),
    counterparty,
  });
}

/** Which of the report's filters a module sets itself. */
export function ownFilters(
  module: ReportModule,
): ("accounts" | "buckets" | "tags" | "counterparty")[] {
  const g = module.graph;
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
  out.modules = r.modules.map((m) => {
    const graph = withoutPeriod(cleanGraph({ ...m.graph, period: r.period }));
    const clean: ReportModule = { id: m.id, type: m.type, graph };
    if (m.title?.trim()) clean.title = m.title.trim();
    if (m.compare && m.compare !== "off") clean.compare = m.compare;
    if (m.breakdown && m.breakdown !== "none") clean.breakdown = m.breakdown;
    return clean;
  });
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

/** A module to add: spending this period as bars, by the report's resolution. */
export function newModule(report: ReportSettings): ReportModule {
  return {
    id: newId(
      "m",
      report.modules.map((m) => m.id),
    ),
    type: "graph",
    graph: { kind: "bar", metric: "spending", resolution: "month" },
  };
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
