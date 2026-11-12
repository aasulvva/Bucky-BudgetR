import {
  Input,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
} from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import {
  cleanGraph,
  GRAPH_METRICS,
  groupBy,
  GROUP_BYS,
  MAX_TOP,
  maxIntervals,
  PIE_LABELS,
  pieSlicing,
  topOf,
  type GraphKind,
  type GraphSettings,
} from "@/lib/graphs";
import { SHOW_AS } from "@/lib/graphRates";
import { defaultPeriod, formatPeriod, parsePeriod, type PeriodChoice } from "@/lib/periods";

import { FilterFields } from "./FilterFields";
import { PeriodPicker } from "./PeriodPicker";
import { ResolutionPicker } from "./ResolutionPicker";

interface GraphControlsProps {
  value: GraphSettings;
  onChange: (value: GraphSettings) => void;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  /** One column, for the mobile drawer. */
  narrow?: boolean;
  /**
   * A report module's graph (#125): the period is the report's and isn't
   * shown, and an empty filter uses the report's.
   */
  reportPeriod?: PeriodChoice;
  /** Whether an empty filter uses the report's; a report module's unless said (#201). */
  inherits?: boolean;
  /** Shown under the period: the Stats tab's comparison (#204). */
  belowPeriod?: ReactNode;
}

/** What a graph shows and how (#122, pies #123). Each change is a whole new value. */
export function GraphControls({
  value,
  onChange,
  cycles,
  accounts,
  buckets,
  tags,
  narrow = false,
  reportPeriod,
  inherits,
  belowPeriod,
}: GraphControlsProps) {
  const { t } = useTranslation();
  // The drawer locks page scrolling and lets touches through only inside
  // it, so dropdowns there render inside it rather than at the page's end.
  const dropdown = narrow ? { withinPortal: false } : undefined;
  const s = cleanGraph(value);
  const set = (patch: Partial<GraphSettings>) => {
    onChange(cleanGraph({ ...value, ...patch }));
  };
  const balance = s.metric === "balance";
  const group = groupBy(s);
  const pie = s.kind === "pie";
  // A rate per hour isn't offered (#182).
  const hourly = s.resolution === "hour";
  // A pie per bucket or account covers the whole period: no resolution.
  const whole = pie && pieSlicing(s) !== "interval";
  const setKind = (kind: GraphKind) => {
    // An unsplit pie is per interval; a pie starts per bucket.
    set(
      kind === "pie" && kind !== s.kind && group === "none"
        ? { kind, group_by: "bucket" }
        : { kind },
    );
  };
  const choice = reportPeriod ?? parsePeriod(s.period) ?? defaultPeriod(cycles);

  // A balance pie is only per account. An unsplit pie is per interval.
  // Balances have no buckets or counterparties (#170); a balance pie is per account.
  const groups = GROUP_BYS.filter(
    (g) =>
      !(balance && (g === "bucket" || g === "counterparty")) && !(balance && pie && g === "none"),
  );
  const groupLabel = (g: (typeof GROUP_BYS)[number]) =>
    pie && g === "none" ? t("stats.graphs.groups.interval") : t(`stats.graphs.groups.${g}`);

  return (
    <SimpleGrid
      cols={narrow ? 1 : { base: 1, xs: 2, md: 3, lg: 4 }}
      spacing="sm"
      verticalSpacing="sm"
    >
      <Stack gap="sm">
        <Input.Wrapper label={t("stats.graphs.kind")}>
          <SegmentedControl
            fullWidth
            data={[
              { value: "bar", label: t("stats.graphs.kinds.bar") },
              { value: "line", label: t("stats.graphs.kinds.line") },
              { value: "pie", label: t("stats.graphs.kinds.pie") },
            ]}
            value={s.kind}
            onChange={(kind) => {
              setKind(kind);
            }}
          />
        </Input.Wrapper>
        <Select
          comboboxProps={dropdown}
          label={t("stats.graphs.metric")}
          data={GRAPH_METRICS.map((m) => ({ value: m, label: t(`stats.graphs.metrics.${m}`) }))}
          value={s.metric}
          onChange={(m) => {
            if (m) set({ metric: m });
          }}
          allowDeselect={false}
        />
        {!balance && (
          <Select
            comboboxProps={dropdown}
            label={t("stats.graphs.showAs")}
            description={
              hourly
                ? t("stats.graphs.showAsHour")
                : s.show_as
                  ? t("stats.graphs.showAsHint")
                  : undefined
            }
            data={SHOW_AS.map((v) => ({
              value: v,
              label: t(`stats.graphs.showAsOptions.${v}`),
              disabled: v === "cycle" && cycles.length === 0,
            }))}
            value={s.show_as ?? "total"}
            disabled={hourly}
            onChange={(v) => {
              if (v) set({ show_as: v });
            }}
            allowDeselect={false}
          />
        )}
      </Stack>
      {!reportPeriod && (
        <Stack gap="sm">
          <PeriodPicker
            inline={narrow}
            value={choice}
            cycles={cycles}
            onChange={(choice) => {
              set({ period: formatPeriod(choice) });
            }}
          />
          {belowPeriod}
        </Stack>
      )}
      <Stack gap="sm">
        {!whole && (
          <ResolutionPicker
            inline={narrow}
            value={s.resolution}
            choice={choice}
            max={maxIntervals(s.kind)}
            cycles={cycles}
            omit={pie ? ["total"] : undefined}
            onChange={(resolution) => {
              if (resolution !== s.resolution) set({ resolution });
            }}
          />
        )}
        <Select
          comboboxProps={dropdown}
          label={t("stats.graphs.groupBy")}
          data={groups.map((g) => ({ value: g, label: groupLabel(g) }))}
          value={group}
          onChange={(g) => {
            if (g) set({ group_by: g });
          }}
          allowDeselect={false}
        />
        {group !== "none" && (
          <NumberInput
            label={t(pie ? "stats.graphs.topPie" : "stats.graphs.top")}
            description={t(pie ? "stats.graphs.topPieHint" : "stats.graphs.topHint", {
              max: MAX_TOP,
            })}
            min={1}
            max={MAX_TOP}
            clampBehavior="strict"
            allowDecimal={false}
            allowNegative={false}
            value={topOf(s)}
            onChange={(n) => {
              if (typeof n === "number" && n >= 1) set({ top: Math.min(n, MAX_TOP) });
            }}
          />
        )}
        {s.kind === "bar" && group !== "none" && (
          <Input.Wrapper label={t("stats.graphs.bars")}>
            <SegmentedControl
              fullWidth
              data={[
                { value: "stacked", label: t("stats.graphs.stacked") },
                { value: "side", label: t("stats.graphs.sideBySide") },
              ]}
              value={s.side_by_side ? "side" : "stacked"}
              onChange={(v) => {
                set({ side_by_side: v === "side" });
              }}
            />
          </Input.Wrapper>
        )}
        {s.kind === "line" && (
          <Input.Wrapper label={t("stats.graphs.lineStyle")}>
            <SegmentedControl
              fullWidth
              data={[
                { value: "straight", label: t("stats.graphs.straight") },
                { value: "stepped", label: t("stats.graphs.stepped") },
              ]}
              value={s.stepped ? "stepped" : "straight"}
              onChange={(v) => {
                set({ stepped: v === "stepped" });
              }}
            />
          </Input.Wrapper>
        )}
        {pie ? (
          <Input.Wrapper label={t("stats.graphs.pieLabels")}>
            <SegmentedControl
              fullWidth
              data={PIE_LABELS.map((v) => ({
                value: v,
                label: t(`stats.graphs.pieLabelOptions.${v}`),
              }))}
              value={s.pie_labels ?? "list"}
              onChange={(v) => {
                set({ pie_labels: v });
              }}
            />
          </Input.Wrapper>
        ) : (
          <Input.Wrapper label={t("stats.graphs.yAxis")}>
            <SegmentedControl
              fullWidth
              data={[
                { value: "zero", label: t("stats.graphs.includeZero") },
                { value: "fit", label: t("stats.graphs.fit") },
              ]}
              value={s.fit_y_axis ? "fit" : "zero"}
              onChange={(v) => {
                set({ fit_y_axis: v === "fit" });
              }}
            />
          </Input.Wrapper>
        )}
        {s.kind === "line" && !balance && (
          <Switch
            label={t("stats.graphs.cumulative")}
            description={t("stats.graphs.cumulativeHint")}
            checked={s.cumulative ?? false}
            onChange={(e) => {
              set({ cumulative: e.currentTarget.checked });
            }}
          />
        )}
        {!pie && (
          <Switch
            label={t("stats.graphs.averageLine")}
            description={
              s.cumulative ? t("stats.graphs.averageCumulative") : t("stats.graphs.averageHint")
            }
            checked={s.average ?? false}
            disabled={s.cumulative ?? false}
            onChange={(e) => {
              set({ average: e.currentTarget.checked });
            }}
          />
        )}
      </Stack>
      <FilterFields
        value={s}
        onChange={set}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        accountsOnly={balance}
        inline={narrow}
        inherits={inherits ?? reportPeriod !== undefined}
      />
    </SimpleGrid>
  );
}
