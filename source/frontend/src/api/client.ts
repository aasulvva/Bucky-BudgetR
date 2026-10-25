import createClient from "openapi-fetch";

import type { paths } from "./schema";

/**
 * Typed client for the REST API, generated from api/openapi.yaml
 * (`make generate`). Wrap calls in unwrap() to get the data or an ApiError:
 *
 *   const status = await unwrap(api.GET("/readyz"));
 */
export const api = createClient<paths>({ baseUrl: window.location.origin });
