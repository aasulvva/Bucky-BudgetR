// Names and texts for transactions, from the accounts and buckets the app
// already has. Deleted ones aren't listed, so they show by ID.

import { useAccounts, useBuckets } from "@/api/accounts";
import type { Transaction } from "@/api/transactions";
import i18n from "@/i18n";
import { formatMoney } from "@/lib/money";
import { shownLines, transferAccounts } from "@/lib/transactionList";

export interface Lookups {
  accountName: (id: string) => string;
  bucketName: (id: string) => string;
  /** The currency of the transaction's account or bucket. */
  currencyOf: (tx: Transaction) => string | undefined;
  /** An account's currency, if the app has it. */
  accountCurrency: (id: string) => string | undefined;
}

export function useLookups(): Lookups {
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  return {
    accountName: (id) =>
      accounts.find((a) => a.id === id)?.name ?? i18n.t("transactions.unknownAccount", { id }),
    bucketName: (id) =>
      buckets.find((b) => b.id === id)?.name ?? i18n.t("transactions.unknownBucket", { id }),
    accountCurrency: (id) => accounts.find((a) => a.id === id)?.currency,
    currencyOf: (tx) => {
      const lines = shownLines(tx);
      const account = lines.bank_lines[0]?.account_id;
      if (account) return accounts.find((a) => a.id === account)?.currency;
      const bucket = lines.bucket_lines[0]?.bucket_id;
      return buckets.find((b) => b.id === bucket)?.currency;
    },
  };
}

/** What a transaction is called: its counterparty, a transfer's accounts, or its type. */
export function transactionTitle(tx: Transaction, names: Lookups): string {
  if (tx.counterparty.trim()) return tx.counterparty;
  if (tx.type === "TRF") {
    const { from, to } = transferAccounts(shownLines(tx));
    if (from && to) return `${names.accountName(from)} → ${names.accountName(to)}`;
  }
  return i18n.t(`transactionTypes.${tx.type}`);
}

/** The line under the title: the account, the buckets and the tags. */
export function transactionSubLine(tx: Transaction, names: Lookups): string {
  const lines = shownLines(tx);
  const accounts = lines.bank_lines.map((l) => names.accountName(l.account_id));
  const buckets = lines.bucket_lines.map((l) => names.bucketName(l.bucket_id));
  let parts: string[];
  switch (tx.type) {
    case "TRF":
      parts = [i18n.t("transactionTypes.TRF")];
      break;
    case "INC":
    case "EXP":
      parts = [
        ...accounts,
        buckets.length > 0 ? buckets.join(", ") : i18n.t("transactions.noBuckets"),
      ];
      break;
    case "OPB":
    case "BLA":
      parts = [...accounts];
      if (tx.counterparty.trim()) parts.unshift(i18n.t(`transactionTypes.${tx.type}`));
      break;
    default:
      parts = [i18n.t(`transactionTypes.${tx.type}`), buckets.join(", ")];
  }
  if (tx.tags.length > 0) parts.push(tx.tags.join(", "));
  return parts.filter((p) => p !== "").join(" · ");
}

/** "+1 665.30 kr" for a positive signed amount, "−612.00 kr" or "2 000.00 kr". */
export function signedMoney(
  { amount, signed }: { amount: string; signed: boolean },
  currency?: string,
): string {
  const text = formatMoney(amount, currency);
  return signed && !amount.startsWith("-") && amount !== "0.00" ? `+${text}` : text;
}
