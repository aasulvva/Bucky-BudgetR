// Counting a purchase in its buckets later (#264, spec §5.5): the form's
// choice, and what a purchase or a DBC shows of it.

import type { TFunction } from "i18next";

import type { Cycle } from "@/api/cycles";
import type { Transaction } from "@/api/transactions";
import type { CountLater, WaitingCharge, WaitingChargeWhen } from "@/api/waiting";

import { now as clockNow } from "./clock";
import { cycleRange } from "./cycles";
import { formatDate } from "./dates";
import { getLocale } from "./locale";
import { addAmounts, compareAmounts } from "./money";

/** When the buckets count a purchase: now, or one of the later rules. */
export type CountWhen = "now" | WaitingChargeWhen;

export interface CountChoice {
  when: CountWhen;
  /** For "cycle": a planned cycle. */
  cycleId: string | null;
  /** For "month": YYYY-MM. */
  month: string | null;
}

export const COUNT_NOW: CountChoice = { when: "now", cycleId: null, month: null };

/** The purchase's own parts that wait for their buckets, as the form's split. */
export function ownWaiting(tx: Transaction): Transaction["waiting_lines"] {
  return tx.waiting_lines.filter(
    (l) => l.purchase_id === tx.id && compareAmounts(l.amount, "0") > 0,
  );
}

/** What a purchase's choice is now: from its waiting charges, or now. */
export function choiceOf(tx: Transaction): CountChoice {
  const w = tx.waiting[0];
  if (!w) return COUNT_NOW;
  if (w.when === "paid") return { when: "paid", cycleId: null, month: null };
  if (w.when === "cycle" && w.cycle_id) return { when: "cycle", cycleId: w.cycle_id, month: null };
  // A month, or a cycle that was deleted: the first cycle from its date.
  return { when: "month", cycleId: null, month: w.take_on ? w.take_on.slice(0, 7) : null };
}

export function sameChoice(a: CountChoice, b: CountChoice): boolean {
  if (a.when !== b.when) return false;
  if (a.when === "cycle") return a.cycleId === b.cycleId;
  if (a.when === "month") return a.month === b.month;
  return true;
}

/** The API's count_later for a choice; undefined for now or one not filled in. */
export function countLaterOf(c: CountChoice): CountLater | undefined {
  switch (c.when) {
    case "paid":
      return { when: "paid" };
    case "cycle":
      return c.cycleId ? { when: "cycle", cycle_id: c.cycleId } : undefined;
    case "month":
      return c.month ? { when: "month", month: c.month } : undefined;
    default:
      return undefined;
  }
}

const ym = (d: Date) => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * The months a purchase can count in: from the month after the active cycle's
 * start month (this month without an active cycle), `count` of them.
 */
export function monthChoices(active: Cycle | null, count = 12, now = clockNow()): string[] {
  const from = active ? new Date(active.start_at) : now;
  const first = new Date(from.getFullYear(), from.getMonth() + (active ? 1 : 0), 1);
  return Array.from({ length: count }, (_, i) =>
    ym(new Date(first.getFullYear(), first.getMonth() + i, 1)),
  );
}

/** "March 2027" for 2027-03. */
export function formatMonth(month: string, locale = getLocale()): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(y ?? 1970, (m ?? 1) - 1, 1),
  );
}

/** The planned cycles a purchase can count in, oldest first. */
export function plannedCycles(cycles: Cycle[], now = clockNow()): Cycle[] {
  return cycles.filter((c) => c.state === "future" && new Date(c.start_at) > now);
}

/** When a waiting charge is taken, in words. */
export function ruleText(w: WaitingCharge, cycles: Cycle[], t: TFunction): string {
  if (w.when === "paid") return t("waiting.rule.paid");
  const cycle = w.cycle_id ? cycles.find((c) => c.id === w.cycle_id) : undefined;
  if (cycle) return t("waiting.rule.cycle", { range: cycleRange(cycle) });
  if (w.when === "month" && w.take_on) {
    return t("waiting.rule.month", { month: formatMonth(w.take_on.slice(0, 7)) });
  }
  return t("waiting.rule.from", { date: w.take_on ? formatDate(w.take_on) : "" });
}

/** What a purchase's buckets haven't taken yet. */
export function waitingLeft(tx: Pick<Transaction, "waiting">): string {
  return addAmounts(...tx.waiting.filter((w) => !w.bucket_deleted).map((w) => w.left));
}

/** Whether a charge can be taken now: something left on a live bucket. */
export function canTake(w: WaitingCharge): boolean {
  return !w.bucket_deleted && compareAmounts(w.left, "0") > 0;
}

/** A DBC's purchase: the transaction its bucket took (part of). */
export function purchaseOf(tx: Transaction): string | null {
  return tx.type === "DBC" ? (tx.waiting_lines[0]?.purchase_id ?? null) : null;
}
