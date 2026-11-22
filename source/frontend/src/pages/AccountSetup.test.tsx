import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem } from "@/test/api";
import { account, budgetEntry, bucket, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";

const main = account({ id: "1234", name: "Main account", balance: "100.00" });
const buffer = account({ id: "2345", name: "Buffer account", type: "savings" });
const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });
const groceries = bucket({
  id: "1000000001",
  name: "Groceries",
  source_account_id: main.id,
});

beforeEach(() => {
  apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main] });
});

/** Chooses an option in a select. The page has one select with each label. */
async function pick(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Account setup", () => {
  it("lists the accounts", async () => {
    renderRoute("/accounts/setup");
    const row = within((await screen.findByText("Euro account")).closest("tr") as HTMLElement);
    expect(row.getByText("EUR")).toBeInTheDocument();
    expect(row.getByText("(#3456)")).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Edit Euro account" })).toBeInTheDocument();
  });

  it("creates an account with an opening balance", async () => {
    apiMock.on("POST /api/v1/accounts", (req) => ({
      status: 201,
      body: account({ id: "4567", name: (req.body as { name: string }).name }),
    }));
    renderRoute("/accounts/setup");
    await userEvent.click(await screen.findByRole("button", { name: "New account" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New account" }));

    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));
    expect(dialog.getByText("Enter a name.")).toBeInTheDocument();

    await userEvent.type(dialog.getByRole("textbox", { name: /Name/ }), " BSU ");
    await pick("Type", "BSU");
    await userEvent.type(dialog.getByRole("textbox", { name: "Opening balance" }), "18400");
    expect(dialog.getByLabelText("Opening balance as of")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("BSU created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts")[0]?.body).toEqual({
      name: "BSU",
      type: "bsu",
      currency: "NOK",
      opening_balance: "18400.00",
    });
    expect(screen.queryByRole("dialog", { name: "New account" })).not.toBeInTheDocument();
  });

  it("says when the name is taken", async () => {
    apiMock.on(
      "POST /api/v1/accounts",
      problem(409, "name_taken", "An account with that name exists."),
    );
    renderRoute("/accounts/setup");
    await userEvent.click(await screen.findByRole("button", { name: "New account" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New account" }));
    await userEvent.type(dialog.getByRole("textbox", { name: /Name/ }), "main account");
    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));
    expect(
      await dialog.findByText("You already have an account with this name."),
    ).toBeInTheDocument();
  });

  it("opens an account from ?edit= and saves only what changed", async () => {
    apiMock.on("PATCH /api/v1/accounts/2345", {
      body: { ...buffer, type: "bsu" },
    });
    const { router } = renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    expect(dialog.getByRole("textbox", { name: /Name/ })).toHaveValue("Buffer account");
    expect(dialog.getByRole("textbox", { name: "Currency" })).toHaveAttribute("readonly");
    const save = dialog.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await pick("Type", "BSU");
    await userEvent.click(save);
    expect(await screen.findByText("Buffer account saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/accounts/2345")[0]?.body).toEqual({
      type: "bsu",
    });
    expect(router.state.location.search).toBe("");
  });

  it("sets a bank, suggesting the other accounts' banks, and lists it (#70)", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, { ...main, bank: "DNB" }] });
    apiMock.on("POST /api/v1/accounts", (req) => ({
      status: 201,
      body: account({ id: "4567", name: (req.body as { name: string }).name, bank: "DNB" }),
    }));
    renderRoute("/accounts/setup");
    const row = within((await screen.findByText("Main account")).closest("tr") as HTMLElement);
    expect(row.getByText("DNB")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "New account" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New account" }));
    await userEvent.type(dialog.getByRole("textbox", { name: /Name/ }), "Savings");
    await userEvent.click(dialog.getByRole("combobox", { name: /Bank/ }));
    await userEvent.click(await dialog.findByRole("option", { name: "DNB" }));
    await userEvent.click(dialog.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Savings created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts")[0]?.body).toMatchObject({
      name: "Savings",
      bank: "DNB",
    });
  });

  it("offers to give the earlier interest the new bank's name (#70)", async () => {
    const dnb = { ...main, bank: "DNB" };
    apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, dnb] });
    apiMock.on("PATCH /api/v1/accounts/1234", { body: { ...dnb, bank: "Sbanken" } });
    apiMock.on("POST /api/v1/transactions/counterparty-rename", { body: { count: 2 } });
    const { router } = renderRoute("/accounts/setup?edit=1234");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    const bank = dialog.getByRole("combobox", { name: /Bank/ });
    expect(bank).toHaveValue("DNB");
    await userEvent.clear(bank);
    await userEvent.type(bank, "Sbanken");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    expect(
      await dialog.findByText(
        "2 earlier interest incomes on Main account have the counterparty Interest or the old bank. Change them to Sbanken? Each one is corrected, so the change stays in its history.",
      ),
    ).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/accounts/1234")[0]?.body).toEqual({ bank: "Sbanken" });
    const renames = () => apiMock.calls("POST /api/v1/transactions/counterparty-rename");
    expect(renames()[0]?.body).toEqual({
      account_id: "1234",
      type: "INC",
      tag: "interest",
      from: ["Interest", "Renter", "DNB"],
      to: "Sbanken",
      apply: false,
    });

    await userEvent.click(dialog.getByRole("button", { name: "Update 2" }));
    expect(
      await screen.findByText("2 interest incomes now have Sbanken as their counterparty."),
    ).toBeInTheDocument();
    expect(renames()[1]?.body).toMatchObject({ apply: true, to: "Sbanken" });
    expect(router.state.location.search).toBe("");
  });

  it.each([
    [0, "closes without an offer when no earlier interest matches"],
    [1, "closes when the offer is left"],
  ])("with %i to rename, %s", async (count) => {
    apiMock.on("PATCH /api/v1/accounts/2345", { body: { ...buffer, bank: "DNB" } });
    apiMock.on("POST /api/v1/transactions/counterparty-rename", { body: { count } });
    const { router } = renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.type(dialog.getByRole("combobox", { name: /Bank/ }), "DNB");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Buffer account saved.")).toBeInTheDocument();
    if (count > 0) {
      await userEvent.click(await dialog.findByRole("button", { name: "Leave as they are" }));
    }
    expect(router.state.location.search).toBe("");
    expect(apiMock.calls("POST /api/v1/transactions/counterparty-rename")).toHaveLength(1);
  });

  it("opens the edit dialog from the list", async () => {
    const { router } = renderRoute("/accounts/setup");
    await userEvent.click(await screen.findByRole("button", { name: "Edit Main account" }));
    expect(await screen.findByRole("dialog", { name: "Edit account" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?edit=1234");
  });

  it("settles an account's money and buckets when deleting it", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [groceries] });
    apiMock.on("POST /api/v1/accounts/1234/delete", { status: 204 });
    renderRoute("/accounts/setup?edit=1234");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));

    expect(await dialog.findByText(/still holds/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    expect(dialog.getByText("Choose an account.")).toBeInTheDocument();
    expect(dialog.getByText("Choose an account, or delete it.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/1234/delete")).toHaveLength(0);

    // Only accounts in the same currency are offered.
    await userEvent.click(dialog.getByRole("combobox", { name: "Transfer to" }));
    expect(screen.queryByRole("option", { name: "Euro account" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Buffer account" }));
    await pick("Groceries", "Buffer account");
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("Main account deleted.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/1234/delete")[0]?.body).toEqual({
      remaining_funds: { action: "transfer", to_account_id: "2345" },
      bucket_sources: { "1000000001": "2345" },
    });
  });

  it("can adjust the money away instead", async () => {
    apiMock.on("POST /api/v1/accounts/1234/delete", { status: 204 });
    renderRoute("/accounts/setup?edit=1234");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    await userEvent.click(await dialog.findByRole("radio", { name: /Adjust the balance to 0/ }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    await screen.findByText("Main account deleted.");
    expect(apiMock.calls("POST /api/v1/accounts/1234/delete")[0]?.body).toEqual({
      remaining_funds: { action: "adjust" },
    });
  });

  it("deletes an empty account without questions", async () => {
    apiMock.on("POST /api/v1/accounts/2345/delete", { status: 204 });
    renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    await userEvent.click(await dialog.findByRole("button", { name: "Delete account" }));
    await screen.findByText("Buffer account deleted.");
    expect(apiMock.calls("POST /api/v1/accounts/2345/delete")[0]?.body).toBeUndefined();
  });

  it("names the savings budget's fixed amounts it deletes (#234)", async () => {
    apiMock.on("GET /api/v1/savings/targets", {
      body: [savingsTarget({ id: "1000001001", name: "Rainy day" })],
    });
    apiMock.on("GET /api/v1/savings/budget", {
      body: [
        budgetEntry({ id: "2345000001", account_id: "2345", target_id: "1000001001" }),
        budgetEntry({ id: "1234000001", account_id: "1234" }),
      ],
    });
    renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(
      await dialog.findByText(
        /^Deletes 1 entry in the savings budget: .*500\.00 to Rainy day\. What it reserved/,
      ),
    ).toBeInTheDocument();
  });

  it("explains when buckets have nowhere to go", async () => {
    // Funds left, no other EUR account, and no cycle to release them in.
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    apiMock.on("GET /api/v1/buckets", {
      body: [
        bucket({
          id: "1000000002",
          name: "Trip",
          source_account_id: euro.id,
          currency: "EUR",
          target_funds: "40.00",
        }),
      ],
    });
    renderRoute("/accounts/setup?edit=3456");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(await dialog.findByText(/no other EUR account to move them to/)).toBeInTheDocument();
    expect(dialog.getByText(/Releasing what's left needs an active cycle/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete account" })).toBeDisabled();
  });
});

describe("Account setup, deleting buckets with the account (#137)", () => {
  const rent = bucket({
    id: "1000000003",
    name: "Rent",
    source_account_id: main.id,
    target_funds: "250.00",
  });

  async function openDelete() {
    renderRoute("/accounts/setup?edit=1234");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    await dialog.findByText(/still holds/);
    await userEvent.click(dialog.getByRole("radio", { name: /Adjust the balance to 0/ }));
    return dialog;
  }

  it("deletes some buckets and moves others", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [groceries, rent] });
    apiMock.on("POST /api/v1/accounts/1234/delete", { status: 204 });
    const dialog = await openDelete();
    await pick("Rent", "Delete the bucket");
    expect(
      dialog.getByText(/Its NOK\s250\.00 left goes back to the account first/),
    ).toBeInTheDocument();
    expect(
      dialog.getByText("Deletes 1 bucket with the account: Rent. Its transactions are kept."),
    ).toBeInTheDocument();
    await pick("Groceries", "Buffer account");
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("Main account deleted.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/1234/delete")[0]?.body).toEqual({
      remaining_funds: { action: "adjust" },
      bucket_sources: { "1000000001": "2345" },
      delete_buckets: ["1000000003"],
    });
  });

  it("sets them all at once", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [groceries, rent] });
    apiMock.on("POST /api/v1/accounts/1234/delete", { status: 204 });
    const dialog = await openDelete();
    await userEvent.click(dialog.getByRole("button", { name: "Delete them all" }));
    expect(dialog.getByRole("combobox", { name: "Groceries" })).toHaveValue("Delete the bucket");
    expect(dialog.getByRole("combobox", { name: "Rent" })).toHaveValue("Delete the bucket");

    await pick("Move all to…", "Buffer account");
    expect(dialog.getByRole("combobox", { name: "Groceries" })).toHaveValue("Buffer account");
    expect(dialog.getByRole("combobox", { name: "Rent" })).toHaveValue("Buffer account");
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    await screen.findByText("Main account deleted.");
    expect(apiMock.calls("POST /api/v1/accounts/1234/delete")[0]?.body).toEqual({
      remaining_funds: { action: "adjust" },
      bucket_sources: { "1000000001": "2345", "1000000003": "2345" },
    });
  });

  it("can't delete a bucket with funds left without a cycle, but one at 0", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    apiMock.on("GET /api/v1/buckets", { body: [groceries, rent] });
    const dialog = await openDelete();
    expect(dialog.getByText(/Releasing what's left needs an active cycle/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("combobox", { name: "Rent" }));
    expect(await screen.findByRole("option", { name: "Delete the bucket" })).toHaveAttribute(
      "data-combobox-disabled",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    await pick("Groceries", "Delete the bucket");
    expect(dialog.getByRole("combobox", { name: "Groceries" })).toHaveValue("Delete the bucket");
  });

  it("deletes the buckets when there's no other account to move them to", async () => {
    apiMock.on("GET /api/v1/buckets", {
      body: [
        bucket({
          id: "1000000002",
          name: "Trip",
          source_account_id: euro.id,
          currency: "EUR",
        }),
      ],
    });
    apiMock.on("POST /api/v1/accounts/3456/delete", { status: 204 });
    renderRoute("/accounts/setup?edit=3456");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(dialog.queryByText(/no other EUR account/)).not.toBeInTheDocument();
    await pick("Trip", "Delete the bucket");
    await userEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    await screen.findByText("Euro account deleted.");
    expect(apiMock.calls("POST /api/v1/accounts/3456/delete")[0]?.body).toEqual({
      delete_buckets: ["1000000002"],
    });
  });
});
