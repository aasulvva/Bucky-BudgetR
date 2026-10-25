import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
import { renderRoute } from "@/test/render";

const main = account({ id: "1234", name: "Main account", balance: "100.00" });
const buffer = account({ id: "2345", name: "Buffer account", type: "savings" });
const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });
const groceries = bucket({ id: "1000000001", name: "Groceries", source_account_id: main.id });

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
    apiMock.on("PATCH /api/v1/accounts/2345", { body: { ...buffer, type: "bsu" } });
    const { router } = renderRoute("/accounts/setup?edit=2345");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    expect(dialog.getByRole("textbox", { name: /Name/ })).toHaveValue("Buffer account");
    expect(dialog.getByRole("textbox", { name: "Currency" })).toHaveAttribute("readonly");
    const save = dialog.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await pick("Type", "BSU");
    await userEvent.click(save);
    expect(await screen.findByText("Buffer account saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/accounts/2345")[0]?.body).toEqual({ type: "bsu" });
    expect(router.state.location.search).toBe("");
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
    expect(dialog.getAllByText("Choose an account.")).toHaveLength(2);
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

  it("explains when buckets have nowhere to go", async () => {
    apiMock.on("GET /api/v1/buckets", {
      body: [bucket({ id: "1000000002", name: "Trip", source_account_id: euro.id })],
    });
    renderRoute("/accounts/setup?edit=3456");
    const dialog = within(await screen.findByRole("dialog", { name: "Edit account" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    expect(await dialog.findByText(/no other EUR account to move them to/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete account" })).toBeDisabled();
  });
});
