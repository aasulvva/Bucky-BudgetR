import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser, type MockRequest } from "@/test/api";
import { account, bucket, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");
/** An amount in an accessible name, which keeps the no-break spaces. */
const name = (amount: string) => formatMoney(amount, "NOK");

const main = account({ id: "1234", name: "Main account" });
const buffer = account({ id: "2345", name: "Buffer account", type: "savings" });
const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });

const groceries = bucket({
  id: "1000000001",
  name: "Groceries",
  source_account_id: main.id,
  refill_amount: "4000.00",
  capacity: "4000.00",
  target_funds: "1000.00",
});
const hobby = bucket({
  id: "1000000002",
  name: "Hobby",
  source_account_id: buffer.id,
  refill_amount: "1000.00",
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "3000.00",
  capacity: "3000.00",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries, hobby] });
});

/** Chooses an option in a select. */
async function pick(label: RegExp, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Bucket setup", () => {
  it("lists the buckets by account, and opens one", async () => {
    const { router } = renderRoute("/buckets/setup");
    const list = within(await screen.findByRole("navigation", { name: "Buffer account" }));
    expect(screen.getByText("Pick a bucket to edit it, or create a new one.")).toBeInTheDocument();
    expect(list.getByText(m("1000.00"))).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Euro account" })).not.toBeInTheDocument();

    await userEvent.click(list.getByRole("button", { name: /^Hobby \(#1000000002\)/ }));
    expect(router.state.location.search).toBe("?edit=1000000002");
    expect(screen.getByRole("heading", { name: "Hobby (#1000000002)" })).toBeInTheDocument();
    const form = within(screen.getByRole("form", { name: "Hobby" }));
    expect(form.getByRole("radio", { name: "Fixed amount" })).toBeChecked();
    expect(form.getByRole("textbox", { name: "Capacity amount" })).toHaveValue("3,000.00");
  });

  it("creates a bucket, with the default refill mode and the capacity worked out", async () => {
    apiMock.on("GET /api/v1/me", {
      body: {
        ...testUser,
        preferences: {
          ...testUser.preferences,
          default_refill_mode: "manual",
          default_negative_tf: "clear",
        },
      },
    });
    apiMock.on("POST /api/v1/buckets", (req) => ({
      status: 201,
      body: bucket({
        id: "1000000003",
        name: "Car",
        source_account_id: main.id,
        ...(req.body as object),
      }),
    }));
    const { router } = renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(form.getByRole("radio", { name: "Manual" })).toBeChecked();

    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));
    expect(form.getByText("Enter a name.")).toBeInTheDocument();
    expect(form.getByText("Choose an account.")).toBeInTheDocument();

    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Car");
    await pick(/Source account/, "Main account");
    await userEvent.clear(form.getByRole("textbox", { name: /Refill amount/ }));
    await userEvent.type(form.getByRole("textbox", { name: /Refill amount/ }), "1000");
    await userEvent.clear(form.getByRole("textbox", { name: "Multiplier" }));
    await userEvent.type(form.getByRole("textbox", { name: "Multiplier" }), "2,5");
    expect(form.getByText(`Capacity ${m("2500.00")}`)).toBeInTheDocument();
    // What an overspend does only matters with Keep funds.
    expect(form.queryByRole("radio", { name: /Clear it at the refill/ })).not.toBeInTheDocument();
    await userEvent.click(form.getByRole("checkbox", { name: /Keep funds/ }));
    expect(form.getByRole("radio", { name: /Clear it at the refill/ })).toBeChecked();
    expect(form.getByRole("radio", { name: `Refill now (+${name("1000.00")})` })).toBeChecked();
    await userEvent.click(form.getByRole("radio", { name: "Set starting funds" }));
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));
    expect(form.getByText("Enter an amount above 0.")).toBeInTheDocument();
    await userEvent.type(form.getByRole("textbox", { name: "Opening funds" }), "300");
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));

    expect(await screen.findByText("Car created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets")[0]?.body).toEqual({
      name: "Car",
      source_account_id: "1234",
      priority: false,
      importance: 5,
      refill_amount: "1000.00",
      cap_mode: "multiplier",
      cap_multiplier: "2.5",
      refill_mode: "manual",
      keep_funds: true,
      negative_tf: "clear",
      overflow_destination: "unallocated",
      opening_funds: "300.00",
    });
    // The new bucket stays selected on desktop.
    expect(router.state.location.search).toBe("?edit=1000000003");
  });

  it("refills a new bucket by default, or starts it at 0", async () => {
    apiMock.on("POST /api/v1/buckets", (req) => ({
      status: 201,
      body: bucket({
        id: "1000000003",
        name: "Car",
        source_account_id: main.id,
        ...(req.body as object),
      }),
    }));
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Car");
    await pick(/Source account/, "Main account");
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));
    expect(await screen.findByText("Car created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets")[0]?.body).toMatchObject({ refill: true });

    await userEvent.click(screen.getByRole("button", { name: "New bucket" }));
    const next = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.type(next.getByRole("textbox", { name: /Name/ }), "Car");
    await pick(/Source account/, "Main account");
    await userEvent.click(next.getByRole("radio", { name: "Start at 0" }));
    await userEvent.click(next.getByRole("button", { name: "Create bucket" }));
    await vi.waitFor(() => {
      expect(apiMock.calls("POST /api/v1/buckets")).toHaveLength(2);
    });
    const body = apiMock.calls("POST /api/v1/buckets")[1]?.body;
    expect(body).not.toHaveProperty("refill");
    expect(body).not.toHaveProperty("opening_funds");
  });

  it("checks the capacity, and says when a fixed one is raised to RA", async () => {
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.clear(form.getByRole("textbox", { name: "Multiplier" }));
    await userEvent.type(form.getByRole("textbox", { name: "Multiplier" }), "0.5");
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));
    expect(
      form.getByText("Enter a number of at least 1, with at most two decimals."),
    ).toBeInTheDocument();

    await userEvent.clear(form.getByRole("textbox", { name: /Refill amount/ }));
    await userEvent.type(form.getByRole("textbox", { name: /Refill amount/ }), "500");
    await userEvent.click(form.getByRole("radio", { name: "Fixed amount" }));
    await userEvent.type(form.getByRole("textbox", { name: "Capacity amount" }), "200");
    expect(form.getByText(`Capacity ${m("500.00")}`)).toBeInTheDocument();
    expect(form.getByText(/Raised to the refill amount/)).toBeInTheDocument();
  });

  it("offers the starting funds only in a running cycle", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(form.queryByRole("radio", { name: /Refill now/ })).not.toBeInTheDocument();
    expect(form.queryByRole("textbox", { name: "Opening funds" })).not.toBeInTheDocument();
    expect(form.getByText(/Needs an active cycle/)).toBeInTheDocument();
  });

  it("says when the name is taken", async () => {
    apiMock.on("PATCH /api/v1/buckets/1000000001", problem(409, "name_taken", "Taken."));
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await userEvent.clear(form.getByRole("textbox", { name: /Name/ }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "hobby");
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(await form.findByText("You already have a bucket with this name.")).toBeInTheDocument();
  });

  it("saves only what changed, from accounts in the same currency", async () => {
    apiMock.on("PATCH /api/v1/buckets/1000000001", (req) => ({
      body: { ...groceries, ...(req.body as object) },
    }));
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    const save = form.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await userEvent.click(form.getByRole("combobox", { name: /Source account/ }));
    expect(screen.queryByRole("option", { name: "Euro account" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Buffer account" }));
    expect(form.getByText(/Covered starts from 0 again/)).toBeInTheDocument();
    await userEvent.click(form.getByRole("checkbox", { name: /Priority/ }));
    await userEvent.clear(form.getByRole("textbox", { name: "Multiplier" }));
    await userEvent.type(form.getByRole("textbox", { name: "Multiplier" }), "1.50");
    await userEvent.click(save);

    expect(await screen.findByText("Groceries saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000001")[0]?.body).toEqual({
      source_account_id: "2345",
      priority: true,
      cap_mode: "multiplier",
      cap_multiplier: "1.50",
    });
  });

  it("changes what a Keep funds bucket does when overspent", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [groceries, { ...hobby, keep_funds: true }] });
    apiMock.on("PATCH /api/v1/buckets/1000000002", (req) => ({
      body: { ...hobby, keep_funds: true, ...(req.body as object) },
    }));
    renderRoute("/buckets/setup?edit=1000000002");
    const form = within(await screen.findByRole("form", { name: "Hobby" }));
    expect(form.getByRole("radio", { name: /Carry it as debt/ })).toBeChecked();
    await userEvent.click(form.getByRole("radio", { name: /Clear it at the refill/ }));
    await userEvent.click(form.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Hobby saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000002")[0]?.body).toEqual({
      negative_tf: "clear",
    });
  });

  it("releases what's left when deleting a bucket", async () => {
    apiMock.on("DELETE /api/v1/buckets/1000000001", { status: 204 });
    const { router } = renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await userEvent.click(form.getByRole("button", { name: "Delete" }));
    expect(
      screen.getByText(`Its ${m("1000.00")} left goes back to unallocated in Main account.`),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete bucket" }));
    expect(await screen.findByText("Groceries deleted.")).toBeInTheDocument();
    expect(apiMock.calls("DELETE /api/v1/buckets/1000000001")).toHaveLength(1);
    expect(router.state.location.search).toBe("");
  });

  it("can't release funds without a running cycle, but deletes an empty bucket", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await userEvent.click(form.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/Releasing what's left needs an active cycle/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete bucket" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: /Hobby/ }));
    const other = within(await screen.findByRole("form", { name: "Hobby" }));
    await userEvent.click(other.getByRole("button", { name: "Delete" }));
    expect(screen.queryByText(/left goes back/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete bucket" })).toBeEnabled();
  });

  it("opens the form full screen on mobile", async () => {
    viewport.width = 390;
    renderRoute("/buckets/setup");
    await userEvent.click(await screen.findByRole("button", { name: /Groceries/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "Groceries (#1000000001)" }));
    expect(dialog.getByRole("textbox", { name: /Name/ })).toHaveValue("Groceries");
  });

  it("points to Account setup without accounts", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [] });
    apiMock.on("GET /api/v1/buckets", { body: [] });
    renderRoute("/buckets/setup");
    expect(
      await screen.findByRole("link", { name: "Create one in Account setup" }),
    ).toHaveAttribute("href", "/accounts/setup");
    expect(screen.getByRole("button", { name: "New bucket" })).toBeDisabled();
  });
});

describe("Bucket setup, Fully manual", () => {
  it("creates one without a refill amount, with a fixed capacity or none", async () => {
    apiMock.on("POST /api/v1/buckets", (req) => ({
      status: 201,
      body: bucket({
        id: "1000000003",
        name: "Gifts",
        source_account_id: main.id,
        ...(req.body as object),
      }),
    }));
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Gifts");
    await pick(/Source account/, "Main account");
    await userEvent.click(form.getByRole("radio", { name: "Fully manual" }));

    // No refill, so no refill amount, Keep funds, overspend or overflow setting.
    expect(form.queryByRole("textbox", { name: /Refill amount/ })).not.toBeInTheDocument();
    expect(form.queryByRole("checkbox", { name: /Keep funds/ })).not.toBeInTheDocument();
    expect(form.queryByRole("combobox", { name: /Overflow goes to/ })).not.toBeInTheDocument();
    expect(form.queryByRole("radio", { name: /Refill now/ })).not.toBeInTheDocument();
    expect(form.getByRole("radio", { name: "Start at 0" })).toBeChecked();
    expect(form.getByRole("radio", { name: "No cap" })).toBeChecked();
    expect(form.queryByRole("radio", { name: "Multiplier" })).not.toBeInTheDocument();
    expect(form.getByText("The bucket can hold any amount.")).toBeInTheDocument();

    await userEvent.click(form.getByRole("radio", { name: "Fixed amount" }));
    await userEvent.type(form.getByRole("textbox", { name: "Capacity amount" }), "1000");
    await userEvent.click(form.getByRole("radio", { name: "Set starting funds" }));
    await userEvent.type(form.getByRole("textbox", { name: "Opening funds" }), "1500");
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));
    expect(form.getByText(`The capacity is ${m("1000.00")}.`)).toBeInTheDocument();
    await userEvent.clear(form.getByRole("textbox", { name: "Opening funds" }));
    await userEvent.type(form.getByRole("textbox", { name: "Opening funds" }), "200");
    await userEvent.click(form.getByRole("button", { name: "Create bucket" }));

    expect(await screen.findByText("Gifts created.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets")[0]?.body).toEqual({
      name: "Gifts",
      source_account_id: "1234",
      priority: false,
      importance: 5,
      refill_amount: "0.00",
      cap_mode: "fixed",
      cap_amount: "1000.00",
      refill_mode: "fully_manual",
      keep_funds: true,
      negative_tf: "debt",
      overflow_destination: "unallocated",
      opening_funds: "200.00",
    });
  });

  it("switches a bucket to it and back", async () => {
    apiMock.on("PATCH /api/v1/buckets/1000000001", (req) => ({
      body: { ...groceries, ...(req.body as object) },
    }));
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await userEvent.click(form.getByRole("radio", { name: "Fully manual" }));
    expect(form.getByRole("radio", { name: "No cap" })).toBeChecked();
    // Back again: the refill amount and multiplier are as they were.
    await userEvent.click(form.getByRole("radio", { name: "Auto" }));
    expect(form.getByRole("radio", { name: "Multiplier" })).toBeChecked();
    expect(form.getByRole("textbox", { name: /Refill amount/ })).toHaveValue("4,000.00");
    expect(form.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.click(form.getByRole("radio", { name: "Fully manual" }));
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Groceries saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000001")[0]?.body).toEqual({
      refill_amount: "0.00",
      cap_mode: "none",
      refill_mode: "fully_manual",
      keep_funds: true,
    });
  });

  it("lists it by its mode instead of a refill amount", async () => {
    apiMock.on("GET /api/v1/buckets", {
      body: [
        groceries,
        bucket({
          id: "1000000003",
          name: "Gifts",
          source_account_id: main.id,
          refill_mode: "fully_manual",
          cap_mode: "none",
          cap_multiplier: null,
          capacity: null,
          keep_funds: true,
        }),
      ],
    });
    renderRoute("/buckets/setup");
    const list = within(await screen.findByRole("navigation", { name: "Main account" }));
    expect(list.getByRole("button", { name: /^Gifts \(#1000000003\)/ })).toHaveTextContent(
      "Fully manual",
    );
  });
});

/** Answers a preferences PATCH as the API does: merged, null resets. */
function patchPreferences(initial: Record<string, unknown>) {
  let prefs = { ...testUser.preferences, ...initial };
  return (req: MockRequest) => {
    const merged = Object.entries({ ...prefs, ...(req.body as object) });
    prefs = Object.fromEntries(merged.filter(([, v]) => v !== null));
    return { body: prefs };
  };
}

const employer = { counterparty: "Employer AS", min_amount: "20000" };

/** Signs in with these preferences, which a PATCH then changes. */
function withPreferences(prefs: Record<string, unknown>) {
  apiMock.on("GET /api/v1/me", {
    body: { ...testUser, preferences: { ...testUser.preferences, ...prefs } },
  });
  apiMock.on("PATCH /api/v1/me/preferences", patchPreferences(prefs));
}

describe("Bucket setup, Bucket settings (#102)", () => {
  afterEach(() => {
    viewport.touch = false;
  });

  it("opens from the header, and closes again", async () => {
    const { router } = renderRoute("/buckets/setup?edit=1000000001");
    await userEvent.click(await screen.findByRole("button", { name: "Bucket settings" }));
    expect(router.state.location.search).toBe("?edit=1000000001&settings=");
    const drawer = within(await screen.findByRole("dialog", { name: "Bucket settings" }));
    expect(drawer.getByRole("combobox", { name: /Default refill mode/ })).toHaveValue(
      "Automatic, at the start of each cycle",
    );
    await userEvent.click(drawer.getByRole("button", { name: "" }));
    expect(router.state.location.search).toBe("?edit=1000000001");
  });

  it("can make new buckets Fully manual", async () => {
    withPreferences({});
    renderRoute("/buckets/setup?settings");
    await userEvent.click(await screen.findByRole("combobox", { name: /Default refill mode/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Fully manual, funds added and removed by hand" }),
    );
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      default_refill_mode: "fully_manual",
    });
  });

  it("sets what new Keep funds buckets do when overspent", async () => {
    withPreferences({});
    renderRoute("/buckets/setup?settings");
    const select = await screen.findByRole("combobox", { name: /Overspent buckets/ });
    expect(select).toHaveValue("Carry it as debt");
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Clear it at the refill" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      default_negative_tf: "clear",
    });

    await userEvent.click(screen.getByRole("combobox", { name: /Overspent buckets/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Carry it as debt" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
      default_negative_tf: null,
    });
  });

  it("edits the income rules", async () => {
    withPreferences({ income_refill_rules: [employer] });
    renderRoute("/buckets/setup?settings");
    expect(await screen.findByDisplayValue("Employer AS")).toBeInTheDocument();
    expect(screen.getByDisplayValue("20,000.00")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save rules" });
    expect(save).toBeDisabled();

    // A new row must be filled in before it saves.
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.click(save);
    expect(screen.getByText("Enter the counterparty.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")).toHaveLength(0);

    // The new row's fields are the ones with the errors.
    await userEvent.type(
      screen.getByRole("textbox", { name: "Counterparty", description: /Enter the counterparty/ }),
      " Side job ",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "At least", description: /Enter an amount/ }),
      "1500",
    );
    await userEvent.click(save);
    expect(await screen.findByText("Income rules saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      income_refill_rules: [employer, { counterparty: "Side job", min_amount: "1500.00" }],
    });

    // Removing them all clears the rules.
    await userEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove rule 1" }));
    expect(screen.getByText(/No rules yet\./)).toBeInTheDocument();
    await userEvent.click(save);
    await screen.findByText(/No rules yet\./);
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
      income_refill_rules: null,
    });
  });

  it("opens from the new bucket's hint, over the form", async () => {
    withPreferences({ default_refill_mode: "manual" });
    const { router } = renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(form.getByText(/New buckets start as Manual\./)).toBeInTheDocument();
    await userEvent.click(form.getByRole("button", { name: "Change the default" }));
    expect(router.state.location.search).toBe("?new=&settings=");
    expect(await screen.findByRole("dialog", { name: "Bucket settings" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "New bucket" })).toBeInTheDocument();
  });

  it("doesn't show the default when editing a bucket", async () => {
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    expect(form.queryByText(/New buckets start as/)).not.toBeInTheDocument();
  });

  it("says when On income has no income rules to trigger it", async () => {
    withPreferences({});
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(form.queryByText(/no income rules yet/)).not.toBeInTheDocument();
    await userEvent.click(form.getByRole("radio", { name: "On income" }));
    expect(form.getByText(/You have no income rules yet/)).toBeInTheDocument();
    await userEvent.click(form.getByRole("button", { name: "Set up income rules" }));
    expect(await screen.findByRole("dialog", { name: "Bucket settings" })).toBeInTheDocument();
  });

  it("doesn't say so when there are income rules", async () => {
    withPreferences({ income_refill_rules: [employer] });
    renderRoute("/buckets/setup?new");
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.click(form.getByRole("radio", { name: "On income" }));
    expect(form.queryByText(/no income rules yet/)).not.toBeInTheDocument();
  });

  it("opens full screen on mobile, where its selects work on touch", async () => {
    viewport.width = 390;
    viewport.touch = true;
    withPreferences({});
    renderRoute("/buckets/setup");
    await userEvent.click(await screen.findByRole("button", { name: "Bucket settings" }));
    const drawer = await screen.findByRole("dialog", { name: "Bucket settings" });
    await userEvent.click(within(drawer).getByRole("combobox", { name: /Default refill mode/ }));
    // The options open inside the drawer, not in a portal it would close on.
    await userEvent.click(within(drawer).getByRole("option", { name: "Manual" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      default_refill_mode: "manual",
    });
  });
});

describe("Bucket setup, overflow to savings (#233)", () => {
  const rainy = savingsTarget({ id: "1000001001", name: "Rainy day", account_id: buffer.id });
  const abroad = savingsTarget({
    id: "1000001002",
    name: "Abroad",
    account_id: euro.id,
    currency: "EUR",
  });
  const itself = savingsTarget({
    id: "1000001003",
    name: "Groceries goal",
    account_id: null,
    bucket_id: groceries.id,
  });

  beforeEach(() => {
    apiMock.on("GET /api/v1/savings/targets", { body: [rainy, abroad, itself] });
    apiMock.on("PATCH /api/v1/buckets/1000000001", (req) => ({
      body: { ...groceries, ...(req.body as object) },
    }));
  });

  it("sends overflow to a target in the bucket's currency, not itself", async () => {
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await pick(/Overflow goes to/, "A savings target");
    expect(form.getByText(/Only the part the account's money covers is saved/)).toBeInTheDocument();

    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(await form.findByText("Pick a savings target.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000001")).toHaveLength(0);

    await userEvent.click(form.getByRole("combobox", { name: /^Savings target/ }));
    expect(screen.queryByRole("option", { name: "Abroad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Groceries goal" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "Rainy day" }));
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Groceries saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000001")[0]?.body).toEqual({
      overflow_destination: "savings_target",
      overflow_target_id: rainy.id,
    });
  });

  it("sends overflow to the distributor", async () => {
    renderRoute("/buckets/setup?edit=1000000001");
    const form = within(await screen.findByRole("form", { name: "Groceries" }));
    await pick(/Overflow goes to/, "The savings distributor");
    await userEvent.click(form.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Groceries saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/buckets/1000000001")[0]?.body).toEqual({
      overflow_destination: "savings_distribution",
    });
  });
});
