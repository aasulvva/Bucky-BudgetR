import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
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
