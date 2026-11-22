import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatAmountInput, formatMoney } from "@/lib/money";
import { apiMock } from "@/test/api";
import { account, bucket, budgetEntry, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main" });
const buffer = account({ id: "2345", name: "Buffer", type: "savings" });
const bsu = account({ id: "4567", name: "Home", type: "bsu", balance: "25000.00" });
const holiday = bucket({
  id: "1000000001",
  name: "Holiday",
  source_account_id: main.id,
  refill_mode: "fully_manual",
  cap_mode: "fixed",
  capacity: "3000.00",
  target_funds: "1200.00",
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
    expect(form.getByText(`${m("1200.00")} in the bucket`)).toBeInTheDocument();
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
    expect(screen.queryByRole("option", { name: /^Buffer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Main/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Home (BSU)" }));
    expect(form.getByText(`${m("25000.00")} in the account`)).toBeInTheDocument();
  });

  it("deletes a target, saying what's released", async () => {
    apiMock.on("DELETE /api/v1/savings/targets/1000001001", { status: 204 });
    const { router } = renderRoute("/savings/setup?edit=1000001001");
    const form = within(await screen.findByRole("form", { name: "Buffer" }));
    expect(form.getByText(`${m("0.00")} in the account`)).toBeInTheDocument();
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

describe("the savings distributor (#232)", () => {
  const trip = savingsTarget({
    id: "1000001002",
    name: "Holiday",
    account_id: null,
    bucket_id: holiday.id,
    goal: "3000.00",
    current: "1200.00",
  });
  const low = {
    id: "100000100101",
    target_id: rainy.id,
    from: "0.00",
    to: "5000.00",
    priority: 4,
    past_goal: false,
  };
  const high = { ...low, id: "100000100102", from: "8000.00", to: null, priority: 1 };

  beforeEach(() => {
    apiMock.on("GET /api/v1/savings/targets", { body: [rainy, trip] });
    apiMock.on("GET /api/v1/savings/rules", { body: [low, high] });
    apiMock.on("GET /api/v1/savings/distributor/preview", {
      body: {
        shares: [
          { target_id: rainy.id, amount: "3000.00", into_bucket: false },
          { target_id: trip.id, amount: "2000.00", into_bucket: true },
        ],
        left: "0.00",
      },
    });
  });

  it("is first in the list, and sets the hold mode", async () => {
    apiMock.on("PATCH /api/v1/savings/distributor", {
      body: { id: "1000009999", hold_mode: "minimum", min_amount: "1000.00", held: [] },
    });
    renderRoute("/savings/setup?distributor");
    expect(await screen.findByRole("heading", { name: "Savings distributor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Savings distributor/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("radio", { name: /^Immediately/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /^At a minimum amount/ }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Minimum amount" }), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/savings/distributor")[0]?.body).toEqual({
        hold_mode: "minimum",
        min_amount: "1000.00",
      });
    });
  });

  it("edits each target's ranges, refusing overlaps and warning of gaps", async () => {
    apiMock.on("POST /api/v1/savings/rules", {
      status: 201,
      body: { ...low, id: "100000100201", target_id: trip.id, to: null, priority: 1 },
    });
    apiMock.on("DELETE /api/v1/savings/rules/100000100101", { status: 204 });
    renderRoute("/savings/setup?distributor");
    const buffer = within(await screen.findByRole("region", { name: "Buffer" }));
    expect(buffer.getByText(`${m("0.00")} – ${m("5000.00")}`)).toBeInTheDocument();
    expect(buffer.getByText("Priority 4")).toBeInTheDocument();
    expect(
      buffer.getByText(
        `Between ${m("5000.00")} and ${m("8000.00")}, Buffer gets nothing: no rule covers it.`,
      ),
    ).toBeInTheDocument();

    // A new range starts in the gap; up to 9 000 runs into 8 000 and up.
    await userEvent.click(buffer.getByRole("button", { name: "Add range for Buffer" }));
    const editor = within(buffer.getByRole("group", { name: "New range for Buffer" }));
    expect(editor.getByRole("textbox", { name: "From" })).toHaveValue(formatAmountInput("5000.00"));
    await userEvent.type(editor.getByRole("textbox", { name: "Up to" }), "9000");
    expect(editor.getByText(`The range overlaps ${m("8000.00")} and up.`)).toBeInTheDocument();
    expect(editor.getByRole("button", { name: "Add range" })).toBeDisabled();
    await userEvent.click(editor.getByRole("button", { name: "Cancel" }));

    const trip_ = within(screen.getByRole("region", { name: "Holiday" }));
    expect(trip_.getByText("No rules: it gets nothing from the distributor.")).toBeInTheDocument();
    await userEvent.click(trip_.getByRole("button", { name: "Add range for Holiday" }));
    const fresh = within(trip_.getByRole("group", { name: "New range for Holiday" }));
    await userEvent.click(fresh.getByRole("button", { name: "Add range" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/savings/rules")[0]?.body).toEqual({
        target_id: trip.id,
        from: "0.00",
        to: null,
        priority: 1,
        past_goal: false,
      });
    });

    await userEvent.click(
      buffer.getByRole("button", {
        name: `Delete ${formatMoney("0.00", "NOK")} – ${formatMoney("5000.00", "NOK")} for Buffer`,
      }),
    );
    await waitFor(() => {
      expect(apiMock.calls("DELETE /api/v1/savings/rules/100000100101")).toHaveLength(1);
    });
  });

  it("previews a split", async () => {
    renderRoute("/savings/setup?distributor");
    const preview = within(await screen.findByRole("region", { name: "Preview" }));
    const result = within(await preview.findByRole("list", { name: "The split" }));
    expect(result.getByText(m("3000.00"))).toBeInTheDocument();
    expect(result.getByText(/into the bucket/)).toBeInTheDocument();
    const query = apiMock.calls("GET /api/v1/savings/distributor/preview")[0]?.query;
    expect(query?.get("amount")).toBe("5000.00");
  });

  it("links a target to its rules, and says they go with it", async () => {
    apiMock.on("GET /api/v1/savings/targets", { body: [rainy] });
    renderRoute(`/savings/setup?edit=${rainy.id}`);
    expect(await screen.findByText(/2 distributor rules/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit in the distributor" })).toHaveAttribute(
      "href",
      "/savings/setup?distributor",
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete target" }));
    expect(await screen.findByText(/Its 2 distributor rules are deleted\./)).toBeInTheDocument();
  });

  it("says which buckets' overflow goes to the distributor instead when a target goes (#233)", async () => {
    apiMock.on("GET /api/v1/savings/targets", { body: [rainy] });
    apiMock.on("GET /api/v1/buckets", {
      body: [
        food,
        holiday,
        bucket({
          id: "1000000003",
          name: "Fuel",
          source_account_id: main.id,
          overflow_destination: "savings_target",
          overflow_target_id: rainy.id,
        }),
      ],
    });
    renderRoute(`/savings/setup?edit=${rainy.id}`);
    await userEvent.click(await screen.findByRole("button", { name: "Delete target" }));
    expect(
      await screen.findByText(
        "Fuel sends its overflow here; it goes to the savings distributor instead.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the savings budget (#234)", () => {
  const raw = (amount: string) => formatMoney(amount, "NOK");
  const toBuffer = budgetEntry({
    id: "1234000001",
    target_id: rainy.id,
    amount: "1000.00",
    when: "on_income",
  });
  const stopped = budgetEntry({ id: "1234000002", target_id: "1000001999", stopped: true });

  beforeEach(() => {
    apiMock.on("GET /api/v1/savings/budget", { body: [toBuffer, stopped] });
  });

  it("lists the fixed amounts per account, with what runs per cycle", async () => {
    renderRoute("/savings/setup");
    await userEvent.click(await screen.findByRole("button", { name: /^Savings budget/ }));
    const section = within(await screen.findByRole("region", { name: "Main" }));
    // The stopped one doesn't run, so it isn't counted.
    expect(section.getByText(`${m("1000.00")} per cycle`)).toBeInTheDocument();
    expect(section.getByRole("button", { name: `${raw("1000.00")} to Buffer` })).toHaveTextContent(
      "On income",
    );
    expect(section.getByText("Stopped")).toBeInTheDocument();
  });

  it("adds an At cycle start amount, asking about this cycle", async () => {
    apiMock.on("POST /api/v1/savings/budget", {
      status: 201,
      body: budgetEntry({ id: "1234000003", target_id: rainy.id }),
    });
    renderRoute("/savings/setup?budget");
    await userEvent.click(await screen.findByRole("button", { name: "Add a fixed amount" }));
    const form = within(await screen.findByRole("form", { name: "New fixed amount" }));
    await userEvent.click(form.getByRole("button", { name: "Add" }));
    expect(form.getByText("Pick an account.")).toBeInTheDocument();
    expect(form.getByText("Enter an amount above 0.")).toBeInTheDocument();

    await userEvent.click(form.getByRole("combobox", { name: "From account" }));
    await userEvent.click(await screen.findByRole("option", { name: "Main" }));
    await userEvent.click(form.getByRole("combobox", { name: "Save to" }));
    await userEvent.click(await screen.findByRole("option", { name: "Buffer" }));
    await userEvent.type(form.getByRole("textbox", { name: "Amount per cycle" }), "750");
    // At cycle start in a running cycle: reserve now, or start next cycle.
    expect(form.getByRole("radio", { name: "Reserve it now" })).toBeChecked();
    await userEvent.click(form.getByRole("radio", { name: "Start next cycle" }));
    await userEvent.click(form.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/savings/budget")).toHaveLength(1);
    });
    expect(apiMock.calls("POST /api/v1/savings/budget")[0]?.body).toEqual({
      account_id: main.id,
      target_id: rainy.id,
      amount: "750.00",
      when: "cycle_start",
      this_cycle: false,
    });
  });

  it("doesn't offer an account's own target, nor ask about this cycle for other modes", async () => {
    renderRoute("/savings/setup?budget");
    await userEvent.click(await screen.findByRole("button", { name: "Add a fixed amount" }));
    const form = within(await screen.findByRole("form", { name: "New fixed amount" }));
    await userEvent.click(form.getByRole("combobox", { name: "From account" }));
    await userEvent.click(await screen.findByRole("option", { name: "Buffer" }));
    await userEvent.click(form.getByRole("combobox", { name: "Save to" }));
    expect(await screen.findByRole("option", { name: "Savings distributor" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Buffer" })).not.toBeInTheDocument();
    await userEvent.click(form.getByRole("radio", { name: "Manually" }));
    expect(form.queryByRole("radio", { name: "Reserve it now" })).not.toBeInTheDocument();
  });

  it("gives a stopped amount another destination, or deletes one", async () => {
    apiMock.on("PATCH /api/v1/savings/budget/1234000002", { body: { ...stopped, stopped: false } });
    apiMock.on("DELETE /api/v1/savings/budget/1234000001", { status: 204 });
    renderRoute("/savings/setup?budget");
    await userEvent.click(
      await screen.findByRole("button", { name: `${raw("500.00")} to Savings target #1000001999` }),
    );
    const form = within(await screen.findByRole("form", { name: "Fixed amount" }));
    expect(form.getByText(/Its savings target is gone/)).toBeInTheDocument();
    // Switching to At cycle start from it doesn't apply: it's At cycle start already.
    expect(form.queryByRole("radio", { name: "Reserve it now" })).not.toBeInTheDocument();
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/savings/budget/1234000002")[0]?.body).toEqual({
        target_id: null,
        amount: "500.00",
        when: "cycle_start",
      });
    });

    await userEvent.click(
      await screen.findByRole("button", { name: `${raw("1000.00")} to Buffer` }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByText("What it has reserved stays held.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(apiMock.calls("DELETE /api/v1/savings/budget/1234000001")).toHaveLength(1);
    });
  });

  it("says when deleting a target stops fixed amounts", async () => {
    renderRoute("/savings/setup?edit=1000001001");
    const form = within(await screen.findByRole("form", { name: "Buffer" }));
    await userEvent.click(form.getByRole("button", { name: "Delete target" }));
    expect(
      await screen.findByText(
        "1 fixed amount in the savings budget stops until it gets another destination.",
      ),
    ).toBeInTheDocument();
  });
});
