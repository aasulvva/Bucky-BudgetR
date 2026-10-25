import createClient from "openapi-fetch";

import { csrfHeader, csrfMiddleware } from "./client";
import type { paths } from "./schema";

function clientRecording() {
  const requests: Request[] = [];
  const client = createClient<paths>({
    baseUrl: "http://localhost",
    fetch: (request: Request) => {
      requests.push(request);
      return Promise.resolve(
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
      );
    },
  });
  client.use(csrfMiddleware);
  return { client, requests };
}

describe("csrfMiddleware", () => {
  it("adds the CSRF header to state-changing requests", async () => {
    const { client, requests } = clientRecording();
    await client.POST("/api/v1/auth/logout");
    await client.PATCH("/api/v1/me/preferences", { body: { locale: "nb-NO" } });
    expect(requests.map((r) => r.headers.get(csrfHeader))).toEqual(["1", "1"]);
  });

  it("leaves reads alone", async () => {
    const { client, requests } = clientRecording();
    await client.GET("/api/v1/me");
    expect(requests.map((r) => r.headers.has(csrfHeader))).toEqual([false]);
  });
});
