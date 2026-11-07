// The Stats API (#121): sums of spending or income, or balances, per interval.

import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";

import { browserTimeZone } from "@/lib/cycleRule";
import { getLocale } from "@/lib/locale";
import { weekStart } from "@/lib/periods";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components, operations } from "./schema";

export type StatsSeries = components["schemas"]["StatsSeries"];
export type StatsSeriesLine = components["schemas"]["StatsSeriesLine"];

/**
 * What to sum. The time zone and the week's first day are added: the
 * browser's, which the dates on screen are in.
 */
export type StatsQuery = Omit<
  operations["getStatsSeries"]["parameters"]["query"],
  "time_zone" | "week_start"
>;

/**
 * The series for a query; off without one. Under the transactions key, so
 * money changes refresh it.
 */
export function useStatsSeries(query: StatsQuery | null) {
  const full = query && {
    ...query,
    time_zone: browserTimeZone(),
    week_start: weekStart(getLocale()),
  };
  return useQuery({
    queryKey: ["transactions", "stats", full],
    queryFn: full
      ? () => unwrap(api.GET("/api/v1/stats/series", { params: { query: full } }))
      : skipToken,
    placeholderData: keepPreviousData,
  });
}
