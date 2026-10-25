import { ApiError, describeError, unwrap } from "./errors";

const res = (status: number, statusText = "") => new Response(null, { status, statusText });

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
      title: "Service Unavailable",
      detail: undefined,
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
  });
});
