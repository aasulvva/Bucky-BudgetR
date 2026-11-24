import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { CounterpartySuggestion } from "@/api/transactions";
import { apiMock, problem, testUser } from "@/test/api";
import { account, bsuStatus, bucket, creditCard, cycle } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

const main = account({ id: "1234", name: "Main account", balance: "1000.00" });
const buffer = account({ id: "2345", name: "Buffer account", balance: "500.00" });
const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });
const groceries = bucket({
  id: "1000000001",
  name: "Groceries",
  source_account_id: main.id,
  current_available_funds: "3200.00",
});
const household = bucket({ id: "1000000002", name: "Household", source_account_id: main.id });
const car = bucket({ id: "1000000003", name: "Car", source_account_id: buffer.id });
const food = bucket({
  id: "1000000004",
  name: "Food",
  source_account_id: main.id,
  refill_mode: "on_income",
});

const saved = { status: 201, body: {} };

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main] });
  apiMock.on("GET /api/v1/buckets", { body: [car, groceries, household] });
  apiMock.on("POST /api/v1/transactions", saved);
});

const amount = () => screen.getByRole("textbox", { name: "Amount" });

/** Chooses an option in a select. */
async function pick(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

function sent(): Record<string, unknown> | undefined {
  return apiMock.calls("POST /api/v1/transactions").at(-1)?.body as
    Record<string, unknown> | undefined;
}

describe("Create transaction", () => {
  it("records an expense split between buckets, and remembers the account", async () => {
    const { router } = renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "250.40");
    await pick("Account", /^Main account/);
    await userEvent.type(screen.getByRole("combobox", { name: "Paid to" }), "Rema 1000");

    const split = within(screen.getByRole("region", { name: "Buckets" }));
    expect(split.getByText("From Main account")).toBeInTheDocument();
    await userEvent.click(split.getByRole("button", { name: "Add bucket" }));
    // A new row gets what's not tied to a bucket yet.
    expect(split.getByRole("textbox", { name: "Amount for the bucket" })).toHaveValue("250.40");
    // Only the account's buckets, with what's left in them.
    await userEvent.click(split.getByRole("combobox", { name: "Bucket" }));
    expect(screen.queryByRole("option", { name: /^Car/ })).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("option", { name: /^Groceries · .*3,200\.00 left$/ }),
    );
    await userEvent.clear(split.getByRole("textbox", { name: "Amount for Groceries" }));
    await userEvent.type(split.getByRole("textbox", { name: "Amount for Groceries" }), "200.40");
    await userEvent.click(split.getByRole("button", { name: "Add bucket" }));
    // The only bucket left is picked by itself.
    expect(split.getByRole("textbox", { name: "Amount for Household" })).toHaveValue("50.00");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Expense saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      type: "EXP",
      account_id: "1234",
      amount: "250.40",
      counterparty: "Rema 1000",
      bucket_lines: [
        { bucket_id: "1000000001", amount: "200.40" },
        { bucket_id: "1000000002", amount: "50.00" },
      ],
    });
    expect(localStorage.getItem("bucky.lastAccount")).toBe("1234");
    // Opened directly, so it goes to the dashboard.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("checks the amount and the split", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter an amount above 0.")).toBeInTheDocument();

    await userEvent.type(amount(), "100");
    await userEvent.click(screen.getByRole("button", { name: "Add bucket" }));
    await pick("Bucket", /^Groceries/);
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount for Groceries" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Amount for Groceries" }), "150");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/The buckets get .*50\.00 more/);
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(0);
  });

  it("transfers between accounts in the same currency", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    expect(screen.queryByRole("region", { name: "Buckets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Paid to" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "From account" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "To account" }));
    expect(screen.queryByRole("option", { name: /^Euro account/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Main account/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: /^Buffer account/ }));
    await userEvent.type(amount(), "300");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Transfer saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      type: "TRF",
      account_id: "1234",
      to_account_id: "2345",
      amount: "300.00",
    });
  });

  it("asks before going over a BSU limit, and sends it confirmed (#214)", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    apiMock.on("POST /api/v1/transactions", (req) =>
      (req.body as Record<string, unknown>).bsu_confirmed
        ? saved
        : problem(409, "bsu_over_limit", "This takes the BSU account over its deposit limit."),
    );
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await userEvent.click(screen.getByRole("combobox", { name: "To account" }));
    await userEvent.click(await screen.findByRole("option", { name: /^Buffer account/ }));
    await userEvent.type(amount(), "30000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const ask = await screen.findByRole("alertdialog", { name: "Over the BSU limit" });
    expect(
      within(ask).getByText(/over this year's or the total deposit limit/),
    ).toBeInTheDocument();

    // Cancel leaves it unsent; asked again, Record it anyway sends it.
    await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Record it anyway",
      }),
    );
    expect(await screen.findByText("Transfer saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      type: "TRF",
      account_id: "1234",
      to_account_id: "2345",
      amount: "30000.00",
      bsu_confirmed: true,
    });
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(3);
  });

  it("asks before taking money out of a BSU (#214)", async () => {
    apiMock.on("POST /api/v1/transactions", problem(409, "bsu_withdrawal", "Money out of a BSU."));
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "100");
    await pick("Account", /^Main account/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const ask = await screen.findByRole("alertdialog", { name: "Money out of a BSU account" });
    expect(within(ask).getByText(/can cost you the tax deduction/)).toBeInTheDocument();
  });

  it("says what a BSU may still take this year, but not for interest (#214)", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    const home = account({ id: "4567", name: "Home", type: "bsu", bsu: bsuStatus() });
    apiMock.on("GET /api/v1/accounts", { body: [buffer, home, main] });
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Transfer" }));
    await pick("To account", /^Home/);
    const hint = await screen.findByText(/^Home: .* left this year \(BSU\)$/);
    expect(hint).toHaveTextContent("9,500.00");
    await userEvent.type(amount(), "10000");
    expect(hint).toHaveStyle({ color: "var(--mantine-color-orange-text)" });
  });

  it("leaves locked BSU accounts out of the choices (#214)", async () => {
    const home = account({
      id: "4567",
      name: "Home",
      type: "bsu",
      bsu: bsuStatus({ locked: true }),
    });
    apiMock.on("GET /api/v1/accounts", { body: [buffer, home, main] });
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("combobox", { name: "Account" }));
    expect(await screen.findByRole("option", { name: /^Main account/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Home/ })).not.toBeInTheDocument();
    // Said on the account list, not as a hint under it.
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveAccessibleDescription(
      "Locked BSU accounts are left out until their history is set up.",
    );
  });

  it("pre-checks Triggers refill for waiting On income buckets, and sends an untick", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    apiMock.on("GET /api/v1/buckets", { body: [food, groceries] });
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Income" }));
    const box = screen.getByRole("checkbox", { name: "Triggers refill" });
    expect(box).toBeChecked();
    expect(screen.getByText(/Refills Food, the “On income” buckets/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "From" })).toBeInTheDocument();

    await userEvent.type(amount(), "100");
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Income saved.")).toBeInTheDocument();
    expect(sent()).toMatchObject({ type: "INC", triggers_refill: false });
  });

  it("pre-checks Triggers refill when an income rule matches", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    apiMock.on("GET /api/v1/me", {
      body: {
        ...testUser,
        preferences: {
          ...testUser.preferences,
          income_refill_rules: [{ counterparty: "Employer AS", min_amount: "20000" }],
        },
      },
    });
    renderRoute("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Income" }));
    const box = screen.getByRole("checkbox", { name: "Triggers refill" });
    expect(box).not.toBeChecked();
    await userEvent.type(amount(), "25000");
    await userEvent.type(screen.getByRole("combobox", { name: "From" }), "employer as");
    expect(box).toBeChecked();
  });

  it("fills in what was used last time with a counterparty", async () => {
    localStorage.setItem("bucky.lastAccount", "2345");
    const rema: CounterpartySuggestion = {
      counterparty: "Rema 1000",
      type: "EXP",
      at: "2026-10-20T10:00:00Z",
      account_id: main.id,
      tags: ["food"],
      bucket_ids: [groceries.id],
    };
    apiMock.on("GET /api/v1/counterparties", { body: [rema] });
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "80");
    await userEvent.type(screen.getByRole("combobox", { name: "Paid to" }), "Re");
    await userEvent.click(await screen.findByRole("option", { name: "Rema 1000" }));

    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Account" }).value).toMatch(
      /^Main account/,
    );
    expect(screen.getByText("food")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount for Groceries" })).toHaveValue("80.00");
  });

  it("keeps type, account and date for the next one, and Save goes back", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    const { router } = renderRoute("/accounts");
    await screen.findByRole("heading", { name: "Accounts" });
    await router.navigate("/transactions/new");
    await userEvent.click(await screen.findByRole("radio", { name: "Income" }));
    await userEvent.type(amount(), "100");
    await userEvent.click(screen.getByRole("button", { name: "Save and add another" }));
    expect(await screen.findByText("Income saved.")).toBeInTheDocument();
    expect(amount()).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Income" })).toBeChecked();
    expect(router.state.location.pathname).toBe("/transactions/new");

    await userEvent.type(amount(), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/accounts");
    });
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(2);
  });

  it("sends a description, trimmed, and clears it for the next one (#130)", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "4000");
    const description = screen.getByRole("textbox", { name: "Description" });
    await userEvent.type(description, "  New winter tyres{enter}fitted too ");
    await userEvent.click(screen.getByRole("button", { name: "Save and add another" }));
    await waitFor(() => {
      expect(sent()?.description).toBe("New winter tyres\nfitted too");
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("");
    });

    // Without one, none is sent.
    await userEvent.type(amount(), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save and add another" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(2);
    });
    expect(sent()).not.toHaveProperty("description");
  });

  it("hides the description behind Add description on mobile (#130)", async () => {
    viewport.width = 390;
    localStorage.setItem("bucky.lastAccount", "1234");
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "80");
    expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add description" }));
    const description = screen.getByRole("textbox", { name: "Description" });
    expect(description).toHaveFocus();
    await userEvent.type(description, "Split dinner with Kari");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()?.description).toBe("Split dinner with Kari");
    });
  });

  it("needs an active cycle for bucket lines", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/transactions/new");
    expect(await screen.findByText(/Bucket lines need an active cycle/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add bucket" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Income" }));
    expect(screen.queryByRole("checkbox", { name: "Triggers refill" })).not.toBeInTheDocument();
  });

  it("counts a card purchase in its buckets as it's paid off (#264)", async () => {
    const visa = account({
      id: "4567",
      name: "Visa",
      type: "credit_card",
      balance: "-4520.00",
      credit_card: creditCard(),
    });
    apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main, visa] });
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "3000");
    await pick("Account", /^Visa/);
    await userEvent.click(screen.getByRole("button", { name: "Add bucket" }));
    await pick("Bucket", /^Groceries/);
    expect(screen.getByRole("combobox", { name: "Count in bucket" })).toHaveValue("Now");
    await pick("Count in bucket", "As it's paid off");
    expect(screen.getByText(/oldest debt first/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        account_id: "4567",
        bucket_lines: [{ bucket_id: "1000000001", amount: "3000.00" }],
        count_later: { when: "paid" },
      });
    });
  });

  it("counts a purchase in a later cycle or month, without an active cycle (#264)", async () => {
    localStorage.setItem("bucky.lastAccount", "1234");
    const later = cycle({
      id: "100001000002",
      state: "future",
      start_at: "2099-03-01T00:00:00Z",
      end_at: "2099-04-01T00:00:00Z",
    });
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: later } });
    apiMock.on("GET /api/v1/cycles", { body: [later] });
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "800");
    expect(screen.getByText(/Bucket lines need an active cycle/)).toBeInTheDocument();
    // Only a card can wait until it's paid off.
    await userEvent.click(screen.getByRole("combobox", { name: "Count in bucket" }));
    expect(screen.queryByRole("option", { name: "As it's paid off" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "In a later cycle" }));
    // Counting later needs no active cycle.
    await userEvent.click(screen.getByRole("button", { name: "Add bucket" }));
    await pick("Bucket", /^Household/);
    // The first planned cycle is picked.
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Cycle" }).value).toMatch(/2099/);
    // A month instead: the first cycle starting in or after it.
    await pick("Count in bucket", "In a month");
    expect(screen.getByRole("combobox", { name: "Month" })).not.toHaveValue("");
    await pick("Count in bucket", "In a later cycle");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent()).toMatchObject({
        count_later: { when: "cycle", cycle_id: "100001000002" },
        bucket_lines: [{ bucket_id: "1000000002", amount: "800.00" }],
      });
    });
  });

  it("keeps Save at hand on mobile", async () => {
    viewport.width = 390;
    renderRoute("/transactions/new");
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and add another" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Internal payment (later)" }),
    ).not.toBeInTheDocument();
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", {
      body: { ...testUser, preferences: { ...testUser.preferences, language: "nn" } },
    });
    renderRoute("/transactions/new");
    expect(await screen.findByRole("radio", { name: "Utgift" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Betalt til" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lagre" })).toBeInTheDocument();
  });
});
