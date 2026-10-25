import { Center, Loader } from "@mantine/core";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ErrorAlert } from "./ErrorAlert";

interface QueryStateProps<T> {
  query: UseQueryResult<T>;
  /** Rendered once the data is there. */
  children: (data: T) => ReactNode;
  /** Shown while loading; defaults to a spinner. */
  loading?: ReactNode;
}

/** The standard loading and error handling for a query. */
export function QueryState<T>({ query, children, loading }: QueryStateProps<T>) {
  if (query.isPending) {
    return (
      loading ?? (
        <Center py="xl">
          <Loader size="sm" />
        </Center>
      )
    );
  }
  if (query.isError) {
    return <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />;
  }
  return children(query.data);
}
