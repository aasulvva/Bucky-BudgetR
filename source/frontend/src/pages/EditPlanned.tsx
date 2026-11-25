import { Anchor, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { usePlannedPurchase } from "@/api/planned";
import { QueryState } from "@/components/QueryState";
import { PLANNED_PATH } from "@/lib/planned";

import { Form } from "./NewPlanned";

/** Edit a planned purchase (#265): its form, filled in, while it's open. */
export default function EditPlanned() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const plan = usePlannedPurchase(id);
  return (
    <Stack gap="lg">
      <Title order={2}>{t("planned.edit")}</Title>
      <QueryState query={plan}>
        {(p) =>
          p.status === "open" ? (
            <Form editing={p} />
          ) : (
            <Text c="dimmed">
              {t("planned.closedNote")}{" "}
              <Anchor component={Link} to={PLANNED_PATH}>
                {t("planned.back")}
              </Anchor>
            </Text>
          )
        }
      </QueryState>
    </Stack>
  );
}
