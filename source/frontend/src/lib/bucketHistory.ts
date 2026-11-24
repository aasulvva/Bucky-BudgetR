// A bucket's transactions in one cycle, with its TF after each (#84): how
// the bucket got from the cycle's start to what it has now.

import type { Transaction, TransactionType } from "@/api/transactions";

import type { BreakdownPart } from "./buckets";
import { addAmounts, compareAmounts, subtractAmounts } from "./money";

/** What the history shows: every line, the bucket-only types, or one type. */
export type HistoryKind = "all" | "bucket" | (typeof KIND_TYPES)[number];

/** The types the history can be narrowed to, in the order the picker lists them. */
export const KIND_TYPES = ["INC", "EXP", "REF", "OVF", "OPF", "BUA", "BAT"] as const;

/** The types that only move a bucket's funds. */
const BUCKET_TYPES: TransactionType[] = ["REF", "OVF", "OPF", "BUA", "BAT"];

/** The kind each part of the cycle breakdown links to. Start has no lines. */
export const BREAKDOWN_KIND: Record<Exclude<BreakdownPart, "start">, HistoryKind> = {
  refills: "REF",
  income: "INC",
  opening_funds: "OPF",
  adjustments: "BUA",
  transfers: "BAT",
};

export interface HistoryRow {
  tx: Transaction;
  /** What the transaction put into (positive) or took out of the bucket. */
  amount: string;
  /** The bucket's TF after it. */
  tf: string;
  /** For a transfer between buckets, the other bucket. */
  otherBucketId?: string;
}

/**
 * The rows for a bucket in a cycle, newest first (as `transactions`, which
 * come from the API in that order). Each TF counts back from `end`, the
 * bucket's TF now (or at the cycle's end), so the rows are right even when
 * older ones are missing. Only the bucket's lines in that cycle count, with
 * their effective amounts; a transaction that comes to 0 there (e.g.
 * reversed) is left out.
 */
export function historyRows(
  transactions: Transaction[],
  bucketId: string,
  cycleId: string,
  end: string,
): HistoryRow[] {
  let tf = addAmounts(end);
  const rows: HistoryRow[] = [];
  for (const tx of transactions) {
    const own = tx.bucket_lines.filter((l) => l.bucket_id === bucketId && l.cycle_id === cycleId);
    const amount = addAmounts(...own.map((l) => l.amount));
    if (own.length === 0 || compareAmounts(amount, "0") === 0) continue;
    const other =
      tx.type === "BAT" ? tx.bucket_lines.find((l) => l.bucket_id !== bucketId) : undefined;
    rows.push({ tx, amount, tf, ...(other ? { otherBucketId: other.bucket_id } : {}) });
    tf = subtractAmounts(tf, amount);
  }
  return rows;
}

/** Whether a row is of the kind shown. */
export function ofKind(row: HistoryRow, kind: HistoryKind): boolean {
  if (kind === "all") return true;
  if (kind === "bucket") return BUCKET_TYPES.includes(row.tx.type);
  // A purchase counted later (#264) is spending, as Used counts it.
  if (kind === "EXP") return row.tx.type === "EXP" || row.tx.type === "DBC";
  return row.tx.type === kind;
}
