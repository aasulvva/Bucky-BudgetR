import { Group } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useTranslation } from "react-i18next";

import type { DateRange, LocalDate } from "@/lib/cycles";

interface CycleDatesProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  error?: string;
  /** The earliest start that can be picked. */
  minStart?: LocalDate;
}

/** The first and last day of a cycle, as local dates. */
export function CycleDates({ value, onChange, error, minStart }: CycleDatesProps) {
  const { t } = useTranslation();
  return (
    <Group grow align="flex-start" gap="sm">
      <DatePickerInput
        label={t("cycles.startDate")}
        valueFormat="D MMM YYYY"
        value={value.start}
        minDate={minStart}
        onChange={(start) => {
          if (start) onChange({ ...value, start });
        }}
      />
      <DatePickerInput
        label={t("cycles.lastDate")}
        valueFormat="D MMM YYYY"
        value={value.end}
        minDate={value.start}
        onChange={(end) => {
          if (end) onChange({ ...value, end });
        }}
        error={error}
      />
    </Group>
  );
}
