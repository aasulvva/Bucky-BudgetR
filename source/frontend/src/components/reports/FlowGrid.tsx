import { Badge, Box, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { signedMoney } from "@/components/transactions/lookups";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import { usePrintMode } from "@/lib/print";
import {
  accountFigureLabel,
  type AccountFigure,
  type BucketFigure,
  type FlowRow,
  type FlowTables,
} from "@/lib/reports";

import { ReportLink } from "./ReportLink";

const BUCKET_IN: BucketFigure[] = [
  "refills",
  "income",
  "opening_funds",
  "adjustments_in",
  "transfers_in",
];
const BUCKET_OUT: BucketFigure[] = ["spent", "overflow", "adjustments_out", "transfers_out"];
const ACCOUNT_IN: AccountFigure[] = ["income", "transfers_in"];
const ACCOUNT_OUT: AccountFigure[] = ["expenses", "transfers_out"];

const isZero = (a: string) => compareAmounts(a, "0") === 0;

/** A figure on a card, with its parts under it. */
interface Line {
  key: string;
  label: string;
  amount: string;
  parts: { key: string; label: string; amount: string }[];
}

/** What a card shows, for a bucket, an account or a total. */
interface Card {
  key: string;
  name: ReactNode;
  label: string;
  currency: string;
  changeLabel: string;
  change: string;
  /** The start and end balance, when the card has them. */
  balances: [string, string] | null;
  lines: Line[];
  overspent: boolean;
  total: boolean;
}

/**
 * An In/out/balance module as a grid (#187): a card per bucket and per
 * account, with its change, its start and end, its in and out (and their
 * parts, with details), and a total card per currency last.
 */
export function FlowGrid({
  buckets,
  accounts,
  details,
  balances,
  bucketLink,
  accountLink,
}: {
  buckets: FlowTables["buckets"] | null;
  accounts: FlowTables["accounts"] | null;
  details: boolean;
  balances: boolean;
  bucketLink: (id: string) => string;
  accountLink: (id: string) => string;
}) {
  const { t } = useTranslation();
  const both = buckets !== null && accounts !== null;

  const totalName = (several: boolean, currency: string) =>
    several ? t("stats.reports.flows.totalIn", { currency }) : t("stats.reports.flows.total");

  const line = <F extends string>(
    r: FlowRow<F>,
    key: F,
    parts: F[],
    label: (f: F) => string,
  ): Line => ({
    key,
    label: label(key),
    amount: r.values[key],
    parts: details
      ? parts
          .filter((p) => !isZero(r.values[p]))
          .map((p) => ({ key: p, label: label(p), amount: r.values[p] }))
      : [],
  });

  const bucketLabel = (f: BucketFigure) => t(`stats.reports.flows.columns.${f}`);
  const bucketCard = (r: FlowRow<BucketFigure>, total: string | null): Card => ({
    key: total === null ? r.id : `total-${r.currency}`,
    name: total ?? <ReportLink to={bucketLink(r.id)}>{r.name}</ReportLink>,
    label: total ?? r.name,
    currency: r.currency,
    changeLabel: t("stats.reports.flows.grid.change"),
    change: subtractAmounts(r.values.end, r.values.start),
    balances: [r.values.start, r.values.end],
    lines: [line(r, "in", BUCKET_IN, bucketLabel), line(r, "out", BUCKET_OUT, bucketLabel)],
    overspent: total === null && compareAmounts(r.values.end, "0") < 0,
    total: total !== null,
  });

  const accountCard = (r: FlowRow<AccountFigure>, total: string | null): Card => {
    const lines = [
      line(r, "in", ACCOUNT_IN, accountFigureLabel),
      line(r, "out", ACCOUNT_OUT, accountFigureLabel),
    ];
    if (balances && !isZero(r.values.other)) lines.push(line(r, "other", [], accountFigureLabel));
    return {
      key: total === null ? r.id : `total-${r.currency}`,
      name: total ?? <ReportLink to={accountLink(r.id)}>{r.name}</ReportLink>,
      label: total ?? r.name,
      currency: r.currency,
      changeLabel: balances
        ? t("stats.reports.flows.grid.change")
        : t("stats.reports.flows.columns.net"),
      change: balances ? subtractAmounts(r.values.end, r.values.start) : r.values.net,
      balances: balances ? [r.values.start, r.values.end] : null,
      lines,
      overspent: false,
      total: total !== null,
    };
  };

  const grids: { key: string; label: string; cards: Card[] }[] = [];
  if (buckets && buckets.rows.length > 0) {
    const several = buckets.totals.length > 1;
    grids.push({
      key: "buckets",
      label: t("stats.reports.flows.buckets"),
      cards: [
        ...buckets.rows.map((r) => bucketCard(r, null)),
        ...buckets.totals.map((r) => bucketCard(r, totalName(several, r.currency))),
      ],
    });
  }
  if (accounts && accounts.rows.length > 0) {
    const several = accounts.totals.length > 1;
    grids.push({
      key: "accounts",
      label: t("stats.reports.flows.accounts"),
      cards: [
        ...accounts.rows.map((r) => accountCard(r, null)),
        ...accounts.totals.map((r) => accountCard(r, totalName(several, r.currency))),
      ],
    });
  }

  return (
    <Stack gap="sm">
      {grids.map((g) => (
        <Stack key={g.key} gap={4} data-flow-grid={g.key}>
          {both && (
            <Text size="sm" fw={500}>
              {g.label}
            </Text>
          )}
          <Grid cards={g.cards} />
        </Stack>
      ))}
    </Stack>
  );
}

function Grid({ cards }: { cards: Card[] }) {
  const print = usePrintMode();
  return (
    <SimpleGrid cols={print ? 2 : { base: 1, sm: 2, lg: 3 }} spacing="sm">
      {cards.map((c) => (
        <FlowCard key={c.key} card={c} />
      ))}
    </SimpleGrid>
  );
}

const figures = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as const;

function FlowCard({ card }: { card: Card }) {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, card.currency);
  const up = compareAmounts(card.change, "0") > 0;
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      role="group"
      aria-label={card.label}
      data-flow-card
      data-total={card.total || undefined}
      bg={card.total ? "var(--mantine-color-default-hover)" : undefined}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
          <Text fw={600} size="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {card.name}
          </Text>
          {card.overspent && (
            <Badge color="red" variant="light" size="sm" style={{ flexShrink: 0 }}>
              {t("stats.reports.flows.grid.overspent")}
            </Badge>
          )}
        </Group>
        <Box>
          <Text size="xs" c="dimmed">
            {card.changeLabel}
          </Text>
          <Text
            size="xl"
            fw={600}
            c={up ? "var(--mantine-color-blue-text)" : undefined}
            style={figures}
            data-change
          >
            {signedMoney({ amount: card.change, signed: true }, card.currency)}
          </Text>
          {card.balances && (
            <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }} data-balances>
              {t("stats.reports.flows.grid.startEnd", {
                start: money(card.balances[0]),
                end: money(card.balances[1]),
              })}
            </Text>
          )}
        </Box>
        <Stack gap={2}>
          {card.lines.map((l) => (
            <Box key={l.key}>
              <Figure label={l.label} amount={money(l.amount)} strong />
              {l.parts.map((p) => (
                <Figure key={p.key} label={p.label} amount={money(p.amount)} indent />
              ))}
            </Box>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

function Figure({
  label,
  amount,
  strong,
  indent,
}: {
  label: string;
  amount: string;
  strong?: boolean;
  indent?: boolean;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="xs"
      pl={indent ? "sm" : undefined}
      data-figure={label}
    >
      <Text size={indent ? "xs" : "sm"} c={indent ? "dimmed" : undefined}>
        {label}
      </Text>
      <Text
        size={indent ? "xs" : "sm"}
        fw={strong ? 500 : undefined}
        c={indent ? "dimmed" : undefined}
        style={figures}
      >
        {amount}
      </Text>
    </Group>
  );
}
