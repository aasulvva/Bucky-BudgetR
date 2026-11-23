// Credit card accounts (#260, spec §2.2).

import type { Account, AccountType, CreditCard, CreditCardFields } from "@/api/accounts";
import { ApiError } from "@/api/errors";
import i18n from "@/i18n";

import { canonicalAmount, compareAmounts, formatMoney, percentOf, subtractAmounts } from "./money";

/** The statement or due day that means the last day of the month. */
export const LAST_DAY = 31;

/** The share of the limit, in percent, from which a card shows orange. */
export const NEAR_SHARE = 90;

/** The types a card's default account can have. */
export const DEFAULT_ACCOUNT_TYPES: AccountType[] = ["usage", "savings"];

export function isCard(account: Account | undefined): boolean {
  return account?.type === "credit_card";
}

/** Leaves out credit cards: they have no money to fund buckets or savings. */
export function withoutCards(accounts: Account[]): Account[] {
  return accounts.filter((a) => !isCard(a));
}

/** A statement or due day, as said: "1", …, "28", or "Last day". */
export function dayLabel(day: number): string {
  return day === LAST_DAY ? i18n.t("cards.lastDay") : String(day);
}

/** The statement and due days, for a select. */
export function dayOptions(): { value: string; label: string }[] {
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  return [...days, LAST_DAY].map((d) => ({ value: String(d), label: dayLabel(d) }));
}

/** −amount: what's owed from a balance, and the balance from what's owed. */
export function negate(amount: string): string {
  return subtractAmounts("0", amount);
}

/** Whether the card is at NEAR_SHARE percent of its limit or past it. */
export function cardNear(account: Account): boolean {
  const c = account.credit_card;
  if (!c) return false;
  return percentOf(c.owed, c.credit_limit) >= NEAR_SHARE || compareAmounts(c.available, "0") < 0;
}

/**
 * The card's line: what's owed, or in credit, and the credit available of
 * the limit, or how far past the limit it is.
 */
export function cardLine(account: Account): string | null {
  const c = account.credit_card;
  if (!c) return null;
  const money = (a: string) => formatMoney(a, account.currency);
  const owes = compareAmounts(account.balance, "0") < 0;
  const first = owes
    ? i18n.t("cards.owed", { amount: money(c.owed) })
    : compareAmounts(account.balance, "0") > 0
      ? i18n.t("cards.inCredit", { amount: money(account.balance) })
      : i18n.t("cards.nothingOwed");
  const second =
    compareAmounts(c.available, "0") < 0
      ? i18n.t("cards.pastLimit", {
          amount: money(negate(c.available)),
          limit: money(c.credit_limit),
        })
      : i18n.t("cards.available", { amount: money(c.available), limit: money(c.credit_limit) });
  return `${first} · ${second}`;
}

/** The short line for a list row: what's available, or past the limit. */
export function cardShort(account: Account): string | null {
  const c = account.credit_card;
  if (!c) return null;
  const money = (a: string) => formatMoney(a, account.currency);
  return compareAmounts(c.available, "0") < 0
    ? i18n.t("cards.pastLimitShort", { amount: money(negate(c.available)) })
    : i18n.t("cards.availableShort", { amount: money(c.available) });
}

/** The accounts that can be a card's default account in currency. */
export function defaultAccountChoices(accounts: Account[], currency: string): Account[] {
  return accounts.filter((a) => a.currency === currency && DEFAULT_ACCOUNT_TYPES.includes(a.type));
}

/** The cards whose default account this is. */
export function cardsDefaultingTo(accounts: Account[], accountId: string): Account[] {
  return accounts.filter((a) => a.credit_card?.default_account_id === accountId);
}

/** Whether error is the server asking to confirm going past a card's limit. */
export function limitAsk(error: unknown): boolean {
  return error instanceof ApiError && error.code === "over_credit_limit";
}

/** A card's fields as the form holds them. */
export interface CardDraft {
  defaultAccount: string | null;
  limit: string | null;
  statementDay: string | null;
  dueDay: string | null;
  minimum: string | null;
}

export const EMPTY_CARD: CardDraft = {
  defaultAccount: null,
  limit: null,
  statementDay: null,
  dueDay: null,
  minimum: null,
};

export function cardDraft(card: CreditCard): CardDraft {
  return {
    defaultAccount: card.default_account_id,
    limit: canonicalAmount(card.credit_limit),
    statementDay: String(card.statement_day),
    dueDay: String(card.due_day),
    minimum: canonicalAmount(card.minimum_payment),
  };
}

export type CardField = Exclude<keyof CardDraft, "defaultAccount">;

/** What's wrong with each field, if anything. */
export function cardProblems(d: CardDraft): Partial<Record<CardField, "aboveZero" | "chooseDay">> {
  const out: Partial<Record<CardField, "aboveZero" | "chooseDay">> = {};
  const positive = (a: string | null) => a !== null && compareAmounts(a, "0") > 0;
  if (!positive(d.limit)) out.limit = "aboveZero";
  if (!positive(d.minimum)) out.minimum = "aboveZero";
  if (d.statementDay === null) out.statementDay = "chooseDay";
  if (d.dueDay === null) out.dueDay = "chooseDay";
  return out;
}

/** The fields for the API; only for a draft without problems. */
export function cardFields(d: CardDraft): CreditCardFields {
  return {
    ...(d.defaultAccount ? { default_account_id: d.defaultAccount } : {}),
    credit_limit: d.limit ?? "0",
    statement_day: Number(d.statementDay),
    due_day: Number(d.dueDay),
    minimum_payment: d.minimum ?? "0",
  };
}

/** Whether the draft differs from the card's fields. */
export function cardChanged(d: CardDraft, card: CreditCard): boolean {
  const was = cardDraft(card);
  return (Object.keys(was) as (keyof CardDraft)[]).some((k) => d[k] !== was[k]);
}
