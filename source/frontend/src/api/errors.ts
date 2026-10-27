import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";

import type { components } from "./schema";

/** RFC 9457 problem details, the body of every API error. */
export type Problem = components["schemas"]["Problem"];

/** An API call that failed. Carries the server's problem details. */
export class ApiError extends Error {
  readonly problem: Problem;
  /** Seconds to wait before trying again, from a Retry-After header. */
  readonly retryAfter?: number;

  constructor(problem: Problem, retryAfter?: number) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
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
    const retryAfter = Number(result.response.headers.get("Retry-After") ?? NaN);
    throw new ApiError(
      toProblem(result.error, result.response),
      Number.isInteger(retryAfter) ? retryAfter : undefined,
    );
  }
  return result.data as SuccessData<R>;
}

/** The problem details of a failed response, made up if the body has none. */
export function toProblem(body: unknown, response: Response): Problem {
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

type ErrorCode = keyof typeof en.errors.codes;
type ErrorStatus = keyof typeof en.errors.status;

const isErrorCode = (code: string): code is ErrorCode => Object.hasOwn(en.errors.codes, code);
const isErrorStatus = (status: string): status is ErrorStatus =>
  Object.hasOwn(en.errors.status, status);

/**
 * The error's message in the user's language, by its code. Undefined for a
 * code without a translation: the server's detail (in English) then says it.
 */
export function errorMessage(error: ApiError): string | undefined {
  const { code } = error;
  if (code === "network_error") return i18n.t("errors.networkDetail");
  if (code === "too_many_attempts" && error.retryAfter !== undefined) {
    return i18n.t("errors.tooManyAttempts", { count: error.retryAfter });
  }
  return code && isErrorCode(code) ? i18n.t(`errors.codes.${code}`) : undefined;
}

/** What to show the user for any error: a title, an optional detail and request ID. */
export function describeError(error: unknown): {
  title: string;
  detail?: string;
  requestId?: string;
} {
  if (error instanceof ApiError) {
    const { status, detail, request_id } = error.problem;
    const key = String(status);
    const title =
      status === 0
        ? i18n.t("errors.network")
        : isErrorStatus(key)
          ? i18n.t(`errors.status.${key}`)
          : i18n.t("errors.generic");
    return { title, detail: errorMessage(error) ?? detail, requestId: request_id };
  }
  if (error instanceof Error) return { title: i18n.t("errors.generic"), detail: error.message };
  return { title: i18n.t("errors.generic") };
}
