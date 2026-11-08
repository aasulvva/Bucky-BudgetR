import { Select } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { now as clockNow, useClockVersion } from "@/lib/clock";
import {
  applicableResolutions,
  keptResolution,
  type PeriodChoice,
  type Resolution,
} from "@/lib/periods";

interface ResolutionPickerProps {
  value: Resolution;
  onChange: (value: Resolution) => void;
  /** The period it cuts. */
  choice: PeriodChoice;
  /** The most intervals the default may give: MAX_BARS for bars, MAX_POINTS for lines. */
  max: number;
  cycles: Cycle[];
}

/**
 * The resolution for a period (#120): every one whose interval is no longer
 * than the period, per hour to the whole period. When the period changes
 * and the value no longer makes sense, it switches to the period's default.
 * A graph that can't draw that many intervals goes coarser itself.
 */
export function ResolutionPicker({ value, onChange, choice, max, cycles }: ResolutionPickerProps) {
  const { t } = useTranslation();
  useClockVersion();
  const now = clockNow();
  const options = applicableResolutions(choice, cycles, now);
  const kept = options.length > 0 ? keptResolution(value, choice, cycles, max, now) : value;

  useEffect(() => {
    if (kept !== value) onChange(kept);
  }, [kept, value, onChange]);

  return (
    <Select
      label={t("stats.resolution.label")}
      data={options.map((r) => ({ value: r, label: t(`stats.resolution.options.${r}`) }))}
      value={kept}
      onChange={(v) => {
        if (v) onChange(v);
      }}
      allowDeselect={false}
      disabled={options.length === 0}
    />
  );
}
