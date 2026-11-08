import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Occurrence, Schedule } from "@/lib/schedules";
import { apiMock, problem, testUser } from "@/test/api";
import { account, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

// The approval queue, Edit and approve, the counts and the Scheduled widget (#155).

const LA = "America/Los_Angeles";
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const main = account({ id: "1234", name: "Main account" });

function schedule(overrides: Partial<Schedule> & Pick<Schedule, "id">): Schedule {
  return {
    name: "",
    transaction: { type: "EXP", account_id: main.id, amount: "9000.00", counterparty: "Landlord" },
    mode: "approve",
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
    next_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function occurrence(overrides: Partial<Occurrence> & Pick<Occurrence, "id">): Occurrence {
  return {
    schedule_id: rent.id,
    scheduled_at: ago(2),
    state: "queued",
    reason: "approval",
    detail: "",
    queued_at: ago(2),
    due_at: new Date(Date.now() + 70 * HOUR).toISOString(),
    overdue: false,
    transaction_id: null,
    resolved_at: null,
    ...overrides,
  };
}

const rent = schedule({ id: "1234560001", name: "Rent" });
const gym = schedule({
  id: "1234560002",
  mode: "auto",
  transaction: { type: "EXP", account_id: main.id, amount: "399.00", counterparty: "Gym" },
});
const rentNow = occurrence({ id: "5000000001" });
const gymLate = occurrence({
  id: "5000000002",
  schedule_id: gym.id,
  scheduled_at: ago(24 * 5),
  reason: "no_active_cycle",
  due_at: ago(24 * 2),
  overdue: true,
});

const approveRoute = (id: string) => `POST /api/v1/scheduled-transactions/${id}/approve`;
const skipRoute = (id: string) => `POST /api/v1/scheduled-transactions/${id}/skip`;
const approved = (o: Occurrence) => ({
  body: {
    scheduled_transaction: { ...o, state: "applied", transaction_id: "2026110800000001" },
    transaction: transaction({ id: "2026110800000001" }),
  },
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main] });
  apiMock.on("GET /api/v1/schedules", { body: [rent, gym] });
  apiMock.on("GET /api/v1/scheduled-transactions", {
    body: { items: [rentNow, gymLate], next_cursor: null },
  });
});

const queue = async () =>
  within(await screen.findByRole("region", { name: /Waiting for approval/ }, { timeout: 5000 }));

describe("the approval queue", () => {
  it("lists the waiting ones, overdue first, with why", async () => {
    renderRoute("/transactions/scheduled");
    const q = await queue();
    expect(q.getByRole("heading", { name: "Waiting for approval (2)" })).toBeInTheDocument();
    expect(apiMock.calls("GET /api/v1/scheduled-transactions")[0]?.query.get("state")).toBe(
      "queued",
    );
    const [first, second] = q.getAllByTestId("queue-row");
    expect(first).toHaveTextContent("Gym");
    expect(first).toHaveTextContent("There was no active cycle");
    expect(first).toHaveTextContent("Overdue");
    expect(first).toHaveTextContent("-NOK 399.00");
    expect(second).toHaveTextContent("Rent");
    expect(second).toHaveTextContent("Asks for approval");
    expect(second).toHaveTextContent(/Due /);
    expect(q.getAllByRole("link", { name: "Edit and approve" })[1]).toHaveAttribute(
      "href",
      "/transactions/scheduled/queue/5000000001/approve",
    );
  });

  it("approves one as it is, and skips one", async () => {
    apiMock.on(approveRoute(rentNow.id), approved(rentNow));
    apiMock.on(skipRoute(gymLate.id), { body: { ...gymLate, state: "skipped" } });
    renderRoute("/transactions/scheduled");
    const q = await queue();
    await userEvent.click(q.getByRole("button", { name: "Approve Rent" }));
    await waitFor(() => {
      expect(apiMock.calls(approveRoute(rentNow.id))).toHaveLength(1);
    });
    expect(apiMock.calls(approveRoute(rentNow.id))[0]?.body).toBeUndefined();
    expect(await screen.findByText("Approved and recorded.")).toBeInTheDocument();

    await userEvent.click(q.getByRole("button", { name: "Skip Gym" }));
    await waitFor(() => {
      expect(apiMock.calls(skipRoute(gymLate.id))).toHaveLength(1);
    });
    expect(await screen.findByText("Skipped.")).toBeInTheDocument();
  });

  it("shows why one couldn't be approved", async () => {
    apiMock.on(
      approveRoute(rentNow.id),
      problem(409, "no_active_cycle", "Bucket transactions need an active cycle."),
    );
    renderRoute("/transactions/scheduled");
    const q = await queue();
    await userEvent.click(q.getByRole("button", { name: "Approve Rent" }));
    expect(
      await q.findByText("Bucket transactions need an active cycle. Start a cycle first."),
    ).toBeInTheDocument();
  });

  it("approves the selected ones, and keeps the ones that failed selected", async () => {
    apiMock.on(approveRoute(rentNow.id), approved(rentNow));
    apiMock.on(
      approveRoute(gymLate.id),
      problem(409, "no_active_cycle", "Bucket transactions need an active cycle."),
    );
    renderRoute("/transactions/scheduled");
    const q = await queue();
    await userEvent.click(q.getByRole("checkbox", { name: "Select all" }));
    await userEvent.click(q.getByRole("button", { name: "Approve selected (2)" }));
    expect(
      await q.findByText(
        "1 couldn't be approved: Bucket transactions need an active cycle. Start a cycle first.",
      ),
    ).toBeInTheDocument();
    // One at a time, overdue first.
    expect(apiMock.requests.filter((r) => r.path.endsWith("/approve")).map((r) => r.path)).toEqual([
      "/api/v1/scheduled-transactions/5000000002/approve",
      "/api/v1/scheduled-transactions/5000000001/approve",
    ]);
    expect(screen.getByText("Approved and recorded.")).toBeInTheDocument();
    expect(q.getByRole("checkbox", { name: "Select Gym" })).toBeChecked();
    expect(q.getByRole("checkbox", { name: "Select Rent" })).not.toBeChecked();
  });

  it("puts Edit and approve and Skip in a menu on phones", async () => {
    viewport.width = 375;
    apiMock.on(skipRoute(rentNow.id), { body: { ...rentNow, state: "skipped" } });
    renderRoute("/transactions/scheduled");
    const q = await queue();
    expect(q.queryByRole("button", { name: "Skip Rent" })).not.toBeInTheDocument();
    await userEvent.click(q.getByRole("button", { name: "More for Rent" }));
    expect(await screen.findByRole("menuitem", { name: "Edit and approve" })).toHaveAttribute(
      "href",
      "/transactions/scheduled/queue/5000000001/approve",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Skip" }));
    await waitFor(() => {
      expect(apiMock.calls(skipRoute(rentNow.id))).toHaveLength(1);
    });
  });

  it("isn't there while nothing waits", async () => {
    apiMock.on("GET /api/v1/scheduled-transactions", { body: { items: [], next_cursor: null } });
    renderRoute("/transactions/scheduled");
    expect(
      await screen.findByRole("link", { name: /Rent/ }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Waiting for approval/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Scheduled" })).toBeInTheDocument();
  });
});

describe("the counts", () => {
  it("shows how many wait on the tab and in the side menu, red when overdue", async () => {
    renderRoute("/transactions/scheduled");
    await queue();
    // jsdom doesn't space the tab's label and its badge, as a browser's flex does.
    const tab = screen.getByRole("tab", {
      name: /^Scheduled ?2 waiting for approval, some overdue$/,
    });
    expect(within(tab).getByTestId("queue-badge")).toHaveTextContent("2");
    expect(within(tab).getByTestId("queue-badge")).toHaveAttribute(
      "style",
      expect.stringContaining("red") as string,
    );
    const nav = screen.getByRole("navigation");
    expect(
      within(nav).getByRole("link", { name: "Transactions 2 waiting for approval, some overdue" }),
    ).toBeInTheDocument();
  });

  it("shows the count on the bottom tab on phones", async () => {
    viewport.width = 375;
    apiMock.on("GET /api/v1/scheduled-transactions", {
      body: { items: [rentNow], next_cursor: null },
    });
    renderRoute("/");
    const footer = await screen.findByRole("contentinfo");
    expect(
      await within(footer).findByRole("link", { name: "1 waiting for approval Transactions" }),
    ).toBeInTheDocument();
  });
});

describe("Edit and approve", () => {
  beforeEach(() => {
    apiMock.on(`GET /api/v1/scheduled-transactions/${rentNow.id}`, { body: rentNow });
    apiMock.on(`GET /api/v1/schedules/${rent.id}`, { body: rent });
  });

  it("approves it as edited, dated at its time in the active cycle", async () => {
    apiMock.on(approveRoute(rentNow.id), approved(rentNow));
    const { router } = renderRoute(`/transactions/scheduled/queue/${rentNow.id}/approve`);
    const amount = await screen.findByRole("textbox", { name: "Amount" }, { timeout: 5000 });
    expect(amount).toHaveValue("9,000.00");
    expect(
      screen.getByRole("heading", { name: "Approve scheduled transaction" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Type" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /^Repeat or schedule/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and add another" })).not.toBeInTheDocument();
    await userEvent.clear(amount);
    await userEvent.type(amount, "8500");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(apiMock.calls(approveRoute(rentNow.id))).toHaveLength(1);
    });
    expect(apiMock.calls(approveRoute(rentNow.id))[0]?.body).toEqual({
      type: "EXP",
      account_id: main.id,
      amount: "8500.00",
      counterparty: "Landlord",
      at: rentNow.scheduled_at,
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/transactions/scheduled");
    });
  });

  it("dates it now when its time is before the active cycle", async () => {
    const early = occurrence({ id: "5000000003", scheduled_at: ago(24 * 40) });
    apiMock.on(`GET /api/v1/scheduled-transactions/${early.id}`, { body: early });
    apiMock.on(approveRoute(early.id), approved(early));
    renderRoute(`/transactions/scheduled/queue/${early.id}/approve`);
    await screen.findByRole("textbox", { name: "Amount" }, { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(apiMock.calls(approveRoute(early.id))).toHaveLength(1);
    });
    expect(apiMock.calls(approveRoute(early.id))[0]?.body).not.toHaveProperty("at");
  });

  it("says so when it's already resolved", async () => {
    apiMock.on(`GET /api/v1/scheduled-transactions/${rentNow.id}`, {
      body: { ...rentNow, state: "skipped" },
    });
    renderRoute(`/transactions/scheduled/queue/${rentNow.id}/approve`);
    expect(
      await screen.findByText(
        "This scheduled transaction has already been approved or skipped.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });
});

describe("the Scheduled widget", () => {
  const withWidget = (settings: { show: "both" | "queue" | "upcoming"; count: number }) => {
    apiMock.on("GET /api/v1/me", {
      body: {
        ...testUser,
        preferences: {
          ...testUser.preferences,
          dashboard: {
            widgets: [{ id: "s", type: "scheduled", width: "half", scheduled: settings }],
          },
        },
      },
    });
  };
  const soon = new Date(Date.now() + 48 * HOUR).toISOString();

  beforeEach(() => {
    apiMock.on("GET /api/v1/upcoming-transactions", {
      body: [
        { schedule_id: rent.id, at: soon },
        { schedule_id: gym.id, at: soon },
      ],
    });
    apiMock.on("GET /api/v1/cycles/active", { body: { active: cycle(), next: null } });
  });

  const widget = async () =>
    within(await screen.findByRole("region", { name: "Scheduled" }, { timeout: 5000 }));

  it("shows the queue, then what's coming up", async () => {
    withWidget({ show: "both", count: 5 });
    apiMock.on(approveRoute(gymLate.id), approved(gymLate));
    renderRoute("/");
    const w = await widget();
    expect(await w.findAllByTestId("widget-queue-row")).toHaveLength(2);
    expect(w.getAllByTestId("widget-queue-row")[0]).toHaveTextContent("Overdue");
    const upcoming = await w.findAllByTestId("widget-upcoming-row");
    expect(upcoming[0]).toHaveTextContent("Rent");
    expect(upcoming[0]).toHaveTextContent("Asks first");
    expect(upcoming[1]).not.toHaveTextContent("Asks first");
    expect(apiMock.calls("GET /api/v1/upcoming-transactions")[0]?.query.get("count")).toBe("5");
    await userEvent.click(w.getByRole("button", { name: "Approve Gym" }));
    await waitFor(() => {
      expect(apiMock.calls(approveRoute(gymLate.id))).toHaveLength(1);
    });
  });

  it("shows the queue only, with a link to the rest", async () => {
    withWidget({ show: "queue", count: 1 });
    renderRoute("/");
    const w = await widget();
    expect(await w.findAllByTestId("widget-queue-row")).toHaveLength(1);
    expect(w.getByRole("link", { name: "and 1 more" })).toHaveAttribute(
      "href",
      "/transactions/scheduled",
    );
    expect(w.queryByTestId("widget-upcoming-row")).not.toBeInTheDocument();
    expect(apiMock.calls("GET /api/v1/upcoming-transactions")).toHaveLength(0);
  });

  it("shows what's coming up only, and says when nothing is", async () => {
    withWidget({ show: "upcoming", count: 3 });
    apiMock.on("GET /api/v1/upcoming-transactions", { body: [] });
    renderRoute("/");
    const w = await widget();
    expect(await w.findByText("Nothing is coming up.")).toBeInTheDocument();
    expect(w.queryByTestId("widget-queue-row")).not.toBeInTheDocument();
  });
});
