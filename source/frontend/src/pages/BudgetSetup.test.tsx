import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { addDays, endAtFor, today } from "@/lib/cycles";
import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser } from "@/test/api";
import { account, budgetEntry, bucket, cycle, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account", expected_income: "32000.00" });
const buffer = account({ id: "2345", name: "Buffer account" });
const empty = account({ id: "3456", name: "Empty account" });
const food = bucket({
  id: "1000000001",
  name: "Groceries",
  source_account_id: main.id,
  refill_amount: "6000.00",
  capacity: "6000.00",
  target_funds: "2500.00",
});
const rent = bucket({
  id: "1000000002",
  name: "Rent",
  source_account_id: main.id,
  priority: true,
  refill_amount: "12000.00",
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "13000.00",
  capacity: "13000.00",
});
const fun = bucket({
  id: "1000000003",
  name: "Fun",
  source_account_id: buffer.id,
  refill_amount: "100.00",
  capacity: "100.00",
});

const section = async (name: string) => within(await screen.findByRole("region", { name }));
const refill = (name: string) => screen.getByRole("textbox", { name: `Refill amount for ${name}` });
const saveBar = () => screen.queryByRole("region", { name: /changes?$/ });

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, empty, main] });
  apiMock.on("GET /api/v1/buckets", { body: [fun, food, rent] });
});

describe("Budget setup", () => {
  it("shows the buckets by account against the expected income, live", async () => {
    renderRoute("/budget");
    const mainSection = await section("Main account");
    expect(mainSection.getByRole("heading", { name: "Main account (#1234)" })).toBeInTheDocument();
    expect(mainSection.getByText(`${m("18000.00")} (56.2%)`)).toBeInTheDocument();
    expect(mainSection.getByText(m("14000.00"))).toBeInTheDocument();
    expect(mainSection.getByText("37.5%")).toBeInTheDocument();
    // No income: no share yet.
    const bufferSection = await section("Buffer account");
    expect(bufferSection.getByText(/Enter the expected income/)).toBeInTheDocument();
    // An account without buckets comes last (#112).
    const sections = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(sections.slice(-1)).toEqual(["Empty account"]);

    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "14000");
    expect(mainSection.getByText(`${m("20000.00")} (62.5%)`)).toBeInTheDocument();
    expect(mainSection.getByText("43.7%")).toBeInTheDocument();
    expect(mainSection.getByText(m("14000.00"))).toBeInTheDocument();
    expect(mainSection.getByText(`Raised from ${m("13000.00")}`)).toBeInTheDocument();
    expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
  });

  it("saves the incomes and refill amounts that changed", async () => {
    apiMock.on("PATCH /api/v1/accounts/2345", { body: { ...buffer, expected_income: "500.00" } });
    apiMock.on("POST /api/v1/buckets/refill-amounts", { body: { items: [] } });
    renderRoute("/budget");
    const bufferSection = await section("Buffer account");
    await userEvent.type(
      bufferSection.getByRole("textbox", { name: "Expected income per cycle" }),
      "500",
    );
    expect(bufferSection.getByText(`${m("100.00")} (20%)`)).toBeInTheDocument();
    // Retyping the saved value isn't a change.
    await userEvent.clear(refill("Groceries"));
    await userEvent.type(refill("Groceries"), "6000");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    expect(within(saveBar() ?? document.body).getByText("2 changes")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/accounts/2345").map((c) => c.body)).toEqual([
      { expected_income: "500.00" },
    ]);
    expect(apiMock.calls("POST /api/v1/buckets/refill-amounts").map((c) => c.body)).toEqual([
      { items: [{ bucket_id: rent.id, refill_amount: "11000.00" }], this_cycle: false },
    ]);
    expect(saveBar()).not.toBeInTheDocument();
  });

  it("also changes this cycle, after showing what it does", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [{ ...main, balance: "2800.00" }] });
    apiMock.on("GET /api/v1/buckets", { body: [{ ...food, refilled: true }, rent] });
    apiMock.on("POST /api/v1/buckets/refill-amounts", { body: { items: [] } });
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Groceries"));
    await userEvent.type(refill("Groceries"), "6500");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    const bar = within(saveBar() ?? document.body);
    expect(bar.getByText(/doesn't change/)).toBeInTheDocument();
    await userEvent.click(bar.getByRole("switch", { name: /Also change this cycle/ }));
    expect(bar.getByText(/moves by the same amount/)).toBeInTheDocument();

    await userEvent.click(bar.getByRole("button", { name: "Save" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Change this cycle too?" }));
    const listed = within(dialog.getByRole("region", { name: "Main account" }));
    // Groceries was refilled: TF moves by +500. Rent waits for its refill.
    expect(
      listed.getByText(`${m("2500.00")} → ${m("3000.00")} (+${m("500.00")})`),
    ).toBeInTheDocument();
    expect(listed.getByText(/Not refilled yet/)).toBeInTheDocument();
    expect(
      listed.getByText(`The account is short by ${m("200.00")} afterwards.`),
    ).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets/refill-amounts")).toHaveLength(0);

    await userEvent.click(dialog.getByRole("button", { name: "Save and change this cycle" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets/refill-amounts").map((c) => c.body)).toEqual([
      {
        items: [
          { bucket_id: food.id, refill_amount: "6500.00" },
          { bucket_id: rent.id, refill_amount: "11000.00" },
        ],
        this_cycle: true,
      },
    ]);
  });

  it("offers this cycle only while one is running", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    const { unmount } = renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    unmount();

    apiMock.on("GET /api/v1/cycles/active", {
      body: { active: cycle({ end_at: endAtFor(addDays(today(), -2)) }), next: null },
    });
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    expect(await screen.findByRole("switch", { name: /Also change this cycle/ })).toBeDisabled();
    expect(screen.getByText(/has run past its end/)).toBeInTheDocument();
  });

  it("leaves out Fully manual buckets, which have no refill amount", async () => {
    const gifts = bucket({
      id: "1000000004",
      name: "Gifts",
      source_account_id: main.id,
      refill_mode: "fully_manual",
      cap_mode: "none",
      cap_multiplier: null,
      capacity: null,
      keep_funds: true,
      target_funds: "500.00",
    });
    apiMock.on("GET /api/v1/buckets", { body: [fun, food, gifts, rent] });
    renderRoute("/budget");
    const mainSection = await section("Main account");
    expect(mainSection.queryByText("Gifts")).not.toBeInTheDocument();
    expect(
      mainSection.getByText("1 fully manual bucket isn't budgeted here: it has no refill amount."),
    ).toBeInTheDocument();
    expect(mainSection.getByText(`${m("18000.00")} (56.2%)`)).toBeInTheDocument();
  });

  it("discards the changes", async () => {
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(saveBar()).not.toBeInTheDocument();
    expect(refill("Rent")).toHaveValue("12,000.00");
  });

  it("needs a refill amount", async () => {
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    expect(screen.getByText("Enter a refill amount.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the changes when saving fails", async () => {
    apiMock.on(
      "POST /api/v1/buckets/refill-amounts",
      problem(404, "not_found", "Bucket not found."),
    );
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("It doesn't exist, or it has been deleted."),
    ).toBeInTheDocument();
    expect(refill("Rent")).toHaveValue("11,000.00");
    expect(saveBar()).toBeInTheDocument();
  });

  it("shows what's allocated beyond the income", async () => {
    renderRoute("/budget");
    const mainSection = await section("Main account");
    const income = mainSection.getByRole("textbox", { name: "Expected income per cycle" });
    await userEvent.clear(income);
    await userEvent.type(income, "15000");
    expect(mainSection.getByText("Over by")).toBeInTheDocument();
    expect(mainSection.getByText(m("3000.00"))).toBeInTheDocument();
    expect(mainSection.getByText(`${m("18000.00")} (120%)`)).toBeInTheDocument();
  });

  it("asks before leaving with changes", async () => {
    const { router } = renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "1");
    await userEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Buckets" }),
    );
    expect(
      await screen.findByText("You have changes that aren't saved. Leave without saving?"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/budget");
    await userEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Buckets" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));
    // The page loads lazily, so navigating can take a moment.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/buckets");
    });
  });

  it("shows a card per bucket on mobile", async () => {
    viewport.width = 390;
    renderRoute("/budget");
    const card = within(await screen.findByRole("article", { name: "Rent" }));
    expect(card.getByRole("textbox", { name: "Refill amount for Rent" })).toBeInTheDocument();
    expect(card.getByText("37.5%")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("starts a budget from accounts without buckets (#112)", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [] });
    renderRoute("/budget");
    const mainSection = await section("Main account");
    expect(mainSection.getByText("No buckets yet.")).toBeInTheDocument();
    expect(
      mainSection.getByRole("textbox", { name: "Expected income per cycle" }),
    ).toBeInTheDocument();
    expect(
      mainSection.getByRole("button", { name: "New bucket on Main account" }),
    ).toBeInTheDocument();
    expect(await section("Buffer account")).toBeTruthy();
  });

  it("points to Account setup without accounts", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [] });
    apiMock.on("GET /api/v1/buckets", { body: [] });
    renderRoute("/budget");
    expect(await screen.findByRole("link", { name: /Account setup/ })).toHaveAttribute(
      "href",
      "/accounts/setup",
    );
    expect(screen.getByRole("button", { name: "New bucket" })).toBeDisabled();
  });

  it("edits the income rules, planned with the refills (#102)", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", (req) => ({
      body: { ...testUser.preferences, ...(req.body as object) },
    }));
    renderRoute("/budget");
    await userEvent.click(await screen.findByRole("button", { name: "Income rules" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Income rules" }));
    expect(dialog.getByText(/No rules yet\./)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Add rule" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Counterparty" }), "Employer AS");
    await userEvent.type(dialog.getByRole("textbox", { name: "At least" }), "20000");
    await userEvent.click(dialog.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByText("Income rules saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      income_refill_rules: [{ counterparty: "Employer AS", min_amount: "20000.00" }],
    });
    // The budget's own changes are untouched.
    expect(saveBar()).not.toBeInTheDocument();
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", {
      body: { ...testUser, preferences: { ...testUser.preferences, language: "nn" } },
    });
    renderRoute("/budget");
    const mainSection = await section("Main account");
    expect(
      mainSection.getByRole("textbox", { name: "Venta inntekt per periode" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Påfyllingsbeløp for Rent" })).toBeInTheDocument();
  });
});

describe("Budget setup, new buckets (#112)", () => {
  /** Opens the form from an account's section and fills in a bucket. */
  async function addBucket(account: string, name: string, ra: string) {
    const s = await section(account);
    await userEvent.click(s.getByRole("button", { name: `New bucket on ${account}` }));
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), name);
    await userEvent.clear(form.getByRole("textbox", { name: /Refill amount/ }));
    await userEvent.type(form.getByRole("textbox", { name: /Refill amount/ }), ra);
    return form;
  }

  const created = (req: { body: unknown }) => ({
    status: 201,
    body: bucket({
      id: "1000000009",
      name: "Gifts",
      source_account_id: main.id,
      ...(req.body as object),
    }),
  });

  it("adds a bucket to the draft from an account's section, counted at once", async () => {
    renderRoute("/budget");
    const form = await addBucket("Main account", "Gifts", "2000");
    // The account is preset.
    expect(form.getByRole("combobox", { name: /Source account/ })).toHaveValue("Main account");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));

    const mainSection = await section("Main account");
    expect(mainSection.getByText("Gifts")).toBeInTheDocument();
    expect(mainSection.getByText("New")).toBeInTheDocument();
    expect(mainSection.getByText(`${m("20000.00")} (62.5%)`)).toBeInTheDocument();
    // Refill now is the default in a running cycle.
    expect(mainSection.getByText("Refilled when saved")).toBeInTheDocument();
    expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets")).toHaveLength(0);
  });

  it("creates the new buckets first on Save, with the other changes", async () => {
    apiMock.on("POST /api/v1/buckets", created);
    apiMock.on("POST /api/v1/buckets/refill-amounts", { body: { items: [] } });
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    const form = await addBucket("Main account", "Gifts", "2000");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    expect(within(saveBar() ?? document.body).getByText("2 changes")).toBeInTheDocument();

    apiMock.on("GET /api/v1/buckets", {
      body: [
        fun,
        food,
        rent,
        bucket({ id: "1000000009", name: "Gifts", source_account_id: main.id }),
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets").map((c) => c.body)).toEqual([
      expect.objectContaining({
        name: "Gifts",
        source_account_id: main.id,
        refill_amount: "2000.00",
        refill: true,
      }),
    ]);
    expect(apiMock.calls("POST /api/v1/buckets/refill-amounts")).toHaveLength(1);
    expect(saveBar()).not.toBeInTheDocument();
    expect((await section("Main account")).queryByText("New")).not.toBeInTheDocument();
  });

  it("edits and removes a bucket in the draft", async () => {
    renderRoute("/budget");
    const form = await addBucket("Main account", "Gifts", "2000");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));

    await userEvent.click(await screen.findByRole("button", { name: "Edit Gifts" }));
    const edit = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(edit.getByRole("textbox", { name: /Name/ })).toHaveValue("Gifts");
    await userEvent.clear(edit.getByRole("textbox", { name: /Refill amount/ }));
    await userEvent.type(edit.getByRole("textbox", { name: /Refill amount/ }), "4000");
    await userEvent.click(edit.getByRole("radio", { name: "Start at 0" }));
    await userEvent.click(edit.getByRole("button", { name: "Update" }));
    const mainSection = await section("Main account");
    expect(mainSection.getByText(`${m("22000.00")} (68.7%)`)).toBeInTheDocument();
    expect(mainSection.getByText("Starts at 0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit Gifts" }));
    const again = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.click(again.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => {
      expect(mainSection.queryByText("Gifts")).not.toBeInTheDocument();
    });
    expect(saveBar()).not.toBeInTheDocument();
  });

  it("won't take a name a saved or a new bucket has", async () => {
    renderRoute("/budget");
    const form = await addBucket("Main account", "rent", "100");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    expect(form.getByText("You already have a bucket with this name.")).toBeInTheDocument();
    await userEvent.clear(form.getByRole("textbox", { name: /Name/ }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Gifts");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));

    const next = await addBucket("Buffer account", "GIFTS", "100");
    await userEvent.click(next.getByRole("button", { name: "Add to budget" }));
    expect(next.getByText("You already have a bucket with this name.")).toBeInTheDocument();
  });

  it("discards new buckets, and asks before leaving with only one", async () => {
    const { router } = renderRoute("/budget");
    const form = await addBucket("Main account", "Gifts", "2000");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    await userEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Buckets" }),
    );
    expect(
      await screen.findByText("You have changes that aren't saved. Leave without saving?"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/budget");

    await userEvent.click(
      within(saveBar() ?? document.body).getByRole("button", { name: "Discard" }),
    );
    expect((await section("Main account")).queryByText("Gifts")).not.toBeInTheDocument();
    expect(saveBar()).not.toBeInTheDocument();
  });

  it("doesn't create a bucket twice when a later step fails", async () => {
    apiMock.on("POST /api/v1/buckets", created);
    apiMock.on(
      "POST /api/v1/buckets/refill-amounts",
      problem(500, "internal", "Something went wrong."),
    );
    renderRoute("/budget");
    await section("Main account");
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    const form = await addBucket("Main account", "Gifts", "2000");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
    });
    expect((await section("Main account")).queryByText("New")).not.toBeInTheDocument();

    apiMock.on("POST /api/v1/buckets/refill-amounts", { body: { items: [] } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets")).toHaveLength(1);
  });

  it("opens from the header, with the account to choose", async () => {
    renderRoute("/budget");
    await section("Main account");
    await userEvent.click(screen.getByRole("button", { name: "New bucket" }));
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    expect(form.getByRole("combobox", { name: /Source account/ })).toHaveValue("");
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Gifts");
    await userEvent.click(form.getByRole("combobox", { name: /Source account/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Empty account" }));
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    const emptySection = await section("Empty account");
    expect(emptySection.getByText("Gifts")).toBeInTheDocument();
    expect(emptySection.queryByText("No buckets yet.")).not.toBeInTheDocument();
  });

  it("shows new buckets as cards on mobile", async () => {
    viewport.width = 390;
    renderRoute("/budget");
    const form = await addBucket("Main account", "Gifts", "2000");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    const card = within(await screen.findByRole("article", { name: "Gifts" }));
    expect(card.getByText("New")).toBeInTheDocument();
    expect(card.getByText("Refilled when saved")).toBeInTheDocument();
  });
});

describe("Budget setup, deleting buckets (#174)", () => {
  const groceriesRow = () => section("Main account");

  it("marks a bucket deleted in the draft, and Undo brings it back", async () => {
    renderRoute("/budget");
    const mainSection = await groceriesRow();
    // An RA edit before the delete comes back with Undo.
    await userEvent.clear(refill("Groceries"));
    await userEvent.type(refill("Groceries"), "7000");
    await userEvent.click(mainSection.getByRole("button", { name: "Delete Groceries" }));

    expect(mainSection.getByText("Deleted")).toBeInTheDocument();
    expect(
      mainSection.queryByRole("textbox", { name: "Refill amount for Groceries" }),
    ).not.toBeInTheDocument();
    expect(mainSection.getByText(`${m("12000.00")} (37.5%)`)).toBeInTheDocument();
    expect(
      mainSection.getByText(`Its ${m("2500.00")} left goes back to unallocated in Main account.`),
    ).toBeInTheDocument();
    // Only the delete counts; the RA edit waits.
    expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
    expect(apiMock.calls("DELETE /api/v1/buckets/1000000001")).toHaveLength(0);

    await userEvent.click(mainSection.getByRole("button", { name: "Undo deleting Groceries" }));
    expect(mainSection.queryByText("Deleted")).not.toBeInTheDocument();
    expect(refill("Groceries")).toHaveValue("7,000.00");
    expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
  });

  it("deletes first on Save, so a new bucket can take the name", async () => {
    const order: string[] = [];
    apiMock.on("DELETE /api/v1/buckets/1000000001", () => {
      order.push("delete");
      return { status: 204 };
    });
    apiMock.on("POST /api/v1/buckets", (req) => {
      order.push("create");
      return {
        status: 201,
        body: bucket({
          id: "1000000009",
          name: "Groceries",
          source_account_id: main.id,
          ...(req.body as object),
        }),
      };
    });
    apiMock.on("POST /api/v1/buckets/refill-amounts", () => {
      order.push("refill amounts");
      return { body: { items: [] } };
    });
    renderRoute("/budget");
    const mainSection = await groceriesRow();
    await userEvent.click(mainSection.getByRole("button", { name: "Delete Groceries" }));
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    await userEvent.click(mainSection.getByRole("button", { name: "New bucket on Main account" }));
    const form = within(await screen.findByRole("form", { name: "New bucket" }));
    await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Groceries");
    await userEvent.click(form.getByRole("button", { name: "Add to budget" }));
    expect(within(saveBar() ?? document.body).getByText("3 changes")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(order).toEqual(["delete", "create", "refill amounts"]);
    expect(saveBar()).not.toBeInTheDocument();
  });

  it("brings deleted buckets back on Discard", async () => {
    renderRoute("/budget");
    const mainSection = await groceriesRow();
    await userEvent.click(mainSection.getByRole("button", { name: "Delete Groceries" }));
    await userEvent.click(
      within(saveBar() ?? document.body).getByRole("button", { name: "Discard" }),
    );
    expect(mainSection.queryByText("Deleted")).not.toBeInTheDocument();
    expect(refill("Groceries")).toBeInTheDocument();
  });

  it("can't release funds without a running cycle, but deletes an empty bucket", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/budget");
    const mainSection = await groceriesRow();
    const groceries = mainSection.getByRole("button", { name: "Delete Groceries" });
    expect(groceries).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(groceries);
    expect(mainSection.queryByText("Deleted")).not.toBeInTheDocument();
    await userEvent.hover(groceries);
    expect(
      await screen.findByText(/Releasing what's left needs an active cycle/),
    ).toBeInTheDocument();

    // Rent has nothing left (TF 0).
    await userEvent.click(mainSection.getByRole("button", { name: "Delete Rent" }));
    expect(mainSection.getByText("Deleted")).toBeInTheDocument();
  });

  it("doesn't delete twice when a later step fails", async () => {
    apiMock.on("DELETE /api/v1/buckets/1000000001", { status: 204 });
    apiMock.on(
      "POST /api/v1/buckets/refill-amounts",
      problem(500, "internal", "Something went wrong."),
    );
    renderRoute("/budget");
    const mainSection = await groceriesRow();
    await userEvent.click(mainSection.getByRole("button", { name: "Delete Groceries" }));
    await userEvent.clear(refill("Rent"));
    await userEvent.type(refill("Rent"), "11000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();
    });

    apiMock.on("POST /api/v1/buckets/refill-amounts", { body: { items: [] } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("DELETE /api/v1/buckets/1000000001")).toHaveLength(1);
  });

  it("deletes from the card on mobile", async () => {
    viewport.width = 390;
    renderRoute("/budget");
    const card = within(await screen.findByRole("article", { name: "Groceries" }));
    await userEvent.click(card.getByRole("button", { name: "Delete Groceries" }));
    expect(card.getByText("Deleted")).toBeInTheDocument();
    expect(card.getByRole("button", { name: "Undo deleting Groceries" })).toBeInTheDocument();
  });
});

describe("the savings budget in Budget setup (#234)", () => {
  const trip = savingsTarget({ id: "1000001001", name: "Holiday fund", account_id: "9999" });
  const toTrip = budgetEntry({ id: "1234000001", target_id: trip.id, amount: "2000.00" });
  const stopped = budgetEntry({ id: "1234000002", target_id: "1000001999", stopped: true });

  beforeEach(() => {
    apiMock.on("GET /api/v1/savings/targets", { body: [trip] });
    apiMock.on("GET /api/v1/savings/budget", { body: [toTrip, stopped] });
  });

  it("counts the fixed amounts with the buckets, and saves them", async () => {
    apiMock.on("PATCH /api/v1/savings/budget/1234000001", {
      body: { ...toTrip, amount: "3000.00" },
    });
    renderRoute("/budget");
    const mainSection = await section("Main account");
    // 18000 of buckets and 2000 to save; the stopped one isn't counted or listed.
    expect(await mainSection.findByText(`${m("20000.00")} (62.5%)`)).toBeInTheDocument();
    expect(mainSection.getByText("Holiday fund")).toBeInTheDocument();
    expect(mainSection.getByText("6.2%")).toBeInTheDocument();
    expect(mainSection.queryByText(/Savings target #1000001999/)).not.toBeInTheDocument();
    expect(mainSection.getAllByRole("link", { name: "Savings budget" })[0]).toHaveAttribute(
      "href",
      "/savings/setup?budget",
    );

    const amount = mainSection.getByRole("textbox", { name: "Amount to save for Holiday fund" });
    await userEvent.clear(amount);
    expect(mainSection.getByText("Enter an amount.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(amount, "3000");
    expect(mainSection.getByText(`${m("21000.00")} (65.6%)`)).toBeInTheDocument();
    expect(within(saveBar() ?? document.body).getByText("1 change")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Budget saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/savings/budget/1234000001").map((c) => c.body)).toEqual([
      { amount: "3000.00" },
    ]);
    expect(apiMock.calls("POST /api/v1/buckets/refill-amounts")).toHaveLength(0);
  });
});
