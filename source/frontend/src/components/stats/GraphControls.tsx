import {
  Input,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { useState } from "react";
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
  topOf,
  type GraphSettings,
} from "@/lib/graphs";
import { defaultPeriod, formatPeriod, parsePeriod, type Period } from "@/lib/periods";

import { PeriodPicker } from "./PeriodPicker";
import { ResolutionPicker } from "./ResolutionPicker";

interface GraphControlsProps {
  value: GraphSettings;
  onChange: (value: GraphSettings) => void;
  /** The value's period, resolved now. */
  period: Period | null;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  /** One column, for the mobile drawer. */
  narrow?: boolean;
}

/** What a graph shows and how (#122). Each change is a whole new value. */
export function GraphControls({
  value,
  onChange,
  period,
  cycles,
  accounts,
  buckets,
  tags,
  narrow = false,
}: GraphControlsProps) {
  const { t } = useTranslation();
  const s = cleanGraph(value);
  const set = (patch: Partial<GraphSettings>) => {
    onChange(cleanGraph({ ...value, ...patch }));
  };
  const balance = s.metric === "balance";
  const group = groupBy(s);
  const [counterparty, setCounterparty] = useState(s.counterparty ?? "");
  // Follow a counterparty set from elsewhere (a saved graph, Back).
  const [shown, setShown] = useState(s.counterparty ?? "");
  if ((s.counterparty ?? "") !== shown) {
    setShown(s.counterparty ?? "");
    if (counterparty.trim() !== (s.counterparty ?? "")) setCounterparty(s.counterparty ?? "");
  }
  const setCounterpartyLater = useDebouncedCallback((q: string) => {
    set({ counterparty: q });
  }, 400);

  const groups = GROUP_BYS.filter((g) => !(balance && g === "bucket"));
  const chosenAccounts = s.account_ids ?? [];
  // Buckets of the chosen accounts, when any are chosen.
  const bucketOptions = buckets
    .filter((b) => chosenAccounts.length === 0 || chosenAccounts.includes(b.source_account_id))
    .map((b) => ({ value: b.id, label: b.name }));

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
            ]}
            value={s.kind}
            onChange={(kind) => {
              set({ kind: kind });
            }}
          />
        </Input.Wrapper>
        <Select
          label={t("stats.graphs.metric")}
          data={GRAPH_METRICS.map((m) => ({ value: m, label: t(`stats.graphs.metrics.${m}`) }))}
          value={s.metric}
          onChange={(m) => {
            if (m) set({ metric: m });
          }}
          allowDeselect={false}
        />
      </Stack>
      <PeriodPicker
        value={parsePeriod(s.period) ?? defaultPeriod(cycles)}
        cycles={cycles}
        onChange={(choice) => {
          set({ period: formatPeriod(choice) });
        }}
      />
      <Stack gap="sm">
        <ResolutionPicker
          value={s.resolution}
          period={period}
          max={maxIntervals(s.kind)}
          cycles={cycles}
          onChange={(resolution) => {
            if (resolution !== s.resolution) set({ resolution });
          }}
        />
        <Select
          label={t("stats.graphs.groupBy")}
          data={groups.map((g) => ({ value: g, label: t(`stats.graphs.groups.${g}`) }))}
          value={group}
          onChange={(g) => {
            if (g) set({ group_by: g });
          }}
          allowDeselect={false}
        />
        {group !== "none" && (
          <NumberInput
            label={t("stats.graphs.top")}
            description={t("stats.graphs.topHint", { max: MAX_TOP })}
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
      </Stack>
      <Stack gap="sm">
        <MultiSelect
          label={t("stats.graphs.accounts")}
          placeholder={chosenAccounts.length === 0 ? t("stats.graphs.allAccounts") : undefined}
          description={!balance ? t("stats.graphs.accountsHint") : undefined}
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={chosenAccounts}
          onChange={(ids) => {
            set({ account_ids: ids });
          }}
          searchable
          clearable
        />
        {!balance && (
          <>
            <MultiSelect
              label={t("stats.graphs.buckets")}
              placeholder={
                (s.bucket_ids ?? []).length === 0 ? t("stats.graphs.allBuckets") : undefined
              }
              data={bucketOptions}
              value={s.bucket_ids ?? []}
              onChange={(ids) => {
                set({ bucket_ids: ids });
              }}
              searchable
              clearable
            />
            <MultiSelect
              label={t("stats.graphs.tags")}
              placeholder={(s.tags ?? []).length === 0 ? t("stats.graphs.anyTag") : undefined}
              data={[...new Set([...tags, ...(s.tags ?? [])])]}
              value={s.tags ?? []}
              onChange={(chosen) => {
                set({ tags: chosen });
              }}
              searchable
              clearable
            />
            <TextInput
              label={t("stats.graphs.counterparty")}
              value={counterparty}
              onChange={(e) => {
                setCounterparty(e.currentTarget.value);
                setCounterpartyLater(e.currentTarget.value);
              }}
            />
          </>
        )}
      </Stack>
    </SimpleGrid>
  );
}
