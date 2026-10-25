// A fake backend for tests. test/setup.ts installs fakeFetch as the global
// fetch before the API client is created (openapi-fetch keeps the fetch it
// finds then). By default it answers as a logged-in normal user; tests change
// that with apiMock.on().

import type { components } from "@/api/schema";

type User = components["schemas"]["User"];

export interface MockResponse {
  status?: number;
  body?: unknown;
}

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
}

type Handler = MockResponse | ((req: MockRequest) => MockResponse);

export const testUser: User = {
  id: "00000000-0000-0000-0000-000000000001",
  username: "kari",
  admin: false,
  must_change_password: false,
  preferences: {},
};

/** A problem details response, as the API sends it. */
export function problem(status: number, code: string, detail: string): MockResponse {
  return { status, body: { type: "about:blank", title: detail, status, code, detail } };
}

function defaults(): Map<string, Handler> {
  return new Map<string, Handler>([
    ["GET /api/v1/me", { body: testUser }],
    ["GET /readyz", { body: { status: "ok" } }],
    ["POST /api/v1/auth/logout", { status: 204 }],
    ["GET /api/v1/accounts", { body: [] }],
    ["GET /api/v1/buckets", { body: [] }],
  ]);
}

let handlers = defaults();

export const apiMock = {
  /** Every request so far, in order. */
  requests: [] as MockRequest[],

  /** Answers "METHOD /path" with a response, or with what a function returns. */
  on(route: string, handler: Handler) {
    handlers.set(route, handler);
  },

  /** The requests to a route, e.g. "PATCH /api/v1/me/preferences". */
  calls(route: string): MockRequest[] {
    return this.requests.filter((r) => `${r.method} ${r.path}` === route);
  },

  reset() {
    handlers = defaults();
    this.requests = [];
  },
};

export async function fakeFetch(input: Request): Promise<Response> {
  const text = await input.text();
  const req: MockRequest = {
    method: input.method,
    path: new URL(input.url).pathname,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  };
  apiMock.requests.push(req);
  const handler = handlers.get(`${req.method} ${req.path}`);
  const res =
    typeof handler === "function"
      ? handler(req)
      : (handler ?? problem(404, "not_found", `No fake for ${req.method} ${req.path}.`));
  const status = res.status ?? 200;
  return new Response(status === 204 ? null : JSON.stringify(res.body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
}
