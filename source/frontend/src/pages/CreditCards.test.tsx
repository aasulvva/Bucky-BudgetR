// Credit card accounts on the screens (#260): Account setup, Accounts, the
// transaction form and the source lists that leave cards out.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem } from "@/test/api";
import { account, bsuStatus, creditCard } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";
import { formatMoney } from "@/lib/money";

/** As Testing Library reads it: ICU's no-break spaces become plain ones. */
const money = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account", balance: "10000.00" });
const buffer = account({ id: "2345", name: "Buffer account", type: "savings" });
const visa = account({
  id: "9000",
  name: "Visa",
  type: "credit_card",
  balance: "-4520.00",
  credit_card: creditCard(),
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, main, visa] });
  apiMock.on("GET /api/v1/buckets", { body: [] });
});

/** Chooses an option in a select. */
async function pick(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Account setup with credit cards (#260)", () => {
  it("creates a card with its fields, sending what's owed as a negative balance", async () => {
    apiMock.on("POST /api/v1/accounts", { status: 201, body: visa });
    renderRoute("/accounts/setup");
    await userEvent.click(await screen.findByRole("button", { name: "New account" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New account" }));
    await userEvent.type(dialog.getByRole("textbox", { name: /Name/ }), "Visa");
    await pick("Type", "Credit card");
    expect(dialog.getByText(/A credit card owes money/)).toBeInTheDocument();
    // The one usage account in NOK is the default; it can be cleared.
    expect(dialog.getByRole("combobox", { name: "Default account" })).toHaveValue("Main account");

    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));
    expect(dialog.getAllByText("Enter an amount above 0.")).toHaveLength(2);
    expect(dialog.getAllByText("Choose a day.")).toHaveLength(2);
    expect(apiMock.calls("POST /api/v1/accounts")).toHaveLength(0);

    await userEvent.type(dialog.getByRole("textbox", { name: /Credit limit/ }), "20000");
    await pick(/^Statement day/, "Last day");
    await pick(/^Due day/, "15");
    await userEvent.type(dialog.getByRole("textbox", { name: /Minimum payment/ }), "300");
    await userEvent.type(dialog.getByRole("textbox", { name: "Owed today" }), "4520");
    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Visa created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts")[0]?.body).toEqual({
      name: "Visa",
      type: "credit_card",
      currency: "NOK",
      credit_card: {
        default_account_id: "1234",
        credit_limit: "20000.00",
        statement_day: 31,
        due_day: 15,
        minimum_payment: "300.00",
      },
      opening_balance: "-4520.00",
    });
  });

  it("edits a card's fields, but never its type", async () => {
    apiMock.on("PATCH /api/v1/accounts/9000", { body: visa });
    renderRoute("/accounts/setup?edit=9000");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    expect(dialog.getByRole("combobox", { name: "Type" })).toBeDisabled();
    expect(dialog.getByText("A credit card stays a credit card.")).toBeInTheDocument();
    const minimum = dialog.getByRole("textbox", { name: /Minimum payment/ });
    await userEvent.clear(minimum);
    await userEvent.type(minimum, "500");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Visa saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/accounts/9000")[0]?.body).toEqual({
      credit_card: {
        default_account_id: "1234",
        credit_limit: "20000.00",
        statement_day: 1,
        due_day: 15,
        minimum_payment: "500.00",
      },
    });
  });

  it("warns that a default account changed to a fund stops being one", async () => {
    renderRoute("/accounts/setup?edit=1234");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("combobox", { name: "Type" }));
    expect(await screen.findByRole("option", { name: "Credit card" })).toHaveAttribute(
      "data-combobox-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("option", { name: "Fund/ASK" }));
    expect(dialog.getByText("It stops being the default account of Visa.")).toBeInTheDocument();
  });

  it("deletes a card that owes by paying it off", async () => {
    apiMock.on("POST /api/v1/accounts/9000/delete", { status: 204 });
    renderRoute("/accounts/setup?edit=9000");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(await dialog.findByText(`It owes ${money("4520")}`)).toBeInTheDocument();
    expect(dialog.getByRole("radio", { name: "Pay it off from another account" })).toBeChecked();
    await pick("Pay from", "Main account");
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    expect(await screen.findByText("Visa deleted.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/9000/delete")[0]?.body).toEqual({
      remaining_funds: { action: "transfer", to_account_id: "1234" },
    });
  });
});

describe("Accounts with credit cards (#260)", () => {
  it("shows what's owed and available, and adjusts by what's owed", async () => {
    apiMock.on("POST /api/v1/accounts/9000/balance-adjustment", { body: visa });
    renderRoute("/accounts");
    const card = within(await screen.findByRole("article", { name: "Visa" }));
    expect(
      card.getByText(`Owed ${money("4520")} · ${money("15480")} of ${money("20000")} available`),
    ).toBeInTheDocument();
    // Interest and fees on a card come later (#263).
    expect(card.queryByRole("button", { name: "Register interest" })).not.toBeInTheDocument();
    expect(card.queryByText(/bucket/i)).not.toBeInTheDocument();

    await userEvent.click(card.getByRole("button", { name: "Adjust balance" }));
    const panel = within(screen.getByRole("region", { name: "Adjust balance" }));
    expect(panel.getByText("Owed in the app")).toBeInTheDocument();
    const owed = panel.getByRole("textbox", { name: "Owed now" });
    await userEvent.clear(owed);
    await userEvent.type(owed, "5000");
    await userEvent.click(panel.getByRole("button", { name: "Record adjustment" }));
    expect(await screen.findByText("Balance of Visa adjusted.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/9000/balance-adjustment")[0]?.body).toEqual({
      target_balance: "-5000.00",
    });
  });

  it("is orange from 90 % of the limit", async () => {
    const near = account({
      ...visa,
      balance: "-18500.00",
      credit_card: creditCard({ owed: "18500.00", available: "1500.00" }),
    });
    apiMock.on("GET /api/v1/accounts", { body: [main, near] });
    renderRoute("/accounts");
    const card = within(await screen.findByRole("article", { name: "Visa" }));
    expect(card.getByText(/^Owed/)).toHaveStyle({ color: "var(--mantine-color-orange-text)" });
  });
});

describe("Transactions on a credit card (#260)", () => {
  it("says what's available, and asks before going past the limit", async () => {
    const home = account({
      id: "4567",
      name: "Home",
      type: "bsu",
      bsu: bsuStatus({ locked: true }),
    });
    apiMock.on("GET /api/v1/accounts", { body: [buffer, home, main, visa] });
    apiMock.on("POST /api/v1/transactions", (req) =>
      (req.body as Record<string, unknown>).limit_confirmed
        ? { status: 201, body: {} }
        : problem(409, "over_credit_limit", "This takes the credit card past its credit limit."),
    );
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "16000");
    await pick("Account", /^Visa/);
    const hint = await screen.findByText(
      `Visa: ${money("15480")} of ${money("20000")} available (credit card)`,
    );
    expect(hint).toHaveStyle({ color: "var(--mantine-color-orange-text)" });
    // A locked BSU's note stays on the account list, not under the card's hint.
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveAccessibleDescription(
      "Locked BSU accounts are left out until their history is set up.",
    );
    expect(hint.nextElementSibling?.textContent ?? "").not.toMatch(/Locked BSU/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const ask = await screen.findByRole("alertdialog", { name: "Past the credit limit" });
    await userEvent.click(within(ask).getByRole("button", { name: "Record it anyway" }));
    expect(await screen.findByText("Expense saved.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/transactions").at(-1)?.body).toMatchObject({
      type: "EXP",
      account_id: "9000",
      amount: "16000.00",
      limit_confirmed: true,
    });
  });

  it("says what's owed when paying the card", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await pick("To account", /^Visa/);
    expect(
      await screen.findByText(`Visa: ${money("4520")} owed (credit card)`),
    ).toBeInTheDocument();
  });
});

describe("Cards as sources (#260)", () => {
  it("can't fund a bucket", async () => {
    renderRoute("/buckets/setup?new");
    await screen.findByRole("form", { name: "New bucket" });
    await userEvent.click(screen.getByRole("combobox", { name: /Source account/ }));
    expect(await screen.findByRole("option", { name: "Main account" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Visa" })).not.toBeInTheDocument();
  });
});
