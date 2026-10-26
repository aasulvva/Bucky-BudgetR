import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account" });
const buffer = account({ id: "2345", name: "Buffer account" });
const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });

const fuel = bucket({
  id: "1000000001",
  name: "Fuel",
  source_account_id: main.id,
  refill_amount: "1000.00",
  cap_mode: "fixed",
  cap_multiplier: null,
  cap_amount: "1200.00",
  capacity: "1200.00",
  target_funds: "100.00",
});
const fun = bucket({
  id: "1000000002",
  name: "Fun",
  source_account_id: main.id,
  target_funds: "50.00",
});
const travel = bucket({ id: "1000000003", name: "Travel", source_account_id: buffer.id });
const paris = bucket({
  id: "1000000004",
  name: "Paris",
  source_account_id: euro.id,
  currency: "EUR",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, euro, main] });
  apiMock.on("GET /api/v1/buckets", { body: [fuel, fun, travel, paris] });
});

/** Opens Fuel's Adjust funds dialog on the Buckets screen. */
const openAdjust = async () => {
  renderRoute("/buckets");
  await userEvent.click(await screen.findByRole("button", { name: "Adjust funds for Fuel" }));
  return within(await screen.findByRole("dialog", { name: "Adjust funds: Fuel" }));
};

const closed = () =>
  waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

describe("Adjust funds", () => {
  it("sets this cycle only, with a preview", async () => {
    apiMock.on("POST /api/v1/buckets/1000000001/adjustment", { body: fuel });
    const adjust = await openAdjust();
    expect(
      adjust.getByText(`This cycle ${m("100.00")} · refill amount ${m("1000.00")}`),
    ).toBeInTheDocument();
    expect(adjust.getByRole("radio", { name: /^This cycle only/ })).toBeChecked();
    const apply = adjust.getByRole("button", { name: "Apply adjustment" });
    expect(apply).toBeDisabled();

    await userEvent.type(adjust.getByRole("textbox", { name: "New amount this cycle" }), "400");
    expect(
      adjust.getByText(
        `This cycle ${m("100.00")} → ${m("400.00")}, a bucket adjustment of +${m("300.00")}`,
      ),
    ).toBeInTheDocument();
    await userEvent.click(apply);
    expect(await screen.findByText("Fuel adjusted.")).toBeInTheDocument();
    await closed();
    expect(apiMock.calls("POST /api/v1/buckets/1000000001/adjustment").map((c) => c.body)).toEqual([
      { mode: "temporary", target_funds: "400.00" },
    ]);
  });

  it("changes the refill amount, and this cycle too with Both", async () => {
    apiMock.on("POST /api/v1/buckets/1000000001/adjustment", { body: fuel });
    const adjust = await openAdjust();

    await userEvent.click(adjust.getByRole("radio", { name: /^From next refill/ }));
    await userEvent.type(adjust.getByRole("textbox", { name: "New refill amount" }), "1500");
    expect(adjust.getByText(`Refill amount ${m("1000.00")} → ${m("1500.00")}`)).toBeInTheDocument();
    expect(adjust.getByText(`This cycle stays at ${m("100.00")}`)).toBeInTheDocument();
    expect(adjust.getByText(`The capacity is raised to ${m("1500.00")}.`)).toBeInTheDocument();

    await userEvent.click(adjust.getByRole("radio", { name: /^Both/ }));
    await userEvent.type(adjust.getByRole("textbox", { name: "New refill amount" }), "500");
    expect(
      adjust.getByText(
        `This cycle ${m("100.00")} → ${m("-400.00")}, a bucket adjustment of −${m("500.00")}`,
      ),
    ).toBeInTheDocument();
    expect(adjust.getByText(`Fuel goes below 0: overspent by ${m("400.00")}.`)).toBeInTheDocument();
    await userEvent.click(adjust.getByRole("button", { name: "Apply adjustment" }));
    await screen.findByText("Fuel adjusted.");
    expect(apiMock.calls("POST /api/v1/buckets/1000000001/adjustment").map((c) => c.body)).toEqual([
      { mode: "both", refill_amount: "500.00" },
    ]);
  });

  it("asks for a different amount", async () => {
    const adjust = await openAdjust();
    await userEvent.type(adjust.getByRole("textbox", { name: "New amount this cycle" }), "100");
    expect(adjust.getByText("Enter a different amount.")).toBeInTheDocument();
    expect(adjust.getByRole("button", { name: "Apply adjustment" })).toBeDisabled();
  });

  it("changes only the refill amount without a running cycle", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    const adjust = await openAdjust();
    await userEvent.type(adjust.getByRole("textbox", { name: "New amount this cycle" }), "400");
    expect(
      adjust.getByText("This cycle can only change while a cycle is active."),
    ).toBeInTheDocument();
    expect(adjust.getByRole("button", { name: "Apply adjustment" })).toBeDisabled();
    await userEvent.click(adjust.getByRole("radio", { name: /^From next refill/ }));
    await userEvent.type(adjust.getByRole("textbox", { name: "New refill amount" }), "1500");
    expect(adjust.getByRole("button", { name: "Apply adjustment" })).toBeEnabled();
  });

  it("shows an error from the API", async () => {
    apiMock.on(
      "POST /api/v1/buckets/1000000001/adjustment",
      problem(409, "cycle_overdue", "The active cycle's end date has passed."),
    );
    const adjust = await openAdjust();
    await userEvent.type(adjust.getByRole("textbox", { name: "New amount this cycle" }), "400");
    await userEvent.click(adjust.getByRole("button", { name: "Apply adjustment" }));
    expect(await adjust.findByRole("alert")).toBeInTheDocument();
  });

  it("moves funds to a bucket in the same currency", async () => {
    apiMock.on("POST /api/v1/buckets/1000000001/transfer", { body: { from: fuel, to: fun } });
    const dialog = await openAdjust();
    await userEvent.click(dialog.getByRole("radio", { name: "Move to another bucket" }));

    await userEvent.click(dialog.getByRole("combobox", { name: "To bucket" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Travel", "Fun"]);
    await userEvent.click(screen.getByRole("option", { name: "Fun" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "150");
    expect(
      dialog.getByText(
        `Fuel: this cycle ${m("100.00")} → ${m("-50.00")} · refill amount ${m("1000.00")} → ${m("1000.00")}`,
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(
        `Fun: this cycle ${m("50.00")} → ${m("200.00")} · refill amount ${m("0.00")} → ${m("0.00")}`,
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText(`Fuel goes below 0: overspent by ${m("50.00")}.`)).toBeInTheDocument();

    await userEvent.click(dialog.getByRole("radio", { name: /^From next refill/ }));
    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "1500");
    expect(dialog.getByText(`Fuel's refill amount is only ${m("1000.00")}.`)).toBeInTheDocument();
    await userEvent.clear(dialog.getByRole("textbox", { name: "Amount" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Amount" }), "300");
    await userEvent.click(dialog.getByRole("button", { name: "Move funds" }));
    expect(await screen.findByText(`Moved ${m("300.00")} from Fuel to Fun.`)).toBeInTheDocument();
    await closed();
    expect(apiMock.calls("POST /api/v1/buckets/1000000001/transfer").map((c) => c.body)).toEqual([
      { to_bucket_id: fun.id, mode: "future", amount: "300.00" },
    ]);
  });

  it("opens from a bucket card on mobile", async () => {
    viewport.width = 390;
    const dialog = await openAdjust();
    expect(dialog.getByRole("button", { name: "Apply adjustment" })).toBeInTheDocument();
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", { body: { ...testUser, preferences: { language: "nn" } } });
    renderRoute("/buckets");
    await userEvent.click(await screen.findByRole("button", { name: "Juster midlar for Fuel" }));
    const adjust = within(await screen.findByRole("dialog", { name: "Juster midlar: Fuel" }));
    expect(adjust.getByRole("radio", { name: /^Berre denne perioden/ })).toBeChecked();
    expect(adjust.getByRole("button", { name: "Utfør justeringa" })).toBeInTheDocument();
  });
});
