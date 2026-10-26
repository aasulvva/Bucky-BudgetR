import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Transaction } from "@/api/transactions";
import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser } from "@/test/api";
import { account, bucket, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account" });
const buffer = account({ id: "2345", name: "Buffer account" });
const groceries = bucket({ id: "1000000001", name: "Groceries", source_account_id: main.id });
const active = cycle();

const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const rema = transaction({
  id: "2026102300000001",
  counterparty: "Rema 1000",
  tags: ["food"],
  corrected: true,
  bank_lines: [{ account_id: main.id, amount: "-250.40" }],
  bucket_lines: [{ bucket_id: groceries.id, cycle_id: active.id, amount: "-250.40" }],
});
const salary = transaction({
  id: "2026102300000002",
  type: "INC",
  counterparty: "Employer AS",
  bank_lines: [{ account_id: main.id, amount: "32000.00" }],
});
const transfer = transaction({
  id: "2026102200000003",
  type: "TRF",
  at: yesterday,
  bank_lines: [
    { account_id: main.id, amount: "-2000.00" },
    { account_id: buffer.id, amount: "2000.00" },
  ],
});
const wine = transaction({
  id: "2026102200000004",
  counterparty: "Vinmonopolet",
  at: yesterday,
  reversed: true,
  bank_lines: [],
  before_reversal: { bank_lines: [{ account_id: main.id, amount: "-389.90" }], bucket_lines: [] },
});

function listQueries(): URLSearchParams[] {
  return apiMock.calls("GET /api/v1/transactions").map((r) => r.query);
}

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main, buffer] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries] });
  apiMock.on("GET /api/v1/transactions", {
    body: { items: [rema, salary, transfer, wine], next_cursor: null },
  });
});

describe("Transactions", () => {
  it("lists the active cycle's transactions by day, without system ones", async () => {
    renderRoute("/transactions");
    // The page's first render in a run is the slow one (its filters and date
    // picker), well past the default wait when the whole suite runs at once.
    const row = await screen.findByRole("link", { name: /Rema 1000/ }, { timeout: 5000 });
    expect(row).toHaveTextContent(`Main account · Groceries · food`);
    expect(row).toHaveTextContent(m("-250.40"));
    expect(row).toHaveTextContent("Edited");
    expect(screen.getByRole("link", { name: /Employer AS/ })).toHaveTextContent(
      `+${m("32000.00")}`,
    );
    expect(screen.getByRole("link", { name: /Main account → Buffer account/ })).toHaveTextContent(
      m("2000.00"),
    );
    expect(screen.getByRole("link", { name: /Vinmonopolet/ })).toHaveTextContent("Reversed");
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(3);

    const q = listQueries().at(-1);
    expect(q?.get("cycle_id")).toBe(active.id);
    expect(q?.getAll("type")).toEqual(["INC", "EXP", "TRF", "OPB", "BLA"]);
  });

  it("filters through the URL, as drill-ins do", async () => {
    const { router } = renderRoute("/transactions?account_id=2345");
    await screen.findByRole("link", { name: /Rema 1000/ });
    expect(listQueries().at(-1)?.get("account_id")).toBe("2345");

    await userEvent.click(screen.getByRole("checkbox", { name: "Show refills & adjustments" }));
    await waitFor(() => {
      expect(listQueries().at(-1)?.getAll("type")).toContain("REF");
    });
    expect(router.state.location.search).toContain("system=1");

    await userEvent.click(screen.getByRole("combobox", { name: "Cycle" }));
    await userEvent.click(await screen.findByRole("option", { name: "All cycles" }));
    await waitFor(() => {
      expect(listQueries().at(-1)?.get("cycle_id")).toBeNull();
    });

    await userEvent.type(screen.getByRole("textbox", { name: "Search counterparty" }), "rema");
    await waitFor(() => {
      expect(listQueries().at(-1)?.get("counterparty")).toBe("rema");
    });
    expect(router.state.location.search).toContain("q=rema");
  });

  it("loads more pages", async () => {
    apiMock.on("GET /api/v1/transactions", (req) =>
      req.query.get("cursor") === "next"
        ? { body: { items: [salary], next_cursor: null } }
        : { body: { items: [rema], next_cursor: "next" } },
    );
    renderRoute("/transactions");
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: /Employer AS/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows the detail with lines and history, and reverses after a confirmation", async () => {
    const detail: Transaction = {
      ...rema,
      history: [
        {
          id: rema.id,
          correction_type: "none",
          created_at: rema.created_at,
          created_by: testUser.id,
          bank_lines: [{ account_id: main.id, amount: "-200.00" }],
          bucket_lines: [],
        },
        {
          id: "2026102400000009",
          correction_type: "adjustment",
          created_at: rema.created_at,
          created_by: null,
          bank_lines: [{ account_id: main.id, amount: "-50.40" }],
          bucket_lines: [],
        },
      ],
    };
    apiMock.on(`GET /api/v1/transactions/${rema.id}`, { body: detail });
    apiMock.on(`POST /api/v1/transactions/${rema.id}/reversal`, {
      body: { ...rema, reversed: true, bank_lines: [], bucket_lines: [] },
    });
    const { router } = renderRoute("/transactions");
    await userEvent.click(await screen.findByRole("link", { name: /Rema 1000/ }));
    const panel = within(await screen.findByRole("article", { name: "Rema 1000" }));
    expect(router.state.location.search).toContain(`open=${rema.id}`);
    expect(panel.getByText("Bucket: Groceries")).toBeInTheDocument();
    expect(panel.getByText(/^Recorded .* by you$/)).toBeInTheDocument();
    expect(panel.getByText(/^Corrected .* by the system$/)).toBeInTheDocument();
    expect(panel.getByText(/Bucket amounts can be changed until the cycle/)).toBeInTheDocument();
    expect(panel.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/transactions/${rema.id}/edit`,
    );

    await userEvent.click(panel.getByRole("button", { name: "Reverse" }));
    expect(panel.getByText(/Reverse this transaction\?/)).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Reverse Rema 1000" }));
    expect(await screen.findByText("Transaction reversed.")).toBeInTheDocument();
    expect(apiMock.calls(`POST /api/v1/transactions/${rema.id}/reversal`)).toHaveLength(1);

    await userEvent.click(panel.getByRole("button", { name: "Close" }));
    expect(router.state.location.search).not.toContain("open=");
  });

  it("locks Reverse when the bucket lines are in a finished cycle", async () => {
    const old = {
      ...rema,
      at: "2026-01-15T12:00:00Z",
      bucket_lines: [{ bucket_id: groceries.id, cycle_id: "100000000999", amount: "-250.40" }],
    };
    apiMock.on(`GET /api/v1/transactions/${rema.id}`, { body: { ...old, history: [] } });
    renderRoute(`/transactions?open=${rema.id}&cycle_id=all`);
    const panel = within(await screen.findByRole("article", { name: "Rema 1000" }));
    expect(panel.getByRole("button", { name: "Reverse" })).toBeDisabled();
    expect(panel.getByRole("link", { name: "Edit" })).toBeInTheDocument();
    expect(panel.getByText(/in a cycle that has ended/)).toBeInTheDocument();
  });

  it("shows why system transactions can't change", async () => {
    const refill = transaction({
      id: "2026102300000005",
      type: "REF",
      bank_lines: [],
      bucket_lines: [{ bucket_id: groceries.id, cycle_id: active.id, amount: "4000.00" }],
    });
    apiMock.on(`GET /api/v1/transactions/${refill.id}`, { body: { ...refill, history: [] } });
    renderRoute(`/transactions?open=${refill.id}`);
    const panel = within(await screen.findByRole("article", { name: "Refill" }));
    expect(panel.getByText(/can't be corrected or reversed here/)).toBeInTheDocument();
    expect(panel.queryByRole("button", { name: "Reverse" })).not.toBeInTheDocument();
  });

  it("offers to widen an empty list", async () => {
    apiMock.on("GET /api/v1/transactions", { body: { items: [], next_cursor: null } });
    const { router } = renderRoute("/transactions?tag=food");
    await userEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Show every cycle" }));
    await waitFor(() => {
      expect(listQueries().at(-1)?.get("cycle_id")).toBeNull();
    });
  });

  it("uses chips and a filter dialog on mobile, with the detail full screen", async () => {
    viewport.width = 390;
    apiMock.on(`GET /api/v1/transactions/${rema.id}`, { body: { ...rema, history: [] } });
    renderRoute("/transactions?account_id=1234");
    await screen.findByRole("link", { name: /Rema 1000/ });
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Main account" }));
    await waitFor(() => {
      expect(listQueries().at(-1)?.get("account_id")).toBeNull();
    });
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Filters" }));
    expect(dialog.getByRole("combobox", { name: "Bucket" })).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Show transactions" }));

    await userEvent.click(screen.getByRole("link", { name: /Rema 1000/ }));
    expect(await screen.findByRole("dialog", { name: "Transaction" })).toBeInTheDocument();
  });

  it("explains an error loading the detail", async () => {
    apiMock.on(`GET /api/v1/transactions/${rema.id}`, problem(404, "not_found", "Not found."));
    renderRoute(`/transactions?open=${rema.id}`);
    expect(
      await screen.findByText("It doesn't exist, or it has been deleted."),
    ).toBeInTheDocument();
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", { body: { ...testUser, preferences: { language: "nn" } } });
    renderRoute("/transactions");
    expect(await screen.findByRole("link", { name: /Rema 1000/ })).toHaveTextContent("Endra");
    expect(screen.getByRole("checkbox", { name: "Vis påfyll og justeringar" })).toBeInTheDocument();
  });
});
