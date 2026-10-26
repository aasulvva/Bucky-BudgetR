// Transactions: creating them, and the suggestions the Create transaction
// screen autocompletes from.

import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components, operations } from "./schema";

export type TransactionCreate = components["schemas"]["TransactionCreate"];
export type NewTransactionType = TransactionCreate["type"];
export type CounterpartySuggestion = components["schemas"]["CounterpartySuggestion"];
export type Transaction = components["schemas"]["Transaction"];
export type TransactionType = components["schemas"]["TransactionType"];
export type TransactionCorrection = components["schemas"]["TransactionCorrection"];
export type TransactionQuery = NonNullable<operations["listTransactions"]["parameters"]["query"]>;

/** Under ["transactions"], so useRefreshMoney() refreshes the suggestions after a save. */
const SUGGESTIONS_KEY = ["transactions", "suggestions"] as const;

/** The user's tags, most recently used first. Suggestions only, so errors stay quiet. */
export function useTags() {
  return useQuery({
    queryKey: [...SUGGESTIONS_KEY, "tags"],
    queryFn: () => unwrap(api.GET("/api/v1/tags", { params: { query: { limit: 100 } } })),
    meta: { silentError: true },
  });
}

/**
 * Earlier counterparties of incomes or expenses that contain what's typed,
 * newest first, with what they used last time. The text is debounced.
 */
export function useCounterparties(type: "INC" | "EXP", q: string) {
  const [debounced] = useDebouncedValue(q.trim(), 200);
  return useQuery({
    queryKey: [...SUGGESTIONS_KEY, "counterparties", type, debounced],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/counterparties", {
          params: { query: { type, ...(debounced ? { q: debounced } : {}) } },
        }),
      ),
    placeholderData: keepPreviousData,
    meta: { silentError: true },
  });
}

/** The transactions matching query, newest first, a page at a time. */
export function useTransactionPages(query: TransactionQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["transactions", "list", query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/transactions", {
          params: { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
  });
}

/** One transaction, merged with its corrections, with its history. */
export function useTransaction(id: string | null) {
  return useQuery({
    queryKey: ["transactions", "detail", id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/transactions/{transactionId}", {
          params: { path: { transactionId: id ?? "" } },
        }),
      ),
    enabled: id !== null,
  });
}
