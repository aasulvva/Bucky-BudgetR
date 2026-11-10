// The user's data export and import (#36). The export is downloaded and the
// import uploaded as the file's text, never parsed and re-serialized, so that
// amounts stay exact. The browser parses a file only to preview it.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { downloadBlob } from "@/lib/download";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type ImportResult = components["schemas"]["ImportResult"];

/** The newest file format this app reads (userdata.Format). */
export const EXPORT_FORMAT = 1;

/** The export's file name: bucky-budgetr-<username>-<yyyy-mm-dd>.json, in local time. */
export function exportFileName(username: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `bucky-budgetr-${username}-${day}.json`;
}

/** Downloads the user's data as a file. */
export async function downloadExport(username: string): Promise<void> {
  const blob = await unwrap(api.GET("/api/v1/me/export", { parseAs: "blob" }));
  downloadBlob(blob, exportFileName(username));
}

export interface ExportPreview {
  userId: string;
  username: string;
  exportedAt: string;
  accounts: number;
  buckets: number;
  cycles: number;
  transactions: number;
  schedules: number;
}

export type ParsedExport =
  { ok: true; preview: ExportPreview } | { ok: false; reason: "invalid" | "newer" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks that text is an export this app can read, and sums it up as the
 * server will: live accounts and buckets, cycles, transactions (not their
 * corrections) and schedules.
 */
export function parseExport(text: string): ParsedExport {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isObject(file) || file.app !== "bucky-budgetr" || typeof file.format !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (file.format > EXPORT_FORMAT) return { ok: false, reason: "newer" };
  const data = file.data;
  if (!isObject(data) || !isObject(data.tables)) return { ok: false, reason: "invalid" };
  const tables = data.tables;
  const rows = (name: string): Record<string, unknown>[] => {
    const list = tables[name];
    return Array.isArray(list) ? list.filter(isObject) : [];
  };
  const live = (name: string) => rows(name).filter((r) => r.deleted !== true).length;
  return {
    ok: true,
    preview: {
      userId: typeof file.user_id === "string" ? file.user_id : "",
      username: typeof file.username === "string" ? file.username : "",
      exportedAt: typeof file.exported_at === "string" ? file.exported_at : "",
      accounts: live("bank_accounts"),
      buckets: live("buckets"),
      cycles: rows("cycles").length,
      transactions: rows("transaction_headers").filter((r) => r.parent_id == null).length,
      schedules: rows("schedules").length,
    },
  };
}

/**
 * Replaces all of the user's data with the file's text. Everything cached is
 * then out of date.
 */
export function useImportData() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      unwrap(
        api.POST("/api/v1/me/import", {
          body: text,
          bodySerializer: (b: string) => b,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    onSuccess: () => client.invalidateQueries(),
    meta: { silentError: true },
  });
}
