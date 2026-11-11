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
import { GraphControls } from "@/components/stats/GraphControls";
import { GraphView } from "@/components/stats/GraphView";
import { SavedModuleView } from "@/components/stats/SavedModuleView";
import { SavedModules } from "@/components/stats/SavedModules";
import { useClockVersion } from "@/lib/clock";
import {
  defaultGraph,
  graphFromSearch,
  graphSummary,
  graphToSearch,
  type GraphSettings,
} from "@/lib/graphs";
import { defaultPeriod, parsePeriod, resolvePeriod } from "@/lib/periods";
import {
  readTemplates,
  sameReport,
  sourceValue,
  starter,
  STARTER_IDS,
  type ReportSettings,
  type ReportSource,
  type ReportTemplate,
} from "@/lib/reports";
import {
  graphAsSaved,
  isGraphModule,
  readSavedModules,
  savedGraph,
  type SavedModule,
} from "@/lib/savedModules";

const REPORTS_PATH = "/stats/reports";

/** Stats & reports (spec §9): graphs (#122) and reports (#125). */
export default function Stats() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname === REPORTS_PATH ? "reports" : "graphs";
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
          <Tabs.Tab value="graphs">{t("stats.tabs.graphs")}</Tabs.Tab>
          <Tabs.Tab value="reports">{t("stats.tabs.reports")}</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === "graphs" ? <GraphsTab /> : <ReportsTab />}
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
  const select = (next: ReportSource) => {
    setParams(new URLSearchParams({ [next.kind]: next.id }));
  };
  return (
    <Report
      // A new source starts over from what it holds.
      key={sourceValue(source)}
      source={source}
      saved={template?.report ?? starter(starterId)}
      templates={templates}
      onSelect={select}
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
  cycles,
  accounts,
  buckets,
}: {
  source: ReportSource;
  saved: ReportSettings;
  templates: ReportTemplate[];
  onSelect: (source: ReportSource) => void;
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
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        isDesktop={isDesktop}
      />
    </Stack>
  );
}

function GraphsTab() {
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={cycles}>
      {(c) => (
        <QueryState query={accounts}>
          {(a) => (
            <QueryState query={buckets}>
              {(b) => <Graphs cycles={c} accounts={a} buckets={b} />}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function Graphs({
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

  const settings = graphFromSearch(params, defaultGraph(cycles));
  const period = resolvePeriod(parsePeriod(settings.period) ?? defaultPeriod(cycles), cycles);
  const selectedId = params.get("saved");
  const selected = saved.find((s) => s.id === selectedId) ?? null;

  const show = (s: GraphSettings, savedId: string | null, replace: boolean) => {
    const next = graphToSearch(s);
    if (savedId) next.set("saved", savedId);
    setParams(next, { replace });
  };
  const change = (s: GraphSettings) => {
    show(s, selectedId, true);
  };
  const select = (s: SavedModule | null) => {
    if (!s) show(settings, null, true);
    else if (isGraphModule(s)) show(savedGraph(s), s.id, false);
    // Another kind keeps the graph in the URL, for when it's cleared.
    else show(settings, s.id, false);
  };

  // A saved module that isn't a graph (#201) has a screen of its own.
  if (selected && !isGraphModule(selected)) {
    return (
      <SavedModuleView
        key={selected.id}
        saved={saved}
        selected={selected}
        onSelect={select}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        isDesktop={isDesktop}
      />
    );
  }

  const controls = (narrow: boolean) => (
    <GraphControls
      value={settings}
      onChange={change}
      cycles={cycles}
      accounts={accounts}
      buckets={buckets}
      tags={tags}
      narrow={narrow}
    />
  );

  return (
    <Stack gap="md">
      <SavedModules
        saved={saved}
        current={graphAsSaved(settings, selected)}
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
      <GraphView
        settings={settings}
        period={period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={isDesktop ? 360 : 280}
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
