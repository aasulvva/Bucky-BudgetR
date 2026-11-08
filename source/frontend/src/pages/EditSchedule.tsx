import { Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

import { useSchedule } from "@/api/schedules";
import { QueryState } from "@/components/QueryState";

import { Form } from "./NewSchedule";

/** Edit a schedule (#154): its form, filled in. Saving replaces it. */
export default function EditSchedule() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const schedule = useSchedule(id);
  return (
    <Stack gap="lg">
      <Title order={2}>{t("schedules.edit")}</Title>
      <QueryState query={schedule}>{(s) => <Form schedule={{ editing: s }} />}</QueryState>
    </Stack>
  );
}
