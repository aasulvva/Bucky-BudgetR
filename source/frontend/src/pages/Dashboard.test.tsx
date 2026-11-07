import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import { addDays, cycleRange, daysLeftLabel, endAtFor, startAtFor, today } from "@/lib/cycles";
import { formatMoney } from "@/lib/money";
import { apiMock, testUser } from "@/test/api";
import { account, bucket, bucketFigures, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

type Preferences = components["schemas"]["Preferences"];

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");
/** Text as Testing Library reads it, with plain spaces. */
const plain = (text: string) => text.replace(/\s/g, " ");

const main = account({ id: "1234", name: "Main account", balance: "1500.00" });
const buffer = account({
  id: "2345",
  name: "Buffer account",
  balance: "900.00",
  unallocated: "900.00",
});
const base = { source_account_id: main.id };

const groceries = bucket({
  ...base,
  id: "1000000001",
  name: "Groceries",
  target_funds: "1000.00",
  current_available_funds: "650.00",
});
const rent = bucket({
  ...base,
  id: "1000000002",
  name: "Rent",
  priority: true,
  target_funds: "800.00",
  current_available_funds: "800.00",
});
const hobby = bucket({ ...base, id: "1000000003", name: "Hobby", target_funds: "-50.00" });
const fun = bucket({
  ...base,
  id: "1000000004",
  name: "Fun",
  target_funds: "100.00",
  current_available_funds: "100.00",
});

const withPreferences = (preferences: Preferences) => {
  apiMock.on("GET /api/v1/me", {
    body: { ...testUser, preferences: { ...testUser.preferences, ...preferences } },
  });
};

beforeEach(() => {
  apiMock.on("GET /api/v1/accounts", { body: [main, buffer] });
  apiMock.on("GET /api/v1/buckets", { body: [groceries, rent, hobby, fun] });
  apiMock.on("GET /api/v1/cycles/100001000001/bucket-figures", {
    body: [
      bucketFigures({ bucket_id: groceries.id, budget: "1000.00", used: "350.00" }),
      bucketFigures({ bucket_id: rent.id, budget: "800.00", used: "0.00" }),
      bucketFigures({ bucket_id: hobby.id, budget: "100.00", used: "150.00" }),
      bucketFigures({ bucket_id: fun.id, budget: "1000.00", used: "950.00" }),
    ],
  });
  apiMock.on("GET /api/v1/transactions", {
    body: {
      items: [
        transaction({ id: "100000000001", counterparty: "Rema 1000" }),
        transaction({
          id: "100000000002",
          type: "INC",
          counterparty: "Employer",
          bank_lines: [{ account_id: main.id, amount: "20000.00" }],
        }),
      ],
      next_cursor: null,
    },
  });
  apiMock.on("PATCH /api/v1/me/preferences", (req) => ({
    body: { ...testUser.preferences, ...(req.body as object) },
  }));
});

/** The default layout as Done or a settings save sends it, with some settings changed. */
const savedLayout = (settings: Partial<Record<string, object>> = {}) => ({
  dashboard: {
    widgets: [
      { id: "cycle", type: "cycle", width: "half", cycle: settings.cycle ?? { show_next: true } },
      { id: "health", type: "health", width: "half" },
      {
        id: "bucket_status",
        type: "bucket_status",
        width: "half",
        bucket_status: settings.bucket_status ?? { mode: "attention" },
      },
      {
        id: "accounts",
        type: "accounts",
        width: "half",
        accounts: settings.accounts ?? { mode: "all" },
      },
      {
        id: "recent_transactions",
        type: "recent_transactions",
        width: "full",
        recent_transactions: settings.recent_transactions ?? { count: 5 },
      },
    ],
  },
});

const widget = async (name: string) => within(await screen.findByRole("region", { name }));

/** Picks an option in a Mantine select. */
async function choose(dialog: HTMLElement, label: string, option: string) {
  await userEvent.click(within(dialog).getByLabelText(label, { selector: "input" }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Dashboard", () => {
  it("shows the cycle, the health, the buckets, the accounts and the latest transactions", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeInTheDocument();

    const cycleWidget = await widget("Cycle");
    expect(await cycleWidget.findByText(plain(cycleRange(cycle())))).toBeInTheDocument();
    expect(cycleWidget.getByText(plain(daysLeftLabel(cycle())))).toBeInTheDocument();

    const health = within(
      (await widget("Budget health")).getByRole("article", { name: "Main account" }),
    );
    expect(health.getByText(`${m("400.00")} short`)).toBeInTheDocument();
    expect(
      health.getByText(
        `81% covered: ${m("1550.00")} of ${m("1900.00")} · 1 bucket not fully covered · 1 overspent`,
      ),
    ).toBeInTheDocument();
    // Buffer account funds no bucket.
    expect(screen.queryByRole("article", { name: "Buffer account" })).not.toBeInTheDocument();

    const status = await widget("Bucket status");
    expect(status.getByText("Needs attention")).toBeInTheDocument();
    await status.findByText(`Overspent by ${m("50.00")}`);
    const names = status.getAllByRole("link", { name: /^(Hobby|Groceries|Fun|Rent)$/ });
    expect(names.map((n) => n.textContent)).toEqual(["Hobby", "Groceries", "Fun"]);
    expect(status.getByText(`${m("350.00")} not covered`)).toBeInTheDocument();
    expect(status.getByText("95% used")).toBeInTheDocument();

    const accounts = await widget("Account balances");
    expect(accounts.getByRole("link", { name: "Buffer account" })).toHaveAttribute(
      "href",
      "/transactions?account_id=2345",
    );
    expect(accounts.getByText(m("2400.00"))).toBeInTheDocument();
    expect(accounts.getByText(`${m("0.00")} unallocated`)).toBeInTheDocument();

    const recent = await widget("Recent transactions");
    expect(await recent.findByRole("link", { name: /Rema 1000/ })).toHaveAttribute(
      "href",
      "/transactions?open=100000000001",
    );
    expect(recent.getByRole("link", { name: /Employer/ })).toBeInTheDocument();
    const [query] = apiMock.calls("GET /api/v1/transactions").map((c) => c.query);
    expect(query?.get("limit")).toBe("5");
    expect(query?.getAll("type")).toEqual(["INC", "EXP", "TRF", "OPB", "BLA"]);
  });

  it("offers to start a cycle without one", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/");
    // The app prompts by itself first.
    const prompt = await screen.findByRole("dialog", { name: "Start a budget cycle" });
    await userEvent.click(within(prompt).getByRole("button", { name: /Not now/ }));
    const cycleWidget = await widget("Cycle");
    expect(cycleWidget.getByText("No active cycle")).toBeInTheDocument();
    await userEvent.click(cycleWidget.getByRole("button", { name: "Start cycle" }));
    expect(await screen.findByRole("dialog", { name: "Start a budget cycle" })).toBeInTheDocument();
  });

  it("says when all buckets are fine", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [rent] });
    renderRoute("/");
    const status = await widget("Bucket status");
    expect(
      await status.findByText("All buckets are fine: fully covered, and none more than 90% used."),
    ).toBeInTheDocument();
  });

  it("shows all buckets, the most used, or one", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "all" } } });
    const { unmount } = renderRoute("/");
    let status = await widget("Bucket status");
    expect(await status.findByText("All buckets")).toBeInTheDocument();
    expect(status.getByRole("article", { name: "Main account" })).toBeInTheDocument();
    expect(status.getAllByRole("link").map((l) => l.textContent)).toEqual(
      expect.arrayContaining(["Groceries", "Rent", "Hobby", "Fun"]),
    );
    unmount();

    withPreferences({ dashboard: { bucket_status: { mode: "most_used" } } });
    renderRoute("/");
    status = await widget("Bucket status");
    expect(await status.findByText("Most used")).toBeInTheDocument();
    await status.findByText("150%");
    expect(status.getAllByText(/^\d+%$/).map((e) => e.textContent)).toEqual([
      "150%",
      "95%",
      "35%",
      "0%",
    ]);
  });

  it("shows the chosen bucket, or falls back when it's gone", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "bucket", bucket_id: fun.id } } });
    const { unmount } = renderRoute("/");
    const status = await widget("Bucket status");
    expect(await status.findByText("One bucket")).toBeInTheDocument();
    expect(status.getByText("Left this cycle")).toBeInTheDocument();
    expect(await status.findByText(`Used ${m("950.00")} of ${m("1000.00")}`)).toBeInTheDocument();
    unmount();

    withPreferences({ dashboard: { bucket_status: { mode: "bucket", bucket_id: "1999999999" } } });
    renderRoute("/");
    expect(await (await widget("Bucket status")).findByText("Needs attention")).toBeInTheDocument();
  });

  it("saves the Bucket status settings", async () => {
    renderRoute("/");
    const status = await widget("Bucket status");
    await userEvent.click(
      await status.findByRole("button", { name: "Settings for Bucket status" }),
    );
    const box = await screen.findByRole("dialog", { name: "Bucket status settings" });
    const dialog = within(box);
    await choose(box, "Show", "One bucket");
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await choose(box, "Bucket", "Fun");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout({ bucket_status: { mode: "bucket", bucket_id: fun.id } }),
    ]);
    expect(await status.findByText("One bucket")).toBeInTheDocument();
  });

  it("saves how many transactions to show", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "all" } } });
    renderRoute("/");
    const recent = await widget("Recent transactions");
    await userEvent.click(
      await recent.findByRole("button", { name: "Settings for Recent transactions" }),
    );
    const box = await screen.findByRole("dialog", { name: "Recent transactions settings" });
    const dialog = within(box);
    await choose(box, "Number of transactions", "10");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiMock.calls("GET /api/v1/transactions").at(-1)?.query.get("limit")).toBe("10");
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout({ bucket_status: { mode: "all" }, recent_transactions: { count: 10 } }),
    ]);
  });

  it("shows the next planned cycle, unless switched off", async () => {
    const planned = cycle({
      id: "100001000002",
      state: "future",
      start_at: startAtFor(addDays(today(), 20)),
      end_at: endAtFor(addDays(today(), 49)),
    });
    apiMock.on("GET /api/v1/cycles/active", { body: { active: cycle(), next: planned } });
    renderRoute("/");
    const cycleWidget = await widget("Cycle");
    const next = plain(`Next: ${cycleRange(planned)} (planned)`);
    expect(await cycleWidget.findByText(next)).toBeInTheDocument();

    await userEvent.click(cycleWidget.getByRole("button", { name: "Settings for Cycle" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Cycle settings" }));
    await userEvent.click(dialog.getByRole("checkbox", { name: "Show the next planned cycle" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(cycleWidget.queryByText(next)).not.toBeInTheDocument();
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout({ cycle: { show_next: false } }),
    ]);
  });

  it("shows one account", async () => {
    withPreferences({ dashboard: { accounts: { mode: "account", account_id: main.id } } });
    renderRoute("/");
    // Titled after the account, which isn't named again inside.
    const accounts = await widget("Main account");
    expect(await accounts.findByText(m("1850.00"))).toBeInTheDocument();
    expect(accounts.queryByRole("link", { name: "Main account" })).not.toBeInTheDocument();
    expect(accounts.queryByRole("link", { name: "Buffer account" })).not.toBeInTheDocument();
    expect(accounts.getByText(m("1500.00"))).toBeInTheDocument();
    expect(accounts.getByText(m("1850.00"))).toBeInTheDocument();
    expect(accounts.getByText(m("400.00"))).toBeInTheDocument();
  });

  it("saves the account to show", async () => {
    renderRoute("/");
    const accounts = await widget("Account balances");
    await userEvent.click(
      await accounts.findByRole("button", { name: "Settings for Account balances" }),
    );
    const box = await screen.findByRole("dialog", { name: "Account balances settings" });
    await choose(box, "Show", "One account");
    expect(within(box).getByRole("button", { name: "Save" })).toBeDisabled();
    await choose(box, "Account", "Buffer account");
    await userEvent.click(within(box).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(accounts.queryByRole("link", { name: "Main account" })).not.toBeInTheDocument();
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout({ accounts: { mode: "account", account_id: buffer.id } }),
    ]);
  });

  it("speaks nynorsk", async () => {
    withPreferences({ language: "nn" });
    renderRoute("/");
    expect(await screen.findByRole("heading", { level: 2, name: "Oversikt" })).toBeInTheDocument();
    const status = await widget("Bøttestatus");
    expect(status.getByText("Treng merksemd")).toBeInTheDocument();
    expect(await widget("Siste transaksjonar")).toBeTruthy();
  });
});

describe("Dashboard layout", () => {
  beforeEach(() => {
    viewport.width = 1280;
  });
  const patches = () => apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body);
  /** The widgets' names, in the order shown. */
  const shown = () =>
    screen
      .queryAllByRole("region")
      .map((r) => r.getAttribute("aria-label"))
      .filter((name) => name !== "Edit dashboard");
  const editMode = async () => {
    renderRoute("/");
    await userEvent.click(await screen.findByRole("button", { name: "Edit dashboard" }));
    return within(await screen.findByRole("region", { name: "Edit dashboard" }));
  };

  it("shows a saved layout in its order, with copies of a widget", async () => {
    withPreferences({
      dashboard: {
        widgets: [
          { id: "a", type: "bucket_status", width: "full", bucket_status: { mode: "most_used" } },
          { id: "b", type: "cycle", width: "half" },
          {
            id: "c",
            type: "bucket_status",
            width: "half",
            bucket_status: { mode: "bucket", bucket_id: fun.id },
          },
        ],
      },
    });
    renderRoute("/");
    const [first, second] = await screen.findAllByRole("region", { name: "Bucket status" });
    expect(shown()).toEqual(["Bucket status", "Cycle", "Bucket status"]);
    if (!first || !second) throw new Error("two Bucket status widgets");
    expect(await within(first).findByText("Most used")).toBeInTheDocument();
    expect(within(second).getByText("One bucket")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Budget health" })).not.toBeInTheDocument();
  });

  it("moves, resizes and removes widgets, saving them with Done", async () => {
    const bar = await editMode();
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Cycle up" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move Budget health down" }));
    await userEvent.click(screen.getByRole("button", { name: "Make Cycle full width" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Account balances" }));
    expect(shown()).toEqual(["Cycle", "Bucket status", "Budget health", "Recent transactions"]);
    expect(screen.getByRole("button", { name: "Make Cycle half width" })).toBeInTheDocument();
    expect(patches()).toEqual([]);

    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: "Edit dashboard" })).toBeInTheDocument();
    const [widgets] = patches().map((b) => (b as ReturnType<typeof savedLayout>).dashboard.widgets);
    expect(widgets?.map((w) => [w.id, w.width])).toEqual([
      ["cycle", "full"],
      ["bucket_status", "half"],
      ["health", "half"],
      ["recent_transactions", "full"],
    ]);
    expect(shown()).toEqual(["Cycle", "Bucket status", "Budget health", "Recent transactions"]);
  });

  it("throws the changes away with Cancel", async () => {
    const bar = await editMode();
    await userEvent.click(screen.getByRole("button", { name: "Remove Cycle" }));
    expect(screen.queryByRole("region", { name: "Cycle" })).not.toBeInTheDocument();
    await userEvent.click(bar.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("region", { name: "Cycle" })).toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  it("has no width toggle on a phone", async () => {
    viewport.width = 390;
    await editMode();
    expect(screen.getByRole("button", { name: "Remove Cycle" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make Cycle full width" })).not.toBeInTheDocument();
  });

  it("adds a widget, choosing its settings first", async () => {
    const bar = await editMode();
    await userEvent.click(bar.getByRole("button", { name: "Add widget" }));
    const picker = await screen.findByRole("dialog", { name: "Add widget" });
    await userEvent.click(within(picker).getByRole("button", { name: /^Bucket status/ }));
    const box = await screen.findByRole("dialog", { name: "Add widget: Bucket status" });
    await choose(box, "Show", "One bucket");
    expect(within(box).getByRole("button", { name: "Add" })).toBeDisabled();
    await choose(box, "Bucket", "Fun");
    await userEvent.click(within(box).getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(shown()).toEqual([
      "Cycle",
      "Budget health",
      "Bucket status",
      "Account balances",
      "Recent transactions",
      // One bucket is titled after its bucket.
      "Fun",
    ]);
    expect(screen.getByRole("button", { name: "Remove Fun" })).toBeInTheDocument();

    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    await screen.findByRole("button", { name: "Edit dashboard" });
    const [body] = patches() as ReturnType<typeof savedLayout>[];
    expect(body?.dashboard.widgets).toHaveLength(6);
    expect(body?.dashboard.widgets[5]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,40}$/) as unknown,
      type: "bucket_status",
      width: "half",
      bucket_status: { mode: "bucket", bucket_id: fun.id },
    });
  });

  it("names a widget after its bucket or a custom title, and can hide the mode", async () => {
    withPreferences({
      dashboard: {
        widgets: [
          {
            id: "a",
            type: "bucket_status",
            width: "half",
            bucket_status: { mode: "bucket", bucket_id: fun.id, show_mode: false },
          },
          {
            id: "b",
            type: "bucket_status",
            width: "half",
            title: "Everything",
            bucket_status: { mode: "all" },
          },
          { id: "c", type: "bucket_status", width: "half" },
          { id: "d", type: "bucket_status", width: "half" },
          {
            id: "e",
            type: "bucket_status",
            width: "half",
            title: "Spending",
            bucket_status: { mode: "bucket", bucket_id: fun.id },
          },
        ],
      },
    });
    renderRoute("/");
    const one = await widget("Fun");
    expect(await one.findByText("Left this cycle")).toBeInTheDocument();
    expect(one.queryByText("One bucket")).not.toBeInTheDocument();
    // The title names the bucket, so it isn't named again, unlike under another title.
    expect(one.queryByRole("link", { name: "Fun" })).not.toBeInTheDocument();
    expect((await widget("Spending")).getByRole("link", { name: "Fun" })).toBeInTheDocument();
    expect(await (await widget("Everything")).findByText("All buckets")).toBeInTheDocument();
    expect(shown()).toEqual(["Fun", "Everything", "Bucket status", "Bucket status", "Spending"]);

    // Widgets with the same title are told apart in the edit bar.
    await userEvent.click(screen.getByRole("button", { name: "Edit dashboard" }));
    expect(screen.getByRole("button", { name: "Remove Bucket status 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Fun" })).toBeInTheDocument();
  });

  it("saves a custom title, and clears it back to the automatic one", async () => {
    renderRoute("/");
    const health = await widget("Budget health");
    await userEvent.click(health.getByRole("button", { name: "Settings for Budget health" }));
    let box = within(await screen.findByRole("dialog", { name: "Budget health settings" }));
    const field = box.getByRole("textbox", { name: "Title" });
    expect(field).toHaveAttribute("placeholder", "Budget health");
    await userEvent.type(field, "  Are we OK?  ");
    await userEvent.click(box.getByRole("button", { name: "Save" }));
    const renamed = await widget("Are we OK?");
    const [first] = patches() as ReturnType<typeof savedLayout>[];
    expect(first?.dashboard.widgets[1]).toEqual({
      id: "health",
      type: "health",
      width: "half",
      title: "Are we OK?",
    });

    await userEvent.click(renamed.getByRole("button", { name: "Settings for Are we OK?" }));
    box = within(await screen.findByRole("dialog", { name: "Are we OK? settings" }));
    await userEvent.clear(box.getByRole("textbox", { name: "Title" }));
    await userEvent.click(box.getByRole("button", { name: "Save" }));
    expect(await widget("Budget health")).toBeTruthy();
    expect(patches().at(-1)).toEqual(savedLayout());
  });

  it("hides the mode line of Bucket status", async () => {
    renderRoute("/");
    const status = await widget("Bucket status");
    expect(await status.findByText("Needs attention")).toBeInTheDocument();
    await userEvent.click(status.getByRole("button", { name: "Settings for Bucket status" }));
    const box = within(await screen.findByRole("dialog", { name: "Bucket status settings" }));
    await userEvent.click(
      box.getByRole("checkbox", { name: "Show the mode (e.g. Needs attention)" }),
    );
    await userEvent.click(box.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(status.queryByText("Needs attention")).not.toBeInTheDocument();
    });
    expect(patches()).toEqual([
      savedLayout({ bucket_status: { mode: "attention", show_mode: false } }),
    ]);
  });

  it("adds Budget health at once, as its only setting is the title", async () => {
    const bar = await editMode();
    await userEvent.click(bar.getByRole("button", { name: "Add widget" }));
    const picker = await screen.findByRole("dialog", { name: "Add widget" });
    await userEvent.click(within(picker).getByRole("button", { name: /^Budget health/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole("region", { name: "Budget health" })).toHaveLength(2);
  });

  it("changes a widget's settings in edit mode, saving them with Done", async () => {
    const bar = await editMode();
    await userEvent.click(screen.getByRole("button", { name: "Settings for Recent transactions" }));
    const box = await screen.findByRole("dialog", { name: "Recent transactions settings" });
    await choose(box, "Number of transactions", "10");
    await userEvent.click(within(box).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(patches()).toEqual([]);
    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(patches()).toEqual([savedLayout({ recent_transactions: { count: 10 } })]);
    });
  });

  it("resets to the default layout after asking", async () => {
    withPreferences({ dashboard: { widgets: [{ id: "x", type: "health", width: "full" }] } });
    const bar = await editMode();
    expect(shown()).toEqual(["Budget health"]);
    await userEvent.click(bar.getByRole("button", { name: "Reset to default" }));
    const confirm = await screen.findByRole("dialog", { name: "Reset the dashboard?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => {
      expect(shown()).toEqual([
        "Cycle",
        "Budget health",
        "Bucket status",
        "Account balances",
        "Recent transactions",
      ]);
    });
    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(patches()).toEqual([savedLayout()]);
    });
  });

  it("can be empty, and offers to add a widget", async () => {
    withPreferences({ dashboard: { widgets: [] } });
    renderRoute("/");
    expect(await screen.findByText("Your dashboard has no widgets.")).toBeInTheDocument();
    expect(shown()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Add widget" }));
    expect(await screen.findByRole("dialog", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Edit dashboard" })).toBeInTheDocument();
  });

  it("shows what went wrong when Done fails, staying in edit mode", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", {
      status: 400,
      body: { title: "Bad Request", status: 400, code: "invalid_request", detail: "Nope." },
    });
    const bar = await editMode();
    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    expect(await bar.findByText(/Nope\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit dashboard" })).not.toBeInTheDocument();
  });
});
