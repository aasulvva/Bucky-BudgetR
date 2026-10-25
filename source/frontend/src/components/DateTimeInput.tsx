import { DateTimePicker, type DateTimePickerProps } from "@mantine/dates";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/lib/dates";

interface DateTimeInputProps extends Omit<
  DateTimePickerProps,
  "value" | "defaultValue" | "onChange" | "valueFormat"
> {
  /** An API timestamp (ISO 8601, UTC), or null for "now". */
  value: string | null;
  onChange: (value: string | null) => void;
}

/**
 * Picks when something happened, in the user's local time. The value is a
 * UTC timestamp for the API; empty means now. The future can't be picked.
 */
export function DateTimeInput({ value, onChange, ...props }: DateTimeInputProps) {
  const { t } = useTranslation();
  return (
    <DateTimePicker
      clearable
      placeholder={t("common.now")}
      maxDate={new Date()}
      valueFormat={(local) => formatDateTime(dayjs(local).toDate())}
      {...props}
      value={value === null ? null : dayjs(value).format("YYYY-MM-DD HH:mm:ss")}
      onChange={(local) => {
        onChange(local === null ? null : dayjs(local).toISOString());
      }}
    />
  );
}
