import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  CloseButton,
  Drawer,
  Group,
  Menu,
  Stack,
  Text,
  Title,
  UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconDots, IconSettings } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  accountTypeLabel,
  useAccounts,
  useBuckets,
  useRefreshMoney,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import { BsuSetupDialog } from "@/components/accounts/BsuSetup";
import { BsuLine, BsuLocked } from "@/components/accounts/BsuStatus";
import { CardDebtForm, CardDebtLine } from "@/components/accounts/CardDebt";
import { CardLine } from "@/components/accounts/CardStatus";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { QueryState } from "@/components/QueryState";
import i18n from "@/i18n";
import { bsuShort, isLockedBsu } from "@/lib/bsu";
import {
  canCardDebt,
  cardHeldLine,
  cardNear,
  cardShort,
  isCard,
  negate,
  type CardDebtMode,
} from "@/lib/cards";

const CARD_DEBT_MODES: CardDebtMode[] = ["setAside", "release"];
import { autofocusField } from "@/lib/device";
import { INTEREST_TAG, interestCounterparty } from "@/lib/interest";
import {
  addAmounts,
  canonicalAmount,
  compareAmounts,
  formatMoney,
  subtractAmounts,
} from "@/lib/money";

type PanelKind = "adjust" | "interest" | CardDebtMode;
type Panel = { kind: PanelKind; accountId: string } | null;

/**
 * Accounts (spec §9, canvas "Accounts"): the balance of each account, its
 * buckets at a glance, and the balance adjustment and interest actions.
 * `?adjust=<accountId>` opens that account's balance adjustment, and
 * `?bsu=<accountId>` a locked BSU's history setup (#214).
 */
export default function Accounts() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const [chosen, setChosen] = useState<Panel>(null);
  // A notification opens an account's Adjust balance with ?adjust=<id> (#57).
  const [params, setParams] = useSearchParams();
  const adjustId = params.get("adjust");
  const panel: Panel = chosen ?? (adjustId ? { kind: "adjust", accountId: adjustId } : null);
  const bsuId = params.get("bsu");
  const openBsu = (id: string | null) => {
    setParams(
      (p) => {
        if (id === null) p.delete("bsu");
        else p.set("bsu", id);
        return p;
      },
      { replace: id === null },
    );
  };

  return (
    <QueryState query={accounts}>
      {(list) => {
        const selected = panel ? list.find((a) => a.id === panel.accountId) : undefined;
        const close = () => {
          setChosen(null);
          if (adjustId !== null) {
            setParams(
              (p) => {
                p.delete("adjust");
                return p;
              },
              { replace: true },
            );
          }
        };
        const panelContent =
          panel && selected ? (
            <PanelContent kind={panel.kind} account={selected} accounts={list} onClose={close} />
          ) : null;
        const actions = (a: Account) => ({
          onAdjust: () => {
            setChosen({ kind: "adjust", accountId: a.id });
          },
          onInterest: () => {
            setChosen({ kind: "interest", accountId: a.id });
          },
          onSetUpBsu: () => {
            setChosen(null);
            openBsu(a.id);
          },
          onCardDebt: (mode: CardDebtMode) => {
            setChosen({ kind: mode, accountId: a.id });
          },
        });
        const settingUp = bsuId ? list.find((a) => a.id === bsuId && isLockedBsu(a)) : undefined;

        return (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-end" wrap="wrap">
              <Title order={2}>{t("nav.items.accounts")}</Title>
              <Totals accounts={list} />
            </Group>
            {list.length === 0 ? (
              <Text c="dimmed">
                <Trans
                  i18nKey="accounts.empty"
                  components={{ setup: <Anchor component={Link} to="/accounts/setup" /> }}
                />
              </Text>
            ) : isDesktop ? (
              <Group align="flex-start" wrap="wrap" gap="lg">
                <Box
                  style={{
                    flex: "999 1 420px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: "var(--mantine-spacing-md)",
                  }}
                >
                  {list.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      // A card has no buckets (#260): its own line says it all.
                      summary={
                        !isCard(a) && buckets.data ? accountLine(a, buckets.data, list) : undefined
                      }
                      selected={a.id === selected?.id}
                      {...actions(a)}
                    />
                  ))}
                </Box>
                {panelContent && (
                  <Card
                    withBorder
                    shadow="sm"
                    padding="lg"
                    style={{ flex: "1 1 320px", maxWidth: 380 }}
                  >
                    {panelContent}
                  </Card>
                )}
              </Group>
            ) : (
              <>
                <Card withBorder padding={0}>
                  {list.map((a) => (
                    <AccountRow key={a.id} account={a} {...actions(a)} />
                  ))}
                </Card>
                <Drawer
                  opened={panelContent !== null}
                  onClose={close}
                  position="bottom"
                  withCloseButton={false}
                  size="auto"
                >
                  {panelContent}
                </Drawer>
              </>
            )}
            <BsuSetupDialog
              account={settingUp}
              onClose={() => {
                openBsu(null);
              }}
            />
          </Stack>
        );
      }}
    </QueryState>
  );
}

/** The total balance per currency. */
function Totals({ accounts }: { accounts: Account[] }) {
  const { t } = useTranslation();
  const currencies = [...new Set(accounts.map((a) => a.currency))];
  if (currencies.length === 0) return null;
  return (
    <Group gap="md">
      {currencies.map((currency) => (
        <Text key={currency} size="sm" c="dimmed">
          {t("accounts.total")}{" "}
          <Text span fw={700} size="lg" c="var(--mantine-color-text)">
            {formatMoney(
              addAmounts(...accounts.filter((a) => a.currency === currency).map((a) => a.balance)),
              currency,
            )}
          </Text>
        </Text>
      ))}
    </Group>
  );
}

/**
 * The account's line: its buckets, what's set aside for card debt (#261),
 * then what's reserved for savings (#231).
 */
function accountLine(account: Account, buckets: Bucket[], accounts: Account[]): string {
  const parts = [bucketSummary(account, buckets)];
  const held = cardHeldLine(account, accounts);
  if (held) parts.push(held);
  if (compareAmounts(account.reserved, "0") > 0) {
    const reserved = formatMoney(account.reserved, account.currency);
    parts.push(
      compareAmounts(account.reserved_uncovered, "0") > 0
        ? i18n.t("accounts.reservedUncovered", {
            amount: reserved,
            uncovered: formatMoney(account.reserved_uncovered, account.currency),
          })
        : i18n.t("accounts.reserved", { amount: reserved }),
    );
  }
  return parts.join(" · ");
}

/**
 * The account's buckets in a line: how many, and what's short (TF the
 * account can't cover) or else unallocated.
 */
function bucketSummary(account: Account, buckets: Bucket[]): string {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  if (own.length === 0) return i18n.t("accounts.noBuckets");
  const count = i18n.t("accounts.bucketCount", { count: own.length });
  const short = addAmounts(
    ...own.map((b) =>
      compareAmounts(b.target_funds, "0") > 0
        ? subtractAmounts(b.target_funds, b.current_available_funds)
        : "0",
    ),
  );
  if (compareAmounts(short, "0") > 0) {
    return i18n.t("accounts.bucketsShort", {
      buckets: count,
      amount: formatMoney(short, account.currency),
    });
  }
  if (compareAmounts(account.unallocated, "0") > 0) {
    return i18n.t("accounts.bucketsUnallocated", {
      buckets: count,
      amount: formatMoney(account.unallocated, account.currency),
    });
  }
  return count;
}

interface ActionsProps {
  onAdjust: () => void;
  onInterest: () => void;
  onSetUpBsu: () => void;
  onCardDebt: (mode: CardDebtMode) => void;
}

function SetupLink({ account, size }: { account: Account; size: number }) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      component={Link}
      to={`/accounts/setup?edit=${account.id}`}
      variant="subtle"
      color="gray"
      size={size}
      aria-label={t("accounts.setupFor", { name: account.name })}
      title={t("nav.items.accountSetup")}
    >
      <IconSettings size={18} />
    </ActionIcon>
  );
}

function AccountCard({
  account,
  summary,
  selected,
  onAdjust,
  onInterest,
  onSetUpBsu,
  onCardDebt,
}: ActionsProps & { account: Account; summary?: string; selected: boolean }) {
  const { t } = useTranslation();
  const locked = isLockedBsu(account);
  return (
    <Card
      withBorder
      component="article"
      aria-label={account.name}
      style={
        selected
          ? { borderColor: "var(--mantine-primary-color-filled)", borderWidth: 2 }
          : undefined
      }
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <Title order={3} size="h5" style={{ flexGrow: 1 }}>
            {account.name}
          </Title>
          <Badge variant="light" color="gray" radius="sm">
            {accountTypeLabel(account.type)}
          </Badge>
          <SetupLink account={account} size={32} />
        </Group>
        {account.bank && (
          <Text size="sm" c="dimmed" mt={-8}>
            {account.bank}
          </Text>
        )}
        <Text fz={24} fw={600}>
          {formatMoney(account.balance, account.currency)}
        </Text>
        {summary && (
          <Text size="sm" c="dimmed">
            {summary}
          </Text>
        )}
        <BsuLine account={account} />
        <BsuLocked account={account} onSetUp={onSetUpBsu} />
        <CardLine account={account} />
        <CardDebtLine account={account} />
        <Group
          gap="xs"
          pt="xs"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          <Button
            component={Link}
            to={`/transactions?account_id=${account.id}`}
            size="xs"
            variant="light"
          >
            {t("nav.items.transactions")}
          </Button>
          <Button size="xs" variant="default" onClick={onAdjust} disabled={locked}>
            {t("accounts.adjust")}
          </Button>
          {/* Card interest and fees come with #263. */}
          {isCard(account) ? (
            CARD_DEBT_MODES.map((mode) => (
              <Button
                key={mode}
                size="xs"
                variant="default"
                onClick={() => {
                  onCardDebt(mode);
                }}
                disabled={!canCardDebt(account, mode)}
              >
                {t(`cards.debt.${mode}`)}
              </Button>
            ))
          ) : (
            <Button size="xs" variant="default" onClick={onInterest} disabled={locked}>
              {t("accounts.interest")}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function AccountRow({
  account,
  onAdjust,
  onInterest,
  onSetUpBsu,
  onCardDebt,
}: ActionsProps & { account: Account }) {
  const { t } = useTranslation();
  const locked = isLockedBsu(account);
  const short = bsuShort(account) ?? cardShort(account);
  const orange = locked || account.bsu?.over === true || cardNear(account);
  return (
    <Group
      gap={0}
      wrap="nowrap"
      pr={4}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <UnstyledButton
        component={Link}
        to={`/transactions?account_id=${account.id}`}
        style={{ flexGrow: 1, minWidth: 0 }}
        py="xs"
        pl="md"
        pr={4}
        mih={64}
        aria-label={t("accounts.transactionsOf", { name: account.name })}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <div style={{ minWidth: 0 }}>
            <Text fw={600} truncate>
              {account.name}
            </Text>
            <Text size="sm" c="dimmed" truncate>
              {[accountTypeLabel(account.type), account.bank].filter(Boolean).join(" · ")}
            </Text>
            {short && (
              <Text size="xs" c={orange ? "var(--mantine-color-orange-text)" : "dimmed"} truncate>
                {short}
              </Text>
            )}
          </div>
          <Text fw={600} style={{ whiteSpace: "nowrap" }}>
            {formatMoney(account.balance, account.currency)}
          </Text>
        </Group>
      </UnstyledButton>
      <SetupLink account={account} size={44} />
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={44}
            aria-label={t("accounts.moreFor", { name: account.name })}
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {locked && account.currency === "NOK" && (
            <Menu.Item onClick={onSetUpBsu}>{t("bsu.locked.setUp")}</Menu.Item>
          )}
          <Menu.Item onClick={onAdjust} disabled={locked}>
            {t("accounts.adjust")}
          </Menu.Item>
          {isCard(account) ? (
            CARD_DEBT_MODES.map((mode) => (
              <Menu.Item
                key={mode}
                onClick={() => {
                  onCardDebt(mode);
                }}
                disabled={!canCardDebt(account, mode)}
              >
                {t(`cards.debt.${mode}`)}
              </Menu.Item>
            ))
          ) : (
            <Menu.Item onClick={onInterest} disabled={locked}>
              {t("accounts.interest")}
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

function PanelContent({
  kind,
  account,
  accounts,
  onClose,
}: {
  kind: PanelKind;
  account: Account;
  accounts: Account[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title =
    kind === "adjust"
      ? t("accounts.adjust")
      : kind === "interest"
        ? t("accounts.interest")
        : t(`cards.debt.${kind}`);
  return (
    <Stack gap="md" component="section" aria-label={title}>
      <Group justify="space-between">
        <Title order={3} size="h4">
          {title}
        </Title>
        <CloseButton aria-label={t("common.close")} onClick={onClose} />
      </Group>
      <Text size="sm" c="dimmed">
        {account.name} · {accountTypeLabel(account.type)}
      </Text>
      {/* Keyed so that switching accounts starts the form afresh. */}
      {kind === "adjust" ? (
        <AdjustForm key={account.id} account={account} onDone={onClose} />
      ) : kind === "interest" ? (
        <InterestForm key={account.id} account={account} onDone={onClose} />
      ) : (
        <CardDebtForm
          key={account.id + kind}
          card={account}
          accounts={accounts}
          mode={kind}
          onDone={onClose}
        />
      )}
    </Stack>
  );
}

function FormButtons({
  onCancel,
  submit,
  loading,
}: {
  onCancel: () => void;
  submit: ReactNode;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Group justify="flex-end" gap="xs">
      <Button variant="default" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" loading={loading}>
        {submit}
      </Button>
    </Group>
  );
}

/** Records a balance adjustment (BLA) to the balance the bank shows. */
function AdjustForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const balance = canonicalAmount(account.balance);
  // A card is adjusted by what's owed (#260): the balance negated.
  const card = isCard(account);
  const shown = card ? negate(balance) : balance;
  const [entered, setActual] = useState<string | null>(shown);
  const actual = entered !== null && card ? negate(entered) : entered;
  const [at, setAt] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const adjust = useMutation({
    mutationFn: (target: string) =>
      unwrap(
        api.POST("/api/v1/accounts/{accountId}/balance-adjustment", {
          params: { path: { accountId: account.id } },
          body: { target_balance: target, ...(at ? { at } : {}) },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("accounts.adjusted", { name: account.name }),
      });
      onDone();
      await refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "no_change") {
        setError(t("accounts.alreadyBalance"));
      }
    },
  });

  const diff = actual === null ? null : subtractAmounts(actual, balance);
  const sign = diff !== null && compareAmounts(diff, "0") > 0 ? "+" : "";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (actual === null) setError(t(card ? "cards.enterOwed" : "accounts.enterBalance"));
        else adjust.mutate(actual);
      }}
    >
      <Stack gap="md">
        <Group justify="space-between">
          <Text size="sm">{t(card ? "cards.appOwed" : "accounts.appBalance")}</Text>
          <Text size="sm" fw={700}>
            {formatMoney(shown, account.currency)}
          </Text>
        </Group>
        <AmountInput
          label={t(card ? "cards.owedNow" : "accounts.actualBalance")}
          description={card ? t("cards.owedHint") : undefined}
          currency={account.currency}
          value={entered}
          onChange={setActual}
          error={error}
          {...autofocusField()}
        />
        <DateTimeInput
          label={t("common.dateTime")}
          description={t("accounts.adjustWhen")}
          value={at}
          onChange={setAt}
        />
        {diff !== null && (
          <Alert color="gray" variant="light">
            {at
              ? t("accounts.adjustAtTime")
              : compareAmounts(diff, "0") === 0
                ? t("accounts.adjustMatches")
                : t("accounts.adjustRecords", {
                    amount: sign + formatMoney(diff, account.currency),
                  })}
          </Alert>
        )}
        {adjust.error &&
          !(adjust.error instanceof ApiError && adjust.error.code === "no_change") && (
            <ErrorAlert error={adjust.error} />
          )}
        <FormButtons
          onCancel={onDone}
          submit={t("accounts.adjustSubmit")}
          loading={adjust.isPending}
        />
      </Stack>
    </form>
  );
}

/**
 * Registers interest as an income (INC) from the account's bank, or with the
 * counterparty "Interest" (in the user's language) without one (#70), and the
 * tag "interest". It never triggers a refill.
 */
function InterestForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshMoney();
  const [amount, setAmount] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const register = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.POST("/api/v1/transactions", {
          body: {
            type: "INC",
            account_id: account.id,
            amount: value,
            counterparty: interestCounterparty(account),
            tags: [INTEREST_TAG],
            triggers_refill: false,
            ...(at ? { at } : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      notifications.show({
        color: "green",
        message: t("accounts.interestRegistered", { name: account.name }),
      });
      onDone();
      await refresh();
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        if (amount === null) setError(t("accounts.enterInterest"));
        else if (compareAmounts(amount, "0") <= 0) setError(t("accounts.interestPositive"));
        else register.mutate(amount);
      }}
    >
      <Stack gap="md">
        <AmountInput
          label={t("accounts.interestAmount")}
          currency={account.currency}
          value={amount}
          onChange={setAmount}
          error={error}
          {...autofocusField()}
        />
        <DateTimeInput
          label={t("common.dateTime")}
          description={t("accounts.interestWhen")}
          value={at}
          onChange={setAt}
        />
        <Alert color="gray" variant="light">
          <Trans
            i18nKey="accounts.interestNote"
            values={{ counterparty: interestCounterparty(account), tag: INTEREST_TAG }}
            components={{ b: <strong /> }}
          />
        </Alert>
        {register.error && <ErrorAlert error={register.error} />}
        <FormButtons
          onCancel={onDone}
          submit={t("accounts.interest")}
          loading={register.isPending}
        />
      </Stack>
    </form>
  );
}
