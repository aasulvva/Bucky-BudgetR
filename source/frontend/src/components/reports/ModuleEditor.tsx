import { Button, Group, Input, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { GraphControls } from "@/components/stats/GraphControls";
import type { Period, PeriodChoice } from "@/lib/periods";
import {
  BREAKDOWN_MIN_DAYS,
  BREAKDOWNS,
  MAX_SUB_PERIODS,
  MODULE_COMPARES,
  subPeriods,
  type Breakdown,
  type ReportModule,
  type ReportSettings,
  withoutPeriod,
} from "@/lib/reports";

const MAX_TITLE = 80;

interface ModuleEditorProps {
  /** The module to edit, or null when closed. */
  module: ReportModule | null;
  /** Whether it's being added. */
  adding: boolean;
  report: ReportSettings;
  choice: PeriodChoice;
  period: Period | null;
  /** Whether the report's period has one before it to compare with. */
  comparable: boolean;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  onApply: (module: ReportModule) => void;
  onClose: () => void;
}

/** A report module's settings (#125): the graph, a title, comparison and breakdown. */
export function ModuleEditor(props: ModuleEditorProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveModal
      opened={props.module !== null}
      onClose={props.onClose}
      size="lg"
      title={t(props.adding ? "stats.reports.module.addTitle" : "stats.reports.module.editTitle")}
    >
      {props.module && <Editor {...props} module={props.module} />}
    </ResponsiveModal>
  );
}

function Editor({
  module,
  adding,
  report,
  choice,
  period,
  comparable,
  cycles,
  accounts,
  buckets,
  tags,
  onApply,
  onClose,
}: ModuleEditorProps & { module: ReportModule }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(module);
  const g = draft.graph;
  const tooLong = (draft.title ?? "").trim().length > MAX_TITLE;
  const breakdownWhy = (by: Exclude<Breakdown, "none">) => {
    if (!period) return null;
    const parts = subPeriods(choice, period, by, cycles);
    if (parts.ok) return null;
    return parts.reason === "short"
      ? t("stats.reports.breakdown.short", { days: BREAKDOWN_MIN_DAYS })
      : parts.reason === "many"
        ? t("stats.reports.breakdown.many", { max: MAX_SUB_PERIODS })
        : t("stats.reports.breakdown.none");
  };
  const breakdown = draft.breakdown ?? "none";
  const why = breakdown === "none" ? null : breakdownWhy(breakdown);
  // A pie's difference would be the same two pies.
  const compares = MODULE_COMPARES.filter((c) => g.kind !== "pie" || c !== "difference");
  const compare =
    draft.compare === "difference" && g.kind === "pie" ? "both" : (draft.compare ?? "off");

  return (
    <Stack gap="md">
      <TextInput
        label={t("stats.reports.module.title")}
        description={t("stats.reports.module.titleHint")}
        value={draft.title ?? ""}
        error={tooLong ? t("common.maxChars", { count: MAX_TITLE }) : undefined}
        onChange={(e) => {
          setDraft({ ...draft, title: e.currentTarget.value });
        }}
      />
      <GraphControls
        value={{ ...g, period: report.period }}
        onChange={(next) => {
          setDraft({ ...draft, graph: withoutPeriod(next) });
        }}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        narrow
        reportPeriod={choice}
      />
      <Input.Wrapper
        label={t("stats.reports.compare.label")}
        description={
          comparable ? t("stats.reports.compare.hint") : t("stats.reports.compare.unavailable")
        }
      >
        <SegmentedControl
          fullWidth
          mt={4}
          disabled={!comparable}
          data={compares.map((c) => ({ value: c, label: t(`stats.reports.compare.options.${c}`) }))}
          value={compare}
          onChange={(c) => {
            setDraft({ ...draft, compare: c });
          }}
        />
      </Input.Wrapper>
      <Input.Wrapper
        label={t("stats.reports.breakdown.label")}
        description={t("stats.reports.breakdown.hint", { days: BREAKDOWN_MIN_DAYS })}
      >
        <SegmentedControl
          fullWidth
          mt={4}
          data={BREAKDOWNS.map((b) => ({
            value: b,
            label: t(`stats.reports.breakdown.options.${b}`),
            disabled: b !== "none" && b !== breakdown && breakdownWhy(b) !== null,
          }))}
          value={breakdown}
          onChange={(b) => {
            setDraft({ ...draft, breakdown: b });
          }}
        />
      </Input.Wrapper>
      {why && (
        <Text size="sm" c="dimmed">
          {why}
        </Text>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={tooLong}
          onClick={() => {
            onApply(draft);
          }}
        >
          {t(adding ? "stats.reports.module.add" : "stats.reports.module.apply")}
        </Button>
      </Group>
    </Stack>
  );
}
