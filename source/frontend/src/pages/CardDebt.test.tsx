// Card debt held per account on the screens (#261): Accounts' lines and the
// Set aside / Release panels, the transaction form's card purchase, payment
// and carry, and a CDH in the transaction detail.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { amountOf } from "@/test/breakdown";
import { account, bucket, creditCard, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** As Testing Library reads it: ICU's no-break spaces become plain ones. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

// Visa owes 800: 300 set aside on Main, 500 on Buffer.
const main = account({
  id: "1234",
  name: "Main account",
  balance: "10000.00",
  unallocated: "4000.00",
  card_holds: [{ card_id: "9000", amount: "300.00" }],
});
const buffer = account({
  id: "2345",
  name: "Buffer account",
  type: "savings",
  balance: "400.00",
  card_holds: [{ card_id: "9000", amount: "500.00" }],
  card_debt_uncovered: "100.00",
});
const visa = account({
  id: "9000",
  name: "Visa",
  type: "credit_card",
  balance: "-1000.00",
  credit_card: creditCard({
    owed: "1000.00",
    available: "19000.00",
    held_on: [
      { account_id: "2345", amount: "500.00" },
      { account_id: "1234", amount: "300.00" },
    ],
    set_aside: "800.00",
    not_set_aside: "200.00",
  }),
});
const groceries = bucket({
  id: "1000000001",
  name: "Groceries",
  source_account_id: main.id,
  current_available_funds: "3000.00",
});
const trip = bucket({
  id: "1000000002",
  name: "Trip",
  source_account_id: buffer.id,
  current_available_funds: "400.00",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, main, visa] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries, trip] });
  apiMock.on("POST /api/v1/transactions", { status: 201, body: {} });
});

/** Chooses an option in a select. */
async function pick(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

function sent(): Record<string, unknown> | undefined {
  return apiMock.calls("POST /api/v1/transactions").at(-1)?.body as
    Record<string, unknown> | undefined;
}

describe("Accounts with card debt (#261)", () => {
  it("says what each account holds for a card, and what a card has set aside", async () => {
    renderRoute("/accounts");
    const mainMoney = await screen.findByLabelText("Where the money in Main account is");
    expect(amountOf(mainMoney, "Set aside for Visa")).toBe(m("300.00"));
    expect(amountOf(mainMoney, "1 bucket")).toBe(m("3000.00"));
    expect(amountOf(mainMoney, "Unallocated")).toBe(m("4000.00"));
    const bufferMoney = screen.getByLabelText("Where the money in Buffer account is");
    expect(amountOf(bufferMoney, "Set aside for Visa")).toBe(m("500.00"));
    expect(within(bufferMoney).getByText(`${m("100.00")} not covered`)).toHaveStyle({
      color: "var(--mantine-color-orange-text)",
    });
    const visaDebt = screen.getByLabelText("Where the debt on Visa is set aside");
    expect(amountOf(visaDebt, "Set aside on Buffer account")).toBe(m("500.00"));
    expect(amountOf(visaDebt, "Set aside on Main account")).toBe(m("300.00"));
    expect(amountOf(visaDebt, "Not set aside")).toBe(m("200.00"));
  });

  it("sets aside what isn't, on the default account", async () => {
    apiMock.on("POST /api/v1/accounts/9000/card-debt/set-aside", { status: 201, body: {} });
    renderRoute("/accounts");
    const card = within(await screen.findByRole("article", { name: "Visa" }));
    await userEvent.click(card.getByRole("button", { name: "Set aside" }));
    const panel = within(screen.getByRole("region", { name: "Set aside" }));
    expect(panel.getByRole("combobox", { name: "Account" })).toHaveValue("Main account");
    const amount = panel.getByRole("textbox", { name: "Amount" });
    expect(amount).toHaveValue("200.00");
    await userEvent.clear(amount);
    await userEvent.type(amount, "300");
    await userEvent.click(panel.getByRole("button", { name: "Set aside" }));
    expect(panel.getByText(`At most ${m("200")}.`)).toBeInTheDocument();

    await userEvent.clear(amount);
    await userEvent.type(amount, "150");
    await userEvent.click(panel.getByRole("button", { name: "Set aside" }));
    expect(await screen.findByText(`${m("150")} set aside for Visa.`)).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/9000/card-debt/set-aside")[0]?.body).toEqual({
      account_id: "1234",
      amount: "150.00",
    });
  });

  it("releases what's set aside, starting with the largest", async () => {
    apiMock.on("POST /api/v1/accounts/9000/card-debt/release", { status: 201, body: {} });
    renderRoute("/accounts");
    const card = within(await screen.findByRole("article", { name: "Visa" }));
    await userEvent.click(card.getByRole("button", { name: "Release" }));
    const panel = within(screen.getByRole("region", { name: "Release" }));
    expect(panel.getByRole("combobox", { name: "Account" })).toHaveValue("Buffer account");
    expect(panel.getByRole("textbox", { name: "Amount" })).toHaveValue("500.00");
    await pick("Account", "Main account");
    expect(panel.getByRole("textbox", { name: "Amount" })).toHaveValue("300.00");
    await userEvent.click(panel.getByRole("button", { name: "Release" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/accounts/9000/card-debt/release")[0]?.body).toEqual({
        account_id: "1234",
        amount: "300.00",
      });
    });
  });
});

describe("Card debt in the transaction form (#261)", () => {
  it("pays by card from any account's buckets, setting the rest aside", async () => {
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "250");
    await pick("Account", /^Visa/);
    expect(screen.getByRole("combobox", { name: "Set aside on" })).toHaveValue("Main account");

    const split = within(screen.getByRole("region", { name: "Buckets" }));
    expect(split.getByText("From any account in NOK")).toBeInTheDocument();
    await userEvent.click(split.getByRole("button", { name: "Add bucket" }));
    await userEvent.click(split.getByRole("combobox", { name: "Bucket" }));
    // Buckets on both accounts, grouped by account.
    expect(await screen.findByRole("option", { name: /^Groceries/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /^Trip/ }));
    await userEvent.clear(split.getByRole("textbox", { name: "Amount for Trip" }));
    await userEvent.type(split.getByRole("textbox", { name: "Amount for Trip" }), "200");
    await pick("Set aside on", "Don't set aside");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Expense saved.")).toBeInTheDocument();
    expect(sent()).toMatchObject({
      type: "EXP",
      account_id: "9000",
      amount: "250.00",
      bucket_lines: [{ bucket_id: trip.id, amount: "200.00" }],
      set_aside_account_id: null,
    });
  });

  it("clears the payer's part of a payment and releases the rest elsewhere", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Amount" }), "1000");
    await pick("To account", /^Visa/);
    const debt = within(screen.getByRole("region", { name: "Card debt" }));
    expect(debt.getByText(`Clears the ${m("300")} set aside on Main account.`)).toBeInTheDocument();
    // What's held beyond what's still owed: 800 held − 300 cleared − 0 owed.
    const release = debt.getByRole("textbox", { name: "Release on Buffer account" });
    expect(release).toHaveValue("500.00");

    await userEvent.clear(release);
    await userEvent.type(release, "600");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(debt.getByRole("alert")).toHaveTextContent(
      `Buffer account has only ${m("500")} set aside.`,
    );
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(0);

    await userEvent.clear(release);
    await userEvent.type(release, "200");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        type: "TRF",
        account_id: "1234",
        to_account_id: "9000",
        release_card_debt: [{ account_id: "2345", amount: "200.00" }],
      });
    });
  });

  it("leaves the releases to the server when they aren't changed", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Amount" }), "1000");
    await pick("To account", /^Visa/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()).toBeDefined();
    });
    expect(sent()).not.toHaveProperty("release_card_debt");
  });

  it("moves card debt with a transfer only when asked", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Amount" }), "200");
    await pick("To account", /^Buffer account/);
    const carry = screen.getByRole("switch", { name: /^Move card debt with it/ });
    expect(carry).not.toBeChecked();
    await userEvent.click(carry);
    expect(screen.getByRole("textbox", { name: "Move for Visa" })).toHaveValue("200.00");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        type: "TRF",
        account_id: "1234",
        to_account_id: "2345",
        carry_card_debt: [{ card_id: "9000", amount: "200.00" }],
      });
    });
  });
});

describe("Card debt in the transaction detail (#261)", () => {
  const hold = transaction({
    id: "2026112300000001",
    type: "CDH",
    bank_lines: [],
    card_lines: [{ card_id: visa.id, account_id: main.id, amount: "150.00" }],
  });

  beforeEach(() => {
    apiMock.on("GET /api/v1/transactions", { body: { items: [hold], next_cursor: null } });
    apiMock.on(`GET /api/v1/transactions/${hold.id}`, { body: { ...hold, history: [] } });
  });

  it("names the card and account in the row", async () => {
    renderRoute("/transactions?system=1");
    expect(
      await screen.findByText("Card debt set aside · Visa · Main account"),
    ).toBeInTheDocument();
  });

  it("shows its card line and reverses it without Edit", async () => {
    apiMock.on(`POST /api/v1/transactions/${hold.id}/reversal`, {
      body: { ...hold, reversed: true },
    });
    renderRoute(`/transactions?open=${hold.id}`);
    const panel = within(await screen.findByRole("article", { name: "Card debt set aside" }));
    expect(panel.getAllByText(`+${m("150.00")}`).length).toBeGreaterThan(0);
    const lines = within(panel.getByRole("region", { name: "Card debt" }));
    expect(lines.getByText("Main account")).toBeInTheDocument();
    expect(lines.getByText("Set aside for Visa")).toBeInTheDocument();
    expect(panel.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Reverse" }));
    expect(panel.getByText(/The money becomes unallocated again\./)).toBeInTheDocument();
  });
});

describe("Editing a card purchase (#261)", () => {
  // 250 on Visa: 200 from Trip (held on Buffer), 50 set aside on Main.
  const purchase = transaction({
    id: "2026112300000002",
    type: "EXP",
    counterparty: "Rema 1000",
    bank_lines: [{ account_id: visa.id, amount: "-250.00" }],
    bucket_lines: [{ bucket_id: trip.id, cycle_id: "20261101", amount: "-200.00" }],
    card_lines: [
      { card_id: visa.id, account_id: buffer.id, amount: "200.00" },
      { card_id: visa.id, account_id: main.id, amount: "50.00" },
    ],
  });
  const path = `/api/v1/transactions/${purchase.id}`;

  beforeEach(() => {
    apiMock.on(`GET ${path}`, { body: { ...purchase, history: [] } });
    apiMock.on(`POST ${path}/correction`, { body: purchase });
  });

  it("starts from where the rest was set aside, and sends a new choice", async () => {
    renderRoute(`/transactions/${purchase.id}/edit`);
    const setAside = await screen.findByRole("combobox", { name: "Set aside on" });
    expect(setAside).toHaveValue("Main account");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await pick("Set aside on", "Buffer account");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Correction saved.")).toBeInTheDocument();
    expect(apiMock.calls(`POST ${path}/correction`)[0]?.body).toEqual({
      set_aside_account_id: "2345",
    });
  });
});

describe("Deleting an account that holds card debt (#261)", () => {
  it("says the debt moves with the money, or is released", async () => {
    renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(
      await dialog.findByText(`Its card debt (${m("500")} set aside for Visa) is released.`),
    ).toBeInTheDocument();
    await pick("Transfer to", "Main account");
    expect(
      dialog.getByText(
        `Its card debt (${m("500")} set aside for Visa) moves with the money to Main account.`,
      ),
    ).toBeInTheDocument();
  });
});
