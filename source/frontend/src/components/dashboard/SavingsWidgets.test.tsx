import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock, testUser } from "@/test/api";
import { account, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";

// Mantine's text uses a plain space where Intl gives a narrow no-break one.
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main", balance: "10000.00", unallocated: "4000.00" });
const other = account({ id: "3456", name: "Other", balance: "1000.00" });
const buffer = account({ id: "2345", name: "Buffer", type: "savings", balance: "1500.00" });
const homeAccount = account({ id: "4567", name: "Home", type: "bsu", balance: "120000.00" });

const rainy = savingsTarget({
  id: "1000001001",
  name: "Rainy day",
  current: "1500.00",
  goal: "10000.00",
  held_total: "700.00",
  held: [
    { account_id: main.id, amount: "500.00", covered: "500.00" },
    { account_id: other.id, amount: "200.00", covered: "50.00" },
  ],
});
const trip = savingsTarget({
  id: "1000001002",
  name: "Trip",
  account_id: buffer.id,
  goal: "3000.00",
});
const home = savingsTarget({
  id: "1000001003",
  name: "Home",
  account_id: homeAccount.id,
  current: "120000.00",
  goal: "300000.00",
  held_total: "300.00",
  held: [{ account_id: main.id, amount: "300.00", covered: "300.00" }],
  bsu_room: "1500.00",
});

function withWidgets(widgets: unknown[]) {
  apiMock.on("GET /api/v1/me", {
    body: { ...testUser, preferences: { ...testUser.preferences, dashboard: { widgets } } },
  });
}

beforeEach(() => {
  apiMock.on("GET /api/v1/accounts", { body: [main, other, buffer, homeAccount] });
  apiMock.on("GET /api/v1/savings/targets", { body: [rainy, trip, home] });
});

const region = async (name: string) =>
  within(await screen.findByRole("region", { name }, { timeout: 5000 }));

describe("the Savings widget", () => {
  it("shows each target's progress, its held money and a BSU's room", async () => {
    withWidgets([{ id: "s", type: "savings", width: "half", savings: { mode: "all", count: 5 } }]);
    renderRoute("/");
    const w = await region("Savings");
    const rows = await w.findAllByTestId("widget-savings-row");
    expect(rows.map((r) => within(r).getByText(/^(Rainy day|Trip|Home)$/).textContent)).toEqual([
      "Rainy day",
      "Trip",
      "Home",
    ]);
    const [rainyRow, , homeRow] = rows as [HTMLElement, HTMLElement, HTMLElement];
    const r = within(rainyRow);
    expect(r.getByText(`${m("2200.00")} of ${m("10000.00")}`)).toBeInTheDocument();
    expect(r.getByText(`${m("700.00")} held`)).toBeInTheDocument();
    expect(
      within(homeRow).getByText(`${m("300.00")} held · ${m("1500.00")} left this year (BSU)`),
    ).toBeInTheDocument();
    expect(w.getByRole("link", { name: "Open Savings" })).toHaveAttribute("href", "/savings");
    // The distributor holds nothing, so its part isn't there.
    expect(w.queryByRole("region", { name: "In the savings distributor" })).not.toBeInTheDocument();
  });

  it("shows the chosen targets, the most rows, and a link to the rest", async () => {
    withWidgets([
      {
        id: "s",
        type: "savings",
        width: "half",
        savings: { mode: "chosen", count: 1, target_ids: [home.id, trip.id, "1000009999"] },
      },
    ]);
    renderRoute("/");
    const w = await region("Savings");
    const rows = await w.findAllByTestId("widget-savings-row");
    expect(rows.map((r) => within(r).getByText(/^(Rainy day|Trip|Home)$/).textContent)).toEqual([
      "Trip",
    ]);
    expect(w.getByRole("link", { name: "and 1 more" })).toHaveAttribute("href", "/savings");
  });

  it("is titled after One target, and says when it's gone", async () => {
    withWidgets([
      {
        id: "a",
        type: "savings",
        width: "half",
        savings: { mode: "target", count: 5, target_id: trip.id },
      },
      {
        id: "b",
        type: "savings",
        width: "half",
        savings: { mode: "target", count: 5, target_id: "1000009999" },
      },
    ]);
    renderRoute("/");
    const w = await region("Trip");
    expect(await w.findAllByTestId("widget-savings-row")).toHaveLength(1);
    const gone = await region("Savings");
    expect(
      await gone.findByText("The savings target this widget showed has been deleted."),
    ).toBeInTheDocument();
    expect(gone.getByRole("button", { name: "Choose another target" })).toBeInTheDocument();
  });

  it("shows what the distributor holds, with Distribute now", async () => {
    apiMock.on("GET /api/v1/savings/distributor", {
      body: {
        id: "1000000001",
        hold_mode: "manual",
        min_amount: null,
        held: [{ account_id: main.id, amount: "800.00", covered: "800.00" }],
      },
    });
    apiMock.on("GET /api/v1/savings/distributor/preview", {
      body: {
        shares: [{ target_id: rainy.id, amount: "800.00", into_bucket: false }],
        left: "0.00",
      },
    });
    withWidgets([
      { id: "s", type: "savings", width: "half", savings: { mode: "all", count: 5 } },
      {
        id: "t",
        type: "savings",
        width: "half",
        title: "No distributor",
        savings: { mode: "all", count: 5, show_distributor: false },
      },
    ]);
    renderRoute("/");
    const w = await region("Savings");
    const part = within(await w.findByRole("region", { name: "In the savings distributor" }));
    expect(part.getByText(`${m("800.00")} on Main`)).toBeInTheDocument();
    await userEvent.click(part.getByRole("button", { name: "Distribute now from Main" }));
    expect(await screen.findByRole("dialog", { name: "Distribute now" })).toBeInTheDocument();
    const off = await region("No distributor");
    expect(
      off.queryByRole("region", { name: "In the savings distributor" }),
    ).not.toBeInTheDocument();
  });

  it("says where to make a target when there are none", async () => {
    apiMock.on("GET /api/v1/savings/targets", { body: [] });
    withWidgets([{ id: "s", type: "savings", width: "half", savings: { mode: "all", count: 5 } }]);
    renderRoute("/");
    const w = await region("Savings");
    expect(await w.findByRole("link", { name: "Create one in Savings setup" })).toHaveAttribute(
      "href",
      "/savings/setup",
    );
  });
});

describe("the Savings to transfer widget", () => {
  it("lists the held money per target and account, with Done", async () => {
    apiMock.on("POST /api/v1/savings/targets/1000001001/done", { body: rainy });
    withWidgets([
      {
        id: "t",
        type: "savings_transfer",
        width: "half",
        savings_transfer: { mode: "all", count: 5 },
      },
    ]);
    renderRoute("/");
    const w = await region("Savings to transfer");
    const rows = await w.findAllByTestId("widget-transfer-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(`${m("500.00")} · Main → Rainy day`);
    expect(rows[1]).toHaveTextContent(`${m("200.00")} · Other → Rainy day`);
    expect(rows[2]).toHaveTextContent(`${m("300.00")} · Main → Home`);
    expect(rows[1]).toHaveTextContent(`${m("150.00")} not covered`);
    await userEvent.click(w.getByRole("button", { name: "Done for Rainy day on Main" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Done: Rainy day" }));
    expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("500.00");
    await userEvent.click(dialog.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/savings/targets/1000001001/done")[0]?.body).toEqual({
        account_id: main.id,
        amount: "500.00",
      });
    });
  });

  it("shows the most rows, with a link to the rest", async () => {
    withWidgets([
      {
        id: "t",
        type: "savings_transfer",
        width: "half",
        savings_transfer: { mode: "target", count: 1, target_id: rainy.id },
      },
    ]);
    renderRoute("/");
    const w = await region("Rainy day");
    expect(await w.findAllByTestId("widget-transfer-row")).toHaveLength(1);
    expect(w.getByRole("link", { name: "and 1 more" })).toHaveAttribute("href", "/savings");
  });

  it("says when nothing is waiting", async () => {
    withWidgets([
      {
        id: "t",
        type: "savings_transfer",
        width: "half",
        savings_transfer: { mode: "chosen", count: 5, target_ids: [trip.id] },
      },
    ]);
    renderRoute("/");
    const w = await region("Savings to transfer");
    expect(await w.findByText("Nothing is waiting for a transfer.")).toBeInTheDocument();
  });
});

describe("the savings widgets' settings", () => {
  it("adds a Savings to transfer widget for one target, titled after it", async () => {
    withWidgets([]);
    apiMock.on("PATCH /api/v1/me/preferences", (req) => ({
      body: { ...testUser.preferences, ...(req.body as object) },
    }));
    renderRoute("/");
    await userEvent.click(await screen.findByRole("button", { name: "Edit dashboard" }));
    await userEvent.click(await screen.findByRole("button", { name: /Add widget/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Savings to transfer/ }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("combobox", { name: "Show" }));
    await userEvent.click(await dialog.findByRole("option", { name: "One target" }));
    const add = dialog.getByRole("button", { name: /Add/ });
    expect(add).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Target" }));
    await userEvent.click(await dialog.findByRole("option", { name: "Trip" }));
    expect(dialog.getByRole("textbox", { name: /Title/ })).toHaveAttribute("placeholder", "Trip");
    // Rows stay: one target can be held on several accounts.
    expect(dialog.getByRole("combobox", { name: "Rows" })).toBeInTheDocument();
    expect(add).toBeEnabled();
  });
});
