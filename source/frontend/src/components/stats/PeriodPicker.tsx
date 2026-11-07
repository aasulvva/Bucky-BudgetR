import { NumberInput, Select, Stack, Text } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { now as clockNow, useClockVersion } from "@/lib/clock";
import { formatDateRange, today, type LocalDate } from "@/lib/cycles";
import {
  CALENDAR_UNITS,
  LAST_MAX,
  LAST_UNITS,
  resolvePeriod,
  type LastUnit,
  type PeriodChoice,
} from "@/lib/periods";

interface PeriodPickerProps {
  value: PeriodChoice;
  onChange: (value: PeriodChoice) => void;
  /** The user's cycles, for This cycle and Previous cycle. */
  cycles: Cycle[];
}

/** The option a choice is under: "last_days", "current_month", "custom". */
function optionOf(choice: PeriodChoice): string {
  return choice.kind === "custom" ? "custom" : `${choice.kind}_${choice.unit}`;
}

/** A shared period picker (#120): a kind, then N or dates where it needs them, then the dates it covers. */
export function PeriodPicker({ value, onChange, cycles }: PeriodPickerProps) {
  const { t } = useTranslation();
  useClockVersion();
  const now = clockNow();
  const period = resolvePeriod(value, cycles, now);
  // A custom range in the making: it applies once both ends are picked.
  const [range, setRange] = useState<[LocalDate | null, LocalDate | null] | null>(null);

  const data = [
    {
      group: t("stats.period.groups.last"),
      items: LAST_UNITS.map((u) => ({
        value: `last_${u}`,
        label: t(`stats.period.options.last_${u}`),
      })),
    },
    ...(["current", "previous"] as const).map((kind) => ({
      group: t(`stats.period.groups.${kind}`),
      items: CALENDAR_UNITS.map((u) => ({
        value: `${kind}_${u}`,
        label: t(`stats.period.options.${kind}_${u}`),
      })),
    })),
    {
      group: t("stats.period.groups.custom"),
      items: [{ value: "custom", label: t("stats.period.options.custom") }],
    },
  ];

  const choose = (option: string | null) => {
    if (!option || option === optionOf(value)) return;
    setRange(null);
    if (option === "custom") {
      // Start from the dates shown now.
      const day = today(now);
      onChange({ kind: "custom", from: period?.from ?? day, to: period?.to ?? day });
      return;
    }
    const [kind, ...rest] = option.split("_");
    const unit = rest.join("_");
    if (kind === "last") {
      const count = value.kind === "last" ? Math.min(value.count, LAST_MAX[unit as LastUnit]) : 7;
      onChange({ kind: "last", unit: unit as LastUnit, count });
    } else {
      onChange({
        kind: kind as "current" | "previous",
        unit: unit as (typeof CALENDAR_UNITS)[number],
      });
    }
  };

  const missing =
    value.kind === "current" ? t("stats.period.noActiveCycle") : t("stats.period.noFinishedCycle");

  return (
    <Stack gap="xs">
      <Select
        label={t("stats.period.label")}
        data={data}
        value={optionOf(value)}
        onChange={choose}
        allowDeselect={false}
        maxDropdownHeight={360}
      />
      {value.kind === "last" && (
        <NumberInput
          label={t(`stats.period.count.${value.unit}`)}
          description={t(`stats.period.countHint.${value.unit}`)}
          min={1}
          max={LAST_MAX[value.unit]}
          clampBehavior="strict"
          allowDecimal={false}
          allowNegative={false}
          value={value.count}
          onChange={(n) => {
            if (typeof n === "number" && n >= 1) {
              onChange({ ...value, count: Math.min(n, LAST_MAX[value.unit]) });
            }
          }}
        />
      )}
      {value.kind === "custom" && (
        <DatePickerInput
          type="range"
          label={t("stats.period.dates")}
          valueFormat="D MMM YYYY"
          maxDate={today(now)}
          allowSingleDateInRange
          value={range ?? [value.from, value.to]}
          onChange={(v) => {
            setRange(v);
            if (v[0] && v[1]) {
              setRange(null);
              onChange({ kind: "custom", from: v[0], to: v[1] });
            }
          }}
        />
      )}
      <Text size="sm" c="dimmed" data-testid="period-range">
        {period ? formatDateRange(period.from, period.to) : missing}
      </Text>
    </Stack>
  );
}
