import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery, useWindowEvent } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useBlocker } from "react-router";

import {
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { unwrap } from "@/api/errors";
import { AmountInput } from "@/components/AmountInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import {
  EMPTY_DRAFT,
  accountBudget,
  budgetChanges,
  capacityAfter,
  draftIncome,
  draftRefill,
  incomeProblem,
  refillProblem,
  shareOf,
  type BudgetChanges,
  type BudgetDraft,
} from "@/lib/budget";
import { getLocale } from "@/lib/locale";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";

/**
 * Budget setup (spec §9): every bucket by source account, the income
 * expected on each account per cycle, and the refill amounts against it.
 * Saving sets the refill amounts all at once (the *Future* adjustment: what's
 * left this cycle stays).
 */
export default function BudgetSetup() {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const buckets = useBuckets();
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>{t("nav.items.budgetSetup")}</Title>
        <Text size="sm" c="dimmed">
          {t("budgetSetup.intro")}
        </Text>
      </Stack>
      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => <Budget accounts={accountList} buckets={bucketList} />}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);
}

function Budget({ accounts, buckets }: { accounts: Account[]; buckets: Bucket[] }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const refresh = useRefreshMoney();
  const [draft, setDraft] = useState<BudgetDraft>(EMPTY_DRAFT);
  const changes = budgetChanges(draft, accounts, buckets);
  const dirty = changes.count > 0;

  const save = useMutation({
    mutationFn: async (c: BudgetChanges) => {
      for (const income of c.incomes) {
        await unwrap(
          api.PATCH("/api/v1/accounts/{accountId}", {
            params: { path: { accountId: income.account_id } },
            body: { expected_income: income.expected_income },
          }),
        );
      }
      if (c.ras.length > 0) {
        await unwrap(api.POST("/api/v1/buckets/refill-amounts", { body: { items: c.ras } }));
      }
    },
    meta: { silentError: true },
    onSuccess: async () => {
      await refresh();
      setDraft(EMPTY_DRAFT);
      notifications.show({ color: "green", message: t("budgetSetup.saved") });
    },
    // Some incomes may have been saved before the error.
    onError: () => refresh(),
  });

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useWindowEvent("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  if (buckets.length === 0) {
    return (
      <Text c="dimmed">
        <Trans
          i18nKey={accounts.length === 0 ? "accounts.empty" : "buckets.noBuckets"}
          components={{
            setup: (
              <Anchor
                component={Link}
                to={accounts.length === 0 ? "/accounts/setup" : "/buckets/setup"}
              />
            ),
          }}
        />
      </Text>
    );
  }

  const edit = (kind: keyof BudgetDraft, id: string, value: string | null) => {
    setDraft((d) => ({ ...d, [kind]: { ...d[kind], [id]: value } }));
  };

  return (
    <>
      {accounts
        .filter((a) => buckets.some((b) => b.source_account_id === a.id))
        .map((a) => (
          <AccountSection
            key={a.id}
            account={a}
            buckets={buckets.filter((b) => b.source_account_id === a.id)}
            draft={draft}
            onEdit={edit}
            isDesktop={isDesktop}
          />
        ))}

      {dirty && (
        <Card
          withBorder
          shadow="md"
          padding="sm"
          component="section"
          aria-label={t("budgetSetup.changes", { count: changes.count })}
          style={{
            position: "sticky",
            bottom: "calc(var(--app-shell-footer-offset, 0rem) + var(--mantine-spacing-sm))",
            zIndex: 10,
          }}
        >
          <Stack gap="xs">
            <Group justify="space-between" gap="sm" wrap="wrap">
              <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                <Text fw={600}>{t("budgetSetup.changes", { count: changes.count })}</Text>
                <Text size="xs" c="dimmed">
                  {t("budgetSetup.futureNote")}
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  variant="default"
                  disabled={save.isPending}
                  onClick={() => {
                    setDraft(EMPTY_DRAFT);
                    save.reset();
                  }}
                >
                  {t("budgetSetup.discard")}
                </Button>
                <Button
                  loading={save.isPending}
                  disabled={changes.invalid}
                  onClick={() => {
                    save.mutate(changes);
                  }}
                >
                  {t("common.save")}
                </Button>
              </Group>
            </Group>
            {save.error && <ErrorAlert error={save.error} />}
          </Stack>
        </Card>
      )}

      <Modal
        opened={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        withCloseButton={false}
        centered
      >
        <Stack gap="md">
          <Text>{t("budgetSetup.leaveQuestion")}</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => blocker.reset?.()}>
              {t("budgetSetup.stay")}
            </Button>
            <Button color="red" onClick={() => blocker.proceed?.()}>
              {t("budgetSetup.leave")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

type Edit = (kind: keyof BudgetDraft, id: string, value: string | null) => void;

function AccountSection({
  account,
  buckets,
  draft,
  onEdit,
  isDesktop,
}: {
  account: Account;
  buckets: Bucket[];
  draft: BudgetDraft;
  onEdit: Edit;
  isDesktop: boolean;
}) {
  const { t } = useTranslation();
  const budget = accountBudget(draft, account, buckets);
  const money = (amount: string) => formatMoney(amount, account.currency);
  const income = draftIncome(draft, account);

  return (
    <Stack gap="sm" component="section" aria-label={account.name}>
      <Group justify="space-between" align="flex-end" gap="md" wrap="wrap" px={4}>
        <Title order={3} size="h4">
          {account.name}{" "}
          <Text span inherit c="dimmed" fw={400}>
            (#{account.id})
          </Text>
        </Title>
        <AmountInput
          label={t("budgetSetup.expectedIncome")}
          value={income}
          currency={account.currency}
          onChange={(v) => {
            onEdit("incomes", account.id, v);
          }}
          error={incomeProblem(income) && t("common.notNegative")}
          w={isDesktop ? 240 : "100%"}
        />
      </Group>

      <Stack gap={6} px={4}>
        <Group gap="lg" wrap="wrap">
          <Figure
            label={t("budgetSetup.allocated")}
            value={
              budget.percent === null
                ? money(budget.allocated)
                : t("budgetSetup.allocatedShare", {
                    amount: money(budget.allocated),
                    percent: formatPercent(budget.percent),
                  })
            }
          />
          {budget.remainder !== null &&
            (budget.over ? (
              <Figure
                label={t("budgetSetup.over")}
                value={money(subtractAmounts("0", budget.remainder))}
                color="var(--mantine-color-red-text)"
              />
            ) : (
              <Figure label={t("budgetSetup.left")} value={money(budget.remainder)} />
            ))}
        </Group>
        {budget.percent === null ? (
          <Text size="xs" c="dimmed">
            {t("budgetSetup.noIncome")}
          </Text>
        ) : (
          <Progress
            value={Math.min(budget.percent, 100)}
            color={budget.over ? "red" : undefined}
            size="sm"
            aria-label={t("budgetSetup.allocated")}
          />
        )}
      </Stack>

      {isDesktop ? (
        <Card withBorder padding={0}>
          <Table.ScrollContainer minWidth={720}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("buckets.bucket")}</Table.Th>
                  <Table.Th w={200}>{t("budgetSetup.refillAmount")}</Table.Th>
                  <Table.Th>{t("budgetSetup.share")}</Table.Th>
                  <Table.Th>{t("bucketSetup.capacity")}</Table.Th>
                  <Table.Th>{t("buckets.leftThisCycle")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {buckets.map((b) => (
                  <BucketRow
                    key={b.id}
                    bucket={b}
                    draft={draft}
                    expected={budget.percent === null ? null : budget.expected}
                    onEdit={onEdit}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ) : (
        <Stack gap="sm">
          {buckets.map((b) => (
            <BucketCard
              key={b.id}
              bucket={b}
              draft={draft}
              expected={budget.percent === null ? null : budget.expected}
              onEdit={onEdit}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Text size="sm" c="dimmed">
      {label}{" "}
      <Text span fw={700} c={color ?? "var(--mantine-color-text)"}>
        {value}
      </Text>
    </Text>
  );
}

interface BucketProps {
  bucket: Bucket;
  draft: BudgetDraft;
  /** The account's expected income, when there is a valid one. */
  expected: string | null;
  onEdit: Edit;
}

/** What a bucket's row shows besides its name and refill amount field. */
function useBucketValues({ bucket, draft, expected }: Omit<BucketProps, "onEdit">) {
  const { t } = useTranslation();
  const money = (amount: string) => formatMoney(amount, bucket.currency);
  const ra = draftRefill(draft, bucket);
  const problem = bucket.id in draft.ras ? refillProblem(ra) : null;
  const usable = ra !== null && problem === null ? ra : bucket.refill_amount;
  const share = shareOf(usable, expected);
  const after = capacityAfter(bucket, usable);
  return {
    ra,
    error:
      problem === "empty"
        ? t("budgetSetup.enterRefill")
        : problem === "negative"
          ? t("common.notNegative")
          : undefined,
    share: share === null ? "–" : t("budgetSetup.shareValue", { percent: formatPercent(share) }),
    capacity: money(after.capacity),
    raised:
      after.raised && compareAmounts(after.capacity, bucket.capacity) !== 0
        ? t("budgetSetup.capacityRaised", { amount: money(bucket.capacity) })
        : null,
    left: money(bucket.target_funds),
  };
}

function BucketName({ bucket }: { bucket: Bucket }) {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
      <Text fw={600}>{bucket.name}</Text>
      {bucket.priority && (
        <Badge size="sm" variant="light" radius="sm">
          {t("buckets.priority")}
        </Badge>
      )}
    </Group>
  );
}

function RefillInput({
  bucket,
  ra,
  error,
  onEdit,
}: {
  bucket: Bucket;
  ra: string | null;
  error: string | undefined;
  onEdit: Edit;
}) {
  const { t } = useTranslation();
  return (
    <AmountInput
      aria-label={t("budgetSetup.refillAmountFor", { name: bucket.name })}
      value={ra}
      currency={bucket.currency}
      error={error}
      onChange={(v) => {
        onEdit("ras", bucket.id, v);
      }}
    />
  );
}

function BucketRow(props: BucketProps) {
  const { bucket, onEdit } = props;
  const v = useBucketValues(props);
  return (
    <Table.Tr>
      <Table.Td>
        <BucketName bucket={bucket} />
      </Table.Td>
      <Table.Td>
        <RefillInput bucket={bucket} ra={v.ra} error={v.error} onEdit={onEdit} />
      </Table.Td>
      <Table.Td>
        <Text size="sm">{v.share}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{v.capacity}</Text>
        {v.raised && (
          <Text size="xs" c="dimmed">
            {v.raised}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {v.left}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

function BucketCard(props: BucketProps) {
  const { t } = useTranslation();
  const { bucket, onEdit } = props;
  const v = useBucketValues(props);
  return (
    <Card withBorder component="article" aria-label={bucket.name}>
      <Stack gap="xs">
        <BucketName bucket={bucket} />
        <RefillInput bucket={bucket} ra={v.ra} error={v.error} onEdit={onEdit} />
        <Group gap="lg" wrap="wrap">
          <Figure label={t("budgetSetup.share")} value={v.share} />
          <Figure label={t("bucketSetup.capacity")} value={v.capacity} />
          <Figure label={t("buckets.leftThisCycle")} value={v.left} />
        </Group>
        {v.raised && (
          <Text size="xs" c="dimmed">
            {v.raised}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
