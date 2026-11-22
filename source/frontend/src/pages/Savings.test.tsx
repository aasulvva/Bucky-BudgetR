import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { account, bucket, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");
/** An amount in an input's value, which keeps the no-break spaces. */
const raw = (amount: string) => formatMoney(amount, "NOK");

const main = account({ id: "1234", name: "Main", balance: "10000.00", unallocated: "4000.00" });
const other = account({ id: "3456", name: "Other", balance: "1000.00", unallocated: "500.00" });
const buffer = account({ id: "2345", name: "Buffer", type: "savings", balance: "1500.00" });
const holiday = bucket({
  id: "1000000001",
  name: "Holiday",
  source_account_id: main.id,
  refill_mode: "fully_manual",
  cap_mode: "fixed",
  capacity: "3000.00",
  target_funds: "1000.00",
});
const rainy = savingsTarget({
  id: "1000001001",
  name: "Rainy day",
  custom_name: "Rainy day",
  account_id: buffer.id,
  current: "1500.00",
  held_total: "800.00",
  held: [
    { account_id: main.id, amount: "500.00", covered: "500.00" },
    { account_id: other.id, amount: "300.00", covered: "100.00" },
  ],
  note: "For the car",
});
const trip = savingsTarget({
  id: "1000001002",
  name: "Holiday",
  account_id: null,
  bucket_id: holiday.id,
  goal: "3000.00",
  current: "1000.00",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, main, other] });
  apiMock.on("GET /api/v1/buckets", { body: [holiday] });
  apiMock.on("GET /api/v1/savings/targets", { body: [rainy, trip] });
});

const card = async (name: string) => within(await screen.findByRole("region", { name }));

const closed = () =>
  waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

describe("Savings", () => {
  it("shows each target's progress and what's held for it", async () => {
    renderRoute("/savings");
    const rainyCard = await card("Rainy day");
    expect(rainyCard.getByText("Savings")).toBeInTheDocument();
    expect(rainyCard.getByText(`${m("2300.00")} of ${m("10000.00")}`)).toBeInTheDocument();
    expect(rainyCard.getByText(`${m("7700.00")} to go`)).toBeInTheDocument();
    expect(rainyCard.getByText(`${m("500.00")} on Main`)).toBeInTheDocument();
    expect(
      rainyCard.getByText(`${m("200.00")} not covered: the account's buckets come first`),
    ).toBeInTheDocument();
    expect(rainyCard.getByText("For the car")).toBeInTheDocument();

    const tripCard = await card("Holiday");
    expect(tripCard.getByText("Bucket on Main")).toBeInTheDocument();
    expect(tripCard.queryByRole("button", { name: /^Done/ })).not.toBeInTheDocument();
  });

  it("says how to start without targets", async () => {
    apiMock.on("GET /api/v1/savings/targets", { body: [] });
    renderRoute("/savings");
    expect(await screen.findByText("No savings targets yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New savings target" })).toHaveAttribute(
      "href",
      "/savings/setup?new",
    );
  });

  it("adds to savings from unallocated money, at most what's there", async () => {
    apiMock.on("POST /api/v1/savings/targets/1000001001/add", { body: rainy });
    renderRoute("/savings");
    await userEvent.click(
      (await card("Rainy day")).getByRole("button", { name: "Add to savings for Rainy day" }),
    );
    const dialog = within(await screen.findByRole("dialog", { name: "Add to savings: Rainy day" }));
    // The account with the most unallocated, and not Buffer itself.
    expect(dialog.getByRole("combobox", { name: "From" })).toHaveValue(
      `Main (${raw("4000.00")} unallocated)`,
    );
    const amount = dialog.getByRole("textbox", { name: "Amount" });
    await userEvent.type(amount, "4000.01");
    await userEvent.tab();
    expect(
      dialog.getByText(`The account has only ${m("4000.00")} unallocated.`),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Add to savings" })).toBeDisabled();

    await userEvent.clear(amount);
    await userEvent.type(amount, "250");
    expect(
      dialog.getByText(
        `${m("250.00")} of Main's unallocated money is held for Rainy day until you move it.`,
      ),
    ).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Add to savings" }));
    await closed();
    expect(apiMock.calls("POST /api/v1/savings/targets/1000001001/add")[0]?.body).toEqual({
      account_id: main.id,
      amount: "250.00",
    });
  });

  it("puts money straight into a bucket target from its own account", async () => {
    renderRoute("/savings");
    await userEvent.click(
      (await card("Holiday")).getByRole("button", { name: "Add to savings for Holiday" }),
    );
    const dialog = within(await screen.findByRole("dialog", { name: "Add to savings: Holiday" }));
    expect(dialog.getByRole("combobox", { name: "From" })).toHaveValue(
      `Main (${raw("4000.00")} unallocated)`,
    );
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "2500");
    await userEvent.tab();
    expect(
      dialog.getByText(`The bucket's capacity leaves room for ${m("2000.00")}.`),
    ).toBeInTheDocument();
    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "500");
    expect(
      dialog.getByText(`${m("500.00")} goes straight into Holiday from Main's unallocated money.`),
    ).toBeInTheDocument();
  });

  it("records held money as moved, all of it by default", async () => {
    apiMock.on("POST /api/v1/savings/targets/1000001001/done", { body: rainy });
    renderRoute("/savings");
    await userEvent.click(
      (await card("Rainy day")).getByRole("button", { name: "Done for Rainy day on Main" }),
    );
    const dialog = within(await screen.findByRole("dialog", { name: "Done: Rainy day" }));
    expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("500.00");
    expect(
      dialog.getByText(`Records a transfer of ${m("500.00")} from Main to Buffer.`),
    ).toBeInTheDocument();
    await userEvent.type(dialog.getByRole("textbox", { name: "Description" }), "Monthly");
    await userEvent.click(dialog.getByRole("button", { name: "Done" }));
    await closed();
    expect(apiMock.calls("POST /api/v1/savings/targets/1000001001/done")[0]?.body).toEqual({
      account_id: main.id,
      amount: "500.00",
      description: "Monthly",
    });
  });

  it("clears part of what's held, not more than that", async () => {
    apiMock.on("POST /api/v1/savings/targets/1000001001/clear", { body: rainy });
    renderRoute("/savings");
    await userEvent.click(
      (await card("Rainy day")).getByRole("button", { name: "Clear for Rainy day on Other" }),
    );
    const dialog = within(await screen.findByRole("dialog", { name: "Clear: Rainy day" }));
    const amount = dialog.getByRole("textbox", { name: "Amount" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "301");
    expect(dialog.getByText(`Only ${m("300.00")} is held on this account.`)).toBeInTheDocument();
    await userEvent.clear(amount);
    await userEvent.type(amount, "100");
    expect(
      dialog.getByText(`${m("100.00")} goes back to Other's unallocated money.`),
    ).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Clear" }));
    await closed();
    expect(apiMock.calls("POST /api/v1/savings/targets/1000001001/clear")[0]?.body).toEqual({
      account_id: other.id,
      amount: "100.00",
    });
  });
});
