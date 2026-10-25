import createClient, { type Middleware } from "openapi-fetch";

import type { paths } from "./schema";

/**
 * The backend refuses state-changing API requests without this header
 * (CSRF protection; see docs/DEVELOPMENT.md).
 */
export const csrfHeader = "X-Bucky-CSRF";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (!safeMethods.has(request.method.toUpperCase())) {
      request.headers.set(csrfHeader, "1");
    }
    return request;
  },
};

/**
 * Typed client for the REST API, generated from api/openapi.yaml
 * (`make generate`). Wrap calls in unwrap() to get the data or an ApiError:
 *
 *   const status = await unwrap(api.GET("/readyz"));
 *
 * The session cookie is sent automatically (same origin).
 */
export const api = createClient<paths>({ baseUrl: window.location.origin });
api.use(csrfMiddleware);
