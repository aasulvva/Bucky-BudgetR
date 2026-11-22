import {
  Box,
  Button,
  Card,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowsSplit, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import {
  useSavingsDistributor,
  useSavingsRules,
  useSavingsTargets,
  type SavingsDistributor,
  type SavingsTarget,
} from "@/api/savings";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { DistributorForm } from "@/components/savings/DistributorForm";
import { TargetForm, TargetTitle } from "@/components/savings/TargetForm";
import { formatMoney } from "@/lib/money";
import { targetKindText } from "@/lib/savings";

/**
 * What's selected in the URL: a target's ID (`?edit=<id>`), "new" (`?new`),
 * "distributor" (`?distributor`, #232), or null.
 */
type Selection = string | null;

/**
 * Savings setup (spec §9): the savings distributor and the targets, and the
 * selected one's form beside them (full screen on mobile). `?edit=<id>` opens
 * a target, as its cog on the Savings screen does; `?distributor` the
 * distributor.
 */
export default function SavingsSetup() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const targets = useSavingsTargets();
  const distributor = useSavingsDistributor();
  const rules = useSavingsRules();
  const [params, setParams] = useSearchParams();
  const selection: Selection = params.has("new")
    ? "new"
    : params.has("distributor")
      ? "distributor"
      : params.get("edit");

  const select = (next: Selection) => {
    setParams(
      () => {
        const p = new URLSearchParams();
        if (next === "new") p.set("new", "");
        else if (next === "distributor") p.set("distributor", "");
        else if (next !== null) p.set("edit", next);
        return p;
      },
      { replace: next === null },
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.savingsSetup")}</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => {
            select("new");
          }}
        >
          {t("savingsSetup.newTarget")}
        </Button>
      </Group>
      <Text size="sm" c="dimmed" maw={720}>
        {t("savingsSetup.intro")}
      </Text>
      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => (
              <QueryState query={targets}>
                {(targetList) => (
                  <QueryState query={distributor}>
                    {(dist) => (
                      <QueryState query={rules}>
                        {(ruleList) => {
                          const onDistributor = selection === "distributor";
                          const editing =
                            selection && selection !== "new" && !onDistributor
                              ? targetList.find((x) => x.id === selection)
                              : undefined;
                          const open =
                            selection === "new" || onDistributor || editing !== undefined;
                          const form = onDistributor ? (
                            <DistributorForm
                              distributor={dist}
                              targets={targetList}
                              rules={ruleList}
                              accounts={accountList}
                              buckets={bucketList}
                            />
                          ) : (
                            open && (
                              <TargetForm
                                key={editing?.id ?? "new"}
                                target={editing}
                                targets={targetList}
                                accounts={accountList}
                                buckets={bucketList}
                                ruleCount={
                                  ruleList.filter((r) => r.target_id === editing?.id).length
                                }
                                onDone={(saved) => {
                                  select(isDesktop ? saved : null);
                                }}
                              />
                            )
                          );
                          const title = onDistributor ? (
                            t("savingsSetup.distributor.title")
                          ) : (
                            <TargetTitle target={editing} />
                          );
                          const list = (
                            <TargetList
                              targets={targetList}
                              distributor={dist}
                              accounts={accountList}
                              buckets={bucketList}
                              selected={onDistributor ? "distributor" : (editing?.id ?? null)}
                              onSelect={select}
                            />
                          );
                          if (!isDesktop) {
                            return (
                              <>
                                {list}
                                <ResponsiveModal
                                  opened={open}
                                  title={title}
                                  onClose={() => {
                                    select(null);
                                  }}
                                >
                                  {form}
                                </ResponsiveModal>
                              </>
                            );
                          }
                          return (
                            <Group align="flex-start" gap="lg" wrap="nowrap">
                              <Box w={320} style={{ flexShrink: 0 }}>
                                {list}
                              </Box>
                              <Card withBorder style={{ flex: 1, minWidth: 0 }}>
                                {form ? (
                                  <Stack gap="md">
                                    <Title order={3} size="h4">
                                      {title}
                                    </Title>
                                    {form}
                                  </Stack>
                                ) : (
                                  <Text c="dimmed">{t("savingsSetup.pick")}</Text>
                                )}
                              </Card>
                            </Group>
                          );
                        }}
                      </QueryState>
                    )}
                  </QueryState>
                )}
              </QueryState>
            )}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

function TargetList({
  targets,
  distributor,
  accounts,
  buckets,
  selected,
  onSelect,
}: {
  targets: SavingsTarget[];
  distributor: SavingsDistributor;
  accounts: Account[];
  buckets: Bucket[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const onDistributor = selected === "distributor";
  return (
    <Card withBorder padding="xs">
      <NavLink
        component="button"
        type="button"
        label={t("savingsSetup.distributor.title")}
        description={t(`savingsSetup.distributor.modes.${distributor.hold_mode}`)}
        leftSection={<IconArrowsSplit size={18} />}
        active={onDistributor}
        aria-current={onDistributor ? "true" : undefined}
        onClick={() => {
          onSelect("distributor");
        }}
      />
      {targets.length === 0 ? (
        <Text c="dimmed" p="sm">
          {t("savingsSetup.empty")}
        </Text>
      ) : (
        <nav aria-label={t("savingsSetup.targets")}>
          {targets.map((x) => (
            <NavLink
              key={x.id}
              component="button"
              type="button"
              label={x.name}
              description={targetKindText(x, accounts, buckets)}
              active={x.id === selected}
              aria-current={x.id === selected ? "true" : undefined}
              rightSection={
                <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {formatMoney(x.goal, x.currency)}
                </Text>
              }
              onClick={() => {
                onSelect(x.id);
              }}
            />
          ))}
        </nav>
      )}
    </Card>
  );
}
