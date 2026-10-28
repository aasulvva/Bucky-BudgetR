import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";

import { formatMoney } from "@/lib/money";
import {
  addDays,
  cycleRange,
  daysLeftLabel,
  daysLeftShort,
  endAtFor,
  formatDateRange,
  lastDay,
  localDate,
  monthFrom,
  startAtFor,
  today,
} from "@/lib/cycles";
import { apiMock, problem, testUser } from "@/test/api";
import { bucket, cycle } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** As Testing Library reads text: ICU's special spaces become plain ones. */
const plain = (s: string) => s.replace(/\s/g, " ");

const active = cycle();
const planned = cycle({
  id: "100001000002",
  state: "future",
  start_at: startAtFor(addDays(today(), 25)),
  end_at: endAtFor(addDays(today(), 54)),
});
const finished = cycle({
  id: "100001000000",
  state: "finished",
  start_at: startAtFor(addDays(today(), -40)),
  end_at: active.start_at,
});

function given(
  current: { active: typeof active | null; next: typeof active | null },
  all = [finished, active, planned],
) {
  apiMock.on("GET /api/v1/cycles/active", { body: current });
  apiMock.on("GET /api/v1/cycles", { body: all });
}

afterEach(() => {
  viewport.width = 1280;
});

describe("the cycle in the shell", () => {
  it("shows the active cycle and its days left in the side menu", async () => {
    renderRoute("/accounts");
    const nav = await screen.findByRole("navigation");
    const link = await within(nav).findByRole("link", { name: /^Cycle / });
    expect(link).toHaveAttribute("href", "/cycles");
    expect(link).toHaveTextContent(plain(cycleRange(active)));
    expect(link).toHaveTextContent(daysLeftLabel(active));
  });

  it("shows a chip in the mobile header", async () => {
    viewport.width = 390;
    renderRoute("/accounts");
    const chip = await screen.findByRole("link", { name: /days left/ });
    expect(chip).toHaveTextContent(daysLeftShort(active));
    expect(chip).toHaveAttribute("href", "/cycles");
  });

  it("warns on every screen when the cycle is overdue", async () => {
    const overdue = cycle({ end_at: startAtFor(addDays(today(), -2)) });
    given({ active: overdue, next: null }, [overdue]);
    renderRoute("/accounts");
    expect(await screen.findByText(/Bucket transactions are paused/)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByText("Overdue")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Extend" }));
    expect(await screen.findByRole("dialog", { name: "Extend the cycle" })).toBeInTheDocument();
  });
});

describe("without an active cycle", () => {
  it("prompts once, and a banner brings the prompt back", async () => {
    given({ active: null, next: null }, [finished]);
    renderRoute("/accounts");
    const dialog = await screen.findByRole("dialog", { name: "Start a budget cycle" });
    await userEvent.click(within(dialog).getByRole("button", { name: /Not now/ }));
    expect(screen.queryByRole("dialog", { name: "Start a budget cycle" })).not.toBeInTheDocument();

    // Moving on doesn't prompt again; the banner stays.
    await userEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Buckets" }),
    );
    expect(await screen.findByText(/No active cycle\. Buckets/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Start a budget cycle" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByText("No active cycle")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Start cycle" }));
    expect(await screen.findByRole("dialog", { name: "Start a budget cycle" })).toBeInTheDocument();
  });

  it("starts the planned cycle", async () => {
    given({ active: null, next: planned }, [finished, planned]);
    apiMock.on(`POST /api/v1/cycles/${planned.id}/start`, {
      body: { ...planned, state: "active" },
    });
    renderRoute("/accounts");
    const dialog = within(await screen.findByRole("dialog", { name: "Start a budget cycle" }));
    expect(dialog.getByRole("radio", { name: /Start the planned cycle/ })).toBeChecked();
    expect(dialog.getByText(/starts today instead of/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Start cycle" }));
    expect(await screen.findByText(/Cycle .* started\./)).toBeInTheDocument();
    expect(apiMock.calls(`POST /api/v1/cycles/${planned.id}/start`)).toHaveLength(1);
  });

  it("plans and starts a new cycle from today", async () => {
    given({ active: null, next: null }, [finished]);
    const created = cycle({ id: "100001000009", state: "future" });
    apiMock.on("POST /api/v1/cycles", { status: 201, body: created });
    apiMock.on(`POST /api/v1/cycles/${created.id}/start`, {
      body: { ...created, state: "active" },
    });
    renderRoute("/accounts");
    const dialog = within(await screen.findByRole("dialog", { name: "Start a budget cycle" }));
    expect(dialog.getByRole("radio", { name: /Start a new cycle/ })).toBeChecked();
    await userEvent.click(dialog.getByRole("button", { name: "Start cycle" }));
    await screen.findByText(/Cycle .* started\./);
    expect(apiMock.calls("POST /api/v1/cycles")[0]?.body).toEqual({
      start_at: startAtFor(today()),
      end_at: endAtFor(monthFrom(today()).end),
    });
    expect(apiMock.calls(`POST /api/v1/cycles/${created.id}/start`)).toHaveLength(1);
  });
});

describe("Cycles screen", () => {
  it("lists the active, planned and finished cycles", async () => {
    given({ active, next: planned });
    renderRoute("/cycles");
    const card = within(await screen.findByRole("region", { name: "Active cycle" }));
    expect(card.getByText(plain(cycleRange(active)))).toBeInTheDocument();
    expect(card.getByText(new RegExp(`next: ${plain(cycleRange(planned))}`))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Edit ${cycleRange(planned)}` })).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText(plain(cycleRange(finished)))).toBeInTheDocument();
  });

  it("plans the month after the latest cycle", async () => {
    given({ active, next: null }, [finished, active]);
    apiMock.on("POST /api/v1/cycles", (req) => ({
      status: 201,
      body: { ...planned, ...(req.body as object) },
    }));
    renderRoute("/cycles");
    await userEvent.click(await screen.findByRole("button", { name: "Plan a cycle" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Plan a cycle" }));
    await userEvent.click(dialog.getByRole("button", { name: "Plan cycle" }));
    const start = localDate(active.end_at);
    const month = monthFrom(start);
    await screen.findByText(`${plain(formatDateRange(month.start, month.end))} planned.`);
    expect(apiMock.calls("POST /api/v1/cycles")[0]?.body).toEqual({
      start_at: active.end_at,
      end_at: endAtFor(monthFrom(start).end),
    });
  });

  it("shows why a cycle can't be planned", async () => {
    apiMock.on(
      "POST /api/v1/cycles",
      problem(409, "cycle_overlap", "The cycle would overlap another cycle."),
    );
    renderRoute("/cycles");
    await userEvent.click(await screen.findByRole("button", { name: "Plan a cycle" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Plan a cycle" }));
    await userEvent.click(dialog.getByRole("button", { name: "Plan cycle" }));
    expect(await dialog.findAllByText("The cycle would overlap another cycle.")).not.toHaveLength(
      0,
    );
  });

  it("edits and deletes a planned cycle", async () => {
    given({ active, next: planned });
    apiMock.on(`PATCH /api/v1/cycles/${planned.id}`, { body: planned });
    apiMock.on(`DELETE /api/v1/cycles/${planned.id}`, { status: 204 });
    renderRoute("/cycles");
    await userEvent.click(
      await screen.findByRole("button", { name: `Edit ${cycleRange(planned)}` }),
    );
    const edit = within(await screen.findByRole("dialog", { name: "Edit planned cycle" }));
    await userEvent.click(edit.getByRole("button", { name: "Save" }));
    await screen.findByText(/saved\.$/);
    expect(apiMock.calls(`PATCH /api/v1/cycles/${planned.id}`)[0]?.body).toEqual({
      start_at: planned.start_at,
      end_at: planned.end_at,
    });

    await userEvent.click(screen.getByRole("button", { name: `Delete ${cycleRange(planned)}` }));
    const del = within(await screen.findByRole("dialog", { name: "Delete planned cycle?" }));
    await userEvent.click(del.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Planned cycle deleted.")).toBeInTheDocument();
    expect(apiMock.calls(`DELETE /api/v1/cycles/${planned.id}`)).toHaveLength(1);
  });

  it("extends the active cycle, pushing the next one along", async () => {
    const adjacent = { ...planned, start_at: active.end_at };
    given({ active, next: adjacent }, [active, adjacent]);
    apiMock.on(`PATCH /api/v1/cycles/${active.id}`, { body: active });
    renderRoute("/cycles");
    await userEvent.click(await screen.findByRole("button", { name: "Extend" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Extend the cycle" }));
    expect(dialog.getByText(/then starts on/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Extend" }));
    await screen.findByText(/The cycle now runs/);
    expect(apiMock.calls(`PATCH /api/v1/cycles/${active.id}`)[0]?.body).toEqual({
      end_at: endAtFor(addDays(lastDay(active), 7)),
    });
  });
});

describe("with a cycle rule", () => {
  const rule = { day: 25, shift: "previous", holidays: "NO", ahead: 3 } as const;
  /** As the date fields show a date. */
  const shown = (date: string) => dayjs(date).format("D MMM YYYY");

  beforeEach(() => {
    apiMock.on("GET /api/v1/me", {
      body: { ...testUser, preferences: { ...testUser.preferences, cycle_rule: rule } },
    });
  });

  it("marks the cycles the rule planned", async () => {
    given({ active, next: planned }, [finished, active, { ...planned, generated: true }]);
    renderRoute("/cycles");
    expect(await screen.findByText("From rule")).toBeInTheDocument();
  });

  it("plans the rule's next period", async () => {
    given({ active, next: null }, [finished, active]);
    const from = localDate(active.end_at);
    const period = { start: addDays(from, 3), end: addDays(from, 33) };
    apiMock.on("POST /api/v1/cycle-rule/periods", {
      body: [{ start: addDays(from, -27), end: addDays(from, 2) }, period],
    });
    apiMock.on("POST /api/v1/cycles", (req) => ({
      status: 201,
      body: { ...planned, ...(req.body as object) },
    }));
    renderRoute("/cycles");
    await userEvent.click(await screen.findByRole("button", { name: "Plan a cycle" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Plan a cycle" }));
    expect(await dialog.findByRole("button", { name: "Next from rule" })).toBeInTheDocument();
    expect(dialog.getByText(shown(period.end))).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/cycle-rule/periods")[0]?.body).toEqual({
      rule,
      from,
      count: 2,
    });

    await userEvent.click(dialog.getByRole("button", { name: "Plan cycle" }));
    await screen.findByText(`${plain(formatDateRange(period.start, period.end))} planned.`);
    expect(apiMock.calls("POST /api/v1/cycles")[0]?.body).toEqual({
      start_at: startAtFor(period.start),
      end_at: endAtFor(period.end),
    });
  });

  it("starts a new cycle that ends with the rule's period", async () => {
    given({ active: null, next: null }, [finished]);
    const end = addDays(today(), 12);
    apiMock.on("POST /api/v1/cycle-rule/periods", {
      body: [{ start: addDays(today(), -18), end }],
    });
    const created = cycle({ id: "100001000009", state: "future" });
    apiMock.on("POST /api/v1/cycles", { status: 201, body: created });
    apiMock.on(`POST /api/v1/cycles/${created.id}/start`, {
      body: { ...created, state: "active" },
    });
    renderRoute("/accounts");
    const dialog = within(await screen.findByRole("dialog", { name: "Start a budget cycle" }));
    expect(await dialog.findByText(shown(end))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Start cycle" }));
    await screen.findByText(/Cycle .* started\./);
    expect(apiMock.calls("POST /api/v1/cycles")[0]?.body).toEqual({
      start_at: startAtFor(today()),
      end_at: endAtFor(end),
    });
  });
});

describe("ending a cycle", () => {
  const buckets = [
    bucket({
      id: "1000000001",
      name: "Groceries",
      source_account_id: "1234",
      refill_amount: "4000.00",
      capacity: "4000.00",
      target_funds: "800.00",
      current_available_funds: "500.00",
    }),
    bucket({
      id: "1000000003",
      name: "Car",
      source_account_id: "1234",
      keep_funds: true,
      refill_amount: "1000.00",
      capacity: "5000.00",
      target_funds: "4500.00",
      current_available_funds: "4500.00",
    }),
  ];

  beforeEach(() => {
    apiMock.on("GET /api/v1/buckets", { body: buckets });
  });

  async function openEnd() {
    renderRoute("/cycles");
    await userEvent.click(await screen.findByRole("button", { name: "End cycle" }));
    return within(await screen.findByRole("dialog", { name: "End this cycle now?" }));
  }

  it("previews what is emptied and refilled, and starts the next cycle now", async () => {
    given({ active, next: planned });
    apiMock.on(`POST /api/v1/cycles/${active.id}/end`, {
      body: { ended: { ...active, state: "finished" }, started: { ...planned, state: "active" } },
    });
    const dialog = await openEnd();
    expect(dialog.getByText(/days early/)).toBeInTheDocument();
    expect(await dialog.findByText(plain(formatMoney("-800.00")))).toBeInTheDocument();
    expect(dialog.getByText(plain(formatMoney("500.00")))).toBeInTheDocument();
    expect(dialog.getByRole("radio", { name: "Start it now" })).toBeChecked();
    expect(dialog.getByText(`+${plain(formatMoney("4000.00"))}`)).toBeInTheDocument();
    expect(
      dialog.getByText(new RegExp(`${plain(formatMoney("500.00"))} overflows`)),
    ).toBeInTheDocument();

    await userEvent.click(dialog.getByRole("button", { name: "End cycle" }));
    expect(await screen.findByText(/Cycle ended\. .* has started\./)).toBeInTheDocument();
    expect(apiMock.calls(`POST /api/v1/cycles/${active.id}/end`)[0]?.body).toEqual({
      start_next: true,
    });
  });

  it("can leave a gap, and says what that means", async () => {
    given({ active, next: planned });
    apiMock.on(`POST /api/v1/cycles/${active.id}/end`, {
      body: { ended: { ...active, state: "finished" }, started: null },
    });
    const dialog = await openEnd();
    await userEvent.click(dialog.getByRole("radio", { name: /Leave a gap/ }));
    expect(dialog.getByText("No active cycle in the gap")).toBeInTheDocument();
    expect(dialog.queryByText(`+${plain(formatMoney("4000.00"))}`)).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "End cycle" }));
    expect(
      await screen.findByText(/There's no active cycle until you start one/),
    ).toBeInTheDocument();
    expect(apiMock.calls(`POST /api/v1/cycles/${active.id}/end`)[0]?.body).toEqual({
      start_next: false,
    });
  });

  it("warns when no cycle is planned after", async () => {
    given({ active, next: null }, [active]);
    apiMock.on(`POST /api/v1/cycles/${active.id}/end`, {
      body: { ended: { ...active, state: "finished" }, started: null },
    });
    const dialog = await openEnd();
    expect(await dialog.findByText("No cycle planned after this one")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "End cycle" }));
    await screen.findByText(/Cycle ended/);
    expect(apiMock.calls(`POST /api/v1/cycles/${active.id}/end`)[0]?.body).toBeUndefined();
  });
});
