import { DateTimePicker, type DateTimePickerProps } from "@mantine/dates";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { now } from "@/lib/clock";
import { formatDateTime } from "@/lib/dates";
import { isTouch } from "@/lib/device";

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
 *
 * On touch screens it opens as a dialog instead of a dropdown (#166): on a
 * phone, the keyboard moved the dropdown and took the focus from the hour
 * after each digit, so a time couldn't be typed in one go.
 */
export function DateTimeInput({ value, onChange, ...props }: DateTimeInputProps) {
  const { t } = useTranslation();
  return (
    <DateTimePicker
      clearable
      placeholder={t("common.now")}
      maxDate={now()}
      defaultDate={now()}
      dropdownType={isTouch() ? "modal" : "popover"}
      valueFormat={(local) => formatDateTime(dayjs(local).toDate())}
      {...props}
      value={value === null ? null : dayjs(value).format("YYYY-MM-DD HH:mm:ss")}
      onChange={(local) => {
        onChange(local === null ? null : dayjs(local).toISOString());
      }}
    />
  );
}
