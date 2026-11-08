// Line, bar and pie graphs on Stats & reports (#122, #123): the settings as
// they live in the URL and in saved graphs, the Stats API query they make,
// the rows and series a chart draws (or a pie's slices), how finely a graph
// fits its width, and the Transactions link for a bar, point or slice.

import type { Account, Bucket } from "@/api/accounts";
import type { components } from "@/api/schema";
import type { StatsQuery, StatsSeries } from "@/api/stats";
import i18n from "@/i18n";

import { addDays, cycleRange, formatDateRange, lastDay, localDate } from "./cycles";
import { CURRENCY, getLocale } from "./locale";
import { addAmounts, compareAmounts } from "./money";
import {
  coarser,
  defaultPeriod,
  defaultResolution,
  formatPeriod,
  intervalCount,
  MAX_BARS,
  MAX_POINTS,
  parsePeriod,
  parseResolution,
  type Period,
  type PeriodChoice,
  type Resolution,
} from "./periods";
import { ALL_CYCLES } from "./transactionList";

export type GraphSettings = components["schemas"]["GraphSettings"];
export type SavedGraph = components["schemas"]["SavedGraph"];
export type GraphKind = GraphSettings["kind"];
export type GraphMetric = GraphSettings["metric"];
export type GroupBy = NonNullable<GraphSettings["group_by"]>;
export type PieLabels = NonNullable<GraphSettings["pie_labels"]>;
/** What a pie's slices are. */
export type PieSlicing = "bucket" | "account" | "interval";

export const GRAPH_KINDS: GraphKind[] = ["bar", "line", "pie"];
export const PIE_LABELS: PieLabels[] = ["list", "slices", "both"];
export const GRAPH_METRICS: GraphMetric[] = ["spending", "income", "balance"];
export const GROUP_BYS: GroupBy[] = ["none", "account", "bucket"];
/** Series with their own colour: the graph palette has 8. */
export const MAX_TOP = 8;
export const DEFAULT_TOP = 5;
/** The most slices a pie per interval has: the graph palette's 12 colours. */
export const MAX_SLICES = 12;

interface CycleTimes {
  id?: string;
  start_at: string;
  end_at: string;
  state: string;
}

export function groupBy(s: GraphSettings): GroupBy {
  // Balances have no buckets: per bucket is per account. A balance pie is
  // always per account, since balances over time don't add up.
  const g = s.group_by ?? "none";
  if (s.metric === "balance" && (g === "bucket" || s.kind === "pie")) return "account";
  return g;
}

/** A pie's slices: per bucket or account over the whole period, or per interval when not split. */
export function pieSlicing(s: GraphSettings): PieSlicing {
  const g = groupBy(s);
  return g === "none" ? "interval" : g;
}

/** The resolution a graph asks the API for: a pie per bucket or account needs only the whole period. */
export function queryResolution(s: GraphSettings, fitted: Resolution): Resolution {
  return s.kind === "pie" && pieSlicing(s) !== "interval" ? "total" : fitted;
}

export function topOf(s: GraphSettings): number {
  return Math.max(1, Math.min(s.top ?? DEFAULT_TOP, MAX_TOP));
}

/** The most intervals a graph of this kind can draw. */
export function maxIntervals(kind: GraphKind): number {
  return kind === "bar" ? MAX_BARS : kind === "pie" ? MAX_SLICES : MAX_POINTS;
}

/** The graph to start with: spending this cycle (or month) as bars. */
export function defaultGraph(cycles: CycleTimes[], now?: Date): GraphSettings {
  const choice = defaultPeriod(cycles);
  return {
    kind: "bar",
    metric: "spending",
    period: formatPeriod(choice),
    resolution: defaultResolution(choice, cycles, MAX_BARS, now),
  };
}

/**
 * The settings without what doesn't apply or is the default: no empty
 * lists, no cumulative on bars, no side by side on lines, no Y axis or
 * stacking on pies, no filters a balance ignores. Two graphs are the same when their clean forms are.
 */
export function cleanGraph(s: GraphSettings): GraphSettings {
  const balance = s.metric === "balance";
  const out: GraphSettings = {
    kind: s.kind,
    metric: s.metric,
    period: s.period,
    resolution: s.resolution,
  };
  const group = groupBy(s);
  if (group !== "none") out.group_by = group;
  if (s.account_ids?.length) out.account_ids = [...s.account_ids];
  if (!balance && s.bucket_ids?.length) out.bucket_ids = [...s.bucket_ids];
  if (!balance && s.tags?.length) out.tags = [...s.tags];
  if (!balance && s.counterparty?.trim()) out.counterparty = s.counterparty.trim();
  if (s.kind === "line" && s.cumulative && !balance) out.cumulative = true;
  if (s.kind === "bar" && s.side_by_side) out.side_by_side = true;
  if (s.kind === "line" && s.stepped) out.stepped = true;
  if (s.fit_y_axis && s.kind !== "pie") out.fit_y_axis = true;
  if (s.kind === "pie" && s.pie_labels && s.pie_labels !== "list") out.pie_labels = s.pie_labels;
  if (topOf(s) !== DEFAULT_TOP) out.top = topOf(s);
  return out;
}

export function sameGraph(a: GraphSettings, b: GraphSettings): boolean {
  return graphToSearch(a).toString() === graphToSearch(b).toString();
}

/** The settings as URL parameters, in a fixed order. */
export function graphToSearch(settings: GraphSettings): URLSearchParams {
  const s = cleanGraph(settings);
  const p = new URLSearchParams();
  p.set("kind", s.kind);
  p.set("metric", s.metric);
  p.set("period", s.period);
  p.set("res", s.resolution);
  if (s.group_by) p.set("group", s.group_by);
  for (const id of s.account_ids ?? []) p.append("account", id);
  for (const id of s.bucket_ids ?? []) p.append("bucket", id);
  for (const tag of s.tags ?? []) p.append("tag", tag);
  if (s.counterparty) p.set("q", s.counterparty);
  if (s.cumulative) p.set("cum", "1");
  if (s.side_by_side) p.set("side", "1");
  if (s.stepped) p.set("step", "1");
  if (s.fit_y_axis) p.set("fit", "1");
  if (s.pie_labels) p.set("labels", s.pie_labels);
  if (s.top) p.set("top", String(s.top));
  return p;
}

const ID = /^[0-9A-Za-z-]{1,40}$/;

/** The settings in the URL; a missing or bad field gets the default's. */
export function graphFromSearch(params: URLSearchParams, fallback: GraphSettings): GraphSettings {
  const pick = <T extends string>(key: string, values: readonly T[]): T | undefined =>
    values.find((v) => v === params.get(key));
  const ids = (key: string, max: number) =>
    params
      .getAll(key)
      .filter((v) => ID.test(v))
      .slice(0, max);
  const period = params.get("period");
  const top = Number(params.get("top"));
  return cleanGraph({
    kind: pick("kind", GRAPH_KINDS) ?? fallback.kind,
    metric: pick("metric", GRAPH_METRICS) ?? fallback.metric,
    period: parsePeriod(period) ? (period ?? fallback.period) : fallback.period,
    resolution: parseResolution(params.get("res")) ?? fallback.resolution,
    group_by: pick("group", GROUP_BYS) ?? "none",
    account_ids: ids("account", 50),
    bucket_ids: ids("bucket", 100),
    tags: params
      .getAll("tag")
      .filter((t) => t.length > 0 && t.length <= 50)
      .slice(0, 20),
    counterparty: (params.get("q") ?? "").slice(0, 200),
    cumulative: params.get("cum") === "1",
    side_by_side: params.get("side") === "1",
    stepped: params.get("step") === "1",
    fit_y_axis: params.get("fit") === "1",
    pie_labels: pick("labels", PIE_LABELS) ?? "list",
    top: Number.isInteger(top) && top >= 1 && top <= MAX_TOP ? top : DEFAULT_TOP,
  });
}

/**
 * The Stats API query for a graph over a period, at the resolution it's
 * drawn at. With one account chosen, its transfers count as income and
 * spending, as on the In/out widget (#90).
 */
export function statsQuery(
  settings: GraphSettings,
  period: Period,
  resolution: Resolution,
): StatsQuery {
  const s = cleanGraph(settings);
  const accounts = s.account_ids ?? [];
  return {
    metric: s.metric,
    from: period.fromAt,
    to: period.toAt,
    resolution,
    group_by: groupBy(s),
    ...(accounts.length > 0 ? { account_id: accounts } : {}),
    ...(s.bucket_ids ? { bucket_id: s.bucket_ids } : {}),
    ...(s.tags ? { tag: s.tags } : {}),
    ...(s.counterparty ? { counterparty: s.counterparty } : {}),
    ...(s.metric !== "balance" && accounts.length === 1 ? { transfers: true } : {}),
  };
}

/**
 * The currency a graph is drawn in: the chosen accounts' when they share
 * one, else the app's. Amounts in other currencies aren't added in;
 * `leftOut` counts the accounts left out.
 */
export function shownCurrency(
  settings: GraphSettings,
  accounts: Account[],
): { currency: string; leftOut: number } {
  const ids = settings.account_ids ?? [];
  const chosen = ids.length > 0 ? accounts.filter((a) => ids.includes(a.id)) : [];
  const currencies = new Set(chosen.map((a) => a.currency));
  const [only] = currencies;
  const currency = currencies.size === 1 && only ? only : CURRENCY;
  const among = chosen.length > 0 ? chosen : accounts;
  return { currency, leftOut: among.filter((a) => a.currency !== currency).length };
}

export interface GraphRow {
  /** The axis label. */
  label: string;
  /** The tooltip's title: the interval in full. */
  title: string;
  /** The interval's index in the API's result. */
  index: number;
  [series: string]: string | number;
}

export interface GraphSeries {
  /** The key in each row: "total", "a-1234", "b-<id>", "none" or "other". */
  name: string;
  label: string;
  color: string;
  /** The exact amounts per interval, for the tooltip. */
  amounts: string[];
}

export interface GraphData {
  rows: GraphRow[];
  series: GraphSeries[];
  /** How many series went into Other. */
  other: number;
}

/** The colour of a series or slice: the graph palette's slots (0-11) in order, Other in grey. */
export function seriesColor(slot: number | "other"): string {
  return slot === "other" ? "var(--graph-other)" : `var(--graph-${String(slot + 1)})`;
}

interface Interval {
  start: string;
  end: string;
}

function intervalDays(interval: Interval) {
  return {
    from: localDate(interval.start),
    to: lastDay({ start_at: interval.start, end_at: interval.end }),
  };
}

/** An interval's axis label and its tooltip title, in the locale. */
export function intervalLabel(
  interval: Interval,
  resolution: Resolution,
  intervals: Interval[],
  locale = getLocale(),
): { label: string; title: string } {
  const start = new Date(interval.start);
  const { from, to } = intervalDays(interval);
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, o).format(d);
  const range = formatDateRange(from, to, locale);
  const firstStart = intervals[0]?.start ?? interval.start;
  const lastStart = intervals.at(-1)?.start ?? interval.start;
  switch (resolution) {
    case "hour": {
      const oneDay = localDate(firstStart) === localDate(lastStart);
      const time = fmt(start, { hour: "2-digit", minute: "2-digit" });
      const title = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).formatRange(start, new Date(interval.end));
      return {
        label: oneDay ? time : fmt(start, { day: "numeric", month: "short", hour: "2-digit" }),
        title,
      };
    }
    case "day":
      return {
        label: fmt(start, { day: "numeric", month: "short" }),
        title: fmt(start, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
      };
    case "month": {
      const oneYear = new Date(firstStart).getFullYear() === new Date(lastStart).getFullYear();
      return {
        label: fmt(start, oneYear ? { month: "short" } : { month: "short", year: "2-digit" }),
        title: fmt(start, { month: "long", year: "numeric" }),
      };
    }
    case "year":
      return { label: fmt(start, { year: "numeric" }), title: range };
    case "total":
      return { label: range, title: range };
    case "week":
    case "cycle":
      return { label: fmt(start, { day: "numeric", month: "short" }), title: range };
  }
}

/** Running totals. */
function cumulative(amounts: string[]): string[] {
  let sum = "0";
  return amounts.map((a) => (sum = addAmounts(sum, a)));
}

function abs(a: string): string {
  return a.startsWith("-") ? a.slice(1) : a;
}

/**
 * The rows and series a chart draws: the series in the shown currency, the
 * largest `top` with their own colour and the rest added up as Other, named
 * after their account or bucket, in name order so a series keeps its
 * colour while the period changes.
 */
export function graphData(
  result: StatsSeries,
  settings: GraphSettings,
  resolution: Resolution,
  currency: string,
  accounts: Account[],
  buckets: Bucket[],
  locale = getLocale(),
): GraphData {
  const s = cleanGraph(settings);
  const group = groupBy(s);
  const lines = result.series.filter((l) => l.currency === currency);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const bucketName = (id: string) => buckets.find((b) => b.id === id)?.name ?? id;
  // Two buckets with the same name are told apart by their account.
  const names = lines.map((l) => (l.bucket_id ? bucketName(l.bucket_id) : ""));
  const named = lines.map((l) => {
    let name = "total";
    let label = i18n.t("stats.graphs.total");
    if (group === "account" && l.account_id) {
      name = `a-${l.account_id}`;
      label = accountName(l.account_id);
    } else if (group === "bucket") {
      if (l.bucket_id) {
        name = `b-${l.bucket_id}`;
        label = bucketName(l.bucket_id);
        if (names.filter((n) => n === label).length > 1 && l.account_id) {
          label = `${label} (${accountName(l.account_id)})`;
        }
      } else {
        name = "none";
        label = i18n.t("stats.graphs.noBucket");
      }
    }
    const amounts = s.cumulative ? cumulative(l.values) : l.values;
    // Balances by their latest value; sums by the whole period's.
    const size =
      s.metric === "balance" ? abs(l.values.at(-1) ?? "0") : abs(addAmounts("0", ...l.values));
    return { name, label, amounts: l.values, shown: amounts, size };
  });

  const top = topOf(s);
  const ranked = [...named].sort((a, b) => compareAmounts(b.size, a.size));
  const kept = ranked.length > top ? ranked.slice(0, top) : ranked;
  const rest = ranked.length > top ? ranked.slice(top) : [];
  const byName = (a: { label: string; name: string }, b: { label: string; name: string }) =>
    a.name === "none" ? 1 : b.name === "none" ? -1 : a.label.localeCompare(b.label, locale);
  const series: GraphSeries[] = [...kept].sort(byName).map((x, i) => ({
    name: x.name,
    label: x.label,
    color: seriesColor(i),
    amounts: x.shown,
  }));
  if (rest.length > 0) {
    const sums = result.intervals.map((_, i) =>
      addAmounts("0", ...rest.map((r) => r.amounts[i] ?? "0")),
    );
    series.push({
      name: "other",
      label: i18n.t("stats.graphs.other"),
      color: seriesColor("other"),
      amounts: s.cumulative ? cumulative(sums) : sums,
    });
  }

  const rows = result.intervals.map((interval, index) => {
    const row: GraphRow = {
      ...intervalLabel(interval, resolution, result.intervals, locale),
      index,
    };
    for (const x of series) row[x.name] = Number(x.amounts[index] ?? "0");
    return row;
  });
  return { rows, series, other: rest.length };
}

export interface PieSlice {
  /** "a-<id>", "b-<id>", "none" and "other" as for series; "i-<index>" per interval. */
  name: string;
  label: string;
  color: string;
  /** The exact amount, a decimal string. */
  amount: string;
  /** Its part of the total, 0-1. */
  share: number;
  /** The interval it covers, in the API's result. */
  index: number;
}

export interface PieData {
  slices: PieSlice[];
  /** The slices added up. */
  total: string;
  /** How many series went into Other. */
  other: number;
  /** Series or intervals below 0, which a pie can't draw. */
  belowZero: number;
}

const isNegative = (a: string) => compareAmounts(a, "0") < 0;
const isPositive = (a: string) => compareAmounts(a, "0") > 0;

/**
 * A pie's slices (#123), in the shown currency. Per bucket or account they
 * are the series over the whole period, named, ranked and coloured as on a
 * bar graph (the largest `top`, the rest as Other); per interval they are
 * the intervals in time order, at most 12. Slices at 0 are left out, and
 * those below 0 are counted in `belowZero`.
 */
export function pieData(
  result: StatsSeries,
  settings: GraphSettings,
  resolution: Resolution,
  currency: string,
  accounts: Account[],
  buckets: Bucket[],
  locale = getLocale(),
): PieData {
  const s = cleanGraph(settings);
  let slices: Omit<PieSlice, "share">[];
  let other = 0;
  let belowZero: number;
  if (pieSlicing(s) === "interval") {
    const lines = result.series.filter((l) => l.currency === currency);
    const amounts = result.intervals.map((_, i) =>
      addAmounts("0", ...lines.map((l) => l.values[i] ?? "0")),
    );
    belowZero = amounts.filter(isNegative).length;
    slices = result.intervals.flatMap((interval, index) => {
      const amount = amounts[index] ?? "0";
      if (!isPositive(amount)) return [];
      const { title } = intervalLabel(interval, resolution, result.intervals, locale);
      return [{ name: `i-${String(index)}`, label: title, color: "", amount, index }];
    });
    slices = slices.slice(0, MAX_SLICES).map((x, i) => ({ ...x, color: seriesColor(i) }));
  } else {
    // A balance is the value at the period's end; a sum is the period's.
    const value = (l: { values: string[] }) =>
      s.metric === "balance" ? (l.values.at(-1) ?? "0") : addAmounts("0", ...l.values);
    const lines = result.series
      .filter((l) => l.currency === currency)
      .map((l) => ({ ...l, values: [value(l)] }));
    belowZero = lines.filter((l) => isNegative(l.values[0] ?? "0")).length;
    const data = graphData(
      {
        intervals: result.intervals.slice(0, 1),
        series: lines.filter((l) => isPositive(l.values[0] ?? "0")),
      },
      { ...s, cumulative: false },
      "total",
      currency,
      accounts,
      buckets,
      locale,
    );
    other = data.other;
    slices = data.series.map((x) => ({
      name: x.name,
      label: x.label,
      color: x.color,
      amount: x.amounts[0] ?? "0",
      index: 0,
    }));
  }
  // Slot 7 (violet) can't be told from slot 1 (blue) by colour-blind
  // readers, and a 7-slice pie wraps from one to the other: use slot 10.
  const last = slices[6];
  if (slices.length === 7 && last && last.name !== "other") last.color = seriesColor(9);
  const total = addAmounts("0", ...slices.map((x) => x.amount));
  const sum = Number(total);
  return {
    slices: slices.map((x) => ({ ...x, share: sum > 0 ? Number(x.amount) / sum : 0 })),
    total,
    other,
    belowZero,
  };
}

/** A round step near `x`: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(x: number): number {
  const power = 10 ** Math.floor(Math.log10(x));
  const f = x / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}

/**
 * The Y axis range for "Fit to data": the values' range (stacked bars by
 * their totals), padded by a tenth and rounded out to a round step, so
 * 30 000–50 000 becomes 25 000–55 000. Undefined means the chart's default,
 * which includes 0.
 */
export function yDomain(data: GraphData, settings: GraphSettings): [number, number] | undefined {
  const s = cleanGraph(settings);
  if (!s.fit_y_axis || data.rows.length === 0) return undefined;
  const stacked = s.kind === "bar" && !s.side_by_side;
  const values = data.rows.flatMap((row) => {
    const v = data.series.map((x) => Number(row[x.name] ?? 0));
    if (!stacked) return v;
    // A stack reaches from the sum of its negative parts to the sum of its positive ones.
    const neg = v.filter((n) => n < 0);
    const top = v.filter((n) => n > 0).reduce((a, b) => a + b, 0);
    return neg.length > 0 ? [neg.reduce((a, b) => a + b, 0), top] : [top];
  });
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const step = niceStep(span / 4);
  return [Math.floor((min - span / 10) / step) * step, Math.ceil((max + span / 10) / step) * step];
}

/** The width an interval needs: bars ~6 px, lines 2 px; a pie's slices don't need width. */
const MIN_PX: Record<GraphKind, number> = { bar: 6, line: 2, pie: 0 };
/** Lines show a dot per point while each gets this much room. */
const DOT_PX = 12;

/** Why a graph is drawn coarser than chosen: more intervals than it draws, or than fit its width. */
export type Coarsened = "count" | "width" | null;

/**
 * The resolution a graph is drawn at in `width` pixels: the chosen one, or
 * coarser until it gives at most `maxIntervals(kind)` intervals that fit
 * the width. Unmeasured (0) only checks the count.
 */
export function fitResolution(
  period: Period,
  resolution: Resolution,
  kind: GraphKind,
  width: number,
  cycles: CycleTimes[],
  locale = getLocale(),
): { resolution: Resolution; coarsened: Coarsened } {
  const max = maxIntervals(kind);
  let r = resolution;
  let why: Coarsened = null;
  for (;;) {
    const n = intervalCount(period, r, cycles, locale, max);
    const problem: Coarsened =
      n > max ? "count" : width > 0 && n * MIN_PX[kind] > width ? "width" : null;
    const next = coarser(r);
    if (!problem || !next) return { resolution: r, coarsened: r === resolution ? null : why };
    why ??= problem;
    r = next;
  }
}

export function showDots(intervals: number, width: number): boolean {
  return intervals > 0 && width / intervals >= DOT_PX;
}

/**
 * The Transactions screen with what a bar or point sums: the interval's
 * days, the type (EXP or INC; everything for a balance), the series'
 * account or bucket (else the only one chosen), the only tag chosen and the
 * counterparty.
 */
export function intervalLink(
  settings: GraphSettings,
  seriesName: string,
  interval: Interval,
): string {
  const s = cleanGraph(settings);
  const { from, to } = intervalDays(interval);
  const params = new URLSearchParams();
  params.set("cycle_id", ALL_CYCLES);
  params.set("from", from);
  params.set("to", to);
  if (s.metric === "spending") params.set("type", "EXP");
  if (s.metric === "income") params.set("type", "INC");
  const account = seriesName.startsWith("a-")
    ? seriesName.slice(2)
    : s.account_ids?.length === 1
      ? s.account_ids[0]
      : undefined;
  const bucket = seriesName.startsWith("b-")
    ? seriesName.slice(2)
    : s.bucket_ids?.length === 1
      ? s.bucket_ids[0]
      : undefined;
  if (account) params.set("account_id", account);
  if (bucket) params.set("bucket_id", bucket);
  if (s.tags?.length === 1 && s.tags[0]) params.set("tag", s.tags[0]);
  if (s.counterparty) params.set("q", s.counterparty);
  return `/transactions?${params.toString()}`;
}

/** A new id for a saved graph, not used by the others. */
export function newGraphId(saved: SavedGraph[]): string {
  const used = new Set(saved.map((g) => g.id));
  for (let i = saved.length + 1; ; i++) {
    const id = `g-${String(i)}`;
    if (!used.has(id)) return id;
  }
}

/** A specific period's name: its date, "2–8 Nov 2026", "November 2026", "Q4 2026", "2026" or a cycle's dates. */
export function specificLabel(
  choice: Extract<PeriodChoice, { kind: "specific" }>,
  cycles: CycleTimes[],
  locale = getLocale(),
): string {
  const [y = 0, m = 1] = choice.at.split("-").map(Number);
  const year = String(y);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, o).format(new Date(`${choice.at}T12:00`));
  switch (choice.unit) {
    case "day":
      return fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
    case "week":
      return formatDateRange(choice.at, addDays(choice.at, 6), locale);
    case "month":
      return fmt({ month: "long", year: "numeric" });
    case "quarter":
      return i18n.t("stats.period.quarterOf", { n: Math.floor((m - 1) / 3) + 1, year });
    case "half_year":
      return i18n.t("stats.period.halfOf", { n: m <= 6 ? 1 : 2, year });
    case "year":
      return year;
    case "cycle": {
      const c = cycles.find((x) => x.id === choice.at);
      return c ? cycleRange(c, locale) : i18n.t("stats.period.cycleGone");
    }
  }
}

/** A period choice's name: "Last 30 days", "This quarter", "November 2026", or its dates. */
export function periodLabel(
  choice: PeriodChoice,
  cycles: CycleTimes[] = [],
  locale = getLocale(),
): string {
  switch (choice.kind) {
    case "last":
      return i18n.t(`stats.period.last.${choice.unit}`, { count: choice.count });
    case "custom":
      return formatDateRange(choice.from, choice.to, locale);
    case "specific":
      return specificLabel(choice, cycles, locale);
    default:
      return i18n.t(`stats.period.options.${choice.kind}_${choice.unit}`);
  }
}

/**
 * One line for the settings: "Spending · This cycle · Day", or for a pie
 * "Spending · This year · Per bucket" (or "· Month" when per interval).
 */
export function graphSummary(
  settings: GraphSettings,
  cycles: CycleTimes[] = [],
  locale = getLocale(),
): string {
  const choice = parsePeriod(settings.period);
  const resolution = i18n.t(`stats.resolution.options.${settings.resolution}`);
  const group = groupBy(settings);
  const rest =
    settings.kind === "pie"
      ? [group === "none" ? resolution : i18n.t(`stats.graphs.groups.${group}`)]
      : [resolution, ...(group === "none" ? [] : [i18n.t(`stats.graphs.groups.${group}`)])];
  return [
    i18n.t(`stats.graphs.metrics.${settings.metric}`),
    choice ? periodLabel(choice, cycles, locale) : settings.period,
    ...rest,
  ].join(" · ");
}
