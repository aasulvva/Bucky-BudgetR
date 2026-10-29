import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { addDays, endAtFor, today } from "@/lib/cycles";
import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser } from "@/test/api";
import { account, bucket, cycle } from "@/test/fixtures";
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
    expect(screen.queryByRole("region", { name: "Empty account" })).not.toBeInTheDocument();

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

  it("points to Bucket setup without buckets", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [] });
    renderRoute("/budget");
    expect(await screen.findByRole("link", { name: "Create one in Bucket setup" })).toHaveAttribute(
      "href",
      "/buckets/setup",
    );
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
