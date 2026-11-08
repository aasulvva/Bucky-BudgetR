import { Alert, Anchor, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useCurrentCycles } from "@/api/cycles";
import { useOccurrence, useSchedule } from "@/api/schedules";
import { QueryState } from "@/components/QueryState";
import { formatDateTime } from "@/lib/dates";
import { reasonText, type Occurrence } from "@/lib/schedules";

import { Form } from "./NewSchedule";

/**
 * Edit and approve (#155): a queued scheduled transaction in the transaction
 * form, prefilled from its schedule. Approving records it as edited.
 */
export default function ApproveScheduled() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const occurrence = useOccurrence(id);
  return (
    <Stack gap="lg">
      <Title order={2}>{t("schedules.queue.pageTitle")}</Title>
      <QueryState query={occurrence}>
        {(o) =>
          o.state === "queued" ? (
            <Approve occurrence={o} />
          ) : (
            <Alert color="blue">
              <Text size="sm">{t("schedules.queue.notQueued")}</Text>
              <Anchor component={Link} to="/transactions/scheduled" size="sm">
                {t("schedules.title")}
              </Anchor>
            </Alert>
          )
        }
      </QueryState>
    </Stack>
  );
}

function Approve({ occurrence: o }: { occurrence: Occurrence }) {
  const { t } = useTranslation();
  const schedule = useSchedule(o.schedule_id);
  // The date starts from the active cycle, so it's known first.
  const cycles = useCurrentCycles();
  return (
    <QueryState query={schedule}>
      {(s) => (
        <QueryState query={cycles}>
          {() => (
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                {t("schedules.queue.scheduledFor", { date: formatDateTime(o.scheduled_at) })}{" "}
                {reasonText(o, t)}.
              </Text>
              <Form approve={{ occurrence: o, schedule: s }} />
            </Stack>
          )}
        </QueryState>
      )}
    </QueryState>
  );
}
