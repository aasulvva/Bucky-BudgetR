import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";
import { formatMoney } from "@/lib/money";

/** As Testing Library reads it: ICU's no-break spaces become plain ones. */
const money = (amount: string, currency?: string) =>
  formatMoney(amount, currency).replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account", balance: "12340.50" });
const buffer = account({
  id: "2345",
  name: "Buffer account",
  type: "savings",
  balance: "25000",
  unallocated: "16250.00",
});
const euro = account({ id: "3456", name: "Euro account", currency: "EUR", balance: "100.00" });

beforeEach(() => {
  apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main] });
  apiMock.on("GET /api/v1/buckets", {
    body: [
      bucket({
        id: "1000000001",
        name: "Groceries",
        source_account_id: main.id,
        target_funds: "1000.00",
        current_available_funds: "500.00",
      }),
      bucket({
        id: "1000000002",
        name: "Housing",
        source_account_id: main.id,
        target_funds: "200.00",
        current_available_funds: "200.00",
      }),
      bucket({
        id: "1000000003",
        name: "Travel",
        source_account_id: buffer.id,
        target_funds: "100.00",
        current_available_funds: "100.00",
      }),
    ],
  });
});

afterEach(() => {
  viewport.width = 1280;
});

async function card(name: string) {
  return within(await screen.findByRole("article", { name }));
}

describe("Accounts", () => {
  it("shows each account's balance and buckets, and totals per currency", async () => {
    renderRoute("/accounts");
    const mainCard = await card("Main account");
    expect(mainCard.getByText(money("12340.50"))).toBeInTheDocument();
    expect(mainCard.getByText("Usage")).toBeInTheDocument();
    expect(await mainCard.findByText(`2 buckets · ${money("500.00")} short`)).toBeInTheDocument();
    expect(
      (await card("Buffer account")).getByText(`1 bucket · ${money("16250.00")} unallocated`),
    ).toBeInTheDocument();
    expect((await card("Euro account")).getByText("No buckets")).toBeInTheDocument();
    expect((await card("Euro account")).getByText(money("100.00", "EUR"))).toBeInTheDocument();

    expect(screen.getByText(money("37340.50"))).toBeInTheDocument();
    expect(screen.getAllByText(money("100.00", "EUR"))).toHaveLength(2);

    expect(mainCard.getByRole("link", { name: "Account setup for Main account" })).toHaveAttribute(
      "href",
      "/accounts/setup?edit=1234",
    );
    expect(mainCard.getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "href",
      "/transactions?account_id=1234",
    );
  });

  it("says where to start without accounts", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [] });
    renderRoute("/accounts");
    expect(
      await screen.findByRole("link", { name: "Create one in Account setup" }),
    ).toHaveAttribute("href", "/accounts/setup");
  });

  it("adjusts the balance", async () => {
    apiMock.on("POST /api/v1/accounts/1234/balance-adjustment", { body: main });
    renderRoute("/accounts");
    await userEvent.click(
      (await card("Main account")).getByRole("button", { name: "Adjust balance" }),
    );
    const panel = within(screen.getByRole("region", { name: "Adjust balance" }));
    const actual = panel.getByRole("textbox", { name: "Actual balance" });
    await userEvent.clear(actual);
    await userEvent.type(actual, "12000");
    expect(
      panel.getByText(`Records a balance adjustment of ${money("-340.50")}.`),
    ).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Record adjustment" }));

    expect(await screen.findByText("Balance of Main account adjusted.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/1234/balance-adjustment")[0]?.body).toEqual({
      target_balance: "12000.00",
    });
    expect(screen.queryByRole("region", { name: "Adjust balance" })).not.toBeInTheDocument();
  });

  it("says when the balance is right already", async () => {
    apiMock.on(
      "POST /api/v1/accounts/1234/balance-adjustment",
      problem(400, "no_change", "The balance is already 12340.50."),
    );
    renderRoute("/accounts");
    await userEvent.click(
      (await card("Main account")).getByRole("button", { name: "Adjust balance" }),
    );
    const panel = within(screen.getByRole("region", { name: "Adjust balance" }));
    expect(panel.getByText("That matches the balance in the app.")).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Record adjustment" }));
    expect(await panel.findByText("That's already the balance.")).toBeInTheDocument();
  });

  it("registers interest as an income that doesn't refill", async () => {
    apiMock.on("POST /api/v1/transactions", { status: 201, body: {} });
    renderRoute("/accounts");
    await userEvent.click(
      (await card("Buffer account")).getByRole("button", { name: "Register interest" }),
    );
    const panel = within(screen.getByRole("region", { name: "Register interest" }));
    const submit = panel.getByRole("button", { name: "Register interest" });

    await userEvent.click(submit);
    expect(panel.getByText("Enter the interest.")).toBeInTheDocument();
    const amount = panel.getByRole("textbox", { name: "Interest amount" });
    await userEvent.type(amount, "0");
    await userEvent.click(submit);
    expect(panel.getByText("Interest must be more than 0.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(0);

    await userEvent.clear(amount);
    await userEvent.type(amount, "312.4");
    await userEvent.click(submit);
    expect(await screen.findByText("Interest on Buffer account registered.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/transactions")[0]?.body).toEqual({
      type: "INC",
      account_id: "2345",
      amount: "312.40",
      counterparty: "Interest",
      tags: ["interest"],
      triggers_refill: false,
    });
  });

  it("has the actions in a menu on mobile", async () => {
    viewport.width = 390;
    renderRoute("/accounts");
    expect(await screen.findByRole("link", { name: "Main account transactions" })).toHaveAttribute(
      "href",
      "/transactions?account_id=1234",
    );
    await userEvent.click(screen.getByRole("button", { name: "More for Main account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Register interest" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("region", { name: "Register interest" })).toBeInTheDocument();
    expect(within(sheet).getByText("Main account · Usage")).toBeInTheDocument();
  });
});
