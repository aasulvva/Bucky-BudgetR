import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PlannedPurchase } from "@/api/planned";
import { addDays, cycleRange, localDate, startAtFor, today } from "@/lib/cycles";
import { apiMock } from "@/test/api";
import { account, bucket, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

// Ranges and amounts use narrow spaces.
const plain = (s: string | null) => (s ?? "").replace(/\s/g, " ");

/** The calendar's button for a day, as Mantine labels it. */
const dayButton = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const main = account({ id: "1234", name: "Main account" });
const games = bucket({
  id: "1000000001",
  name: "Games",
  source_account_id: main.id,
  current_available_funds: "1000.00",
});
const active = cycle();
const later = cycle({
  id: "100001000002",
  state: "future",
  start_at: active.end_at,
  end_at: startAtFor(addDays(today(), 50)),
});

function plan(overrides: Partial<PlannedPurchase> & Pick<PlannedPurchase, "id">): PlannedPurchase {
  return {
    name: "Game Store",
    account_id: main.id,
    amount: "600.00",
    currency: "NOK",
    expected_at: startAtFor(addDays(today(), 30)),
    note: "Collector's edition",
    status: "open",
    transaction_id: null,
    bucket_lines: [{ bucket_id: games.id, amount: "500.00" }],
    cycle_id: later.id,
    overdue: false,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

const game = plan({ id: "1234561234567890" });
const gift = plan({
  id: "1234561234567891",
  name: "Gift",
  amount: "200.00",
  note: "",
  bucket_lines: [],
  expected_at: startAtFor(addDays(today(), -3)),
  cycle_id: active.id,
  overdue: true,
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main] });
  apiMock.on("GET /api/v1/buckets", { body: [games] });
  apiMock.on("GET /api/v1/cycles", { body: [active, later] });
  apiMock.on("GET /api/v1/planned-purchases", (req) => ({
    body: req.query.get("status") === "closed" ? [] : [gift, game],
  }));
  apiMock.on(`GET /api/v1/planned-purchases/${game.id}`, { body: game });
});

describe("Planned tab (#265)", () => {
  it("lists the open plans with the cycle they're set aside in, and switches by URL", async () => {
    const { router } = renderRoute("/transactions/planned");
    const row = await screen.findByRole("link", { name: "Edit Game Store" }, { timeout: 5000 });
    expect(plain(row.textContent)).toContain(plain(`Set aside in ${cycleRange(later)}`));
    expect(row).toHaveTextContent("From Games");
    expect(row).toHaveTextContent("Main account");
    expect(row).toHaveAttribute("href", `/transactions/planned/${game.id}/edit`);
    const late = screen.getByRole("link", { name: "Edit Gift" });
    expect(late).toHaveTextContent("Overdue");
    expect(plain(late.textContent)).toContain(plain(`Set aside in ${cycleRange(active)}`));
    expect(screen.getByRole("tab", { name: "Planned" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: "Scheduled" }));
    expect(router.state.location.pathname).toBe("/transactions/scheduled");
    await userEvent.click(screen.getByRole("tab", { name: "Planned" }));
    expect(router.state.location.pathname).toBe("/transactions/planned");
  });

  it("shows the charged and cancelled ones when switched, linking a charge", async () => {
    const charged = plan({
      id: "1234561234567892",
      name: "Console",
      status: "charged",
      transaction_id: "123456789012345678",
      cycle_id: null,
    });
    apiMock.on("GET /api/v1/planned-purchases", (req) => ({
      body: req.query.get("status") === "closed" ? [charged] : [],
    }));
    renderRoute("/transactions/planned");
    expect(await screen.findByText("No planned purchases.", {}, { timeout: 5000 })).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show charged and cancelled" }));
    const closed = within(await screen.findByRole("region", { name: "Charged and cancelled" }));
    expect(await closed.findByRole("link", { name: "Charged" })).toHaveAttribute(
      "href",
      "/transactions?open=123456789012345678",
    );
    expect(localStorage.getItem("bucky.plannedShowClosed")).toBe("true");
  });

  it("moves a plan's date", async () => {
    apiMock.on(`PATCH /api/v1/planned-purchases/${game.id}`, { body: game });
    renderRoute("/transactions/planned");
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for Game Store" }, { timeout: 5000 }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move date" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Move Game Store" }));
    const day = `${localDate(game.expected_at).slice(0, 7)}-15`;
    await userEvent.click(dialog.getByRole("button", { name: "Expected day" }));
    await userEvent.click(dialog.getByRole("button", { name: dayButton(day) }));
    await userEvent.click(dialog.getByRole("button", { name: "Move date" }));
    await waitFor(() => {
      expect(apiMock.calls(`PATCH /api/v1/planned-purchases/${game.id}`)).toHaveLength(1);
    });
    expect(apiMock.calls(`PATCH /api/v1/planned-purchases/${game.id}`)[0]?.body).toEqual({
      expected_at: startAtFor(day),
    });
  });

  it("cancels a plan after asking", async () => {
    apiMock.on(`DELETE /api/v1/planned-purchases/${gift.id}`, { status: 204 });
    renderRoute("/transactions/planned");
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for Gift" }, { timeout: 5000 }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel purchase" }));
    expect(screen.getByText(/Its buckets no longer set it aside/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel Gift" }));
    expect(await screen.findByText("Planned purchase cancelled")).toBeInTheDocument();
    expect(apiMock.calls(`DELETE /api/v1/planned-purchases/${gift.id}`)).toHaveLength(1);
  });

  it("makes a plan with its buckets", async () => {
    apiMock.on("POST /api/v1/planned-purchases", { status: 201, body: game });
    const { router } = renderRoute("/transactions/planned/new");
    await userEvent.type(
      await screen.findByRole("textbox", { name: /Name or store/ }, { timeout: 5000 }),
      " Game Store ",
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Expected amount" }), "600");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose an account.")).toBeInTheDocument();
    expect(screen.getByText("Choose the expected day.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/planned-purchases")).toHaveLength(0);

    await userEvent.click(screen.getByRole("combobox", { name: "Charged on" }));
    await userEvent.click(await screen.findByRole("option", { name: "Main account" }));
    const day = `${today().slice(0, 7)}-15`;
    await userEvent.click(screen.getByRole("button", { name: /^Expected day/ }));
    await userEvent.click(await screen.findByRole("button", { name: dayButton(day) }));
    const split = within(screen.getByRole("region", { name: "Buckets" }));
    await userEvent.click(split.getByRole("button", { name: "Add bucket" }));
    await userEvent.clear(split.getByRole("textbox", { name: "Amount for Games" }));
    await userEvent.type(split.getByRole("textbox", { name: "Amount for Games" }), "500");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/planned-purchases")).toHaveLength(1);
    });
    expect(apiMock.calls("POST /api/v1/planned-purchases")[0]?.body).toEqual({
      name: "Game Store",
      account_id: main.id,
      amount: "600.00",
      expected_at: startAtFor(day),
      note: "",
      bucket_lines: [{ bucket_id: games.id, amount: "500.00" }],
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/transactions/planned");
    });
  });

  it("records the charge from a plan, closing it", async () => {
    apiMock.on("POST /api/v1/transactions", { status: 201, body: transaction({ id: "1" }) });
    const { router } = renderRoute(`/transactions/new?planned=${game.id}`);
    expect(
      await screen.findByRole("heading", { name: "Record charge" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/^The charge of Game Store: /)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Type" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and add another" })).not.toBeInTheDocument();
    const split = within(screen.getByRole("region", { name: "Buckets" }));
    expect(split.getByRole("textbox", { name: "Amount for Games" })).toHaveValue("500.00");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(1);
    });
    expect(apiMock.calls("POST /api/v1/transactions")[0]?.body).toMatchObject({
      type: "EXP",
      account_id: main.id,
      amount: "600.00",
      counterparty: "Game Store",
      description: "Collector's edition",
      bucket_lines: [{ bucket_id: games.id, amount: "500.00" }],
      planned_purchase_id: game.id,
    });
    expect(await screen.findByText("Charge recorded, and Game Store closed")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/transactions/planned");
  });
});
