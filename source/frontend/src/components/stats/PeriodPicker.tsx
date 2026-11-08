import { ActionIcon, Box, Group, Input, NumberInput, Select, Stack, Text } from "@mantine/core";
import { DatePickerInput, MonthPickerInput, YearPickerInput } from "@mantine/dates";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { now as clockNow, useClockVersion } from "@/lib/clock";
import { addDays, cycleRange, formatDateRange, today, type LocalDate } from "@/lib/cycles";
import {
  CALENDAR_UNITS,
  LAST_DEFAULT,
  LAST_MAX,
  LAST_UNITS,
  resolvePeriod,
  SPECIFIC_UNITS,
  specificAt,
  stepSpecific,
  type LastUnit,
  type PeriodChoice,
  type SpecificUnit,
} from "@/lib/periods";

interface PeriodPickerProps {
  value: PeriodChoice;
  onChange: (value: PeriodChoice) => void;
  /** The user's cycles, for the cycle periods. */
  cycles: Cycle[];
}

type Kind = PeriodChoice["kind"];
type Specific = Extract<PeriodChoice, { kind: "specific" }>;

const KINDS: Kind[] = ["last", "current", "previous", "specific", "custom"];

/** A last-N unit and the one-period unit it counts. */
const SINGULAR: Record<LastUnit, SpecificUnit> = {
  days: "day",
  weeks: "week",
  months: "month",
  cycles: "cycle",
  years: "year",
};

/** The choice's unit as one period ("day", "month"); null for custom dates. */
function unitOf(choice: PeriodChoice): SpecificUnit | null {
  if (choice.kind === "custom") return null;
  if (choice.kind === "last") return SINGULAR[choice.unit];
  return choice.unit;
}

/**
 * A shared period picker (#120): the kind (Last, This, Previous, Specific,
 * Custom dates) and its unit, then what that needs (N, the one period with
 * arrows to step through them, or two dates), then the dates it covers.
 */
export function PeriodPicker({ value, onChange, cycles }: PeriodPickerProps) {
  const { t } = useTranslation();
  useClockVersion();
  const now = clockNow();
  const day = today(now);
  const period = resolvePeriod(value, cycles, now);
  // A custom range in the making: it applies once both ends are picked.
  const [range, setRange] = useState<[LocalDate | null, LocalDate | null] | null>(null);

  /** The choice of a kind and unit, starting from what's shown now. */
  const choiceFor = (kind: Kind, unit: SpecificUnit | null): PeriodChoice => {
    switch (kind) {
      case "last": {
        const u = LAST_UNITS.find((x) => SINGULAR[x] === unit) ?? "days";
        return { kind, unit: u, count: LAST_DEFAULT[u] };
      }
      case "current":
      case "previous":
        return { kind, unit: CALENDAR_UNITS.find((x) => x === unit) ?? "month" };
      case "specific":
        return (
          specificAt(unit ?? "month", period?.to ?? day, cycles) ??
          specificAt("month", period?.to ?? day, cycles) ?? { kind, unit: "month", at: day }
        );
      case "custom":
        return { kind, from: period?.from ?? day, to: period?.to ?? day };
    }
  };

  const units: string[] =
    value.kind === "last"
      ? LAST_UNITS
      : value.kind === "specific"
        ? SPECIFIC_UNITS
        : value.kind === "custom"
          ? []
          : CALENDAR_UNITS;
  const unitValue = value.kind === "custom" ? null : value.unit;
  const unitLabel = (u: string) =>
    value.kind === "last"
      ? t(`stats.period.unitsPlural.${u as LastUnit}`)
      : t(`stats.period.units.${u as SpecificUnit}`);

  const missing =
    value.kind === "current"
      ? t("stats.period.noActiveCycle")
      : value.kind === "previous"
        ? t("stats.period.noFinishedCycle")
        : t("stats.period.noCycle");

  return (
    <Stack gap="xs">
      <Group gap="xs" grow align="flex-end" wrap="nowrap">
        <Select
          label={t("stats.period.label")}
          data={KINDS.map((k) => ({ value: k, label: t(`stats.period.kinds.${k}`) }))}
          value={value.kind}
          onChange={(k) => {
            if (!k || k === value.kind) return;
            setRange(null);
            onChange(choiceFor(k, unitOf(value)));
          }}
          allowDeselect={false}
        />
        {value.kind !== "custom" && (
          <Select
            aria-label={t("stats.period.unit")}
            data={units.map((u) => ({ value: u, label: unitLabel(u) }))}
            value={unitValue}
            onChange={(u) => {
              if (!u || u === unitValue) return;
              const singular =
                value.kind === "last" ? SINGULAR[u as LastUnit] : (u as SpecificUnit);
              onChange(choiceFor(value.kind, singular));
            }}
            allowDeselect={false}
            maxDropdownHeight={320}
          />
        )}
      </Group>
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
      {value.kind === "specific" && (
        <SpecificPicker value={value} onChange={onChange} cycles={cycles} day={day} now={now} />
      )}
      {value.kind === "custom" && (
        <DatePickerInput
          type="range"
          label={t("stats.period.dates")}
          valueFormat="D MMM YYYY"
          maxDate={day}
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

interface SpecificPickerProps {
  value: Specific;
  onChange: (value: PeriodChoice) => void;
  cycles: Cycle[];
  day: LocalDate;
  now: Date;
}

/** One day, week, cycle, month, quarter, half-year or year, with arrows to the one before and after. */
function SpecificPicker({ value, onChange, cycles, day, now }: SpecificPickerProps) {
  const { t } = useTranslation();
  const before = stepSpecific(value, -1, cycles, now);
  const after = stepSpecific(value, 1, cycles, now);
  const pick = (unit: SpecificUnit, date: LocalDate | null) => {
    const next = date ? specificAt(unit, date, cycles) : null;
    if (next) onChange(next);
  };
  const label = t(`stats.period.units.${value.unit}`);
  const [year = "", month = "01"] = value.at.split("-");

  let picker;
  switch (value.unit) {
    case "day":
    case "week": {
      const end = value.unit === "week" ? addDays(value.at, 6) : value.at;
      picker = (
        <DatePickerInput
          aria-label={label}
          value={value.at}
          maxDate={day}
          valueFormat="ddd D MMM YYYY"
          // A week shows as its dates, and picking any day picks its week.
          valueFormatter={value.unit === "week" ? () => formatDateRange(value.at, end) : undefined}
          getDayProps={
            value.unit === "week"
              ? (date) => ({
                  inRange: date >= value.at && date <= end,
                  firstInRange: date === value.at,
                  lastInRange: date === end,
                })
              : undefined
          }
          onChange={(d) => {
            pick(value.unit, d);
          }}
        />
      );
      break;
    }
    case "month":
      picker = (
        <MonthPickerInput
          aria-label={label}
          value={value.at}
          maxDate={day}
          valueFormat="MMMM YYYY"
          onChange={(d) => {
            pick("month", d);
          }}
        />
      );
      break;
    case "year":
      picker = (
        <YearPickerInput
          aria-label={label}
          value={value.at}
          maxDate={day}
          onChange={(d) => {
            pick("year", d);
          }}
        />
      );
      break;
    case "quarter":
    case "half_year": {
      const size = value.unit === "quarter" ? 3 : 6;
      const parts = Array.from({ length: 12 / size }, (_, i) => {
        const at = `${year}-${String(i * size + 1).padStart(2, "0")}-01`;
        return {
          value: at,
          label: t(
            value.unit === "quarter" ? "stats.period.quarterShort" : "stats.period.halfShort",
            {
              n: i + 1,
            },
          ),
          disabled: at > day,
        };
      });
      picker = (
        <Group gap="xs" grow wrap="nowrap">
          <YearPickerInput
            aria-label={t("stats.period.units.year")}
            value={`${year}-01-01`}
            maxDate={day}
            onChange={(d) => {
              if (!d) return;
              // The same quarter or half-year in that year, or the latest one by today.
              const at = `${d.slice(0, 4)}-${month}-01`;
              pick(value.unit, at > day ? day : at);
            }}
          />
          <Select
            aria-label={label}
            data={parts}
            value={value.at}
            onChange={(at) => {
              pick(value.unit, at);
            }}
            allowDeselect={false}
          />
        </Group>
      );
      break;
    }
    case "cycle": {
      const started = cycles
        .filter((c) => c.state !== "future")
        .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
      picker = (
        <Select
          aria-label={label}
          data={started.map((c) => ({ value: c.id, label: cycleRange(c) }))}
          value={value.at}
          onChange={(id) => {
            if (id) onChange({ ...value, at: id });
          }}
          searchable
          allowDeselect={false}
          maxDropdownHeight={320}
          nothingFoundMessage={t("stats.period.noCycle")}
        />
      );
      break;
    }
  }

  return (
    <Input.Wrapper label={label}>
      <Group gap="xs" wrap="nowrap" align="center">
        <ActionIcon
          variant="default"
          size="input-sm"
          aria-label={t("stats.period.before")}
          disabled={!before}
          onClick={() => {
            if (before) onChange(before);
          }}
        >
          <IconChevronLeft size={16} />
        </ActionIcon>
        <Box style={{ flex: 1, minWidth: 0 }}>{picker}</Box>
        <ActionIcon
          variant="default"
          size="input-sm"
          aria-label={t("stats.period.after")}
          disabled={!after}
          onClick={() => {
            if (after) onChange(after);
          }}
        >
          <IconChevronRight size={16} />
        </ActionIcon>
      </Group>
    </Input.Wrapper>
  );
}
