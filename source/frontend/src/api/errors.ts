import type { components } from "./schema";

/** RFC 9457 problem details, the body of every API error. */
export type Problem = components["schemas"]["Problem"];

/** An API call that failed. Carries the server's problem details. */
export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }

  /** HTTP status, or 0 when the server could not be reached. */
  get status(): number {
    return this.problem.status;
  }

  get code(): string | undefined {
    return this.problem.code;
  }
}

interface FetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** The data type of the success branch of an openapi-fetch result. */
type SuccessData<R> = R extends { data: infer D; error?: never } ? D : never;

/** Awaits an openapi-fetch call and returns its data, or throws an ApiError. */
export async function unwrap<R extends FetchResult>(request: Promise<R>): Promise<SuccessData<R>> {
  let result: R;
  try {
    result = await request;
  } catch (err) {
    throw new ApiError({
      type: "about:blank",
      title: "Network error",
      status: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : "Could not reach the server.",
    });
  }
  if (result.error !== undefined || !result.response.ok) {
    throw new ApiError(toProblem(result.error, result.response));
  }
  return result.data as SuccessData<R>;
}

function toProblem(body: unknown, response: Response): Problem {
  if (isProblem(body)) return body;
  // Not from our API, e.g. the dev proxy failing to reach the backend.
  return {
    type: "about:blank",
    title: response.statusText || `HTTP ${response.status}`,
    status: response.status,
    code: "http_error",
    ...(typeof body === "string" && body !== "" ? { detail: body.slice(0, 200) } : {}),
  };
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Problem).status === "number" &&
    typeof (value as Problem).title === "string"
  );
}

/** What to show the user for any error: a title, an optional detail and request ID. */
export function describeError(error: unknown): {
  title: string;
  detail?: string;
  requestId?: string;
} {
  if (error instanceof ApiError) {
    const { title, detail, request_id } = error.problem;
    return { title, detail, requestId: request_id };
  }
  if (error instanceof Error) return { title: "Something went wrong", detail: error.message };
  return { title: "Something went wrong" };
}
