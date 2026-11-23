// Figures on an account card on Accounts, a row each: where an account's
// money is (its buckets, card debt set aside #261, savings #231 and what's
// unallocated), where a card's debt is set aside, a card's debt and credit
// and a BSU's limits (#272).

import { Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import { FigureRows, type FigureRow } from "@/components/accounts/FigureRows";
import { cardNear, negate, positiveHolds } from "@/lib/cards";
import { addAmounts, compareAmounts, formatMoney, percentOf, subtractAmounts } from "@/lib/money";

/**
 * The account's money, part by part: in its buckets (with what they're
 * short), set aside for each card, reserved for savings (each with what isn't
 * covered) and unallocated. Just "No buckets" when there's nothing but
 * unallocated money.
 */
export function AccountBreakdown({
  account,
  accounts,
  buckets,
}: {
  account: Account;
  accounts: Account[];
  buckets: Bucket[];
}): ReactNode {
  const { t } = useTranslation();
  const money = (a: string) => formatMoney(a, account.currency);
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const holds = positiveHolds(account);
  const reserved = compareAmounts(account.reserved, "0") > 0;
  if (own.length === 0 && holds.length === 0 && !reserved) {
    return (
      <Text size="sm" c="dimmed">
        {t("accounts.noBuckets")}
      </Text>
    );
  }

  const rows: FigureRow[] = [];
  if (own.length > 0) {
    const short = addAmounts(
      ...own.map((b) =>
        compareAmounts(b.target_funds, "0") > 0
          ? subtractAmounts(b.target_funds, b.current_available_funds)
          : "0",
      ),
    );
    rows.push({
      label: t("accounts.bucketCount", { count: own.length }),
      value: money(addAmounts(...own.map((b) => b.current_available_funds))),
      warning:
        compareAmounts(short, "0") > 0
          ? t("accounts.breakdown.short", { amount: money(short) })
          : undefined,
    });
  }
  holds.forEach((h, i) => {
    const uncovered = compareAmounts(account.card_debt_uncovered, "0") > 0;
    rows.push({
      label: t("accounts.breakdown.setAsideFor", {
        card: accounts.find((a) => a.id === h.card_id)?.name ?? h.card_id,
      }),
      value: money(h.amount),
      // What the balance doesn't cover, after the last card.
      warning:
        uncovered && i === holds.length - 1
          ? t("accounts.breakdown.notCovered", { amount: money(account.card_debt_uncovered) })
          : undefined,
    });
  });
  if (reserved) {
    rows.push({
      label: t("accounts.breakdown.reserved"),
      value: money(account.reserved),
      warning:
        compareAmounts(account.reserved_uncovered, "0") > 0
          ? t("accounts.breakdown.notCovered", { amount: money(account.reserved_uncovered) })
          : undefined,
    });
  }
  rows.push({ label: t("accounts.breakdown.unallocated"), value: money(account.unallocated) });
  return <FigureRows label={t("accounts.breakdown.label", { name: account.name })} rows={rows} />;
}

/** Where a card's debt is set aside, account by account, and what isn't. */
export function CardBreakdown({ card, accounts }: { card: Account; accounts: Account[] }) {
  const { t } = useTranslation();
  const c = card.credit_card;
  if (!c) return null;
  const held = c.held_on.filter((h) => compareAmounts(h.amount, "0") !== 0);
  if (held.length === 0 && compareAmounts(c.not_set_aside, "0") === 0) return null;
  const money = (a: string) => formatMoney(a, card.currency);
  const rows: FigureRow[] = held.map((h) => ({
    label: t("accounts.breakdown.setAsideOn", {
      name: accounts.find((a) => a.id === h.account_id)?.name ?? h.account_id,
    }),
    value: money(h.amount),
  }));
  if (compareAmounts(c.not_set_aside, "0") !== 0) {
    rows.push({ label: t("accounts.breakdown.notSetAside"), value: money(c.not_set_aside) });
  }
  return <FigureRows label={t("accounts.breakdown.cardLabel", { name: card.name })} rows={rows} />;
}

/**
 * A BSU's deposits against its limits (#214, #272): this year and in total,
 * each with a bar and what's left, or how far over (orange). Nothing for a
 * locked one: it shows its lock instead.
 */
export function BsuFigures({ account }: { account: Account }) {
  const { t } = useTranslation();
  const st = account.bsu;
  if (!st || st.locked) return null;
  const money = (a: string) => formatMoney(a, account.currency);
  const row = (
    label: string,
    deposited: string,
    limit: string,
    barKey: "bsu.figures.barYear" | "bsu.figures.barTotal",
  ): FigureRow => {
    const percent = percentOf(deposited, limit);
    const over = subtractAmounts(deposited, limit);
    const isOver = compareAmounts(over, "0") > 0;
    return {
      label,
      // The limit goes under the bar, so the amounts stay short (#272).
      value: money(deposited),
      end: t("accounts.figures.of", { limit: money(limit) }),
      orange: isOver,
      bar: { percent, orange: isOver, label: t(barKey, { pct: Math.round(percent) }) },
      ...(isOver
        ? { warning: t("bsu.figures.over", { amount: money(over) }) }
        : { note: t("bsu.figures.left", { amount: money(negate(over)) }) }),
    };
  };
  return (
    <FigureRows
      label={t("bsu.figures.label", { name: account.name })}
      rows={[
        row(t("bsu.figures.year"), st.deposited_year, st.yearly_limit, "bsu.figures.barYear"),
        row(t("bsu.figures.total"), st.deposited_total, st.total_limit, "bsu.figures.barTotal"),
      ]}
    />
  );
}

/**
 * A card's debt and credit (#260, #272): what's owed (or in credit) with a
 * bar of the limit used, orange from 90 %, and what's available of the
 * limit, or how far past it.
 */
export function CardFigures({ card }: { card: Account }) {
  const { t } = useTranslation();
  const c = card.credit_card;
  if (!c) return null;
  const money = (a: string) => formatMoney(a, card.currency);
  const near = cardNear(card);
  const inCredit = compareAmounts(card.balance, "0") > 0;
  const used = percentOf(c.owed, c.credit_limit);
  const past = compareAmounts(c.available, "0") < 0;
  const rows: FigureRow[] = [
    {
      label: t(inCredit ? "cards.figures.inCredit" : "cards.figures.owed"),
      value: money(inCredit ? card.balance : c.owed),
      bar: {
        percent: used,
        orange: near,
        label: t("cards.figures.bar", { pct: Math.round(used) }),
      },
      end: t("cards.figures.limit", { amount: money(c.credit_limit) }),
    },
    past
      ? {
          label: t("cards.figures.pastLimit"),
          value: money(negate(c.available)),
          orange: true,
        }
      : { label: t("cards.figures.available"), value: money(c.available) },
  ];
  return <FigureRows label={t("cards.figures.label", { name: card.name })} rows={rows} />;
}
