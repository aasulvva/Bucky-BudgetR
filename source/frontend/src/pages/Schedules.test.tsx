import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { wallTime, type Schedule } from "@/lib/schedules";
import { apiMock } from "@/test/api";
import { account, bucket, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

// The tests run in America/Los_Angeles, the user's time zone too.
const LA = "America/Los_Angeles";

const main = account({ id: "1234", name: "Main account" });
const savings = account({ id: "2345", name: "Savings account" });
const groceries = bucket({ id: "1000000001", name: "Groceries", source_account_id: main.id });

function schedule(overrides: Partial<Schedule> & Pick<Schedule, "id">): Schedule {
  return {
    name: "",
    transaction: { type: "EXP", account_id: main.id, amount: "9000.00", counterparty: "Landlord" },
    mode: "auto",
    due_days: 3,
    start_date: "2026-08-25",
    time: "08:00",
    time_zone: LA,
    frequency: "month",
    every: 1,
    end_count: null,
    end_date: null,
    paused: false,
    next_index: 3,
    next_at: "2026-11-25T16:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

const rent = schedule({ id: "1234560001", name: "Rent", mode: "approve" });
const saving = schedule({
  id: "1234560002",
  transaction: { type: "TRF", account_id: main.id, to_account_id: savings.id, amount: "1500.00" },
  frequency: "week",
  every: 2,
  start_date: "2026-11-02",
  time: "07:00",
  next_at: "2026-11-16T15:00:00Z",
});
const gym = schedule({
  id: "1234560003",
  transaction: { type: "EXP", account_id: main.id, amount: "399.00", counterparty: "Gym" },
  start_date: "2026-08-01",
  time: "06:00",
  paused: true,
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main, savings] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries] });
  apiMock.on("GET /api/v1/schedules", { body: [rent, saving, gym] });
  apiMock.on("POST /api/v1/schedules/preview", {
    body: ["2026-11-25T16:00:00Z", "2026-12-25T16:00:00Z"],
  });
});

async function pick(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Scheduled tab", () => {
  it("lists the schedules in words, and switches tabs by URL", async () => {
    const { router } = renderRoute("/transactions/scheduled");
    const row = await screen.findByRole("link", { name: /Rent/ }, { timeout: 5000 });
    expect(row).toHaveTextContent("Every month on the 25th at 08:00");
    expect(row).toHaveTextContent("Asks first");
    expect(row).toHaveTextContent("Main account");
    expect(row).toHaveAttribute("href", "/transactions/scheduled/1234560001/edit");
    expect(screen.getByRole("link", { name: /Main account → Savings account/ })).toHaveTextContent(
      "Every 2 weeks on Monday at 07:00",
    );
    expect(screen.getByRole("link", { name: /Gym/ })).toHaveTextContent("Paused");
    expect(screen.getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: "Transactions" }));
    expect(router.state.location.pathname).toBe("/transactions");
    await userEvent.click(screen.getByRole("tab", { name: "Scheduled" }));
    expect(router.state.location.pathname).toBe("/transactions/scheduled");
  });

  it("pauses and resumes a schedule with the whole of it", async () => {
    apiMock.on("PUT /api/v1/schedules/1234560001", { body: { ...rent, paused: true } });
    apiMock.on("PUT /api/v1/schedules/1234560003", { body: { ...gym, paused: false } });
    renderRoute("/transactions/scheduled");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Rent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() => {
      expect(apiMock.calls("PUT /api/v1/schedules/1234560001")).toHaveLength(1);
    });
    expect(apiMock.calls("PUT /api/v1/schedules/1234560001")[0]?.body).toEqual({
      name: "Rent",
      transaction: rent.transaction,
      mode: "approve",
      due_days: 3,
      start_date: "2026-08-25",
      time: "08:00",
      time_zone: LA,
      frequency: "month",
      every: 1,
      paused: true,
    });
    expect(await screen.findByText("Schedule paused.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Actions for Gym" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    await waitFor(() => {
      expect(apiMock.calls("PUT /api/v1/schedules/1234560003")[0]?.body).toMatchObject({
        paused: false,
      });
    });
  });

  it("asks before deleting a schedule", async () => {
    apiMock.on("DELETE /api/v1/schedules/1234560001", { status: 204 });
    renderRoute("/transactions/scheduled");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Rent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/The transactions it recorded stay/)).toBeInTheDocument();
    expect(apiMock.calls("DELETE /api/v1/schedules/1234560001")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete Rent" }));
    expect(await screen.findByText("Schedule deleted.")).toBeInTheDocument();
    expect(apiMock.calls("DELETE /api/v1/schedules/1234560001")).toHaveLength(1);
  });

  it("explains when there are none", async () => {
    apiMock.on("GET /api/v1/schedules", { body: [] });
    renderRoute("/transactions/scheduled");
    expect(
      await screen.findByText(/No scheduled transactions yet/, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New schedule" })).toHaveAttribute(
      "href",
      "/transactions/scheduled/new",
    );
  });
});

describe("Repeat in New transaction", () => {
  it("saves a schedule that records the first now", async () => {
    apiMock.on("POST /api/v1/schedules", {
      status: 201,
      body: schedule({ id: "1234560009", next_index: 1, next_at: "2026-12-08T18:00:00Z" }),
    });
    const { router } = renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "9000");
    await pick("Account", /^Main account/);
    await userEvent.type(screen.getByRole("combobox", { name: "Paid to" }), "Landlord");
    expect(screen.getByRole("button", { name: "Save and add another" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: /^Repeat or schedule/ }));
    expect(screen.queryByRole("button", { name: "Save and add another" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
    const repeat = within(screen.getByRole("region", { name: "Repeat" }));
    expect(await repeat.findByText(/The first, .*, is saved now/)).toBeInTheDocument();
    expect(await repeat.findByTestId("schedule-preview")).toBeInTheDocument();
    await userEvent.type(repeat.getByRole("textbox", { name: "Name" }), "Rent");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/schedules")).toHaveLength(1);
    });
    const req = apiMock.calls("POST /api/v1/schedules")[0];
    expect(req?.query.get("record_first")).toBe("true");
    expect(req?.body).toEqual({
      name: "Rent",
      transaction: {
        type: "EXP",
        account_id: main.id,
        amount: "9000.00",
        counterparty: "Landlord",
      },
      mode: "auto",
      due_days: 3,
      start_date: wallTime(new Date(), LA).date,
      time: expect.stringMatching(/^\d\d:\d\d$/) as unknown,
      time_zone: LA,
      frequency: "month",
      every: 1,
      paused: false,
    });
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(0);
    expect(await screen.findByText(/Saved\. It repeats from/)).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
  });

  it("checks the repeat before saving", async () => {
    renderRoute("/transactions/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "Amount" }), "100");
    await pick("Account", /^Main account/);
    await userEvent.click(screen.getByRole("switch", { name: /^Repeat or schedule/ }));
    const repeat = within(screen.getByRole("region", { name: "Repeat" }));
    await userEvent.click(repeat.getByRole("radio", { name: "On a date" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await repeat.findByText("Choose a date")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/schedules")).toHaveLength(0);
  });
});

describe("A future date in New transaction", () => {
  it("schedules it once, recorded or approved then", async () => {
    apiMock.on("POST /api/v1/schedules", {
      status: 201,
      body: schedule({ id: "1234560009", frequency: "once", next_index: 0 }),
    });
    const later = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const day = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(later);
    renderRoute("/transactions/new");
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Amount" }, { timeout: 5000 }),
      "500",
    );
    await pick("Account", /^Main account/);
    await userEvent.click(screen.getByRole("button", { name: /^Date/ }));
    await userEvent.click(await screen.findByRole("button", { name: day }));
    const submit = document.querySelector<HTMLButtonElement>(
      ".mantine-DateTimePicker-submitButton",
    );
    if (!submit) throw new Error("no submit button");
    await userEvent.click(submit);

    expect(await screen.findByText(/It's in the future/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and add another" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Ask me first" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/schedules")).toHaveLength(1);
    });
    const req = apiMock.calls("POST /api/v1/schedules")[0];
    expect(req?.query.get("record_first")).toBeNull();
    expect(req?.body).toMatchObject({
      transaction: { type: "EXP", account_id: main.id, amount: "500.00" },
      frequency: "once",
      mode: "approve",
      due_days: 3,
      start_date: wallTime(later, LA).date,
    });
    expect(apiMock.calls("POST /api/v1/transactions")).toHaveLength(0);
    expect(await screen.findByText(/Scheduled for/)).toBeInTheDocument();
  });
});

describe("Schedule pages", () => {
  it("makes a transaction recurring from its time", async () => {
    const tx = transaction({
      id: "2026102300000001",
      type: "INC",
      at: "2026-10-23T15:00:00Z",
      counterparty: "Employer AS",
      bank_lines: [{ account_id: main.id, amount: "32000.00" }],
    });
    apiMock.on("GET /api/v1/transactions/2026102300000001", { body: tx });
    apiMock.on("POST /api/v1/schedules", { status: 201, body: rent });
    const { router } = renderRoute("/transactions/scheduled/new?from=2026102300000001");
    expect(
      await screen.findByRole("heading", { name: "New schedule" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Amount" })).toHaveValue("32,000.00");
    expect(screen.queryByRole("switch", { name: /^Repeat or schedule/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/schedules")).toHaveLength(1);
    });
    const req = apiMock.calls("POST /api/v1/schedules")[0];
    expect(req?.query.get("record_first")).toBeNull();
    expect(req?.body).toMatchObject({
      transaction: {
        type: "INC",
        account_id: main.id,
        amount: "32000.00",
        counterparty: "Employer AS",
      },
      start_date: "2026-10-23",
      time: "08:00",
      frequency: "month",
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/transactions/scheduled");
    });
  });

  it("edits a schedule, its type included", async () => {
    apiMock.on("GET /api/v1/schedules/1234560001", { body: rent });
    apiMock.on("PUT /api/v1/schedules/1234560001", { body: rent });
    renderRoute("/transactions/scheduled/1234560001/edit");
    expect(await screen.findByRole("textbox", { name: "Amount" }, { timeout: 5000 })).toHaveValue(
      "9,000.00",
    );
    expect(screen.getByRole("radio", { name: "Ask me first" })).toBeChecked();
    expect(screen.getByRole("switch", { name: /^Paused/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: /^Paused/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PUT /api/v1/schedules/1234560001")).toHaveLength(1);
    });
    expect(apiMock.calls("PUT /api/v1/schedules/1234560001")[0]?.body).toMatchObject({
      name: "Rent",
      mode: "approve",
      paused: true,
      start_date: "2026-08-25",
    });
    expect(await screen.findByText("Schedule saved.")).toBeInTheDocument();
  });
});

describe("Scheduled transactions in the list", () => {
  it("marks them and links to their schedule", async () => {
    const tx = transaction({
      id: "2026102300000002",
      counterparty: "Landlord",
      schedule_id: rent.id,
      bank_lines: [{ account_id: main.id, amount: "-9000.00" }],
    });
    apiMock.on("GET /api/v1/transactions", { body: { items: [tx], next_cursor: null } });
    apiMock.on("GET /api/v1/transactions/2026102300000002", { body: tx });
    renderRoute("/transactions?open=2026102300000002");
    const row = await screen.findByRole("link", { name: /Landlord/ }, { timeout: 5000 });
    expect(within(row).getByRole("img", { name: "Recorded by a schedule" })).toBeInTheDocument();
    const detail = await screen.findByRole("article");
    expect(await within(detail).findByRole("link", { name: "Rent" })).toHaveAttribute(
      "href",
      "/transactions/scheduled/1234560001/edit",
    );
    expect(within(detail).getByRole("link", { name: "Make recurring" })).toHaveAttribute(
      "href",
      "/transactions/scheduled/new?from=2026102300000002",
    );
  });
});
