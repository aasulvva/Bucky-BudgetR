// Credit card accounts (#260, spec §2.2).

import type { Account, AccountType, Bucket, CreditCard, CreditCardFields } from "@/api/accounts";
import type { Transaction } from "@/api/transactions";
import { ApiError } from "@/api/errors";
import i18n from "@/i18n";

import {
  addAmounts,
  canonicalAmount,
  compareAmounts,
  formatMoney,
  percentOf,
  subtractAmounts,
} from "./money";

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

// Card debt held per account (#261, spec §2.2).

/** What's held on account for card, or "0". */
export function heldFor(account: Account | undefined, cardId: string): string {
  return account?.card_holds.find((h) => h.card_id === cardId)?.amount ?? "0";
}

/** The account's holds above 0, as {card, amount}. */
export function positiveHolds(account: Account | undefined): { card_id: string; amount: string }[] {
  return (account?.card_holds ?? []).filter((h) => compareAmounts(h.amount, "0") > 0);
}

/**
 * The account's card debt in a line: "kr 200 set aside for Visa", with what
 * the balance doesn't cover; null without any.
 */
export function cardHeldLine(account: Account, accounts: Account[]): string | null {
  const holds = positiveHolds(account);
  if (holds.length === 0) return null;
  const money = (a: string) => formatMoney(a, account.currency);
  const parts = holds.map((h) =>
    i18n.t("cards.debt.heldFor", {
      amount: money(h.amount),
      card: accounts.find((a) => a.id === h.card_id)?.name ?? h.card_id,
    }),
  );
  if (compareAmounts(account.card_debt_uncovered, "0") > 0) {
    parts.push(i18n.t("cards.debt.uncovered", { amount: money(account.card_debt_uncovered) }));
  }
  return parts.join(" · ");
}

/** The accounts card debt can be held on: in the card's currency, not cards. */
export function holderChoices(accounts: Account[], card: Account): Account[] {
  return accounts.filter((a) => !isCard(a) && a.currency === card.currency);
}

/**
 * What a payment of amount from payer clears there, and what it releases on
 * other accounts when the user doesn't say: what's held beyond what the card
 * still owes, at most the rest of the payment, largest holds first (as the
 * server does).
 */
export function autoRelease(
  card: Account,
  payer: Account,
  accounts: Account[],
  amount: string,
): { clears: string; releases: { account_id: string; amount: string }[] } {
  const zero = (a: string) => (compareAmounts(a, "0") > 0 ? a : "0");
  const min = (a: string, b: string) => (compareAmounts(a, b) <= 0 ? a : b);
  const clears = min(amount, zero(heldFor(payer, card.id)));
  const excess = subtractAmounts(amount, clears);
  const others = accounts
    .filter((a) => a.id !== payer.id && compareAmounts(heldFor(a, card.id), "0") > 0)
    .map((a) => ({ account_id: a.id, amount: heldFor(a, card.id) }))
    .sort((a, b) => compareAmounts(b.amount, a.amount) || a.account_id.localeCompare(b.account_id));
  const total = addAmounts(...accounts.map((a) => zero(heldFor(a, card.id))));
  const owedAfter = zero(subtractAmounts(card.credit_card?.owed ?? "0", amount));
  let left = min(excess, subtractAmounts(subtractAmounts(total, clears), owedAfter));
  const releases: { account_id: string; amount: string }[] = [];
  for (const o of others) {
    const r = min(o.amount, left);
    releases.push({ account_id: o.account_id, amount: zero(r) });
    left = zero(subtractAmounts(left, r));
  }
  return { clears, releases };
}

/** What a transfer of amount from account carries per card, filled in order. */
export function carryPrefill(
  account: Account,
  amount: string | null,
): { card_id: string; amount: string }[] {
  let left = amount ?? "0";
  return positiveHolds(account).map((h) => {
    const c = compareAmounts(h.amount, left) <= 0 ? h.amount : left;
    left = subtractAmounts(left, c);
    return { card_id: h.card_id, amount: compareAmounts(c, "0") > 0 ? c : "0" };
  });
}

/** Set aside on a card, or Release (#261). */
export type CardDebtMode = "setAside" | "release";

/** Whether the card has something to set aside, or to release. */
export function canCardDebt(card: Account, mode: CardDebtMode): boolean {
  const c = card.credit_card;
  if (!c) return false;
  return mode === "setAside"
    ? compareAmounts(c.not_set_aside, "0") > 0
    : c.held_on.some((h) => compareAmounts(h.amount, "0") > 0);
}

/** "Don't set aside", as the Set aside on select holds it. */
export const NOWHERE = "none";

/**
 * The buckets an income or expense on account can use: its own, or on a card
 * (#261), those funded from any account in its currency.
 */
export function bucketsFor(
  account: Account | undefined,
  accounts: Account[],
  buckets: Bucket[],
): Bucket[] {
  if (!account) return [];
  if (!isCard(account)) return buckets.filter((b) => b.source_account_id === account.id);
  const holders = holderChoices(accounts, account).map((a) => a.id);
  return buckets.filter((b) => holders.includes(b.source_account_id));
}

/** Where a card purchase's part outside buckets is set aside by default. */
export function defaultSetAside(card: Account): string {
  return card.credit_card?.default_account_id ?? NOWHERE;
}

/**
 * Where a recorded card purchase or refund set its part outside buckets
 * aside: the account whose card line isn't its buckets' parts, NOWHERE when
 * there was a rest and no such line, or null when there's no telling (no
 * rest).
 */
export function setAsideOf(tx: Transaction, buckets: Bucket[]): string | null {
  const parts: Record<string, string> = {};
  for (const l of tx.bucket_lines) {
    const src = buckets.find((b) => b.id === l.bucket_id)?.source_account_id;
    // A bucket line and its hold have opposite signs.
    if (src) parts[src] = subtractAmounts(parts[src] ?? "0", l.amount);
  }
  const rest = tx.card_lines.find(
    (l) => compareAmounts(l.amount, parts[l.account_id] ?? "0") !== 0,
  );
  if (rest) return rest.account_id;
  const bank = tx.bank_lines[0]?.amount ?? "0";
  const total = addAmounts(...tx.bucket_lines.map((l) => l.amount));
  return compareAmounts(subtractAmounts(bank, total), "0") !== 0 ? NOWHERE : null;
}
