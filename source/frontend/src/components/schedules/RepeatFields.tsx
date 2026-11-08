import {
  Box,
  Group,
  List,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { DatePickerInput, TimePicker } from "@mantine/dates";
import { useTranslation } from "react-i18next";

import { useSchedulePreview } from "@/api/schedules";
import { browserTimeZone } from "@/lib/cycleRule";
import { formatDateTime } from "@/lib/dates";
import { now } from "@/lib/clock";
import {
  FREQUENCIES,
  MAX_DUE_DAYS,
  MAX_EVERY,
  MAX_NAME,
  previewBody,
  startsByNow,
  type Ends,
  type RepeatErrors,
  type RepeatValues,
  type ScheduleMode,
} from "@/lib/schedules";

const ENDS: Ends[] = ["never", "after", "on"];
const MODES: ScheduleMode[] = ["auto", "approve"];

/**
 * When a schedule records its transaction (#154): the start, the repeat, the
 * end, auto or approve, and a preview of the next times from the server.
 * Dates and times are wall time in the schedule's time zone.
 */
export function RepeatFields({
  value,
  onChange,
  errors,
  editing = false,
  recordFirst = false,
}: {
  value: RepeatValues;
  onChange: (change: Partial<RepeatValues>) => void;
  errors: RepeatErrors;
  /** Editing a saved schedule: it can be paused. */
  editing?: boolean;
  /** A first time that's now or past is saved now (New transaction). */
  recordFirst?: boolean;
}) {
  const { t } = useTranslation();
  const preview = useSchedulePreview(previewBody(value));
  const repeats = value.frequency !== "once";
  const every = typeof value.every === "number" ? value.every : Number(value.every) || 1;
  const first =
    recordFirst && startsByNow(value, now()) && value.startDate && value.time
      ? `${value.startDate} ${value.time}`
      : null;

  return (
    <Stack gap="sm" component="section" aria-label={t("schedules.form.section")}>
      <Title order={3} size="h5">
        {t("schedules.form.section")}
      </Title>
      <Group gap="xs" align="flex-start" grow>
        <DatePickerInput
          label={t("schedules.form.startDate")}
          valueFormat="D MMM YYYY"
          value={value.startDate}
          onChange={(v) => {
            onChange({ startDate: v });
          }}
          error={errors.startDate}
        />
        <TimePicker
          label={t("schedules.form.time")}
          value={value.time ?? ""}
          onChange={(v) => {
            onChange({ time: v ? v.slice(0, 5) : null });
          }}
          error={errors.time}
        />
      </Group>
      {value.timeZone !== browserTimeZone() && (
        <Text size="xs" c="dimmed">
          {t("schedules.form.timeZone", { zone: value.timeZone })}
        </Text>
      )}
      <Group gap="xs" align="flex-start" grow>
        <Select
          label={t("schedules.form.frequency")}
          data={FREQUENCIES.map((f) => ({ value: f, label: t(`schedules.form.frequencies.${f}`) }))}
          value={value.frequency}
          allowDeselect={false}
          onChange={(v) => {
            const f = FREQUENCIES.find((x) => x === v);
            if (f) onChange({ frequency: f });
          }}
        />
        {repeats && value.frequency !== "once" && (
          <NumberInput
            label={t("schedules.form.every")}
            min={1}
            max={MAX_EVERY}
            allowDecimal={false}
            allowNegative={false}
            value={value.every}
            onChange={(v) => {
              onChange({ every: v });
            }}
            rightSection={
              <Text size="sm" c="dimmed" pr="xs">
                {t(`schedules.form.units.${value.frequency}`, { count: every })}
              </Text>
            }
            rightSectionWidth={80}
            error={errors.every}
          />
        )}
      </Group>
      {repeats && (
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            {t("schedules.form.ends")}
          </Text>
          <SegmentedControl
            aria-label={t("schedules.form.ends")}
            value={value.ends}
            onChange={(v) => {
              const e = ENDS.find((x) => x === v);
              if (e) onChange({ ends: e });
            }}
            data={ENDS.map((e) => ({ value: e, label: t(`schedules.form.endsOptions.${e}`) }))}
            style={{ alignSelf: "flex-start" }}
          />
          {value.ends === "after" && (
            <NumberInput
              label={t("schedules.form.endCount")}
              min={1}
              allowDecimal={false}
              allowNegative={false}
              value={value.endCount}
              onChange={(v) => {
                onChange({ endCount: v });
              }}
              error={errors.endCount}
              maw={160}
            />
          )}
          {value.ends === "on" && (
            <DatePickerInput
              label={t("schedules.form.endDate")}
              valueFormat="D MMM YYYY"
              value={value.endDate}
              minDate={value.startDate ?? undefined}
              onChange={(v) => {
                onChange({ endDate: v });
              }}
              error={errors.endDate}
              maw={220}
            />
          )}
        </Stack>
      )}
      <ModeFields value={value} onChange={onChange} errors={errors} />
      <TextInput
        label={t("schedules.form.name")}
        placeholder={t("schedules.form.namePlaceholder")}
        value={value.name}
        maxLength={MAX_NAME}
        onChange={(e) => {
          onChange({ name: e.currentTarget.value });
        }}
        error={errors.name}
      />
      {editing && (
        <Switch
          label={t("schedules.form.paused")}
          description={t("schedules.form.pausedHint")}
          checked={value.paused}
          onChange={(e) => {
            onChange({ paused: e.currentTarget.checked });
          }}
        />
      )}
      <Box
        p="sm"
        bg="var(--mantine-color-default-hover)"
        style={{ borderRadius: 8 }}
        aria-live="polite"
      >
        <Group gap="xs" mb={4}>
          <Text size="sm" fw={500}>
            {t("schedules.form.preview")}
          </Text>
          {preview.isFetching && <Loader size={12} />}
        </Group>
        {first && (
          <Text size="sm" mb={4}>
            {t(
              value.mode === "approve" ? "schedules.form.firstApprove" : "schedules.form.firstNow",
              {
                date: formatDateTime(`${first.replace(" ", "T")}:00`),
              },
            )}
          </Text>
        )}
        {preview.data &&
          (preview.data.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("schedules.form.previewNone")}
            </Text>
          ) : (
            <List size="sm" spacing={2} data-testid="schedule-preview">
              {preview.data.map((at) => (
                <List.Item key={at}>{formatDateTime(at)}</List.Item>
              ))}
            </List>
          ))}
      </Box>
    </Stack>
  );
}

/** Record it when due, or ask first and when it's due: a schedule's mode. */
export function ModeFields({
  value,
  onChange,
  errors,
}: {
  value: Pick<RepeatValues, "mode" | "dueDays">;
  onChange: (change: Partial<RepeatValues>) => void;
  errors: Pick<RepeatErrors, "dueDays">;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        {t("schedules.form.mode")}
      </Text>
      <SegmentedControl
        aria-label={t("schedules.form.mode")}
        value={value.mode}
        onChange={(v) => {
          const m = MODES.find((x) => x === v);
          if (m) onChange({ mode: m });
        }}
        data={MODES.map((m) => ({ value: m, label: t(`schedules.form.modes.${m}`) }))}
        style={{ alignSelf: "flex-start" }}
      />
      <Text size="xs" c="dimmed">
        {t(`schedules.form.modeHints.${value.mode}`)}
      </Text>
      {value.mode === "approve" && (
        <NumberInput
          label={t("schedules.form.dueDays")}
          min={0}
          max={MAX_DUE_DAYS}
          allowDecimal={false}
          allowNegative={false}
          value={value.dueDays}
          onChange={(v) => {
            onChange({ dueDays: v });
          }}
          error={errors.dueDays}
          maw={160}
        />
      )}
    </Stack>
  );
}
