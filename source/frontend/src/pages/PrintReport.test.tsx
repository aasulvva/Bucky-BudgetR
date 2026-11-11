import { screen, waitFor, within } from "@testing-library/react";

import { startAtFor } from "@/lib/cycles";
import { formatDateRange } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { specificLabel } from "@/lib/graphs";
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

/** Links into the app: none in a PDF, only the contents' links within it. */
const appLinks = () =>
  screen.queryAllByRole("link").filter((a) => !a.getAttribute("href")?.startsWith("#"));
/** The contents' lines: their text and where they link. */
const contents = () =>
  [...document.querySelectorAll<HTMLAnchorElement>("[data-print-toc] a")].map((a) => [
    a.textContent,
    a.getAttribute("href"),
  ]);
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
    expect(contents()).toEqual([
      ["1. Spending", "#module-m-1"],
      ["2. Transactions", "#module-m-2"],
    ]);

    // Both pages of transactions, without a click; no buttons or links.
    const module = await screen.findByRole("region", { name: "Transactions" });
    expect(await within(module).findByText("Kiwi")).toBeInTheDocument();
    expect(within(module).getByText("Rema 1000")).toBeInTheDocument();
    expect(apiMock.calls(list).at(-1)?.query.get("cursor")).toBe("c1");
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(appLinks()).toEqual([]);
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
    expect(appLinks()).toEqual([]);
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
  });

  it("prints a grid module with no links (#187)", async () => {
    const zero = {
      start: "0.00",
      refills: "0.00",
      income: "0.00",
      opening_funds: "0.00",
      adjustments_in: "0.00",
      adjustments_out: "0.00",
      transfers_in: "0.00",
      transfers_out: "0.00",
      spent: "0.00",
      overflow: "0.00",
      in: "0.00",
      out: "0.00",
      end: "0.00",
    };
    apiMock.on("GET /api/v1/stats/flows", (req) => ({
      body: {
        intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
        buckets: [
          {
            bucket_id: "1000000001",
            account_id: "1234",
            currency: "NOK",
            values: [{ ...zero, refills: "500.00", in: "500.00", end: "500.00" }],
          },
        ],
        accounts: [],
      },
    }));
    renderRoute(
      `/print/report#${fragment(job({ report: { period: "previous-year", modules: [{ id: "m-3", type: "flows", flows: { view: "grid" } }] } }))}`,
    );
    const card = await screen.findByRole("group", { name: "Food" });
    expect(card.querySelector("[data-change]")?.textContent).toContain("500");
    expect(screen.getByRole("group", { name: "Total" })).toBeInTheDocument();
    expect(appLinks()).toEqual([]);
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
  });

  it("prints a module's sections, each on its own page (#191)", async () => {
    const y = String(year - 1);
    apiMock.on(list, {
      body: {
        items: [
          transaction({ id: "t1", counterparty: "Rema 1000", at: `${y}-03-10T10:00:00Z` }),
          transaction({ id: "t2", counterparty: "Kiwi", at: `${y}-01-10T10:00:00Z` }),
        ],
        next_cursor: null,
      },
    });
    renderRoute(
      `/print/report#${fragment(job({ report: { period: "previous-year", modules: [{ id: "m-2", type: "transactions", transactions: { sections: "month" } }] } }))}`,
    );
    expect(await screen.findByText("Kiwi")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-transactions-section]")).toHaveLength(12);
    expect(screen.getAllByText("No transactions")).toHaveLength(10);
    expect(appLinks()).toEqual([]);
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
  });

  it("numbers the contents once the server sends the pages (#193)", async () => {
    const y = String(year - 1);
    apiMock.on(list, {
      body: {
        items: [transaction({ id: "t1", counterparty: "Rema 1000", at: `${y}-03-10T10:00:00Z` })],
        next_cursor: null,
      },
    });
    const month = (m: string) =>
      specificLabel({ kind: "specific", unit: "month", at: `${y}-${m}-01` }, []);
    renderRoute(
      `/print/report#${fragment(
        job({
          report: {
            period: "previous-year",
            modules: [
              {
                id: "m-1",
                type: "graph",
                title: "Spending",
                graph: { kind: "bar", metric: "spending", resolution: "month" },
              },
              { id: "m-2", type: "transactions", transactions: { sections: "month" } },
            ],
          },
        }),
      )}`,
    );
    await waitFor(() => {
      expect(ready()).not.toBeNull();
    });
    // Each module, and the sectioned one's months, newest first, linked to them.
    const lines = contents();
    expect(lines.slice(0, 4)).toEqual([
      ["1. Spending", "#module-m-1"],
      ["2. Transactions", "#module-m-2"],
      [month("12"), `#module-m-2-${y}-12-01`],
      [month("11"), `#module-m-2-${y}-11-01`],
    ]);
    expect(lines).toHaveLength(14);
    for (const [, href] of lines) {
      expect(document.getElementById(href?.slice(1) ?? "")).not.toBeNull();
    }
    // The modules' and sections' headings, for the PDF's outline; no others.
    expect(screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "Året – food"],
      ["H2", "Spending"],
      ["H2", "Transactions"],
      ...Array.from({ length: 12 }, (_, i) => ["H3", month(String(12 - i).padStart(2, "0"))]),
    ]);

    const pages = () => [...document.querySelectorAll("[data-toc-page]")].map((x) => x.textContent);
    expect(pages()[0]).toBe("000");
    expect(document.querySelector("[data-print-paged]")).toBeNull();
    // As the outline gives them: the name first, December with a no-break space.
    window.dispatchEvent(
      new CustomEvent("bucky:print-pages", {
        detail: [
          { title: "Året – food", page: 1 },
          { title: "Spending", page: 2 },
          { title: "Transactions", page: 3 },
          { title: month("12").replace(" ", "\u00a0"), page: 3 },
          { title: month("11"), page: 4 },
        ],
      }),
    );
    await waitFor(() => {
      expect(document.querySelector("[data-print-paged]")).not.toBeNull();
    });
    expect(pages().slice(0, 5)).toEqual(["2", "3", "3", "4", "000"]);
  });

  it("uses the job's language and locale", async () => {
    renderRoute(`/print/report#${fragment(job({ language: "nb", locale: "nb-NO" }))}`);
    const cover = await screen.findByTestId("print-cover");
    expect(within(cover).getByRole("rowheader", { name: "Innhold" })).toBeInTheDocument();
    const row = (label: string) =>
      within(cover).getByRole("rowheader", { name: label }).nextElementSibling?.textContent;
    expect(row("Generert")).toBe(formatDateTime("2026-11-10T08:30:00Z", "nb-NO"));
    // The period's and the comparison's dates too (#192).
    const y = (n: number) => String(year - n);
    expect(row("Periode")).toContain(formatDateRange(`${y(1)}-01-01`, `${y(1)}-12-31`, "nb-NO"));
    expect(row("Sammenlignet med")).toContain(
      formatDateRange(`${y(2)}-01-01`, `${y(2)}-12-31`, "nb-NO"),
    );
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
