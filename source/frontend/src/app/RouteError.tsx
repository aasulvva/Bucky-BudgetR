import { isRouteErrorResponse, useRouteError } from "react-router";

import { ErrorAlert } from "@/components/ErrorAlert";
import NotFound from "@/pages/NotFound";

/** Shown in the layout when a route fails to load or render. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <ErrorAlert
      error={error}
      onRetry={() => {
        window.location.reload();
      }}
    />
  );
}
