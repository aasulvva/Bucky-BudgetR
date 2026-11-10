import { Button, Loader } from "@mantine/core";
import { IconFileTypePdf } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Cycle } from "@/api/cycles";
import { exportReportPdf, pdfFileName, reportPdfRequest } from "@/api/reports";
import { reportPeriods, type ReportSettings } from "@/lib/reports";

/**
 * Export PDF (#127): the server prints the report on screen, as it is now,
 * to a PDF that downloads as "<name> – <period>.pdf". A failure shows the
 * usual error notification.
 */
export function ExportPdfButton({
  name,
  report,
  cycles,
}: {
  name: string;
  report: ReportSettings;
  cycles: Cycle[];
}) {
  const { t } = useTranslation();
  const { period, name: periodName } = reportPeriods(report, cycles);
  const pdf = useMutation({
    mutationFn: () =>
      exportReportPdf(reportPdfRequest(name, report), pdfFileName(name, periodName)),
  });
  return (
    <Button
      variant="default"
      // Not `loading`, which hides the label: it says what's happening.
      leftSection={pdf.isPending ? <Loader size={14} /> : <IconFileTypePdf size={16} />}
      disabled={pdf.isPending || period === null || report.modules.length === 0}
      onClick={() => {
        pdf.mutate();
      }}
    >
      {pdf.isPending ? t("stats.reports.pdf.exporting") : t("stats.reports.pdf.export")}
    </Button>
  );
}
