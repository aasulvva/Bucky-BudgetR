// Admin › BSU rules (#214, spec §2.1): the deposit limits per year, which the
// law changes. A year uses the rule from the latest year at or before it.

import { ActionIcon, Button, Card, Group, NumberInput, Stack, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useBsuRules, useDeleteBsuRule, useSetBsuRule, type BsuRule } from "@/api/bsu";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { formatDateTime } from "@/lib/dates";
import { compareAmounts, formatMoney } from "@/lib/money";

type Dialog = { kind: "edit"; rule: BsuRule | null } | { kind: "delete"; rule: BsuRule } | null;

export function AdminBsuRules() {
  const { t } = useTranslation();
  const rules = useBsuRules();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => {
    setDialog(null);
  };
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t("bsu.admin.intro")}
        </Text>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            setDialog({ kind: "edit", rule: null });
          }}
        >
          {t("bsu.admin.add")}
        </Button>
      </Group>
      <QueryState query={rules}>
        {(list) => (
          <>
            <Card withBorder padding={0}>
              <Table.ScrollContainer minWidth={420}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("bsu.admin.fromYear")}</Table.Th>
                      <Table.Th ta="right">{t("bsu.admin.yearly")}</Table.Th>
                      <Table.Th ta="right">{t("bsu.admin.total")}</Table.Th>
                      <Table.Th>{t("bsu.admin.modified")}</Table.Th>
                      <Table.Th w={96} />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {list.map((r) => (
                      <Table.Tr key={r.from_year}>
                        <Table.Td fw={600}>{r.from_year}</Table.Td>
                        <Table.Td ta="right">{formatMoney(r.yearly_limit, "NOK")}</Table.Td>
                        <Table.Td ta="right">{formatMoney(r.total_limit, "NOK")}</Table.Td>
                        <Table.Td c="dimmed">{formatDateTime(r.modified_at)}</Table.Td>
                        <Table.Td>
                          <Group gap={4} wrap="nowrap" justify="flex-end">
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={t("bsu.admin.editName", { year: r.from_year })}
                              onClick={() => {
                                setDialog({ kind: "edit", rule: r });
                              }}
                            >
                              <IconPencil size={18} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={t("bsu.admin.deleteName", { year: r.from_year })}
                              title={list.length === 1 ? t("bsu.admin.lastRule") : undefined}
                              disabled={list.length === 1}
                              onClick={() => {
                                setDialog({ kind: "delete", rule: r });
                              }}
                            >
                              <IconTrash size={18} />
                            </ActionIcon>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
            <ResponsiveModal
              opened={dialog?.kind === "edit"}
              title={
                dialog?.kind === "edit" && dialog.rule ? t("bsu.admin.edit") : t("bsu.admin.new")
              }
              onClose={close}
            >
              {dialog?.kind === "edit" && (
                <RuleForm rule={dialog.rule} rules={list} onDone={close} />
              )}
            </ResponsiveModal>
            <ResponsiveModal
              opened={dialog?.kind === "delete"}
              title={
                dialog?.kind === "delete"
                  ? t("bsu.admin.deleteName", { year: dialog.rule.from_year })
                  : ""
              }
              onClose={close}
            >
              {dialog?.kind === "delete" && <DeleteRule rule={dialog.rule} onDone={close} />}
            </ResponsiveModal>
          </>
        )}
      </QueryState>
    </Stack>
  );
}

function RuleForm({
  rule,
  rules,
  onDone,
}: {
  rule: BsuRule | null;
  rules: BsuRule[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const last = rules.at(-1);
  const [year, setYear] = useState<number | string>(
    rule?.from_year ?? (last ? last.from_year + 1 : new Date().getFullYear()),
  );
  const [yearly, setYearly] = useState<string | null>(
    rule?.yearly_limit ?? last?.yearly_limit ?? null,
  );
  const [total, setTotal] = useState<string | null>(rule?.total_limit ?? last?.total_limit ?? null);
  const [tried, setTried] = useState(false);
  const save = useSetBsuRule();

  const y = typeof year === "number" ? year : Number(year);
  const yearOK = Number.isInteger(y) && y >= 2000 && y <= 2100;
  const totalBelow = yearly !== null && total !== null && compareAmounts(total, yearly) < 0;
  const taken = rule === null && rules.some((r) => r.from_year === y);
  const valid =
    yearOK && yearly !== null && compareAmounts(yearly, "0") > 0 && total !== null && !totalBelow;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!valid) return;
        save.mutate(
          { year: y, yearly_limit: yearly, total_limit: total },
          {
            onSuccess: () => {
              notifications.show({ color: "green", message: t("bsu.admin.saved", { year: y }) });
              onDone();
            },
          },
        );
      }}
    >
      <Stack gap="md">
        <NumberInput
          label={t("bsu.admin.fromYear")}
          value={year}
          onChange={setYear}
          min={2000}
          max={2100}
          allowDecimal={false}
          disabled={rule !== null}
          error={tried && !yearOK ? t("bsu.admin.yearRange") : undefined}
          description={taken ? t("bsu.admin.yearTaken", { year: y }) : undefined}
        />
        <AmountInput
          label={t("bsu.admin.yearly")}
          currency="NOK"
          value={yearly}
          onChange={setYearly}
          error={
            tried && (yearly === null || compareAmounts(yearly, "0") <= 0)
              ? t("bsu.setup.enterAmount")
              : undefined
          }
        />
        <AmountInput
          label={t("bsu.admin.total")}
          currency="NOK"
          value={total}
          onChange={setTotal}
          error={
            totalBelow
              ? t("bsu.admin.totalBelow")
              : tried && total === null
                ? t("bsu.setup.enterAmount")
                : undefined
          }
        />
        {save.error && <ErrorAlert error={save.error} />}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onDone}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function DeleteRule({ rule, onDone }: { rule: BsuRule; onDone: () => void }) {
  const { t } = useTranslation();
  const remove = useDeleteBsuRule();
  return (
    <Stack gap="md">
      <Text>{t("bsu.admin.deleteConfirm", { year: rule.from_year })}</Text>
      {remove.error && <ErrorAlert error={remove.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          color="red"
          loading={remove.isPending}
          onClick={() => {
            remove.mutate(rule.from_year, {
              onSuccess: () => {
                notifications.show({
                  color: "green",
                  message: t("bsu.admin.deleted", { year: rule.from_year }),
                });
                onDone();
              },
            });
          }}
        >
          {t("common.delete")}
        </Button>
      </Group>
    </Stack>
  );
}
