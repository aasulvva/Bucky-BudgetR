// The Transactions screen's logic, kept apart from the page: the filters as
// they live in the URL, the query they make, and what a row shows.

import type { Cycle } from "@/api/cycles";
import type { Transaction, TransactionQuery, TransactionType } from "@/api/transactions";

import { endAtFor, localDate, startAtFor, type LocalDate } from "./cycles";
import { addAmounts, compareAmounts, subtractAmounts } from "./money";
import { insideCycle } from "./transactionForm";

/** What the user records, shown by default. */
export const USER_TYPES: TransactionType[] = ["INC", "EXP", "TRF", "OPB", "BLA"];
/** What the routines and Bucket setup record: refills, overflow, adjustments. */
export const SYSTEM_TYPES: TransactionType[] = ["REF", "OVF", "OPF", "BUA", "BAT"];
/** The types that can be corrected and reversed. */
export type CorrectableType = "INC" | "EXP" | "TRF" | "OPB" | "BLA";
export const CORRECTABLE: CorrectableType[] = ["INC", "EXP", "TRF", "OPB", "BLA"];

export function isCorrectableType(type: TransactionType): type is CorrectableType {
  return CORRECTABLE.some((x) => x === type);
}

const ALL_TYPES = [...USER_TYPES, ...SYSTEM_TYPES];

export interface TransactionFilter {
  /** Counterparty text. */
  q: string;
  accountId: string | null;
  bucketId: string | null;
  /** null: the active cycle (all when there is none); "all": every cycle. */
  cycleId: string | null;
  type: TransactionType | null;
  tag: string | null;
  from: LocalDate | null;
  /** The last day, inclusive. */
  to: LocalDate | null;
  /** Also show the system types. */
  system: boolean;
}

export const ALL_CYCLES = "all";

const PARAMS: Record<keyof TransactionFilter, string> = {
  q: "q",
  accountId: "account_id",
  bucketId: "bucket_id",
  cycleId: "cycle_id",
  type: "type",
  tag: "tag",
  from: "from",
  to: "to",
  system: "system",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The filter in the screen's URL. */
export function readFilter(params: URLSearchParams): TransactionFilter {
  const get = (key: keyof TransactionFilter) => {
    const v = params.get(PARAMS[key]);
    return v === "" ? null : v;
  };
  const date = (key: "from" | "to") => {
    const v = get(key);
    return v && DATE.test(v) ? v : null;
  };
  const type = get("type");
  return {
    q: get("q") ?? "",
    accountId: get("accountId"),
    bucketId: get("bucketId"),
    cycleId: get("cycleId"),
    type: ALL_TYPES.find((x) => x === type) ?? null,
    tag: get("tag"),
    from: date("from"),
    to: date("to"),
    system: get("system") === "1",
  };
}

/** params with the filter changed; other parameters (like the open transaction) stay. */
export function withFilter(
  params: URLSearchParams,
  change: Partial<TransactionFilter>,
): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const [key, value] of Object.entries(change) as [
    keyof TransactionFilter,
    TransactionFilter[keyof TransactionFilter],
  ][]) {
    const name = PARAMS[key];
    if (value === null || value === "" || value === false) out.delete(name);
    else out.set(name, value === true ? "1" : value);
  }
  return out;
}

/** The cycle the list shows: the chosen one, or the active one by default; null for all. */
export function shownCycle(filter: TransactionFilter, active: Cycle | null): string | null {
  if (filter.cycleId === ALL_CYCLES) return null;
  return filter.cycleId ?? active?.id ?? null;
}

/** Whether the filter narrows more than the default (the active cycle, no system types). */
export function isFiltered(filter: TransactionFilter): boolean {
  return (
    filter.q.trim() !== "" ||
    filter.accountId !== null ||
    filter.bucketId !== null ||
    filter.cycleId !== null ||
    filter.type !== null ||
    filter.tag !== null ||
    filter.from !== null ||
    filter.to !== null ||
    filter.system
  );
}

/** The API query for the filter. Local dates become UTC moments; `to` ends after its day. */
export function listQuery(filter: TransactionFilter, active: Cycle | null): TransactionQuery {
  const cycle = shownCycle(filter, active);
  const q = filter.q.trim();
  return {
    type: filter.type ? [filter.type] : filter.system ? ALL_TYPES : USER_TYPES,
    ...(filter.accountId ? { account_id: filter.accountId } : {}),
    ...(filter.bucketId ? { bucket_id: filter.bucketId } : {}),
    ...(cycle ? { cycle_id: cycle } : {}),
    ...(filter.from ? { from: startAtFor(filter.from) } : {}),
    ...(filter.to ? { to: endAtFor(filter.to) } : {}),
    ...(filter.tag ? { tag: filter.tag } : {}),
    ...(q ? { counterparty: q } : {}),
  };
}

/** Transactions grouped by their local day, in the order given (newest first). */
export function groupByDay(items: Transaction[]): { day: LocalDate; items: Transaction[] }[] {
  const out: { day: LocalDate; items: Transaction[] }[] = [];
  for (const tx of items) {
    const day = localDate(tx.at);
    const last = out.at(-1);
    if (last?.day === day) last.items.push(tx);
    else out.push({ day, items: [tx] });
  }
  return out;
}

type Lines = Pick<Transaction, "bank_lines" | "bucket_lines">;

/** The lines a transaction amounts to: the effective ones, or before its reversal. */
export function shownLines(tx: Transaction): Lines {
  return tx.reversed && tx.before_reversal ? tx.before_reversal : tx;
}

const negate = (a: string) => subtractAmounts("0", a);
const abs = (a: string) => (compareAmounts(a, "0") < 0 ? negate(a) : a);

/**
 * The amount lines add up to, as a row shows it. With bank lines those count,
 * otherwise the bucket lines. One line is signed. Several (a transfer between
 * accounts or buckets) are signed from `focus`'s side when it has a line, and
 * unsigned otherwise.
 */
export function linesAmount(
  lines: Lines,
  focus?: string | null,
): { amount: string; signed: boolean } {
  const list =
    lines.bank_lines.length > 0
      ? lines.bank_lines.map((l) => ({ id: l.account_id, amount: l.amount }))
      : lines.bucket_lines.map((l) => ({ id: l.bucket_id, amount: l.amount }));
  if (list.length <= 1) return { amount: list[0]?.amount ?? "0.00", signed: true };
  const own = list.find((l) => l.id === focus);
  if (own) return { amount: own.amount, signed: true };
  const out = list.filter((l) => compareAmounts(l.amount, "0") < 0).map((l) => l.amount);
  return { amount: abs(addAmounts(...out)), signed: false };
}

/** A row's amount: from the filtered account's (or bucket's) side, if it has one. */
export function rowAmount(
  tx: Transaction,
  filter: Pick<TransactionFilter, "accountId" | "bucketId">,
): { amount: string; signed: boolean } {
  const lines = shownLines(tx);
  return linesAmount(lines, lines.bank_lines.length > 0 ? filter.accountId : filter.bucketId);
}

/** A transfer's sending and receiving account. */
export function transferAccounts(lines: Lines): { from?: string; to?: string } {
  return {
    from: lines.bank_lines.find((l) => compareAmounts(l.amount, "0") < 0)?.account_id,
    to: lines.bank_lines.find((l) => compareAmounts(l.amount, "0") > 0)?.account_id,
  };
}

/**
 * Whether the transaction's bucket lines can no longer change: it has some,
 * and its time is outside the active cycle (as the ledger checks).
 */
export function bucketLinesLocked(tx: Transaction, active: Cycle | null): boolean {
  return tx.bucket_lines.length > 0 && !insideCycle(tx.at, active);
}

/** Whether the transaction can be corrected and reversed at all. */
export function isCorrectable(tx: Transaction): boolean {
  return isCorrectableType(tx.type) && !tx.reversed;
}
