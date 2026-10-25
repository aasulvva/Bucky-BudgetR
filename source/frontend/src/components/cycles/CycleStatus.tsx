import { Badge, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { useCurrentCycles } from "@/api/cycles";
import { cycleRange, daysLeftLabel, daysLeftShort, isOverdue } from "@/lib/cycles";

import classes from "./CycleStatus.module.css";

/**
 * The active cycle and its days left, in the shell: a block in the side
 * menu, or a chip in the mobile header. Links to the Cycles screen.
 */
export function CycleStatus({ placement }: { placement: "sidebar" | "header" }) {
  const { t } = useTranslation();
  const current = useCurrentCycles();
  if (!current.data) return null;
  const { active } = current.data;
  const overdue = active !== null && isOverdue(active);

  if (placement === "header") {
    return (
      <Badge
        component={Link}
        to="/cycles"
        variant="light"
        color={active === null ? "gray" : overdue ? "orange" : "blue"}
        size="lg"
        radius="xl"
        style={{ cursor: "pointer", flexShrink: 0 }}
        aria-label={
          active
            ? t("cycles.statusLabel", {
                range: cycleRange(active),
                status: daysLeftLabel(active).toLowerCase(),
              })
            : t("cycles.noActive")
        }
      >
        {active ? daysLeftShort(active) : t("cycles.noCycle")}
      </Badge>
    );
  }

  return (
    <UnstyledButton
      component={Link}
      to="/cycles"
      className={classes.block}
      data-overdue={overdue || undefined}
    >
      <Text size="xs" c="dimmed">
        {t("cycles.cycle")}
      </Text>
      {active ? (
        <>
          <Text size="sm" fw={600}>
            {cycleRange(active)}
          </Text>
          <Text size="xs" c={overdue ? "orange.8" : "dimmed"} fw={overdue ? 600 : undefined}>
            {daysLeftLabel(active)}
          </Text>
        </>
      ) : (
        <Text size="sm" fw={600}>
          {t("cycles.noActive")}
        </Text>
      )}
    </UnstyledButton>
  );
}
