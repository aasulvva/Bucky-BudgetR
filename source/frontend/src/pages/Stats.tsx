import {
  Button,
  Drawer,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { useCycles, type Cycle } from "@/api/cycles";
import { useTags } from "@/api/transactions";
import { useSession } from "@/app/session";
import { QueryState } from "@/components/QueryState";
import { ExportPdfButton } from "@/components/reports/ExportPdfButton";
import { ReportTemplates } from "@/components/reports/ReportTemplates";
import { ReportView } from "@/components/reports/ReportView";
import { GraphCompareFields } from "@/components/stats/GraphCompareFields";
import { GraphControls } from "@/components/stats/GraphControls";
import { GraphView, type Compare } from "@/components/stats/GraphView";
import { ModuleTypeSwitch } from "@/components/stats/ModuleTypeSwitch";
import { ModuleView, SavedModuleView } from "@/components/stats/SavedModuleView";
import { SavedModules } from "@/components/stats/SavedModules";
import { useClockVersion } from "@/lib/clock";
import {
  defaultGraph,
  graphFromSearch,
  graphSummary,
  graphToSearch,
  type GraphSettings,
} from "@/lib/graphs";
import { defaultPeriod, parsePeriod } from "@/lib/periods";
import {
  periodsOf,
  readTemplates,
  readViewMode,
  sameReport,
  sourceValue,
  starter,
  COMPARE_TOS,
  MODULE_COMPARES,
  PART_MODULE_TYPES,
  STARTER_IDS,
  type ReportSettings,
  type ReportSource,
  type ReportTemplate,
  type PartModule,
  type ReportViewMode,
} from "@/lib/reports";
import {
  graphAsSaved,
  graphCompare,
  isGraphModule,
  newSavedModule,
  readSavedModules,
  savedGraph,
  type GraphCompare,
  type SavedModule,
} from "@/lib/savedModules";

const REPORTS_PATH = "/stats/reports";

/** Stats & reports (spec §9): one module at a time (#122, #204) and reports (#125). */
export default function Stats() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname === REPORTS_PATH ? "reports" : "stats";
  return (
    <Stack gap="md">
      <Title order={2}>{t("nav.items.stats")}</Title>
      <Tabs
        value={tab}
        onChange={(v) => {
          void navigate(v === "reports" ? REPORTS_PATH : "/stats");
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="stats">{t("stats.tabs.stats")}</Tabs.Tab>
          <Tabs.Tab value="reports">{t("stats.tabs.reports")}</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === "stats" ? <StatsTab /> : <ReportsTab />}
    </Stack>
  );
}

function ReportsTab() {
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={cycles}>
      {(c) => (
        <QueryState query={accounts}>
          {(a) => (
            <QueryState query={buckets}>
              {(b) => <Reports cycles={c} accounts={a} buckets={b} />}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

/** Reports (#125): a starter or saved template, changed on screen until saved. */
function Reports({
  cycles,
  accounts,
  buckets,
}: {
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const [params, setParams] = useSearchParams();
  const saved = useSession().data?.preferences.report_templates;
  const templates = useMemo(() => readTemplates(saved ?? []), [saved]);
  const templateId = params.get("template");
  const starterId = STARTER_IDS.find((x) => x === params.get("starter")) ?? "yearly";
  const template = templateId ? templates.find((x) => x.id === templateId) : undefined;
  const source: ReportSource = template
    ? { kind: "template", id: template.id }
    : { kind: "starter", id: starterId };
  const view = readViewMode(params.get("view"));
  const select = (next: ReportSource) => {
    // The full report stays the full report (#202).
    setParams(
      new URLSearchParams({ [next.kind]: next.id, ...(view === "report" ? { view } : {}) }),
    );
  };
  const setView = (next: ReportViewMode) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "report") p.set("view", next);
        else p.delete("view");
        return p;
      },
      { replace: true },
    );
  };
  return (
    <Report
      // A new source starts over from what it holds.
      key={sourceValue(source)}
      source={source}
      saved={template?.report ?? starter(starterId)}
      templates={templates}
      onSelect={select}
      view={view}
      onView={setView}
      cycles={cycles}
      accounts={accounts}
      buckets={buckets}
    />
  );
}

function Report({
  source,
  saved,
  templates,
  onSelect,
  view,
  onView,
  cycles,
  accounts,
  buckets,
}: {
  source: ReportSource;
  saved: ReportSettings;
  templates: ReportTemplate[];
  onSelect: (source: ReportSource) => void;
  view: ReportViewMode;
  onView: (view: ReportViewMode) => void;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  useClockVersion();
  const tags = (useTags().data ?? []).map((x) => x.name);
  const [report, setReport] = useState(saved);
  const name =
    source.kind === "template"
      ? (templates.find((x) => x.id === source.id)?.name ?? "")
      : t(`stats.reports.starters.${source.id}`);
  return (
    <Stack gap="md">
      <ReportTemplates
        templates={templates}
        source={source}
        current={report}
        changed={!sameReport(report, saved)}
        onSelect={onSelect}
        extra={<ExportPdfButton name={name} report={report} cycles={cycles} />}
      />
      <ReportView
        report={report}
        onChange={setReport}
        view={view}
        onView={onView}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        isDesktop={isDesktop}
      />
    </Stack>
  );
}

function StatsTab() {
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={cycles}>
      {(c) => (
        <QueryState query={accounts}>
          {(a) => (
            <QueryState query={buckets}>
              {(b) => <StatsScreen cycles={c} accounts={a} buckets={b} />}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

/** The URL's module type (#204): a graph unless it names another. */
const OTHER_TYPES = PART_MODULE_TYPES.filter(
  (x): x is Exclude<PartModule["type"], "graph"> => x !== "graph",
);

/**
 * The Stats tab: a graph, or a module of another type (#204), over any
 * period, or a saved module. The type is the saved module's, else `type`
 * in the URL; the period is `period` for every type, so it stays when the
 * type changes. An unsaved module of another type is kept on screen until
 * the page is left. A graph's comparison is `compare` and `compare_to`
 * when they aren't its saved graph's.
 */
function StatsScreen({
  cycles,
  accounts,
  buckets,
}: {
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  useClockVersion();
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawer] = useState(false);
  const tags = (useTags().data ?? []).map((x) => x.name);
  const saved = readSavedModules(useSession().data?.preferences.saved_modules);

  // Unsaved modules of the other types, by type, kept while on the page.
  const [drafts, setDrafts] = useState<Partial<Record<PartModule["type"], PartModule>>>({});

  const settings = graphFromSearch(params, defaultGraph(cycles));
  const selectedId = params.get("saved");
  const selected = saved.find((s) => s.id === selectedId) ?? null;
  const urlType = OTHER_TYPES.find((x) => x === params.get("type")) ?? "graph";
  const type = selected ? selected.module.type : urlType;
  const savedCompare = graphCompare(selected);
  const comparison: GraphCompare = {
    mode: MODULE_COMPARES.find((x) => x === params.get("compare")) ?? savedCompare.mode,
    to: COMPARE_TOS.find((x) => x === params.get("compare_to")) ?? savedCompare.to,
  };
  const periods = periodsOf(
    parsePeriod(settings.period) ?? defaultPeriod(cycles),
    comparison.to,
    cycles,
  );

  /**
   * The graph (or, for another type, its period) in the URL, with the type
   * and saved module, and a graph's comparison where it isn't the saved one's.
   */
  const show = (
    s: GraphSettings,
    savedId: string | null,
    replace: boolean,
    to: PartModule["type"] = "graph",
    c?: GraphCompare,
  ) => {
    const next = graphToSearch(s);
    if (to !== "graph") next.set("type", to);
    if (savedId) next.set("saved", savedId);
    if (to === "graph" && c) {
      const base = graphCompare(saved.find((x) => x.id === savedId) ?? null);
      if (c.mode !== base.mode) next.set("compare", c.mode);
      if (c.to !== base.to) next.set("compare_to", c.to);
    }
    setParams(next, { replace });
  };
  const change = (s: GraphSettings) => {
    show(s, selectedId, true, "graph", comparison);
  };
  const select = (s: SavedModule | null, shown?: SavedModule) => {
    if (!s) {
      // What was on screen stays: another type's module as an unsaved one.
      if (shown && shown.module.type !== "graph") {
        const kept = shown.module;
        setDrafts((d) => ({ ...d, [kept.type]: kept }));
        show({ ...settings, period: shown.period }, null, true, kept.type);
      } else {
        show(settings, null, true, type, comparison);
      }
    } else if (isGraphModule(s)) {
      show(savedGraph(s), s.id, false);
    } else {
      // Its period goes in the URL too, so it stays when the type changes.
      show({ ...settings, period: s.period }, s.id, false, s.module.type);
    }
  };
  const typeSwitch = (
    <ModuleTypeSwitch
      value={type}
      onChange={(to) => {
        show({ ...settings, period: selected?.period ?? settings.period }, null, false, to);
      }}
    />
  );
  const shared = { saved, cycles, accounts, buckets, tags, isDesktop };

  // A saved module that isn't a graph (#201) has a screen of its own.
  if (selected && !isGraphModule(selected)) {
    return (
      <Stack gap="md">
        {typeSwitch}
        <SavedModuleView key={selected.id} {...shared} selected={selected} onSelect={select} />
      </Stack>
    );
  }
  // So does a new one of another type (#204).
  if (!selected && type !== "graph") {
    const fresh = newSavedModule(type, settings.period);
    const draft = { ...fresh, module: drafts[type] ?? fresh.module };
    return (
      <Stack gap="md">
        {typeSwitch}
        <ModuleView
          {...shared}
          selected={null}
          draft={draft}
          onDraft={(d) => {
            setDrafts((prev) => ({ ...prev, [type]: d.module }));
            if (d.period !== settings.period)
              show({ ...settings, period: d.period }, null, true, type);
          }}
          onSelect={(s) => {
            select(s);
          }}
        />
      </Stack>
    );
  }

  const pie = settings.kind === "pie";
  const controls = (narrow: boolean) => (
    <GraphControls
      value={settings}
      onChange={change}
      cycles={cycles}
      accounts={accounts}
      buckets={buckets}
      tags={tags}
      narrow={narrow}
      belowPeriod={
        <GraphCompareFields
          value={comparison}
          onChange={(c) => {
            show(settings, selectedId, true, "graph", c);
          }}
          pie={pie}
          choice={periods.choice}
          compare={periods.compare}
          inline={narrow}
        />
      }
    />
  );
  // As a saved graph shows it on the Dashboard: a pie's difference is both.
  const compare: Compare | undefined =
    comparison.mode !== "off" && periods.compare
      ? {
          period: periods.compare.period,
          mode: pie ? "both" : comparison.mode,
          labels: { current: periods.compare.currentLabel, previous: periods.compare.label },
        }
      : undefined;

  return (
    <Stack gap="md">
      {typeSwitch}
      <SavedModules
        saved={saved}
        current={graphAsSaved(settings, selected, comparison)}
        selectedId={selected?.id ?? null}
        onSelect={select}
      />
      {isDesktop ? (
        <Paper withBorder p="md">
          {controls(false)}
        </Paper>
      ) : (
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" c="dimmed" data-testid="graph-summary" style={{ flex: 1, minWidth: 0 }}>
            {graphSummary(settings, cycles)}
          </Text>
          <Button
            variant="default"
            size="xs"
            style={{ flexShrink: 0 }}
            leftSection={<IconAdjustmentsHorizontal size={16} />}
            onClick={() => {
              setDrawer(true);
            }}
          >
            {t("stats.graphs.settings")}
          </Button>
        </Group>
      )}
      {comparison.mode !== "off" && (
        <Text size="sm" c="dimmed" data-testid="graph-compared">
          {periods.compare
            ? t(
                comparison.mode === "difference" && !pie
                  ? "stats.reports.compare.differenceWith"
                  : "stats.reports.compare.comparedWith",
                { period: periods.compare.label },
              )
            : t("stats.reports.compare.unavailable")}
        </Text>
      )}
      <GraphView
        settings={settings}
        period={periods.period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={isDesktop ? 360 : 280}
        compare={compare}
      />
      {!isDesktop && (
        <Drawer
          opened={drawer}
          onClose={() => {
            setDrawer(false);
          }}
          position="bottom"
          size="90%"
          title={t("stats.graphs.settings")}
        >
          {controls(true)}
        </Drawer>
      )}
    </Stack>
  );
}
