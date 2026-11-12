import { Input, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import type { PeriodChoice } from "@/lib/periods";
import { COMPARE_TOS, MODULE_COMPARES, type ReportCompare } from "@/lib/reports";
import type { GraphCompare } from "@/lib/savedModules";

interface GraphCompareFieldsProps {
  value: GraphCompare;
  onChange: (value: GraphCompare) => void;
  /** The graph is a pie, whose difference would be the same two pies. */
  pie: boolean;
  choice: PeriodChoice;
  /** What it compares with, or null when there's nothing to. */
  compare: ReportCompare | null;
  /** Render dropdowns in place, not in a portal (inside a drawer). */
  inline?: boolean;
}

/**
 * A graph's comparison on the Stats tab (#204): off, both periods or the
 * difference, and with the period before or the same one last year.
 */
export function GraphCompareFields({
  value,
  onChange,
  pie,
  choice,
  compare,
  inline = false,
}: GraphCompareFieldsProps) {
  const { t } = useTranslation();
  const custom = choice.kind === "custom";
  const modes = MODULE_COMPARES.filter((c) => !pie || c !== "difference");
  const mode = pie && value.mode === "difference" ? "both" : value.mode;
  const cycleUnit = !custom && (choice.unit === "cycle" || choice.unit === "cycles");
  return (
    <Stack gap="sm">
      <Input.Wrapper
        label={t("stats.graphs.compare")}
        description={compare ? t("stats.reports.compare.hint") : undefined}
      >
        <SegmentedControl
          fullWidth
          mt={4}
          disabled={!compare}
          data={modes.map((c) => ({ value: c, label: t(`stats.reports.compare.options.${c}`) }))}
          value={compare ? mode : "off"}
          onChange={(c) => {
            onChange({ ...value, mode: c });
          }}
        />
      </Input.Wrapper>
      <Stack gap={4}>
        <Select
          comboboxProps={inline ? { withinPortal: false } : undefined}
          label={t("stats.reports.compareTo.label")}
          data={COMPARE_TOS.map((c) => ({
            value: c,
            label: t(`stats.reports.compareTo.options.${c}`),
          }))}
          value={value.to}
          disabled={custom || mode === "off"}
          onChange={(c) => {
            if (c) onChange({ ...value, to: c });
          }}
          allowDeselect={false}
        />
        <Text size="xs" c="dimmed">
          {custom
            ? t("stats.reports.compareTo.custom")
            : compare
              ? t("stats.graphs.compareWith", { period: compare.label })
              : t("stats.reports.compare.unavailable")}
        </Text>
        {cycleUnit && value.to === "last_year" && (
          <Text size="xs" c="dimmed">
            {t("stats.reports.compareTo.cycle")}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
