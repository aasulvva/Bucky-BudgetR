import { Select } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { fittingResolutions, keptResolution, type Period, type Resolution } from "@/lib/periods";

interface ResolutionPickerProps {
  value: Resolution;
  onChange: (value: Resolution) => void;
  /** The period it cuts; null when it doesn't resolve (nothing to pick). */
  period: Period | null;
  /** The most intervals allowed: MAX_BARS for bars, MAX_POINTS for lines. */
  max: number;
  cycles: Cycle[];
}

/**
 * The resolution for a period (#120), offering only those that give at most
 * `max` intervals. When the period changes and the value no longer fits, it
 * switches to the period's default.
 */
export function ResolutionPicker({ value, onChange, period, max, cycles }: ResolutionPickerProps) {
  const { t } = useTranslation();
  const options = period ? fittingResolutions(period, max, cycles) : [];
  const kept = period ? keptResolution(value, period, max, cycles) : value;

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
      disabled={period === null}
    />
  );
}
