import { notifications } from "@mantine/notifications";
import { MutationCache, QueryClient } from "@tanstack/react-query";

import { ApiError, describeError } from "./errors";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** Don't show the default error notification; the caller handles it. */
      silentError?: boolean;
    };
  }
}

/**
 * Query defaults:
 * - Queries retry up to twice, but never on 4xx (retrying won't help).
 * - Failed mutations show an error notification unless meta.silentError is set.
 * Query errors are shown in place, with <QueryState>.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) => {
        if (mutation.meta?.silentError) return;
        const { title, detail, requestId } = describeError(error);
        notifications.show({
          color: "red",
          title,
          message: [detail, requestId && `Request ID: ${requestId}`].filter(Boolean).join(" · "),
        });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          failureCount < 2 &&
          !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}
