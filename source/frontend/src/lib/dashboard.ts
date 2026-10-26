// The Dashboard's logic (spec §9), kept apart from the page: its widgets'
// settings, the budget's health per account, and which buckets to show.

import type { Account, Bucket, BucketFigures } from "@/api/accounts";
import type { components } from "@/api/schema";

import { accountSummary, coverage, type Tone } from "./buckets";
import { addAmounts, compareAmounts, percentOf } from "./money";

type Preferences = components["schemas"]["Preferences"];
export type DashboardPreferences = components["schemas"]["DashboardSettings"];
export type BucketStatusMode = NonNullable<DashboardPreferences["bucket_status"]>["mode"];

export const BUCKET_STATUS_MODES: BucketStatusMode[] = ["attention", "all", "most_used", "bucket"];
export const TRANSACTION_COUNTS = [3, 5, 10, 15, 20];

/** How many buckets Most used shows. */
export const MOST_USED = 5;

export interface DashboardSettings {
  bucketStatus: { mode: BucketStatusMode; bucketId: string | null };
  recentCount: number;
}

/** The widgets' settings, with the defaults for what isn't set. */
export function dashboardSettings(preferences: Preferences): DashboardSettings {
  const saved = preferences.dashboard;
  return {
    bucketStatus: {
      mode: saved?.bucket_status?.mode ?? "attention",
      bucketId: saved?.bucket_status?.bucket_id ?? null,
    },
    recentCount: saved?.recent_transactions?.count ?? 5,
  };
}

/** What saving the settings sends; the API replaces `dashboard` as a whole. */
export function toPreferences(settings: DashboardSettings): DashboardPreferences {
  const { mode, bucketId } = settings.bucketStatus;
  return {
    bucket_status: mode === "bucket" ? { mode, bucket_id: bucketId } : { mode },
    recent_transactions: { count: settings.recentCount },
  };
}

/**
 * The bucket One bucket shows. Without it (none chosen, or it was deleted)
 * the widget falls back to Needs attention.
 */
export function shownBucketStatus(
  settings: DashboardSettings,
  buckets: Bucket[],
): { mode: Exclude<BucketStatusMode, "bucket"> } | { mode: "bucket"; bucket: Bucket } {
  const { mode, bucketId } = settings.bucketStatus;
  if (mode !== "bucket") return { mode };
  const bucket = buckets.find((b) => b.id === bucketId);
  return bucket ? { mode, bucket } : { mode: "attention" };
}

export interface AccountHealth {
  /** Σ TF of the account's buckets that aren't overspent. */
  needed: string;
  /** How much of it the account backs (Σ CAF). */
  covered: string;
  /** covered as a % of needed; 100 when nothing is needed. */
  pct: number;
  short: string;
  unallocated: string;
  uncovered: number;
  overspent: number;
  tone: Tone;
}

/** How well an account backs its buckets, as the Buckets header sums it up. */
export function accountHealth(account: Account, buckets: Bucket[]): AccountHealth {
  const own = buckets.filter((b) => b.source_account_id === account.id);
  const funded = own.filter((b) => compareAmounts(b.target_funds, "0") > 0);
  const needed = addAmounts(...funded.map((b) => b.target_funds));
  const covered = addAmounts(...funded.map((b) => b.current_available_funds));
  const { short, unallocated, tone } = accountSummary(account, buckets);
  return {
    needed,
    covered,
    pct: compareAmounts(needed, "0") > 0 ? Math.min(percentOf(covered, needed), 100) : 100,
    short,
    unallocated,
    uncovered: own.filter((b) => compareAmounts(coverage(b).gap, "0") > 0).length,
    overspent: own.filter((b) => coverage(b).overspent).length,
    tone,
  };
}

/** How much of its budget a bucket has used this cycle; null without figures. */
export function usedPct(figures: BucketFigures | undefined): number | null {
  if (!figures || compareAmounts(figures.budget, "0") <= 0) return null;
  return percentOf(figures.used, figures.budget);
}

export type AttentionReason = "overspent" | "uncovered" | "mostlyUsed";

export interface Attention {
  bucket: Bucket;
  reason: AttentionReason;
}

/**
 * The buckets that need attention, worst first: overspent, not fully
 * covered (priority ones first), then more than 90 % used, the most used
 * first.
 */
export function needsAttention(
  buckets: Bucket[],
  figures: Map<string, BucketFigures>,
): Attention[] {
  const rank = (a: Attention) =>
    a.reason === "overspent" ? 0 : a.reason === "uncovered" ? (a.bucket.priority ? 1 : 2) : 3;
  const pct = (b: Bucket) => usedPct(figures.get(b.id)) ?? 0;
  return buckets
    .flatMap((bucket): Attention[] => {
      const { overspent, gap } = coverage(bucket);
      if (overspent) return [{ bucket, reason: "overspent" }];
      if (compareAmounts(gap, "0") > 0) return [{ bucket, reason: "uncovered" }];
      return pct(bucket) > 90 ? [{ bucket, reason: "mostlyUsed" }] : [];
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        pct(b.bucket) - pct(a.bucket) ||
        a.bucket.name.localeCompare(b.bucket.name),
    );
}

/** The n buckets that have used the most of their budget this cycle. */
export function mostUsed(
  buckets: Bucket[],
  figures: Map<string, BucketFigures>,
  n = MOST_USED,
): { bucket: Bucket; pct: number }[] {
  return buckets
    .flatMap((bucket) => {
      const pct = usedPct(figures.get(bucket.id));
      return pct === null ? [] : [{ bucket, pct }];
    })
    .sort((a, b) => b.pct - a.pct || a.bucket.name.localeCompare(b.bucket.name))
    .slice(0, n);
}
