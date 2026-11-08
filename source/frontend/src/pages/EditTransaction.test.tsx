import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock } from "@/test/api";
import { account, bucket, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

const main = account({ id: "1234", name: "Main account", balance: "1000.00" });
const buffer = account({ id: "2345", name: "Buffer account", balance: "500.00" });
const groceries = bucket({ id: "1000000001", name: "Groceries", source_account_id: main.id });
const household = bucket({ id: "1000000002", name: "Household", source_account_id: main.id });

const rema = transaction({
  id: "2026102300000001",
  counterparty: "Rema 1000",
  tags: ["food"],
  bank_lines: [{ account_id: main.id, amount: "-250.40" }],
  bucket_lines: [{ bucket_id: groceries.id, cycle_id: cycle().id, amount: "-200.40" }],
});
const path = `/api/v1/transactions/${rema.id}`;

function sent(): Record<string, unknown> | undefined {
  return apiMock.calls(`POST ${path}/correction`).at(-1)?.body as
    Record<string, unknown> | undefined;
}

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main, buffer] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries, household] });
  apiMock.on(`GET ${path}`, { body: { ...rema, history: [] } });
  apiMock.on(`POST ${path}/correction`, { body: rema });
});

const amount = () => screen.getByRole("textbox", { name: "Amount" });

describe("Edit transaction", () => {
  it("starts from the transaction and sends only what changed", async () => {
    const { router } = renderRoute(`/transactions/${rema.id}/edit`);
    expect(
      await screen.findByRole("heading", { name: `Edit expense (#${rema.id})` }),
    ).toBeInTheDocument();
    expect(amount()).toHaveValue("250.40");
    expect(screen.getByRole("combobox", { name: "Paid to" })).toHaveValue("Rema 1000");
    expect(screen.queryByRole("radio", { name: "Income" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and add another" })).not.toBeInTheDocument();
    // Nothing changed yet.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.clear(amount());
    await userEvent.type(amount(), "260");
    const split = within(screen.getByRole("region", { name: "Buckets" }));
    await userEvent.clear(split.getByRole("textbox", { name: "Amount for Groceries" }));
    await userEvent.type(split.getByRole("textbox", { name: "Amount for Groceries" }), "210");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Correction saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      amount: "260.00",
      bucket_lines: [{ bucket_id: groceries.id, amount: "210.00" }],
    });
    // Opened directly, so it goes to the transaction in the list.
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?open=${rema.id}`);
    });
  });

  it("changes only the description, shown at once on mobile when there is one (#130)", async () => {
    viewport.width = 390;
    apiMock.on(`GET ${path}`, { body: { ...rema, description: "Weekly shop", history: [] } });
    renderRoute(`/transactions/${rema.id}/edit`);
    const description = await screen.findByRole("textbox", { name: "Description" });
    expect(description).toHaveValue("Weekly shop");
    expect(screen.queryByRole("button", { name: "Add description" })).not.toBeInTheDocument();
    await userEvent.type(description, "{enter}and wine");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Correction saved.")).toBeInTheDocument();
    expect(sent()).toEqual({ description: "Weekly shop\nand wine" });
  });

  it("lets a bucket line that took the whole amount follow it", async () => {
    apiMock.on(`GET ${path}`, {
      body: {
        ...rema,
        bank_lines: [{ account_id: main.id, amount: "-150.00" }],
        bucket_lines: [{ bucket_id: groceries.id, cycle_id: cycle().id, amount: "-150.00" }],
        history: [],
      },
    });
    renderRoute(`/transactions/${rema.id}/edit`);
    expect(
      await screen.findByRole("heading", { name: `Edit expense (#${rema.id})` }),
    ).toBeInTheDocument();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "100");
    expect(screen.getByRole("textbox", { name: "Amount for Groceries" })).toHaveValue("100.00");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Correction saved.");
    expect(sent()).toEqual({
      amount: "100.00",
      bucket_lines: [{ bucket_id: groceries.id, amount: "100.00" }],
    });
  });

  it("moves the transaction to another account", async () => {
    apiMock.on(`POST ${path}/correction`, { body: { ...rema, id: "2026102300000099" } });
    renderRoute(`/transactions/${rema.id}/edit`);
    await userEvent.click(await screen.findByRole("combobox", { name: "Account" }));
    await userEvent.click(await screen.findByRole("option", { name: /^Buffer account/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Moved to the new account.")).toBeInTheDocument();
    // The Groceries line can't follow to the other account.
    expect(sent()).toEqual({ account_id: buffer.id, bucket_lines: [] });
  });

  it("keeps locked bucket lines read-only, but the amount editable", async () => {
    apiMock.on(`GET ${path}`, {
      body: { ...rema, at: "2026-01-15T12:00:00Z", history: [] },
    });
    renderRoute(`/transactions/${rema.id}/edit`);
    const split = within(await screen.findByRole("region", { name: "Buckets" }));
    expect(split.getByText(/in a cycle that has ended/)).toBeInTheDocument();
    expect(split.queryByRole("textbox")).not.toBeInTheDocument();
    expect(split.queryByRole("button", { name: "Add bucket" })).not.toBeInTheDocument();

    // Not below what's in the buckets.
    await userEvent.clear(amount());
    await userEvent.type(amount(), "100");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/The buckets get .*100\.40 more/);
    await userEvent.clear(amount());
    await userEvent.type(amount(), "300");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Correction saved.");
    expect(sent()).toEqual({ amount: "300.00" });
  });

  it("edits a balance adjustment's signed amount and text only", async () => {
    const bla = transaction({
      id: "2026102300000002",
      type: "BLA",
      bank_lines: [{ account_id: main.id, amount: "-12.00" }],
    });
    apiMock.on(`GET /api/v1/transactions/${bla.id}`, { body: { ...bla, history: [] } });
    apiMock.on(`POST /api/v1/transactions/${bla.id}/correction`, { body: bla });
    renderRoute(`/transactions/${bla.id}/edit`);
    expect(
      await screen.findByRole("heading", { name: `Edit balance adjustment (#${bla.id})` }),
    ).toBeInTheDocument();
    expect(amount()).toHaveValue("-12.00");
    expect(screen.getByRole("combobox", { name: "Account" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Buckets" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Counterparty" }), "Fund gains");
    await userEvent.type(screen.getByRole("textbox", { name: "Description" }), "Counted in March");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Correction saved.");
    expect(apiMock.calls(`POST /api/v1/transactions/${bla.id}/correction`).at(-1)?.body).toEqual({
      counterparty: "Fund gains",
      description: "Counted in March",
    });
  });

  it("says when a transaction can't be edited", async () => {
    apiMock.on(`GET ${path}`, { body: { ...rema, reversed: true, history: [] } });
    renderRoute(`/transactions/${rema.id}/edit`);
    expect(await screen.findByText(/has been reversed, so it can't change/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Amount" })).not.toBeInTheDocument();
  });
});
