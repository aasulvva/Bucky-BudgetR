import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { account, bucket, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main" });
const buffer = account({ id: "2345", name: "Buffer", type: "savings" });
const bsu = account({ id: "4567", name: "Home", type: "bsu" });
const holiday = bucket({
  id: "1000000001",
  name: "Holiday",
  source_account_id: main.id,
  refill_mode: "fully_manual",
  cap_mode: "fixed",
  capacity: "3000.00",
});
const food = bucket({ id: "1000000002", name: "Food", source_account_id: main.id });
const rainy = savingsTarget({
  id: "1000001001",
  name: "Buffer",
  account_id: buffer.id,
  held_total: "300.00",
  held: [{ account_id: main.id, amount: "300.00", covered: "300.00" }],
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, bsu, main] });
  apiMock.on("GET /api/v1/buckets", { body: [food, holiday] });
  apiMock.on("GET /api/v1/savings/targets", { body: [rainy] });
});

describe("Savings setup", () => {
  it("makes a Fully manual bucket a target, its goal within the capacity", async () => {
    apiMock.on("POST /api/v1/savings/targets", {
      status: 201,
      body: savingsTarget({
        id: "1000001002",
        name: "Holiday",
        bucket_id: holiday.id,
        account_id: null,
      }),
    });
    const { router } = renderRoute("/savings/setup?new");
    const form = within(await screen.findByRole("form", { name: "New savings target" }));
    await userEvent.click(form.getByRole("combobox", { name: "Bucket" }));
    // Only the Fully manual bucket.
    expect(screen.queryByRole("option", { name: "Food" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Holiday" }));
    expect(form.getByText(`At most the bucket's capacity, ${m("3000.00")}.`)).toBeInTheDocument();

    const goal = form.getByRole("textbox", { name: "Goal" });
    await userEvent.type(goal, "3500");
    await userEvent.click(form.getByRole("button", { name: "Create target" }));
    expect(
      form.getByText(`The goal can't be above the bucket's capacity, ${m("3000.00")}.`),
    ).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/savings/targets")).toHaveLength(0);

    await userEvent.clear(goal);
    await userEvent.type(goal, "2500");
    await userEvent.click(form.getByRole("button", { name: "Create target" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("?edit=1000001002");
    });
    expect(apiMock.calls("POST /api/v1/savings/targets")[0]?.body).toEqual({
      bucket_id: holiday.id,
      goal: "2500.00",
    });
  });

  it("offers only savings-type accounts that aren't targets yet", async () => {
    renderRoute("/savings/setup?new");
    const form = within(await screen.findByRole("form", { name: "New savings target" }));
    await userEvent.click(form.getByRole("radio", { name: "An account" }));
    await userEvent.click(form.getByRole("combobox", { name: "Account" }));
    expect(await screen.findByRole("option", { name: "Home (BSU)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Buffer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Main/ })).not.toBeInTheDocument();
  });

  it("deletes a target, saying what's released", async () => {
    apiMock.on("DELETE /api/v1/savings/targets/1000001001", { status: 204 });
    const { router } = renderRoute("/savings/setup?edit=1000001001");
    const form = within(await screen.findByRole("form", { name: "Buffer" }));
    await userEvent.click(form.getByRole("button", { name: "Delete target" }));
    expect(screen.getByText("What's held for it goes back to unallocated:")).toBeInTheDocument();
    expect(screen.getByText(`${m("300.00")} on Main`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete target" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("");
    });
    expect(apiMock.calls("DELETE /api/v1/savings/targets/1000001001")).toHaveLength(1);
  });
});
