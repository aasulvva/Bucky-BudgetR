import i18n from "@/i18n";

import { ApiError, describeError, unwrap } from "./errors";

const res = (status: number, statusText = "", headers?: HeadersInit) =>
  new Response(null, { status, statusText, ...(headers ? { headers } : {}) });

const apiError = (status: number, code: string, detail?: string) =>
  new ApiError({
    type: "about:blank",
    title: "From the server",
    status,
    code,
    ...(detail ? { detail } : {}),
  });

describe("unwrap", () => {
  it("returns the data of a successful call", async () => {
    await expect(
      unwrap(Promise.resolve({ data: { status: "ok" }, response: res(200) })),
    ).resolves.toEqual({
      status: "ok",
    });
  });

  it("throws the problem of a failed call", async () => {
    const problem = {
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      code: "database_unavailable",
      request_id: "abc",
    };
    const err = await unwrap(Promise.resolve({ error: problem, response: res(503) })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).problem).toEqual(problem);
    expect(describeError(err)).toEqual({
      title: "Service unavailable",
      detail: "The database is not reachable.",
      requestId: "abc",
    });
  });

  it("wraps responses that aren't problems", async () => {
    const err = await unwrap(
      Promise.resolve({ error: "proxy error", response: res(502, "Bad Gateway") }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 502,
      code: "http_error",
      problem: { title: "Bad Gateway", detail: "proxy error" },
    });
  });

  it("turns network failures into status 0", async () => {
    const err = await unwrap(Promise.reject(new TypeError("Failed to fetch"))).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 0, code: "network_error", message: "Failed to fetch" });
    expect(describeError(err)).toEqual({
      title: "Network error",
      detail: "Could not reach the server.",
      requestId: undefined,
    });
  });

  it("reads Retry-After", async () => {
    const problem = { type: "about:blank", title: "Too Many Requests", status: 429 };
    const err = await unwrap(
      Promise.resolve({ error: problem, response: res(429, "", { "Retry-After": "30" }) }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryAfter: 30 });
  });
});

describe("describeError", () => {
  afterEach(() => i18n.changeLanguage("en"));

  it("translates the message by its code, in the user's language", async () => {
    const err = apiError(409, "cycle_overlap", "The cycle would overlap another cycle.");
    expect(describeError(err)).toMatchObject({
      title: "Conflict",
      detail: "The cycle would overlap another cycle.",
    });
    await i18n.changeLanguage("nn");
    expect(describeError(err)).toMatchObject({
      title: "Konflikt",
      detail: "Perioden ville overlappa ein annan periode.",
    });
  });

  it("falls back to the server's detail and a generic title", async () => {
    await i18n.changeLanguage("nb");
    expect(describeError(apiError(418, "teapot", "Short and stout."))).toMatchObject({
      title: "Noe gikk galt",
      detail: "Short and stout.",
    });
  });

  it("puts the wait into a too-many-attempts message", () => {
    const err = new ApiError(
      { type: "about:blank", title: "", status: 429, code: "too_many_attempts" },
      1,
    );
    expect(describeError(err).detail).toBe("Too many failed attempts. Try again in 1 second.");
  });
});
