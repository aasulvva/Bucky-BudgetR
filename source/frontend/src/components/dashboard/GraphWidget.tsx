import { Anchor, Box, Button, Stack, Text, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useContext, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { useCycles, type Cycle } from "@/api/cycles";
import { useSession } from "@/app/session";
import { QueryState } from "@/components/QueryState";
import { GraphView } from "@/components/stats/GraphView";
import { useClockVersion } from "@/lib/clock";
import type { WidgetInstance } from "@/lib/dashboard";
import { statsLink, type SavedGraph } from "@/lib/graphs";
import { defaultPeriod, parsePeriod, resolvePeriod } from "@/lib/periods";

import { WidgetFrame } from "./frame";
import { WidgetCard } from "./Widget";

/** A half-width graph's height, and a full-width one's. */
const HALF_PX = 200;
const FULL_PX = 260;

/**
 * One of the saved graphs from Stats & reports (#124), so it follows
 * changes to it. Clicking it opens it there.
 */
export function GraphWidget({
  widget,
  action,
}: {
  widget: WidgetInstance<"graph">;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const saved = useSession().data?.preferences.saved_graphs ?? [];
  const graph = saved.find((g) => g.id === widget.settings.savedGraphId) ?? null;
  return (
    <WidgetCard
      title={t("dashboard.graph.title")}
      link={graph ? { to: statsLink(graph), label: t("dashboard.graph.open") } : undefined}
      action={action}
    >
      {graph ? (
        <Graph graph={graph} half={widget.width === "half"} />
      ) : (
        <Missing deleted={widget.settings.savedGraphId !== null} noneSaved={saved.length === 0} />
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
          i18nKey="dashboard.graph.noneSaved"
          components={{ stats: <Anchor component={Link} to="/stats" size="sm" /> }}
        />
      </Text>
    );
  }
  return (
    <Stack gap="xs" align="flex-start">
      <Text size="sm" c="dimmed">
        {t(deleted ? "dashboard.graph.deleted" : "dashboard.graph.pick")}
      </Text>
      {openSettings && !editing && (
        <Button variant="light" size="xs" onClick={openSettings}>
          {t("dashboard.graph.pickButton")}
        </Button>
      )}
    </Stack>
  );
}

function Graph({ graph, half }: { graph: SavedGraph; half: boolean }) {
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <QueryState query={cycles}>
      {(c) => (
        <QueryState query={accounts}>
          {(a) => (
            <QueryState query={buckets}>
              {(b) => <Drawn graph={graph} half={half} cycles={c} accounts={a} buckets={b} />}
            </QueryState>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function Drawn({
  graph,
  half,
  cycles,
  accounts,
  buckets,
}: {
  graph: SavedGraph;
  half: boolean;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const navigate = useNavigate();
  useClockVersion();
  // Half width only where the Dashboard has two columns.
  const twoColumns = useMediaQuery(`(min-width: ${theme.breakpoints.md})`, true);
  const settings = graph.graph;
  const period = resolvePeriod(parsePeriod(settings.period) ?? defaultPeriod(cycles), cycles);
  return (
    <Box
      data-testid="graph-widget"
      title={t("dashboard.graph.openGraph", { name: graph.name })}
      style={{ cursor: "pointer" }}
      onClick={() => {
        void navigate(statsLink(graph));
      }}
    >
      <GraphView
        settings={settings}
        period={period}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        height={half && twoColumns ? HALF_PX : FULL_PX}
        clickThrough={false}
      />
    </Box>
  );
}
