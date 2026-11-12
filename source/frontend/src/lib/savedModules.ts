// Saved modules (#201): a module saved by name with a period of its own,
// which Stats & reports and the Dashboard show it over. Saved graphs (#122)
// became saved graph modules. A saved module's period may be any a graph
// has, the last N days, weeks and so on too, which reports don't have.
// Added to a report, it's copied, and the report's period applies there.

import type { TFunction } from "i18next";

import type { components } from "@/api/schema";

import { cleanGraph, graphToSearch, type GraphSettings } from "./graphs";
import { defaultPeriod, parsePeriod } from "./periods";
import {
  PART_MODULE_TYPES,
  allModuleIds,
  cleanReport,
  moduleBudget,
  moduleFlows,
  moduleGraph,
  moduleTransactions,
  newId,
  periodsOf,
  readModule,
  withoutPeriod,
  type CompareTo,
  type GraphModule,
  type PartModule,
  type ReportSettings,
} from "./reports";

type ApiSavedModule = components["schemas"]["SavedModule"];

/** What the period rules need of a cycle. */
interface CycleTimes {
  id?: string;
  start_at: string;
  end_at: string;
  state: string;
}

export interface SavedModule {
  id: string;
  name: string;
  /** Its own period, as a graph's (GraphSettings). */
  period: string;
  compare_to?: CompareTo;
  module: PartModule;
}

export const MAX_SAVED_MODULES = 100;
export const MAX_SAVED_NAME = 60;

/** The saved modules from the preferences; any the app can't show (a section) left out. */
export function readSavedModules(list: ApiSavedModule[] | null | undefined): SavedModule[] {
  return (list ?? []).flatMap((s) => {
    const module = readModule(s.module);
    if (!module || module.type === "section") return [];
    return [
      {
        id: s.id,
        name: s.name,
        period: s.period,
        ...(s.compare_to === undefined ? {} : { compare_to: s.compare_to }),
        module,
      },
    ];
  });
}

/** A saved module as a report of its own, to show and edit it as a report's module. */
export function savedModuleReport(s: SavedModule): ReportSettings {
  return {
    period: s.period,
    ...(s.compare_to === undefined ? {} : { compare_to: s.compare_to }),
    modules: [s.module],
  };
}

/** Its period now, with its names and what a compared graph compares with. */
export function savedModulePeriods(s: SavedModule, cycles: CycleTimes[]) {
  return periodsOf(
    parsePeriod(s.period) ?? defaultPeriod(cycles),
    s.compare_to ?? "previous",
    cycles,
  );
}

/** Without defaults and empty fields: what's saved and compared. */
export function cleanSavedModule(s: SavedModule): SavedModule {
  const [module] = cleanReport(savedModuleReport(s)).modules;
  return {
    id: s.id,
    name: s.name.trim(),
    period: s.period,
    ...(s.compare_to && s.compare_to !== "previous" ? { compare_to: s.compare_to } : {}),
    module: module && module.type !== "section" ? module : s.module,
  };
}

/** Whether two saved modules show the same, whatever their ids and names. */
export function sameSavedModule(a: SavedModule, b: SavedModule): boolean {
  const content = (s: SavedModule) => JSON.stringify({ ...cleanSavedModule(s), id: "", name: "" });
  return content(a) === content(b);
}

/** A graph module's graph with its period, as Stats shows it. */
export function savedGraph(s: SavedModule & { module: GraphModule }): GraphSettings {
  return cleanGraph({ ...s.module.graph, period: s.period });
}

export function isGraphModule(s: SavedModule): s is SavedModule & { module: GraphModule } {
  return s.module.type === "graph";
}

/**
 * The graph on Stats as a saved module: the one picked, with this graph
 * and period, keeping what Stats doesn't change (its comparison, breakdown,
 * title and compare-to), or a new one.
 */
export function graphAsSaved(settings: GraphSettings, selected: SavedModule | null): SavedModule {
  const graph = withoutPeriod(cleanGraph(settings));
  const base = selected?.module.type === "graph" ? selected.module : null;
  return cleanSavedModule({
    id: selected?.id ?? "",
    name: selected?.name ?? "",
    period: settings.period,
    ...(selected?.compare_to === undefined ? {} : { compare_to: selected.compare_to }),
    module: base ? { ...base, graph } : { id: "m-1", type: "graph", graph },
  });
}

/**
 * A report's module saved by name: over the report's period and with its
 * compare-to, and with the report's filters where it has none of its own,
 * so it shows the same data on Stats and the Dashboard.
 */
export function fromReportModule(
  report: ReportSettings,
  m: PartModule,
  id: string,
  name: string,
): SavedModule {
  const own: PartModule =
    m.type === "graph"
      ? { ...m, graph: withoutPeriod(moduleGraph(report, m)) }
      : m.type === "transactions"
        ? { ...m, transactions: moduleTransactions(report, m) }
        : m.type === "flows"
          ? { ...m, flows: moduleFlows(report, m) }
          : { ...m, budget: moduleBudget(report, m) };
  return cleanSavedModule({
    id,
    name,
    period: report.period,
    ...(report.compare_to === undefined ? {} : { compare_to: report.compare_to }),
    module: { ...own, id: "m-1" },
  });
}

/** A copy of a saved module for a report, with an id no module of it has, named as saved unless titled. */
export function toReportModule(s: SavedModule, report: ReportSettings): PartModule {
  return {
    ...structuredClone(s.module),
    id: newId("m", allModuleIds(report)),
    title: s.module.title ?? s.name,
  };
}

/** A new id, not one of the saved modules': "g-<n>", as saved graphs had. */
export function newSavedModuleId(saved: SavedModule[]): string {
  return newId(
    "g",
    saved.map((s) => s.id),
  );
}

/**
 * A new, unsaved module of the type over the period (#204), as the Stats
 * tab starts one: the defaults a report's Add module gives it.
 */
export function newSavedModule(
  type: Exclude<PartModule["type"], "graph">,
  period: string,
): SavedModule {
  // As newModule makes them, with a saved module's one id.
  const id = "m-1";
  const module: PartModule =
    type === "transactions"
      ? { id, type, transactions: {} }
      : type === "flows"
        ? { id, type, flows: {} }
        : { id, type, budget: {} };
  return { id: "", name: "", period, module };
}

/** Stats & reports with the saved module picked, as the Dashboard opens it. */
export function savedModuleLink(s: SavedModule): string {
  const params = isGraphModule(s) ? graphToSearch(savedGraph(s)) : new URLSearchParams();
  params.set("saved", s.id);
  return `/stats?${params.toString()}`;
}

/** The saved modules for a select, grouped by type, each group in the user's order. */
export function savedModuleOptions(
  saved: SavedModule[],
  t: TFunction,
): { group: string; items: { value: string; label: string }[] }[] {
  return PART_MODULE_TYPES.flatMap((type) => {
    const items = saved
      .filter((s) => s.module.type === type)
      .map((s) => ({ value: s.id, label: s.name }));
    return items.length === 0 ? [] : [{ group: t(`stats.reports.module.types.${type}`), items }];
  });
}
