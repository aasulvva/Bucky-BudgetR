// Transactions: creating them, and the suggestions the Create transaction
// screen autocompletes from.

import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "./client";
import { unwrap } from "./errors";
import type { components } from "./schema";

export type TransactionCreate = components["schemas"]["TransactionCreate"];
export type NewTransactionType = TransactionCreate["type"];
export type CounterpartySuggestion = components["schemas"]["CounterpartySuggestion"];

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
