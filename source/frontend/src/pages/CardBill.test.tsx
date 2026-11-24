// A credit card's bill on the screens (#262): the Bill panel on Accounts,
// setting it up, finalizing it with its payment, paying it now, the bill row
// on the card and the mobile line.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Account, CardBill } from "@/api/accounts";
import { setServerClock } from "@/lib/clock";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { apiMock, problem } from "@/test/api";
import { amountOf } from "@/test/breakdown";
import { account, creditCard } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** As Testing Library reads it: ICU's no-break spaces become plain ones. */
const plain = (s: string) => s.replace(/\s/g, " ");
const m = (amount: string) => plain(formatMoney(amount, "NOK"));
const d = (date: string) => plain(formatDate(date));

const main = account({ id: "1234", name: "Main account", balance: "10000.00" });

// The statement of 1 December: 4 520, due the 15th, nothing paid yet.
const statement = {
  id: "900020261201",
  statement_date: "2026-12-01",
  cutoff: "2026-11-30T23:00:00Z",
  due_date: "2026-12-15",
  amount: "4520.00",
  minimum: "300.00",
  paid: "0.00",
  left: "4520.00",
  minimum_left: "300.00",
  fixed: false,
  fixed_by: null,
  fixed_at: null,
} satisfies NonNullable<CardBill["current"]>;

function visa(
  bill: Partial<CardBill> = {},
  card: Partial<NonNullable<Account["credit_card"]>> = {},
) {
  return account({
    id: "9000",
    name: "Visa",
    type: "credit_card",
    balance: "-4520.00",
    credit_card: creditCard({
      bill: {
        set_up: true,
        current: statement,
        previous: null,
        next_statement_date: "2027-01-01",
        payment: null,
        ...bill,
      },
      ...card,
    }),
  });
}

/** Freezes the app's clock at time (ISO 8601). */
function at(time: string) {
  setServerClock({ now: time, real_now: time, mode: "frozen" });
}

beforeEach(() => {
  viewport.width = 1280;
  at("2026-12-05T10:00:00Z");
  apiMock.on("GET /api/v1/accounts", { body: [main, visa()] });
  apiMock.on("GET /api/v1/buckets", { body: [] });
});

afterEach(() => {
  setServerClock(null);
});

async function openBill() {
  renderRoute("/accounts");
  const card = await screen.findByRole("article", { name: "Visa" });
  await userEvent.click(within(card).getByRole("button", { name: "Bill" }));
  return screen.findByRole("region", { name: "Bill" });
}

function finalizeBody(): Record<string, unknown> | undefined {
  return apiMock.calls("POST /api/v1/accounts/9000/bill/finalize").at(-1)?.body as
    Record<string, unknown> | undefined;
}

describe("A card's bill on Accounts (#262)", () => {
  it("shows the bill on the card, and its statement in the Bill panel", async () => {
    renderRoute("/accounts");
    const figures = await screen.findByLabelText("Credit on Visa");
    expect(amountOf(figures, "Bill")).toBe(m("4520.00"));
    expect(within(figures).getByText(`Due ${d("2026-12-15")}`)).toBeInTheDocument();
    expect(within(figures).getByText(`Not finalized · Minimum ${m("300.00")}`)).toBeInTheDocument();

    const card = screen.getByRole("article", { name: "Visa" });
    await userEvent.click(within(card).getByRole("button", { name: "Bill" }));
    const panel = await screen.findByRole("region", { name: "Bill" });
    expect(within(panel).getByText(`Statement ${d("2026-12-01")}`)).toBeInTheDocument();
    expect(within(panel).getByText("Not finalized")).toBeInTheDocument();
    const rows = within(panel).getByLabelText("Visa's bill");
    expect(within(rows).getByText("Left to pay")).toBeInTheDocument();
    expect(within(rows).getByText(`${m("300.00")} of the minimum left`)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Finalize bill" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Pay bill" })).toBeInTheDocument();
  });

  it("opens the bill from a notification's ?bill= link, and closes it", async () => {
    renderRoute("/accounts?bill=9000");
    const panel = await screen.findByRole("region", { name: "Bill" });
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Bill" })).not.toBeInTheDocument();
    });
  });

  it("colors the bill orange when it's due soon and red past due", async () => {
    at("2026-12-13T10:00:00Z");
    const { unmount } = renderRoute("/accounts");
    const figures = await screen.findByLabelText("Credit on Visa");
    expect(within(figures).getByText("Bill")).toHaveStyle({
      color: "var(--mantine-color-orange-text)",
    });
    unmount();

    at("2026-12-16T10:00:00Z");
    renderRoute("/accounts");
    const past = await screen.findByLabelText("Credit on Visa");
    expect(within(past).getByText("Past due")).toHaveStyle({
      color: "var(--mantine-color-red-text)",
    });
  });

  it("shows a scheduled payment, and says when it's paid", async () => {
    apiMock.on("GET /api/v1/accounts", {
      body: [
        main,
        visa({
          current: {
            ...statement,
            fixed: true,
            fixed_by: "bank",
            fixed_at: "2026-12-03T10:00:00Z",
          },
          payment: {
            schedule_id: "1000011234",
            rule: "full",
            amount: "4520.00",
            account_id: "1234",
            at: "2026-12-15T07:00:00Z",
            mode: "approve",
            state: "queued",
            reason: null,
          },
        }),
      ],
    });
    const panel = await openBill();
    expect(within(panel).getByText(`Finalized ${d("2026-12-03")}`)).toBeInTheDocument();
    expect(
      within(panel).getByText(/from Main account on .* waits for your approval/),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Scheduled" })).toHaveAttribute(
      "href",
      "/transactions/scheduled",
    );
    expect(within(panel).queryByRole("button", { name: "Finalize bill" })).not.toBeInTheDocument();
    const figures = screen.getByLabelText("Credit on Visa");
    expect(
      within(figures).getByText(`Payment waits for approval · Minimum ${m("300.00")}`),
    ).toBeInTheDocument();
  });
});

describe("Setting up a card's bill (#262)", () => {
  const locked = () => visa({ set_up: false, current: null, next_statement_date: "2026-12-01" });

  it("sets up a card from before with its last statement", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [main, locked()] });
    apiMock.on("POST /api/v1/accounts/9000/bill/setup", { body: locked().credit_card?.bill });
    renderRoute("/accounts");
    const card = await screen.findByRole("article", { name: "Visa" });
    expect(within(card).getByText("Not set up")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Set up bill" }));
    const panel = await screen.findByRole("region", { name: "Set up bill" });
    await userEvent.type(within(panel).getByRole("textbox", { name: "Its amount" }), "3000");
    await userEvent.type(within(panel).getByRole("textbox", { name: "Paid on it since" }), "500");
    await userEvent.click(within(panel).getByRole("button", { name: "Set up bill" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/accounts/9000/bill/setup")[0]?.body).toEqual({
        last_statement: { amount: "3000.00", paid: "500.00" },
      });
    });
  });

  it("sets up a card without a statement yet", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [main, locked()] });
    apiMock.on("POST /api/v1/accounts/9000/bill/setup", { body: locked().credit_card?.bill });
    renderRoute("/accounts?bill=9000");
    const panel = await screen.findByRole("region", { name: "Set up bill" });
    await userEvent.click(within(panel).getByRole("radio", { name: "No statement yet" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Set up bill" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/accounts/9000/bill/setup")[0]?.body).toEqual({
        last_statement: null,
      });
    });
  });
});

describe("Finalize bill (#262)", () => {
  beforeEach(() => {
    apiMock.on("POST /api/v1/accounts/9000/bill/finalize", {
      body: { bill: visa().credit_card?.bill, schedule_id: "1000011234", transaction_id: null },
    });
  });

  async function openFinalize() {
    const panel = await openBill();
    await userEvent.click(within(panel).getByRole("button", { name: "Finalize bill" }));
    return screen.findByRole("region", { name: "Finalize bill" });
  }

  it("schedules the payment from the card's defaults, checked against the bank's amount", async () => {
    const form = await openFinalize();
    const amount = within(form).getByRole("textbox", { name: "Statement amount" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "4600");
    expect(within(form).getByText(new RegExp(`The app has ${m("4520.00")}`))).toBeInTheDocument();
    expect(
      within(form).getByText(`Pays ${m("4600.00")}, or what's left by then.`),
    ).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Finalize bill" }));
    await waitFor(() => {
      expect(finalizeBody()).toEqual({
        amount: "4600.00",
        payment: {
          rule: "full",
          account_id: "1234",
          // The due date at 08:00 in Oslo.
          at: new Date(2026, 11, 15, 8, 0, 0).toISOString(),
          mode: "approve",
        },
      });
    });
    expect(await screen.findByRole("region", { name: "Bill" })).toBeInTheDocument();
  });

  it("starts from the defaults: a fixed amount, days before, recorded", async () => {
    apiMock.on("GET /api/v1/accounts", {
      body: [
        main,
        visa(
          {},
          {
            pay: {
              rule: "fixed",
              amount: "1000.00",
              days_before: 2,
              mode: "auto",
              auto_finalize: false,
            },
          },
        ),
      ],
    });
    const form = await openFinalize();
    expect(
      within(form).getByText(`Pays ${m("1000.00")}, or what's left by then.`),
    ).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Finalize bill" }));
    await waitFor(() => {
      expect(finalizeBody()).toEqual({
        amount: "4520.00",
        payment: {
          rule: "fixed",
          amount: "1000.00",
          account_id: "1234",
          at: new Date(2026, 11, 13, 8, 0, 0).toISOString(),
          mode: "auto",
        },
      });
    });
  });

  it("pays the minimum now, asking first when the server does", async () => {
    let calls = 0;
    apiMock.on("POST /api/v1/accounts/9000/bill/finalize", () => {
      calls++;
      return calls === 1
        ? problem(409, "bsu_withdrawal", "It takes money out of a BSU.")
        : { body: { bill: visa().credit_card?.bill, schedule_id: null, transaction_id: "1" } };
    });
    const form = await openFinalize();
    await userEvent.click(within(form).getByRole("radio", { name: "Now" }));
    await userEvent.click(within(form).getByRole("radio", { name: "Minimum" }));
    expect(within(form).getByText(`Pays ${m("300.00")} now.`)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Finalize bill" }));
    const confirm = await within(form).findByRole("button", { name: "Record it anyway" });
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(finalizeBody()).toEqual({
        amount: "4520.00",
        payment: { rule: "minimum", account_id: "1234", mode: "auto", bsu_confirmed: true },
      });
    });
  });

  it("finalizes without a payment", async () => {
    const form = await openFinalize();
    await userEvent.click(within(form).getByRole("radio", { name: "Don't pay" }));
    await userEvent.click(within(form).getByRole("button", { name: "Finalize bill" }));
    await waitFor(() => {
      expect(finalizeBody()).toEqual({ amount: "4520.00", payment: null });
    });
  });

  it("goes back to the bill", async () => {
    const form = await openFinalize();
    await userEvent.click(within(form).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("region", { name: "Bill" })).toBeInTheDocument();
  });
});

describe("Pay bill (#262)", () => {
  beforeEach(() => {
    apiMock.on("POST /api/v1/transactions", { status: 201, body: {} });
  });

  it("pays what's left, the minimum or another amount, as a transfer to the card", async () => {
    const panel = await openBill();
    await userEvent.click(within(panel).getByRole("button", { name: "Pay bill" }));
    const form = await screen.findByRole("region", { name: "Pay bill" });
    expect(within(form).getByText(`Pays ${m("4520.00")} now.`)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("radio", { name: "Other" }));
    await userEvent.type(within(form).getByRole("textbox", { name: "Amount" }), "750");
    await userEvent.click(within(form).getByRole("button", { name: "Pay bill" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/transactions")[0]?.body).toEqual({
        type: "TRF",
        account_id: "1234",
        to_account_id: "9000",
        amount: "750.00",
      });
    });
  });
});

describe("A card's line on the mobile list (#262)", () => {
  beforeEach(() => {
    viewport.width = 400;
  });

  it("shows what's available until the bill needs you", async () => {
    renderRoute("/accounts");
    expect(await screen.findByText(`${m("15480.00")} available`)).toBeInTheDocument();
  });

  it("shows the bill when it's due soon, in orange", async () => {
    at("2026-12-13T10:00:00Z");
    renderRoute("/accounts");
    expect(await screen.findByText(`Bill ${m("4520.00")} due ${d("2026-12-15")}`)).toHaveStyle({
      color: "var(--mantine-color-orange-text)",
    });
  });

  it("shows the bill past due in red, and Set up bill when locked", async () => {
    at("2026-12-16T10:00:00Z");
    const { unmount } = renderRoute("/accounts");
    expect(await screen.findByText(`Bill ${m("4520.00")} past due`)).toHaveStyle({
      color: "var(--mantine-color-red-text)",
    });
    unmount();
    apiMock.on("GET /api/v1/accounts", {
      body: [main, visa({ set_up: false, current: null })],
    });
    renderRoute("/accounts");
    expect(await screen.findByText("Set up bill")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More for Visa" }));
    expect(await screen.findByRole("menuitem", { name: "Set up bill" })).toBeInTheDocument();
  });
});
