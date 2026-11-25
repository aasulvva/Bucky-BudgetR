import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Notification } from "@/api/notifications";
import { formatDate } from "@/lib/dates";
import type { Schedule } from "@/lib/schedules";
import { apiMock, problem, testUser, type MockRequest } from "@/test/api";
import { account, bucket, savingsTarget } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

// Notifications (#57): the screen, the counts and the settings.

const main = account({ id: "1234", name: "Main account" });
const shares = account({ id: "2345", name: "Shares", type: "investment" });
const rent = bucket({ id: "1000000001", name: "Rent", source_account_id: main.id });

const savings: Schedule = {
  id: "1234560001",
  name: "Savings",
  transaction: { type: "TRF", account_id: main.id, to_account_id: shares.id, amount: "1500.00" },
  mode: "auto",
  due_days: 3,
  start_date: "2026-08-25",
  time: "08:00",
  time_zone: "UTC",
  frequency: "month",
  every: 1,
  end_count: null,
  end_date: null,
  paused: false,
  next_index: 3,
  next_at: "2026-11-25T08:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  bill: null,
  updated_at: "2026-08-01T00:00:00Z",
};

function notification(n: Partial<Notification> & Pick<Notification, "key" | "kind">): Notification {
  return {
    severity: "info",
    at: null,
    count: null,
    overdue: null,
    schedule_id: null,
    account_id: null,
    bucket_id: null,
    cycle_id: null,
    target_id: null,
    amount: null,
    minimum: null,
    currency: null,
    transaction_id: null,
    counterparty: null,
    planned_id: null,
    ...n,
  };
}

const uncovered = notification({
  key: "bucket:1000000001",
  kind: "bucket_uncovered",
  severity: "alert",
  bucket_id: rent.id,
  amount: "600.00",
  currency: "NOK",
});
const queue = notification({
  key: "queue:5000000001",
  kind: "approval_queue",
  severity: "alert",
  at: "2026-11-08T08:00:00Z",
  count: 3,
  overdue: 1,
});
const bill = notification({
  key: "bill:1234560001:1795593600",
  kind: "upcoming_bill",
  at: "2026-11-25T08:00:00Z",
  schedule_id: savings.id,
  account_id: main.id,
  amount: "1500.00",
  currency: "NOK",
});
const balance = notification({
  key: "balance:123456000001:2345",
  kind: "investment_balance",
  at: "2026-11-01T00:00:00Z",
  account_id: shares.id,
  cycle_id: "123456000001",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [main, shares] });
  apiMock.on("GET /api/v1/buckets", { body: [rent] });
  apiMock.on("GET /api/v1/schedules", { body: [savings] });
  apiMock.on("GET /api/v1/notifications", { body: { items: [uncovered, queue, bill, balance] } });
});

const rows = async () => {
  await screen.findByRole("heading", { name: "Notifications" });
  return screen.findAllByTestId("notification", undefined, { timeout: 5000 });
};

describe("Notifications", () => {
  it("words each kind and links to where it's done", async () => {
    renderRoute("/notifications");
    const [b, q, s, a] = (await rows()).map((r) => within(r));
    if (!b || !q || !s || !a) throw new Error("four rows");

    expect(await b.findByText("Rent isn't covered")).toBeInTheDocument();
    expect(b.getByText(/This priority bucket is missing NOK.600\.00/)).toBeInTheDocument();
    expect(b.getByRole("link", { name: "Open Buckets" })).toHaveAttribute("href", "/buckets");

    expect(q.getByText("3 scheduled transactions wait for approval")).toBeInTheDocument();
    expect(q.getByText("1 is overdue.")).toBeInTheDocument();
    expect(q.getByRole("link", { name: "Open the queue" })).toHaveAttribute(
      "href",
      "/transactions/scheduled",
    );

    expect(await s.findByText("Savings")).toBeInTheDocument();
    expect(
      s.getByText(/NOK.1,500\.00 on .*Remember to make the transfer at the bank\./),
    ).toBeInTheDocument();

    expect(a.getByText("Update the balance of Shares")).toBeInTheDocument();
    expect(a.getByText(/A new cycle started/)).toBeInTheDocument();
    expect(a.getByRole("link", { name: "Adjust balance" })).toHaveAttribute(
      "href",
      "/accounts?adjust=2345",
    );
    expect(
      a.getByRole("button", { name: "The balance is right: Update the balance of Shares" }),
    ).toBeInTheDocument();
  });

  it("dismisses one, and marks one done", async () => {
    apiMock.on("POST /api/v1/notifications/dismiss", { status: 204 });
    renderRoute("/notifications");
    await rows();
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss: Rent isn't covered" }),
    );
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/notifications/dismiss")).toHaveLength(1);
    });
    expect(apiMock.calls("POST /api/v1/notifications/dismiss")[0]?.body).toEqual({
      key: uncovered.key,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "The balance is right: Update the balance of Shares" }),
    );
    await waitFor(() => {
      expect(apiMock.calls("POST /api/v1/notifications/dismiss")[1]?.body).toEqual({
        key: balance.key,
      });
    });
  });

  it("says why one couldn't be dismissed", async () => {
    apiMock.on(
      "POST /api/v1/notifications/dismiss",
      problem(404, "not_found", "Notification not found."),
    );
    renderRoute("/notifications");
    await rows();
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss: Rent isn't covered" }),
    );
    expect(
      await screen.findByText(/It doesn.t exist, or it has been deleted\./),
    ).toBeInTheDocument();
  });

  it("reminds of savings held for a transfer (#231)", async () => {
    apiMock.on("GET /api/v1/savings/targets", {
      body: [savingsTarget({ id: "1000001001", name: "Rainy day", account_id: shares.id })],
    });
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({
            key: "savings:1000001001:100000100100000000000001",
            kind: "savings_transfer",
            target_id: "1000001001",
            amount: "300.00",
            currency: "NOK",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [row] = (await rows()).map((r) => within(r));
    if (!row) throw new Error("one row");
    expect(await row.findByText("Money held for Rainy day")).toBeInTheDocument();
    expect(
      row.getByText(/NOK.300\.00 is set aside\. Make the transfer at the bank, then press Done\./),
    ).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Open Savings" })).toHaveAttribute("href", "/savings");
  });

  it("says when the savings budget fell short (#234)", async () => {
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({
            key: "savings-short:1000002001:100000100100",
            kind: "savings_short",
            severity: "warning",
            account_id: main.id,
            amount: "250.00",
            currency: "NOK",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [row] = (await rows()).map((r) => within(r));
    if (!row) throw new Error("one row");
    expect(await row.findByText("Saved less for the savings distributor")).toBeInTheDocument();
    expect(
      row.getByText(
        new RegExp(
          `${main.name} didn.t have enough unallocated money, so the savings budget is NOK.250\\.00 short`,
        ),
      ),
    ).toBeInTheDocument();
  });

  it("says when a BSU is over its limit or a schedule took money out (#214)", async () => {
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({
            key: `bsu-over:${main.id}:2026`,
            kind: "bsu_over_limit",
            severity: "warning",
            account_id: main.id,
            at: "2025-12-31T23:00:00Z",
            amount: "2500.00",
            currency: "NOK",
          }),
          notification({
            key: "bsu-withdrawal:100000100100000000000002",
            kind: "bsu_withdrawal",
            severity: "warning",
            account_id: main.id,
            at: "2026-10-11T12:00:00Z",
            amount: "100.00",
            currency: "NOK",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [over, withdrawal] = (await rows()).map((r) => within(r));
    if (!over || !withdrawal) throw new Error("two rows");
    expect(await over.findByText(`${main.name} is over its BSU limit`)).toBeInTheDocument();
    expect(over.getByText(/This year's deposits are NOK.2,500\.00 over/)).toBeInTheDocument();
    expect(over.getByRole("link", { name: "Open accounts" })).toHaveAttribute("href", "/accounts");
    expect(withdrawal.getByText(`Money taken out of ${main.name}`)).toBeInTheDocument();
    expect(withdrawal.getByText(/took NOK.100\.00 out of the BSU account/)).toBeInTheDocument();
  });

  it("reminds of a card's bill: ready, due soon and carried over (#262)", async () => {
    const at = "2026-11-14T23:00:00Z";
    const bill = (kind: Notification["kind"], minimum: string) =>
      notification({
        key: `${kind}:${main.id}20261101`,
        kind,
        account_id: main.id,
        at,
        amount: "1500.00",
        minimum,
        currency: "NOK",
      });
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          bill("card_bill", "300.00"),
          bill("card_bill_due", "0.00"),
          bill("card_bill_carried", "300.00"),
        ],
      },
    });
    renderRoute("/notifications");
    const [ready, due, carried] = (await rows()).map((r) => within(r));
    if (!ready || !due || !carried) throw new Error("three rows");
    const date = formatDate(at);
    expect(await ready.findByText(`${main.name}'s bill is ready`)).toBeInTheDocument();
    expect(
      ready.getByText(new RegExp(`NOK.1,500\\.00 to pay by ${date}, at least NOK.300\\.00`)),
    ).toBeInTheDocument();
    expect(ready.getByRole("link", { name: "Open the bill" })).toHaveAttribute(
      "href",
      `/accounts?bill=${main.id}`,
    );
    expect(due.getByText(`${main.name}'s bill is due ${date}`)).toBeInTheDocument();
    expect(
      due.getByText(/NOK.1,500\.00 is left to pay. The minimum payment is paid/),
    ).toBeInTheDocument();
    expect(carried.getByText(`${main.name}'s bill is past due`)).toBeInTheDocument();
    expect(carried.getByText(/NOK.300\.00 of it the minimum payment/)).toBeInTheDocument();
  });

  it("reminds to register a card's interest and fees after a carried bill (#263)", async () => {
    const at = "2026-11-14T23:00:00Z";
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({
            key: `card-interest:${main.id}20261101`,
            kind: "card_interest",
            account_id: main.id,
            at,
            amount: "1500.00",
            currency: "NOK",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [row] = (await rows()).map((r) => within(r));
    if (!row) throw new Error("a row");
    expect(await row.findByText(`Register interest and fees for ${main.name}`)).toBeInTheDocument();
    expect(
      row.getByText(new RegExp(`NOK.1,500\\.00 was left on the bill due ${formatDate(at)}`)),
    ).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Register" })).toHaveAttribute(
      "href",
      `/accounts?interest=${main.id}`,
    );
  });

  it("tells when a cycle's start counted a waiting purchase in its bucket (#264)", async () => {
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({
            key: "bucket-charge:2027020150296413",
            kind: "bucket_charge",
            bucket_id: rent.id,
            cycle_id: "100001000002",
            transaction_id: "2027010520838349",
            counterparty: "Game shop",
            at: "2027-02-01T00:00:00Z",
            amount: "1200.00",
            currency: "NOK",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [row] = (await rows()).map((r) => within(r));
    if (!row) throw new Error("a row");
    expect(await row.findByText(/^Rent took NOK.1,200\.00$/)).toBeInTheDocument();
    expect(row.getByText(/The purchase from Game shop waited for this cycle/)).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Open transactions" })).toHaveAttribute(
      "href",
      `/transactions?bucket_id=${rent.id}&cycle_id=100001000002&system=1`,
    );
  });

  it("reminds of a planned purchase coming up, and when it's overdue (#265)", async () => {
    const at = "2027-01-06T00:00:00Z";
    const planned = {
      kind: "planned_purchase" as const,
      planned_id: "1000011234567890",
      counterparty: "Game Store",
      account_id: main.id,
      at,
      amount: "600.00",
      currency: "NOK",
    };
    apiMock.on("GET /api/v1/notifications", {
      body: {
        items: [
          notification({ ...planned, key: "planned:1000011234567890:1799193600" }),
          notification({
            ...planned,
            key: "planned:1000011234567890:1799193600:overdue",
            severity: "warning",
          }),
        ],
      },
    });
    renderRoute("/notifications");
    const [soon, late] = (await rows()).map((r) => within(r));
    if (!soon || !late) throw new Error("two rows");
    expect(await soon.findByText(`Game Store is expected ${formatDate(at)}`)).toBeInTheDocument();
    expect(
      soon.getByText(new RegExp(`NOK.600\\.00 planned on ${main.name}\\.`)),
    ).toBeInTheDocument();
    expect(soon.getByRole("link", { name: "Open planned purchases" })).toHaveAttribute(
      "href",
      "/transactions/planned",
    );
    expect(late.getByText("Game Store hasn't been charged")).toBeInTheDocument();
    expect(
      late.getByText(
        `It was expected ${formatDate(at)}. Record the charge, or move the date if it's delayed.`,
      ),
    ).toBeInTheDocument();
  });

  it("says when there's nothing to do", async () => {
    apiMock.on("GET /api/v1/notifications", { body: { items: [] } });
    renderRoute("/notifications");
    expect(await screen.findByText("Nothing to do")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose which in Settings." })).toHaveAttribute(
      "href",
      "/settings",
    );
  });
});

describe("the notification count", () => {
  it("shows on the side menu's Notifications", async () => {
    renderRoute("/");
    const link = await screen.findByRole("link", { name: /^Notifications ?4 open notifications$/ });
    expect(link).toHaveAttribute("href", "/notifications");
    expect(within(link).getByTestId("notification-badge")).toHaveTextContent("4");
  });

  it("shows on the mobile bell, and the screen's name in the header", async () => {
    viewport.width = 375;
    renderRoute("/notifications");
    expect(
      await screen.findByRole("link", { name: "Notifications, 4 open notifications" }),
    ).toHaveAttribute("href", "/notifications");
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeInTheDocument();
  });

  it("isn't shown with nothing open", async () => {
    apiMock.on("GET /api/v1/notifications", { body: { items: [] } });
    renderRoute("/");
    expect(await screen.findByRole("link", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByTestId("notification-badge")).not.toBeInTheDocument();
  });
});

describe("Settings › Notifications", () => {
  it("switches a kind off and sets the days ahead", async () => {
    let prefs: Record<string, unknown> = { ...testUser.preferences };
    apiMock.on("PATCH /api/v1/me/preferences", (req: MockRequest) => {
      prefs = { ...prefs, ...(req.body as object) };
      return { body: prefs };
    });
    renderRoute("/settings");
    await userEvent.click(
      await screen.findByRole("switch", { name: /Uncovered priority buckets/ }),
    );
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      notifications: { bucket_uncovered: false },
    });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /Uncovered priority buckets/ })).not.toBeChecked();
    });
    await userEvent.click(screen.getByRole("combobox", { name: "Show bills" }));
    await userEvent.click(await screen.findByRole("option", { name: "7 days ahead" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
        notifications: { bucket_uncovered: false, upcoming_days: 7 },
      });
    });
  });
});
