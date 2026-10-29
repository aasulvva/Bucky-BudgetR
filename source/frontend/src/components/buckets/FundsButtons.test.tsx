import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

// Σ positive TF 1 300 of a 1 500 balance: 200 unallocated.
const main = account({
  id: "1234",
  name: "Main account",
  balance: "1500.00",
  unallocated: "200.00",
});
const manual = {
  source_account_id: main.id,
  refill_mode: "fully_manual" as const,
  keep_funds: true,
  cap_multiplier: null,
};
const holiday = bucket({
  ...manual,
  id: "1000000001",
  name: "Holiday",
  cap_mode: "fixed",
  cap_amount: "1000.00",
  capacity: "1000.00",
  target_funds: "700.00",
  current_available_funds: "700.00",
});
const gifts = bucket({
  ...manual,
  id: "1000000002",
  name: "Gifts",
  cap_mode: "none",
  capacity: null,
});
const food = bucket({
  id: "1000000003",
  name: "Food",
  source_account_id: main.id,
  refill_amount: "600.00",
  capacity: "600.00",
  target_funds: "600.00",
  current_available_funds: "600.00",
  refilled: true,
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main] });
  apiMock.on("GET /api/v1/buckets", { body: [food, gifts, holiday] });
});

const open = async (button: string, title: string) => {
  renderRoute("/buckets");
  await userEvent.click(await screen.findByRole("button", { name: button }));
  return within(await screen.findByRole("dialog", { name: title }));
};

const closed = () =>
  waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

describe("Fully manual buckets", () => {
  it("add funds up to the capacity, warning when the account falls short", async () => {
    apiMock.on("POST /api/v1/buckets/1000000001/adjustment", { body: holiday });
    const dialog = await open("Add funds to Holiday", "Add funds: Holiday");
    expect(
      dialog.getByText(`Taken from the unallocated money in Main account (${m("200.00")}).`),
    ).toBeInTheDocument();
    const add = dialog.getByRole("button", { name: "Add funds" });
    expect(add).toBeDisabled();

    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "400");
    expect(
      dialog.getByText(`The capacity is ${m("1000.00")}, so you can add at most ${m("300.00")}.`),
    ).toBeInTheDocument();
    expect(add).toBeDisabled();

    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "300");
    expect(
      dialog.getByText(
        `Holiday: ${m("700.00")} → ${m("1000.00")}, a bucket adjustment of +${m("300.00")}`,
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(
        `Main account doesn't have that much unallocated: its balance will be ${m("100.00")} short of what's left in its buckets.`,
      ),
    ).toBeInTheDocument();
    await userEvent.click(add);
    expect(await screen.findByText(`Added ${m("300.00")} to Holiday.`)).toBeInTheDocument();
    await closed();
    expect(apiMock.calls("POST /api/v1/buckets/1000000001/adjustment").map((c) => c.body)).toEqual([
      { mode: "temporary", target_funds: "1000.00" },
    ]);
  });

  it("removes funds down to 0", async () => {
    apiMock.on("POST /api/v1/buckets/1000000001/adjustment", { body: holiday });
    const dialog = await open("Remove funds from Holiday", "Remove funds: Holiday");
    expect(
      dialog.getByText("Goes back to the unallocated money in Main account."),
    ).toBeInTheDocument();
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "800");
    expect(dialog.getByText(`Holiday only has ${m("700.00")}.`)).toBeInTheDocument();
    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "700");
    expect(
      dialog.getByText(
        `Holiday: ${m("700.00")} → ${m("0.00")}, a bucket adjustment of ${m("-700.00")}`,
      ),
    ).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Remove funds" }));
    expect(await screen.findByText(`Removed ${m("700.00")} from Holiday.`)).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets/1000000001/adjustment").map((c) => c.body)).toEqual([
      { mode: "temporary", target_funds: "0.00" },
    ]);
  });

  it("replace Refill, with no refill status, and only while a cycle runs", async () => {
    renderRoute("/buckets");
    expect(await screen.findByRole("button", { name: "Remove funds from Gifts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add funds to Gifts" })).toBeEnabled();
    expect(screen.getAllByText("Fully manual · keeps funds")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add funds to Food" })).not.toBeInTheDocument();
  });

  it("has no buttons without an active cycle", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/buckets");
    expect(await screen.findAllByText("Fully manual · keeps funds")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add funds to Holiday" })).not.toBeInTheDocument();
  });

  it("has full-width buttons on mobile", async () => {
    viewport.width = 390;
    renderRoute("/buckets");
    const card = within(await screen.findByRole("article", { name: "Holiday" }));
    expect(card.getByRole("button", { name: "Add funds to Holiday" })).toHaveTextContent(
      "Add funds",
    );
    expect(card.getByRole("button", { name: "Remove funds from Holiday" })).toBeEnabled();
  });

  it("only move what's left, up to a capacity", async () => {
    apiMock.on("POST /api/v1/buckets/1000000003/transfer", { body: { from: food, to: holiday } });
    const dialog = await open("Adjust funds for Food", "Adjust funds: Food");
    await userEvent.click(dialog.getByRole("radio", { name: "Move to another bucket" }));
    await userEvent.click(dialog.getByRole("combobox", { name: "To bucket" }));
    await userEvent.click(await screen.findByRole("option", { name: "Holiday" }));
    expect(
      dialog.getByText("A fully manual bucket has no refill amount, so only what's left moves."),
    ).toBeInTheDocument();
    expect(dialog.queryByRole("radio", { name: /^From next refill/ })).not.toBeInTheDocument();
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "400");
    expect(dialog.getByText(`Holiday can hold at most ${m("1000.00")}.`)).toBeInTheDocument();
    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "300");
    await userEvent.click(dialog.getByRole("button", { name: "Move funds" }));
    await closed();
    expect(apiMock.calls("POST /api/v1/buckets/1000000003/transfer").map((c) => c.body)).toEqual([
      { to_bucket_id: holiday.id, mode: "temporary", amount: "300.00" },
    ]);
  });

  it("go straight to moving funds in Adjust funds", async () => {
    const dialog = await open("Adjust funds for Holiday", "Adjust funds: Holiday");
    expect(dialog.getByText(`Holds ${m("700.00")} · fully manual`)).toBeInTheDocument();
    expect(dialog.queryByRole("radio", { name: "Adjust" })).not.toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "Move to another bucket" })).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "To bucket" })).toBeInTheDocument();
  });
});
