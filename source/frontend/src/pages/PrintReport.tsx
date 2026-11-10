import { Box, Center, Group, List, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { useCycles, type Cycle } from "@/api/cycles";
import { useSession, type User } from "@/app/session";
import { ModuleCard } from "@/components/reports/ModuleCard";
import { formatDateRange } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { applyLanguage } from "@/lib/language";
import { setLocale } from "@/lib/locale";
import { parseJob, PRINT_WIDTH, PrintMode, usePrintReady, type PrintJob } from "@/lib/print";
import { moduleTitle, reportPeriods } from "@/lib/reports";

import "./PrintReport.css";

/**
 * The page a report PDF prints (#127), outside the app's shell. The server's
 * headless Chrome opens it with the job in the fragment and a render token,
 * waits for data-print-ready (or data-print-error) and prints it: a cover,
 * then the modules, in the asking browser's language and locale, light.
 */
export default function PrintReport() {
  const { hash } = useLocation();
  const job = useMemo(() => parseJob(hash), [hash]);
  if (job) {
    // Before anything formats a number or a date. The time zone is Chrome's.
    setLocale(job.locale);
    applyLanguage(job.language);
  }
  useEffect(() => {
    document.documentElement.setAttribute("data-mantine-color-scheme", "light");
  }, []);
  const { t } = useTranslation();
  const session = useSession();
  const cycles = useCycles();
  const accounts = useAccounts();
  const buckets = useBuckets();

  if (!job) {
    return (
      <Box p="md" data-print-error>
        <Text>{t("stats.reports.pdf.nothing")}</Text>
      </Box>
    );
  }
  const failed = session.isError || cycles.isError || accounts.isError || buckets.isError;
  if (failed || session.data === null) {
    return (
      <Box p="md" data-print-error>
        <Text>{t("errors.generic")}</Text>
      </Box>
    );
  }
  if (!session.data || !cycles.data || !accounts.data || !buckets.data) {
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  }
  return (
    <PrintMode.Provider value={true}>
      <Printed
        job={job}
        user={session.data}
        cycles={cycles.data}
        accounts={accounts.data}
        buckets={buckets.data}
      />
    </PrintMode.Provider>
  );
}

function Printed({
  job,
  user,
  cycles,
  accounts,
  buckets,
}: {
  job: PrintJob;
  user: User;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { report } = job;
  // Resolved once: a period that's still going ends now, and a new "now" on
  // every render would be new queries on every render.
  const periods = useMemo(() => reportPeriods(report, cycles), [report, cycles]);
  const { choice, period, compare } = periods;
  return (
    <Box className="print-report" w={PRINT_WIDTH}>
      <ReadyMark />
      <Cover job={job} user={user} periods={periods} accounts={accounts} buckets={buckets} />
      <Stack gap="md">
        {report.modules.map((m, i) => (
          <ModuleCard
            key={m.id}
            report={report}
            module={m}
            index={i}
            count={report.modules.length}
            choice={choice}
            period={period}
            compare={compare}
            cycles={cycles}
            accounts={accounts}
            buckets={buckets}
            isDesktop
            onEdit={noop}
            onMove={noop}
            onRemove={noop}
          />
        ))}
      </Stack>
    </Box>
  );
}

const noop = () => undefined;

/**
 * Says when the page is ready to print, or failed. On its own, so the
 * report doesn't render again whenever a query starts or ends.
 */
function ReadyMark() {
  const ready = usePrintReady();
  return (
    <span
      hidden
      data-print-ready={ready === "ready" || undefined}
      data-print-error={ready === "error" || undefined}
    />
  );
}

/** The first page: what the report is, for whom and when. */
function Cover({
  job,
  user,
  periods,
  accounts,
  buckets,
}: {
  job: PrintJob;
  user: User;
  periods: ReturnType<typeof reportPeriods>;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const { report } = job;
  const { period, label, name, compare } = periods;
  const range = period ? formatDateRange(period.from, period.to) : "";
  // "Previous month · October 2026 (1–31 Oct 2026)", without repeats.
  const periodText =
    [...new Set([label, name])].join(" · ") + (range && range !== name ? ` (${range})` : "");
  const named = (ids: string[] | undefined, list: { id: string; name: string }[]) =>
    (ids ?? []).map((id) => list.find((x) => x.id === id)?.name ?? id).join(", ");
  const filters = [
    { label: t("stats.graphs.accounts"), value: named(report.account_ids, accounts) },
    { label: t("stats.graphs.buckets"), value: named(report.bucket_ids, buckets) },
    { label: t("stats.graphs.tags"), value: (report.tags ?? []).join(", ") },
    { label: t("stats.graphs.counterparty"), value: report.counterparty?.trim() ?? "" },
  ].filter((f) => f.value !== "");
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: t("stats.reports.pdf.cover.period"),
      value: periodText,
    },
    ...(compare && report.modules.some((m) => m.type === "graph" && (m.compare ?? "off") !== "off")
      ? [
          {
            label: t("stats.reports.pdf.cover.comparedWith"),
            value: `${compare.label} (${formatDateRange(compare.period.from, compare.period.to)})`,
          },
        ]
      : []),
    {
      label: t("stats.reports.pdf.cover.filters"),
      value:
        filters.length === 0 ? (
          t("stats.reports.pdf.cover.noFilters")
        ) : (
          <Stack gap={2}>
            {filters.map((f) => (
              <Text key={f.label} size="sm">
                {f.label}: {f.value}
              </Text>
            ))}
          </Stack>
        ),
    },
    {
      label: t("stats.reports.pdf.cover.modules"),
      value: (
        <List type="ordered" size="sm" spacing={2}>
          {report.modules.map((m) => (
            <List.Item key={m.id}>{moduleTitle(m)}</List.Item>
          ))}
        </List>
      ),
    },
    { label: t("stats.reports.pdf.cover.user"), value: user.username },
    { label: t("stats.reports.pdf.cover.generated"), value: formatDateTime(job.generated_at) },
  ];
  return (
    <Stack className="print-cover" gap="lg" pt={64} data-testid="print-cover">
      <Stack gap={4}>
        <Group gap="xs">
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>
            {t("stats.reports.pdf.cover.title")}
          </Text>
        </Group>
        <Title order={1}>{job.name}</Title>
      </Stack>
      <Table variant="vertical" layout="fixed" withTableBorder={false} verticalSpacing="sm">
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.label}>
              <Table.Th scope="row" w={160} style={{ verticalAlign: "top" }}>
                {r.label}
              </Table.Th>
              <Table.Td>{r.value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
