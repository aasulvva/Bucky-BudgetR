// Print mode (#127): the report PDF's page renders the report's modules as
// paper wants them. Without controls or links, every transaction loaded,
// charts drawn at once (no animation) and at the page's width.

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";

import type { Language } from "./language";
import type { ReportSettings } from "./reports";

export const PrintMode = createContext(false);

/** Whether the module renders for a PDF. */
export function usePrintMode(): boolean {
  return useContext(PrintMode);
}

/** The page's printable width in CSS pixels: A4, 210 mm, less 12 mm margins (internal/pdf). */
export const PRINT_WIDTH = 703;

/** What the server puts in the page's fragment (httpapi.printJob). */
export interface PrintJob {
  name: string;
  report: ReportSettings;
  language: Language;
  locale: string;
  time_zone: string;
  generated_at: string;
}

/** The job in a fragment: base64url JSON, without padding. Null if it isn't one. */
export function parseJob(hash: string): PrintJob | null {
  try {
    const b64 = hash.replace(/^#/, "").replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const job = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PrintJob> | null;
    if (
      typeof job?.name !== "string" ||
      typeof job.report?.period !== "string" ||
      !Array.isArray(job.report.modules) ||
      !["en", "nb", "nn"].includes(job.language ?? "") ||
      typeof job.locale !== "string" ||
      typeof job.generated_at !== "string"
    ) {
      return null;
    }
    return job as PrintJob;
  } catch {
    return null;
  }
}

/** How long nothing may fetch before the page counts as drawn. */
const SETTLE_MS = 300;

/**
 * Whether the page is ready to print: nothing has fetched for SETTLE_MS and
 * the fonts are in, or a query failed.
 */
export function usePrintReady(): "waiting" | "ready" | "error" {
  const client = useQueryClient();
  const fetching = useIsFetching();
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");
  useEffect(() => {
    if (state !== "waiting" || fetching > 0) return;
    let live = true;
    const id = setTimeout(() => {
      const failed = client
        .getQueryCache()
        .getAll()
        .some((q) => q.state.status === "error");
      if (failed) {
        setState("error");
        return;
      }
      const fonts = "fonts" in document ? document.fonts.ready : Promise.resolve();
      void fonts.then(() => {
        if (live) setState("ready");
      });
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [state, fetching, client]);
  return state;
}
