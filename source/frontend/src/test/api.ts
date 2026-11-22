// A fake backend for tests. test/setup.ts installs fakeFetch as the global
// fetch before the API client is created (openapi-fetch keeps the fetch it
// finds then). By default it answers as a logged-in normal user; tests change
// that with apiMock.on().

import type { components } from "@/api/schema";
import { APP_VERSION } from "@/lib/changelog";

import { cycle } from "./fixtures";

type User = components["schemas"]["User"];

export interface MockResponse {
  status?: number;
  body?: unknown;
}

export interface MockRequest {
  method: string;
  path: string;
  /** The query string; routes match on method and path only. */
  query: URLSearchParams;
  body: unknown;
}

// A function may answer later, to test what shows while a request loads.
type Handler = MockResponse | ((req: MockRequest) => MockResponse | Promise<MockResponse>);

export const testUser: User = {
  id: "00000000-0000-0000-0000-000000000001",
  username: "kari",
  admin: false,
  must_change_password: false,
  // Set, so the guard doesn't set it (vite.config.ts runs tests there).
  // What's New already seen, so it doesn't pop up over the screens.
  preferences: { time_zone: "America/Los_Angeles", whats_new_seen: APP_VERSION },
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
    ["GET /api/v1/cycles", { body: [cycle()] }],
    ["GET /api/v1/cycles/active", { body: { active: cycle(), next: null } }],
    ["GET /api/v1/buckets", { body: [] }],
    ["GET /api/v1/cycles/100001000001/bucket-figures", { body: [] }],
    ["GET /api/v1/tags", { body: [] }],
    ["GET /api/v1/counterparties", { body: [] }],
    ["GET /api/v1/transactions", { body: { items: [], next_cursor: null } }],
    ["GET /api/v1/savings/targets", { body: [] }],
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
  const url = new URL(input.url);
  const req: MockRequest = {
    method: input.method,
    path: url.pathname,
    query: url.searchParams,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  };
  apiMock.requests.push(req);
  const handler = handlers.get(`${req.method} ${req.path}`);
  const res =
    typeof handler === "function"
      ? await handler(req)
      : (handler ?? problem(404, "not_found", `No fake for ${req.method} ${req.path}.`));
  const status = res.status ?? 200;
  return new Response(status === 204 ? null : JSON.stringify(res.body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
}
