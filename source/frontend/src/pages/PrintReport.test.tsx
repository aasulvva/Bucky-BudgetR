import { screen, waitFor, within } from "@testing-library/react";

import { startAtFor } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { setLocale } from "@/lib/locale";
import type { PrintJob } from "@/lib/print";
import { apiMock, problem, type MockRequest } from "@/test/api";
import { account, bucket, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";

const main = account({ id: "1234", name: "Main" });
const food = bucket({ id: "1000000001", name: "Food", source_account_id: "1234" });
const year = new Date().getFullYear();
const stats = "GET /api/v1/stats/series";
const list = "GET /api/v1/transactions";

function answer(req: MockRequest) {
  return {
    body: {
      intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
      series: [{ currency: "NOK", values: ["120.00"] }],
    },
  };
}

/** The fragment, as the server makes it: base64url JSON without padding. */
function fragment(job: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(job));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const job = (over: Partial<PrintJob> = {}): PrintJob => ({
  name: "Året – food",
  report: {
    period: "previous-year",
    account_ids: ["1234"],
    tags: ["food"],
    modules: [
      {
        id: "m-1",
        type: "graph",
        title: "Spending",
        compare: "difference",
        graph: { kind: "bar", metric: "spending", resolution: "month" },
      },
      { id: "m-2", type: "transactions", transactions: {} },
    ],
  },
  language: "en",
  locale: "en-GB",
  time_zone: "Europe/Oslo",
  generated_at: "2026-11-10T08:30:00Z",
  ...over,
});

const ready = () => document.querySelector("[data-print-ready]");
const failed = () => document.querySelector("[data-print-error]");

beforeEach(() => {
  apiMock.on("GET /api/v1/accounts", { body: [main] });
  apiMock.on("GET /api/v1/buckets", { body: [food] });
  apiMock.on(stats, answer);
  apiMock.on(list, (req) =>
    req.query.get("cursor")
      ? { body: { items: [transaction({ id: "t2", counterparty: "Kiwi" })], next_cursor: null } }
      : {
          body: {
            items: [transaction({ id: "t1", counterparty: "Rema 1000" })],
            next_cursor: "c1",
          },
        },
  );
});

afterEach(() => {
  setLocale(undefined);
});

describe("PrintReport", () => {
  it("prints a cover and every module, with all transactions, then says it's ready", async () => {
    renderRoute(`/print/report#${fragment(job())}`);

    const cover = await screen.findByTestId("print-cover");
    expect(within(cover).getByRole("heading", { name: "Året – food" })).toBeInTheDocument();
    const row = (label: string) =>
      within(cover).getByRole("rowheader", { name: label }).nextElementSibling?.textContent;
    expect(row("Period")).toContain(String(year - 1));
    expect(row("Compared with")).toContain(String(year - 2));
    expect(row("Filters")).toBe("Accounts: MainTags: food");
    expect(row("User")).toBe("kari");
    expect(row("Generated")).toBe(formatDateTime("2026-11-10T08:30:00Z", "en-GB"));
    expect(
      within(cover)
        .getAllByRole("listitem")
        .map((x) => x.textContent),
    ).toEqual(["Spending", "Transactions"]);

    // Both pages of transactions, without a click; no buttons or links.
    const module = await screen.findByRole("region", { name: "Transactions" });
    expect(await within(module).findByText("Kiwi")).toBeInTheDocument();
    expect(within(module).getByText("Rema 1000")).toBeInTheDocument();
    expect(apiMock.calls(list).at(-1)?.query.get("cursor")).toBe("c1");
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(apiMock.calls(stats).map((c) => c.query.get("from"))).toContain(
      startAtFor(`${String(year - 2)}-01-01`),
    );

    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
    expect(failed()).toBeNull();
  });

  it("doesn't loop on a period that's still going", async () => {
    renderRoute(
      `/print/report#${fragment(job({ report: { period: "current-year", modules: [{ id: "m-2", type: "transactions", transactions: {} }] } }))}`,
    );
    expect(await screen.findByText("Kiwi")).toBeInTheDocument();
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
  });

  it("prints a table module with every page and no links (#185)", async () => {
    renderRoute(
      `/print/report#${fragment(job({ report: { period: "previous-year", modules: [{ id: "m-2", type: "transactions", transactions: { view: "table" } }] } }))}`,
    );
    const table = await screen.findByRole("table", { name: "Transactions" });
    expect(await within(table).findByText("Kiwi")).toBeInTheDocument();
    expect(within(table).getByText("Rema 1000")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toEqual([]);
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
  });

  it("uses the job's language and locale", async () => {
    renderRoute(`/print/report#${fragment(job({ language: "nb", locale: "nb-NO" }))}`);
    const cover = await screen.findByTestId("print-cover");
    expect(within(cover).getByRole("rowheader", { name: "Moduler" })).toBeInTheDocument();
    expect(
      within(cover).getByRole("rowheader", { name: "Generert" }).nextElementSibling,
    ).toHaveTextContent(formatDateTime("2026-11-10T08:30:00Z", "nb-NO"));
    expect(document.documentElement.lang).toBe("nb");
  });

  it("says it failed when a module's data doesn't load", async () => {
    apiMock.on(stats, problem(500, "internal_error", "Boom."));
    renderRoute(`/print/report#${fragment(job())}`);
    await waitFor(() => {
      expect(failed()).not.toBeNull();
    });
    expect(ready()).toBeNull();
  });

  it("says it failed without a job", async () => {
    renderRoute("/print/report#not-a-job");
    await waitFor(() => {
      expect(failed()).not.toBeNull();
    });
  });

  it("says it failed without a session", async () => {
    apiMock.on("GET /api/v1/me", problem(401, "unauthenticated", "Log in."));
    renderRoute(`/print/report#${fragment(job())}`);
    await waitFor(() => {
      expect(failed()).not.toBeNull();
    });
  });
});
