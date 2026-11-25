// What ending the active cycle will do to the buckets, for the confirmation.
// This mirrors the cycle-end and cycle-start routines in
// internal/refill/refill.go (spec §6); change both together.

import type { Bucket } from "@/api/accounts";

import { refillOf } from "./buckets";
import { addAmounts, compareAmounts, subtractAmounts } from "./money";

export interface Emptied {
  bucket: Bucket;
  /** The OVF: the positive TF taken out. */
  amount: string;
  /** The part of it the account backs (CAF), which becomes unallocated. */
  funded: string;
}

export interface Refilled {
  bucket: Bucket;
  /** The REF: what the refill adds (negative only if TF was above RA). */
  amount: string;
  /** What the new TF has above BC, sent to the overflow destination. */
  overflow: string;
}

/** What the preview needs of an account: its money now. */
export interface AccountMoney extends MoneyNow {
  currency: string;
  unallocated: string;
}

/**
 * An account's money as balance.NewMoney counts it: its balance, what its
 * buckets are owed for purchases that wait (#264), the card debt held on it
 * (#261) and its savings holds.
 */
interface MoneyNow {
  id: string;
  balance: string;
  reserved: string;
  waiting?: string;
  card_holds?: { amount: string }[];
}

export interface EndPreview {
  emptied: Emptied[];
  /**
   * What becomes unallocated, per currency: the funded part of the emptied
   * buckets, less what the buckets left take of it on an underfunded account.
   */
  backToUnallocated: { currency: string; amount: string }[];
  /** The funded part of the emptied buckets whose overflow goes to savings (#233). */
  toSavings: { currency: string; amount: string }[];
  refilled: Refilled[];
}

const positive = (a: string) => compareAmounts(a, "0") > 0;
const min = (a: string, b: string) => (compareAmounts(a, b) <= 0 ? a : b);

/**
 * Previews the end of the cycle:
 * - Keep funds off: an OVF brings a positive TF to 0.
 * - If a cycle starts right after (`refills`), its Auto buckets are refilled:
 *   Keep funds off sets TF to RA (REF = RA − TF); Keep funds on adds RA and
 *   overflows what's above BC.
 *
 * The amounts use the current CAF; the routine recalculates it first, so the
 * money back to unallocated can differ slightly. With the accounts, what
 * goes back to unallocated is worked out per account after the emptying
 * (unallocatedAfter); without, it's the emptied buckets' funded part.
 */
export function endPreview(
  buckets: Bucket[],
  refills: boolean,
  accounts: AccountMoney[] = [],
): EndPreview {
  const emptied = buckets
    .filter((b) => !b.keep_funds && positive(b.target_funds))
    .map((b) => ({
      bucket: b,
      amount: b.target_funds,
      funded: min(b.current_available_funds, b.target_funds),
    }));

  const refilled: Refilled[] = [];
  if (refills) {
    for (const b of buckets.filter((x) => x.refill_mode === "auto")) {
      // TF after the end routine emptied it.
      const tf = b.keep_funds || !positive(b.target_funds) ? b.target_funds : "0.00";
      const { amount, overflow } = refillOf(b, tf);
      if (compareAmounts(amount, "0") !== 0 || positive(overflow)) {
        refilled.push({ bucket: b, amount, overflow });
      }
    }
  }

  const saved = (e: Emptied) => e.bucket.overflow_destination !== "unallocated";
  const back = emptied.filter((e) => !saved(e));
  return {
    emptied,
    backToUnallocated:
      accounts.length === 0 ? perCurrency(back) : backPerCurrency(buckets, emptied, back, accounts),
    toSavings: perCurrency(emptied.filter(saved)),
    refilled,
  };
}

/**
 * What becomes unallocated per currency, per account after the emptying;
 * an account not given counts its emptied buckets' funded part.
 */
function backPerCurrency(
  buckets: Bucket[],
  emptied: Emptied[],
  back: Emptied[],
  accounts: AccountMoney[],
): { currency: string; amount: string }[] {
  const ids = [...new Set(back.map((e) => e.bucket.source_account_id))];
  const amounts = ids.map((id) => {
    const account = accounts.find((a) => a.id === id);
    const mine = back.filter((e) => e.bucket.source_account_id === id);
    if (!account) {
      return {
        currency: mine[0]?.bucket.currency ?? "",
        amount: addAmounts(...mine.map((e) => e.funded)),
      };
    }
    const more = subtractAmounts(unallocatedAfter(buckets, emptied, account), account.unallocated);
    return { currency: account.currency, amount: positive(more) ? more : "0.00" };
  });
  return [...new Set(amounts.map((a) => a.currency))].map((currency) => ({
    currency,
    amount: addAmounts(...amounts.filter((a) => a.currency === currency).map((a) => a.amount)),
  }));
}

/**
 * What the account has unallocated after the cycle-end routine's OVFs. The
 * emptied buckets have no TF then, so the buckets left (Keep funds on, or at
 * 0 or below) are funded first, up to their TF: an underfunded account's
 * freed money goes to them. The savings holds come next, with what the
 * emptied buckets sent to savings (#233). The money is the balance and what
 * the buckets are owed for waiting purchases (#264), less the card debt held
 * on the account, which is covered first (#261). This mirrors
 * balance.NewMoney.
 */
function unallocatedAfter(buckets: Bucket[], emptied: Emptied[], account: MoneyNow): string {
  const gone = new Set(emptied.map((e) => e.bucket.id));
  const left = buckets.filter((b) => b.source_account_id === account.id && !gone.has(b.id));
  const wanted = addAmounts(
    ...left.map((b) => (positive(b.target_funds) ? b.target_funds : "0.00")),
  );
  const funds = addAmounts(account.balance, account.waiting ?? "0");
  const holds = addAmounts(...(account.card_holds ?? []).map((h) => h.amount));
  const debt = positive(holds) ? holds : "0.00";
  const cardCovered = positive(funds) ? min(funds, debt) : "0.00";
  const rest = subtractAmounts(funds, cardCovered);
  const free = positive(rest) ? rest : "0.00";
  const toSavings = emptied
    .filter(
      (e) =>
        e.bucket.source_account_id === account.id &&
        e.bucket.overflow_destination !== "unallocated",
    )
    .map((e) => e.funded);
  const held = addAmounts(account.reserved, ...toSavings);
  const unallocated = subtractAmounts(subtractAmounts(free, min(free, wanted)), held);
  return positive(unallocated) ? unallocated : "0.00";
}

/** The funded amounts per currency, leaving out currencies with none. */
function perCurrency(emptied: Emptied[]): { currency: string; amount: string }[] {
  return [...new Set(emptied.map((e) => e.bucket.currency))].map((currency) => ({
    currency,
    amount: addAmounts(
      ...emptied.filter((e) => e.bucket.currency === currency).map((e) => e.funded),
    ),
  }));
}

/**
 * About what an At cycle end sweep (#235) takes from the account: what it
 * has unallocated after the OVFs (unallocatedAfter) above keep, at least 0.
 * It runs before the next cycle's refills.
 */
export function sweepEstimate(
  buckets: Bucket[],
  preview: EndPreview,
  account: MoneyNow,
  keep: string,
): string {
  const above = subtractAmounts(unallocatedAfter(buckets, preview.emptied, account), keep);
  return positive(above) ? above : "0.00";
}
