import { Anchor, Box, Button, Stack, Text, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useContext, useMemo, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { useCycles, type Cycle } from "@/api/cycles";
import { useSession } from "@/app/session";
import { QueryState } from "@/components/QueryState";
import { ModuleBody } from "@/components/reports/ModuleCard";
import { GraphView, type Compare } from "@/components/stats/GraphView";
import { useClockVersion } from "@/lib/clock";
import { formatDateRange } from "@/lib/cycles";
import { GRAPH_PX, type ModuleWidgetSettings, type WidgetInstance } from "@/lib/dashboard";
import {
  isGraphModule,
  readSavedModules,
  savedGraph,
  savedModuleLink,
  savedModulePeriods,
  savedModuleReport,
  type SavedModule,
} from "@/lib/savedModules";

import { CompactModule } from "./CompactModule";
import { WidgetFrame } from "./frame";
import { WidgetCard } from "./Widget";

/**
 * One of the saved modules from Stats & reports (#201; a saved graph
 * before, #124), over its own period, so it follows changes to it.
 * Compact by default (#203): a graph as a widget draws it, opening there
 * when clicked, and the others in their short forms (CompactModule). Full
 * shows the module as Stats & reports does, without a graph's breakdown.
 */
export function ModuleWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"module">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const saved = readSavedModules(useSession().data?.preferences.saved_modules);
  const shown = saved.find((s) => s.id === widget.settings.savedModuleId) ?? null;
  return (
    <WidgetCard
      title={t("dashboard.module.title")}
      link={shown ? { to: savedModuleLink(shown), label: t("dashboard.module.open") } : undefined}
      action={action}
    >
      {shown ? (
        <Loaded saved={shown} half={widget.width === "half"} options={widget.settings} />
      ) : (
        <Missing deleted={widget.settings.savedModuleId !== null} noneSaved={saved.length === 0} />
      )}
    </WidgetCard>
  );
}

function Missing({ deleted, noneSaved }: { deleted: boolean; noneSaved: boolean }) {
  const { t } = useTranslation();
  const { openSettings, editing } = useContext(WidgetFrame);
  if (noneSaved) {
    return (
      <Text size="sm" c="dimmed">
        <Trans
          i18nKey="dashboard.module.noneSaved"
          components={{ stats: <Anchor component={Link} to="/stats" size="sm" /> }}
        />
      </Text>
    );
  }
  return (
    <Stack gap="xs" align="flex-start">
      <Text size="sm" c="dimmed">
        {t(deleted ? "dashboard.module.deleted" : "dashboard.module.pick")}
      </Text>
      {openSettings && !editing && (
        <Button variant="light" size="xs" onClick={openSettings}>
          {t("dashboard.module.pickButton")}
        </Button>
      )}
    </Stack>
  );
}

function Loaded({
  saved,
  half,
  options,
}: {
  saved: SavedModule;
  half: boolean;
  options: ModuleWidgetSettings;
}) {
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={cycles}>
      {(c) => (
        <QueryState query={accounts}>
          {(a) => (
            <QueryState query={buckets}>
              {(b) => (
                <Drawn
                  saved={saved}
                  half={half}
                  options={options}
                  cycles={c}
                  accounts={a}
                  buckets={b}
                />
              )}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function Drawn({
  saved,
  half,
  options,
  cycles,
  accounts,
  buckets,
}: {
  saved: SavedModule;
  half: boolean;
  options: ModuleWidgetSettings;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const theme = useMantineTheme();
  const clock = useClockVersion();
  // Half width only where the Dashboard has two columns.
  const twoColumns = useMediaQuery(`(min-width: ${theme.breakpoints.md})`, true);
  // Over its own period, the last N days and so on too; once per clock tick.
  const periods = useMemo(
    () => savedModulePeriods(saved, cycles),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock moves "now"
    [saved, cycles, clock],
  );

  // The period and its dates (#203), unless the widget hides them.
  const range = periods.period && formatDateRange(periods.period.from, periods.period.to);
  const periodLine = options.showPeriod && (
    <Text size="xs" c="dimmed" data-testid="module-period">
      {range && range !== periods.label ? `${periods.label} · ${range}` : periods.label}
    </Text>
  );
  return (
    <Stack gap="xs">
      {periodLine}
      <Body
        saved={saved}
        half={half}
        options={options}
        periods={periods}
        twoColumns={twoColumns}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
      />
    </Stack>
  );
}

/** The module, compact or in full. */
function Body({
  saved,
  half,
  options,
  periods,
  twoColumns,
  cycles,
  accounts,
  buckets,
}: {
  saved: SavedModule;
  half: boolean;
  options: ModuleWidgetSettings;
  periods: ReturnType<typeof savedModulePeriods>;
  twoColumns: boolean;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (options.view === "full") {
    return (
      <ModuleBody
        report={savedModuleReport(saved)}
        module={saved.module}
        choice={periods.choice}
        period={periods.period}
        compare={periods.compare}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        isDesktop={twoColumns}
        headingLevel={4}
        breakdown={false}
      />
    );
  }
  if (!isGraphModule(saved)) {
    return (
      <CompactModule
        report={savedModuleReport(saved)}
        module={saved.module}
        period={periods.period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        options={options}
        more={savedModuleLink(saved)}
      />
    );
  }
  const settings = savedGraph(saved);
  // Its comparison, when it has one; not its breakdown, which is a report's.
  const mode = saved.module.compare ?? "off";
  const compare: Compare | undefined =
    mode !== "off" && periods.compare
      ? {
          period: periods.compare.period,
          mode: settings.kind === "pie" ? "both" : mode,
          labels: { current: periods.compare.currentLabel, previous: periods.compare.label },
        }
      : undefined;
  return (
    <Box
      data-testid="graph-widget"
      title={t("dashboard.module.openModule", { name: saved.name })}
      style={{ cursor: "pointer" }}
      onClick={() => {
        void navigate(savedModuleLink(saved));
      }}
    >
      <GraphView
        settings={settings}
        period={periods.period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={GRAPH_PX[options.graphHeight][half && twoColumns ? "half" : "full"]}
        clickThrough={false}
        compare={compare}
      />
    </Box>
  );
}
