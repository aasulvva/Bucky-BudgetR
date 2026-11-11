// Report PDFs (#127): the server renders the report on screen with a
// headless Chrome and sends the file back.

import { browserTimeZone } from "@/lib/cycleRule";
import { downloadBlob } from "@/lib/download";
import { formatLocale } from "@/lib/locale";
import { cleanReport, type ReportSettings } from "@/lib/reports";
import i18n from "@/i18n";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type ReportPdfRequest = components["schemas"]["ReportPdfRequest"];

/** The request for the report: in this browser's language, locale and time zone. */
export function reportPdfRequest(name: string, report: ReportSettings): ReportPdfRequest {
  const language = i18n.language;
  return {
    name: name.trim().slice(0, 80),
    report: cleanReport(report),
    language: language === "nb" || language === "nn" ? language : "en",
    // As the screen formats, so the PDF matches it (#192).
    locale: formatLocale(),
    time_zone: browserTimeZone(),
  };
}

/** A file name without the characters file systems refuse. */
export function pdfFileName(...parts: string[]): string {
  const name = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" – ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, "-");
  return `${name || "report"}.pdf`;
}

/** Renders the report to a PDF on the server and downloads it as fileName. */
export async function exportReportPdf(body: ReportPdfRequest, fileName: string): Promise<void> {
  const blob = await unwrap(api.POST("/api/v1/reports/pdf", { body, parseAs: "blob" }));
  downloadBlob(blob, fileName);
}
