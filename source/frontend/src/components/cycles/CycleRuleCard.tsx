import {
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CYCLES_KEY, useCyclePeriods } from "@/api/cycles";
import { useUpdatePreferences, type Preferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { formatDateRange } from "@/lib/cycles";
import {
  browserTimeZone,
  defaultRule,
  MAX_AHEAD,
  sameRule,
  validAhead,
  validDay,
  validRule,
  type CycleRule,
} from "@/lib/cycleRule";

const SHIFTS: CycleRule["shift"][] = ["previous", "next", "none"];
const HOLIDAYS: CycleRule["holidays"][] = ["NO", "none"];

/** A NumberInput's value as a whole number; NaN when it isn't one. */
function whole(value: string | number): number {
  return typeof value === "number" ? value : NaN;
}

/**
 * The cycle rule (spec §3, #72): the server keeps the next cycles planned,
 * from one of the rule's dates to the next. Shows the next periods as the
 * rule is edited.
 */
export function CycleRuleCard({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const update = useUpdatePreferences();
  const saved = preferences.cycle_rule ?? null;
  const [enabled, setEnabled] = useState(saved !== null);
  const [rule, setRule] = useState<CycleRule>(() => saved ?? defaultRule());
  const [debounced] = useDebouncedValue(rule, 300);
  const periods = useCyclePeriods(enabled && validRule(debounced) ? debounced : null);

  const draft = enabled ? rule : null;
  const valid = !enabled || validRule(rule);
  const dirty = !sameRule(draft, saved);
  const change = (patch: Partial<CycleRule>) => {
    setRule((r) => ({ ...r, ...patch }));
  };

  const save = () => {
    if (!valid) return;
    update.mutate(
      // The server plans in the time zone; the app normally set it already.
      { cycle_rule: draft, ...(preferences.time_zone ? {} : { time_zone: browserTimeZone() }) },
      {
        onSuccess: () => {
          notifications.show({ color: "green", message: t("settings.cycleRule.saved") });
          // Saving replanned the cycles.
          void client.invalidateQueries({ queryKey: CYCLES_KEY });
        },
      },
    );
  };

  return (
    <Card withBorder>
      <Stack gap="md">
        <Stack gap={6}>
          <Text fw={600}>{t("settings.cycleRule.title")}</Text>
          <Text size="sm" c="dimmed">
            {t("settings.cycleRule.intro")}
          </Text>
        </Stack>
        <Switch
          label={t("settings.cycleRule.enabled")}
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.currentTarget.checked);
          }}
        />
        {enabled && (
          <>
            <Group align="flex-start" gap="sm" grow>
              <NumberInput
                label={t("settings.cycleRule.day")}
                min={1}
                max={31}
                allowDecimal={false}
                allowNegative={false}
                value={Number.isNaN(rule.day) ? "" : rule.day}
                onChange={(v) => {
                  change({ day: whole(v) });
                }}
                error={validDay(rule.day) ? undefined : t("settings.cycleRule.dayRange")}
              />
              <NumberInput
                label={t("settings.cycleRule.ahead")}
                min={1}
                max={MAX_AHEAD}
                allowDecimal={false}
                allowNegative={false}
                value={Number.isNaN(rule.ahead) ? "" : rule.ahead}
                onChange={(v) => {
                  change({ ahead: whole(v) });
                }}
                error={
                  validAhead(rule.ahead)
                    ? undefined
                    : t("settings.cycleRule.aheadRange", { max: MAX_AHEAD })
                }
              />
            </Group>
            <Select
              label={t("settings.cycleRule.shift")}
              data={SHIFTS.map((s) => ({ value: s, label: t(`settings.cycleRule.shifts.${s}`) }))}
              value={rule.shift}
              allowDeselect={false}
              onChange={(v) => {
                const shift = SHIFTS.find((s) => s === v);
                if (shift) change({ shift });
              }}
            />
            <Select
              label={t("settings.cycleRule.holidays")}
              data={HOLIDAYS.map((h) => ({
                value: h,
                label: t(`settings.cycleRule.calendars.${h}`),
              }))}
              value={rule.holidays}
              allowDeselect={false}
              onChange={(v) => {
                const holidays = HOLIDAYS.find((h) => h === v);
                if (holidays) change({ holidays });
              }}
            />
            <Stack gap={4}>
              <Group gap="xs">
                <Text size="sm" fw={500}>
                  {t("settings.cycleRule.preview")}
                </Text>
                {periods.isFetching && <Loader size={14} />}
              </Group>
              {periods.error ? (
                <ErrorAlert error={periods.error} />
              ) : (
                <Stack
                  gap={2}
                  component="ul"
                  m={0}
                  pl="md"
                  aria-label={t("settings.cycleRule.preview")}
                >
                  {periods.data?.map((p) => (
                    <Text key={p.start} size="sm" component="li">
                      {formatDateRange(p.start, p.end)}
                    </Text>
                  ))}
                </Stack>
              )}
            </Stack>
          </>
        )}
        <Text size="sm" c="dimmed">
          {t("settings.cycleRule.note")}
        </Text>
        {update.error && <ErrorAlert error={update.error} />}
        <Group>
          <Button onClick={save} disabled={!dirty || !valid} loading={update.isPending}>
            {t("settings.cycleRule.save")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
