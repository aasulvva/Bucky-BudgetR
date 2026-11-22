// Savings transactions on the Transactions screen (#231): their lines, what
// a reversal says, and a Done transfer's locked amount and accounts.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { account, savingsTarget, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account" });
const buffer = account({ id: "2345", name: "Buffer account", type: "savings" });
const rainy = savingsTarget({ id: "1000001001", name: "Rainy day", account_id: buffer.id });

const reserve = transaction({
  id: "2026102300000001",
  type: "SVR",
  bank_lines: [],
  savings_lines: [{ holder_id: rainy.id, account_id: main.id, amount: "300.00" }],
});
const done = transaction({
  id: "2026102300000002",
  type: "TRF",
  bank_lines: [
    { account_id: main.id, amount: "-200.00" },
    { account_id: buffer.id, amount: "200.00" },
  ],
  savings_lines: [{ holder_id: rainy.id, account_id: main.id, amount: "-200.00" }],
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, main] });
  apiMock.on("GET /api/v1/savings/targets", { body: [rainy] });
  apiMock.on("GET /api/v1/transactions", { body: { items: [reserve, done], next_cursor: null } });
  apiMock.on(`GET /api/v1/transactions/${reserve.id}`, { body: { ...reserve, history: [] } });
  apiMock.on(`GET /api/v1/transactions/${done.id}`, { body: { ...done, history: [] } });
});

describe("savings transactions", () => {
  it("shows a reservation's savings line, and reverses it without Edit", async () => {
    apiMock.on(`POST /api/v1/transactions/${reserve.id}/reversal`, {
      body: { ...reserve, reversed: true },
    });
    renderRoute(`/transactions?open=${reserve.id}`);
    const panel = within(await screen.findByRole("article", { name: "Reserved for savings" }));
    expect(panel.getAllByText(`+${m("300.00")}`).length).toBeGreaterThan(0);
    const lines = within(panel.getByRole("region", { name: "Savings" }));
    expect(lines.getByText("Rainy day")).toBeInTheDocument();
    expect(lines.getByText("Held on Main account")).toBeInTheDocument();
    expect(
      panel.getByText("Recorded by Savings, so it can't be corrected. You can reverse it."),
    ).toBeInTheDocument();
    expect(panel.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();

    await userEvent.click(panel.getByRole("button", { name: "Reverse" }));
    expect(panel.getByText(/The money is no longer held for the target\./)).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Reverse Reserved for savings" }));
    await waitFor(() => {
      expect(apiMock.calls(`POST /api/v1/transactions/${reserve.id}/reversal`)).toHaveLength(1);
    });
  });

  it("names the target and account in the row", async () => {
    renderRoute("/transactions?system=1");
    expect(
      await screen.findByText("Reserved for savings · Rainy day · Main account"),
    ).toBeInTheDocument();
  });

  it("keeps a Done transfer's amount and accounts", async () => {
    renderRoute(`/transactions/${done.id}/edit`);
    const amount = await screen.findByRole("textbox", { name: "Amount" });
    expect(amount).toBeDisabled();
    expect(
      screen.getByText(
        "This transfer moved held savings, so its amount and accounts can't change. Reverse it to put the money back on hold.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "From account" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "To account" })).toBeDisabled();
  });
});
