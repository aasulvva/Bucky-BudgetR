import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem } from "@/test/api";
import { account, bsuStatus, bucket } from "@/test/fixtures";
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

  it("opens an account's balance adjustment from a notification's link (#57)", async () => {
    const { router } = renderRoute("/accounts?adjust=1234");
    const panel = within(await screen.findByRole("region", { name: "Adjust balance" }));
    expect(panel.getByRole("textbox", { name: "Actual balance" })).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Adjust balance" })).not.toBeInTheDocument();
    expect(router.state.location.search).toBe("");
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

  it("registers interest from the account's bank, and shows the bank (#70)", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [{ ...buffer, bank: "DNB" }, euro, main] });
    apiMock.on("POST /api/v1/transactions", { status: 201, body: {} });
    renderRoute("/accounts");
    const buf = await card("Buffer account");
    expect(buf.getByText("DNB")).toBeInTheDocument();
    await userEvent.click(buf.getByRole("button", { name: "Register interest" }));
    const panel = within(screen.getByRole("region", { name: "Register interest" }));
    expect(panel.getByText("DNB")).toBeInTheDocument();
    await userEvent.type(panel.getByRole("textbox", { name: "Interest amount" }), "10");
    await userEvent.click(panel.getByRole("button", { name: "Register interest" }));
    expect(await screen.findByText("Interest on Buffer account registered.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/transactions")[0]?.body).toMatchObject({
      counterparty: "DNB",
      tags: ["interest"],
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

  it("shows a BSU's deposits against this year's limits (#214)", async () => {
    const home = account({
      id: "4567",
      name: "Home",
      type: "bsu",
      balance: "120000.00",
      bsu: bsuStatus(),
    });
    apiMock.on("GET /api/v1/accounts", { body: [home, main] });
    renderRoute("/accounts");
    const c = await card("Home");
    expect(
      c.getByText(
        `${money("18000.00")} of ${money("27500.00")} this year · ${money("9500.00")} left · Total ${money("120000.00")} of ${money("300000.00")}`,
      ),
    ).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Adjust balance" })).toBeEnabled();
  });

  it("sets up a locked BSU's history, then it unlocks (#214)", async () => {
    const home = account({
      id: "4567",
      name: "Home",
      type: "bsu",
      balance: "17100.00",
      bsu: bsuStatus({ locked: true, opened_year: null }),
    });
    apiMock.on("GET /api/v1/accounts", { body: [home, main] });
    apiMock.on("GET /api/v1/accounts/4567/bsu-history", {
      body: {
        latest_opened_year: 2025,
        years: [
          { year: 2025, recorded: { deposits: "10000.00", interest: "0.00", withdrawals: "0.00" } },
          {
            year: 2026,
            recorded: { deposits: "2000.00", interest: "100.00", withdrawals: "0.00" },
          },
        ],
        opening: "5000.00",
        balance: "17100.00",
        set_up_at: null,
        rules: [
          {
            from_year: 2021,
            yearly_limit: "27500.00",
            total_limit: "300000.00",
            modified_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    apiMock.on("POST /api/v1/accounts/4567/bsu-history", {
      body: { ...home, bsu: bsuStatus({ opened_year: 2024 }) },
    });
    const { router } = renderRoute("/accounts");
    const c = await card("Home");
    expect(c.getByText("Locked until set up")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Adjust balance" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Register interest" })).toBeDisabled();
    await userEvent.click(c.getByRole("button", { name: "Set up BSU Home" }));
    expect(router.state.location.search).toBe("?bsu=4567");

    const dialog = within(await screen.findByRole("dialog", { name: "Set up BSU Home" }));
    expect(await dialog.findByRole("group", { name: "2025" })).toBeInTheDocument();
    // Opened a year earlier: 2024 is added, empty.
    await userEvent.click(dialog.getByRole("combobox", { name: "Year opened" }));
    await userEvent.click(await dialog.findByRole("option", { name: "2024" }));
    const field = (name: string) => dialog.getByRole("textbox", { name });
    await userEvent.clear(field("Deposits 2024"));
    await userEvent.type(field("Deposits 2024"), "28000");
    expect(
      dialog.getByText(
        `${money("500.00")} over the yearly limit of ${money("27500.00")}. It's saved as given.`,
      ),
    ).toBeInTheDocument();
    await userEvent.clear(field("Deposits 2025"));
    await userEvent.type(field("Deposits 2025"), "9000");
    await userEvent.click(dialog.getByRole("button", { name: "Set up" }));
    expect(
      dialog.getByText(`At least ${money("10000.00")}, what the app has.`),
    ).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/4567/bsu-history")).toHaveLength(0);

    await userEvent.clear(field("Deposits 2025"));
    await userEvent.type(field("Deposits 2025"), "15000");
    await userEvent.clear(field("Interest 2024"));
    await userEvent.type(field("Interest 2024"), "200");
    const balance = dialog.getByRole("textbox", { name: "Balance today, at the bank" });
    await userEvent.clear(balance);
    await userEvent.type(balance, "50000");
    const plan = within(dialog.getByRole("region", { name: "What it records" }));
    expect(
      plan.getByText(`The opening balance is corrected to 0 (${money("-5000.00")})`),
    ).toBeInTheDocument();
    expect(
      plan.getByText(`2024: a deposit of ${money("28000.00")}, interest of ${money("200.00")}`),
    ).toBeInTheDocument();
    expect(plan.getByText(`2025: a deposit of ${money("5000.00")}`)).toBeInTheDocument();
    // 17 100 − 5 000 + 28 200 + 5 000 = 45 300.
    expect(
      plan.getByText(`A balance adjustment of ${money("4700.00")} to match the bank`),
    ).toBeInTheDocument();

    await userEvent.click(dialog.getByRole("button", { name: "Set up" }));
    expect(await screen.findByText("Home is set up.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/4567/bsu-history")[0]?.body).toEqual({
      opened_year: 2024,
      years: [
        { year: 2024, deposits: "28000.00", interest: "200.00", withdrawals: "0.00" },
        { year: 2025, deposits: "15000.00", interest: "0.00", withdrawals: "0.00" },
        { year: 2026, deposits: "2000.00", interest: "100.00", withdrawals: "0.00" },
      ],
      balance: "50000.00",
    });
    expect(router.state.location.search).toBe("");
  });

  it("says a BSU in another currency must change type or go (#214)", async () => {
    const old = account({
      id: "5678",
      name: "Old BSU",
      type: "bsu",
      currency: "EUR",
      bsu: bsuStatus({ locked: true }),
    });
    apiMock.on("GET /api/v1/accounts", { body: [old, main] });
    renderRoute("/accounts");
    const c = await card("Old BSU");
    expect(c.getByText(/This BSU is in EUR, but a BSU must be in NOK/)).toBeInTheDocument();
    expect(c.getByRole("link", { name: "Open Account setup" })).toHaveAttribute(
      "href",
      "/accounts/setup?edit=5678",
    );
  });
});
