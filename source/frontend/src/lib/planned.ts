// Planned purchases (#265, spec §5.7): the form's values, the request
// bodies, and what a bucket has left once they're set aside.

import type { Bucket, BucketFigures } from "@/api/accounts";
import type { PlannedPurchase, PlannedPurchaseInput } from "@/api/planned";
import { localDate, startAtFor, type LocalDate } from "@/lib/cycles";
import { compareAmounts, subtractAmounts } from "@/lib/money";
import { cleanDescription, newLine, type EditValues, type SplitLine } from "@/lib/transactionForm";

/** The plan form's fields. */
export interface PlannedValues {
  name: string;
  accountId: string | null;
  amount: string | null;
  /** The expected day, local. */
  expected: LocalDate | null;
  note: string;
  lines: SplitLine[];
}

export function emptyPlanned(accountId: string | null): PlannedValues {
  return { name: "", accountId, amount: null, expected: null, note: "", lines: [] };
}

export function plannedValues(p: PlannedPurchase): PlannedValues {
  return {
    name: p.name,
    accountId: p.account_id,
    amount: p.amount,
    expected: localDate(p.expected_at),
    note: p.note,
    lines: p.bucket_lines.map((l) => newLine(l.bucket_id, l.amount)),
  };
}

/** The request body, once the form is valid. */
export function plannedBody(v: PlannedValues): PlannedPurchaseInput {
  return {
    name: v.name.trim(),
    account_id: v.accountId ?? "",
    amount: v.amount ?? "",
    expected_at: startAtFor(v.expected ?? ""),
    note: cleanDescription(v.note),
    bucket_lines: v.lines.map((l) => ({ bucket_id: l.bucketId ?? "", amount: l.amount ?? "" })),
  };
}

/**
 * What a bucket sets aside for planned purchases this cycle, and what it has
 * left after them: what's left now (CAF, as Buckets shows it) less that.
 * Null when nothing is set aside.
 */
export function setAside(
  bucket: Bucket,
  figures: BucketFigures | undefined,
): { planned: string; left: string; short: boolean } | null {
  const planned = figures?.planned ?? "0";
  if (compareAmounts(planned, "0") <= 0) return null;
  const left = subtractAmounts(bucket.current_available_funds, planned);
  return { planned, left, short: compareAmounts(left, "0") < 0 };
}

/** The Record charge link: New transaction, filled in from the plan. */
export function chargeLink(id: string): string {
  return `/transactions/new?planned=${id}`;
}

export const PLANNED_PATH = "/transactions/planned";

/**
 * Record charge: what New transaction starts with, an expense like the plan
 * (the name as its counterparty, the note as its description).
 */
export function chargeValues(
  p: PlannedPurchase,
): Omit<EditValues, "triggersRefill"> & { triggersRefill: boolean | null } {
  return {
    amount: p.amount,
    accountId: p.account_id,
    toAccountId: null,
    counterparty: p.name,
    description: p.note,
    tags: [],
    lines: p.bucket_lines.map((l) => newLine(l.bucket_id, l.amount)),
    triggersRefill: null,
  };
}
