import { Select } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { now as clockNow, useClockVersion } from "@/lib/clock";
import {
  applicableResolutions,
  defaultResolution,
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
  /** Render the dropdown in place, not in a portal (inside a drawer). */
  inline?: boolean;
  /** Resolutions not to offer, such as the whole period for a pie per interval. */
  omit?: Resolution[];
}

/**
 * The resolution for a period (#120): every one whose interval is no longer
 * than the period, per hour to the whole period. When the period changes
 * and the value no longer makes sense, it switches to the period's default.
 * A graph that can't draw that many intervals goes coarser itself.
 */
export function ResolutionPicker({
  value,
  onChange,
  choice,
  max,
  cycles,
  inline = false,
  omit = [],
}: ResolutionPickerProps) {
  const { t } = useTranslation();
  const dropdown = inline ? { withinPortal: false } : undefined;
  useClockVersion();
  const now = clockNow();
  const options = applicableResolutions(choice, cycles, now).filter((r) => !omit.includes(r));
  // A value no longer offered becomes the period's default, or when that
  // isn't offered either, the coarsest one left.
  const fallback = () => {
    const d = defaultResolution(choice, cycles, max, now);
    return options.includes(d) ? d : (options.at(-1) ?? value);
  };
  const kept = options.length === 0 || options.includes(value) ? value : fallback();

  useEffect(() => {
    if (kept !== value) onChange(kept);
  }, [kept, value, onChange]);

  return (
    <Select
      comboboxProps={dropdown}
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
