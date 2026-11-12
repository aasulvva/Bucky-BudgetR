import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import { addDays, cycleRange, daysLeftLabel, endAtFor, startAtFor, today } from "@/lib/cycles";
import { periodSpan } from "@/lib/flows";
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
  viewport.width = 1280;
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

type WidgetSettingsByType = Partial<Record<string, object>>;

/** The mobile default layout (#99) as the API stores it, with some settings changed. */
const mobileWidgets = (settings: WidgetSettingsByType = {}) => [
  {
    id: "bucket_status",
    type: "bucket_status",
    width: "full",
    bucket_status: settings.bucket_status ?? { mode: "attention" },
  },
  { id: "cycle", type: "cycle", width: "full", cycle: settings.cycle ?? { show_next: true } },
  {
    id: "recent_transactions",
    type: "recent_transactions",
    width: "full",
    recent_transactions: settings.recent_transactions ?? { count: 5 },
  },
];

/**
 * The default desktop layout as Done or a settings save sends it, with some
 * settings changed, and the mobile layout sent with it: the mobile default,
 * unless given (e.g. the copy of the desktop layout as it was loaded).
 */
const savedLayout = (settings: WidgetSettingsByType = {}, mobile: object[] = mobileWidgets()) => ({
  dashboard: { widgets: desktopWidgets(settings), mobile_widgets: mobile },
});

/** The default desktop layout as the API stores it, with some settings changed. */
const desktopWidgets = (settings: WidgetSettingsByType = {}) => [
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
];

/** Matches a paragraph by its whole text, spans and all, with plain spaces. */
const paragraph = (text: string) => (_: string, el: Element | null) =>
  el?.tagName === "P" && plain(el.textContent) === text;

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
    // Reversed ones and moved originals are left out unless asked (#91).
    expect(query?.get("reversed")).toBe("false");
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

  it("shows the chosen bucket, or says when it's gone (#135)", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "bucket", bucket_id: fun.id } } });
    const { unmount } = renderRoute("/");
    const status = await widget("Bucket status");
    expect(await status.findByText("One bucket")).toBeInTheDocument();
    expect(status.getByText("Left this cycle")).toBeInTheDocument();
    expect(await status.findByText(`Used ${m("950.00")} of ${m("1000.00")}`)).toBeInTheDocument();
    unmount();

    withPreferences({ dashboard: { bucket_status: { mode: "bucket", bucket_id: "1999999999" } } });
    renderRoute("/");
    // Titled by its type, with no bucket name to use.
    const gone = await widget("Bucket status");
    expect(
      await gone.findByText("The bucket this widget showed has been deleted."),
    ).toBeInTheDocument();
    expect(gone.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(gone.queryByText("One bucket")).not.toBeInTheDocument();
    await userEvent.click(gone.getByRole("button", { name: "Choose another bucket" }));
    expect(
      await screen.findByRole("dialog", { name: "Bucket status settings" }),
    ).toBeInTheDocument();
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

  it("shows one account's buckets under its name, with what they have left", async () => {
    const savings = bucket({ id: "1000000005", name: "Savings", source_account_id: buffer.id });
    apiMock.on("GET /api/v1/buckets", { body: [groceries, rent, hobby, fun, savings] });
    withPreferences({ dashboard: { bucket_status: { mode: "account", account_id: main.id } } });
    const { unmount } = renderRoute("/");
    const status = await widget("Main account");
    expect(await status.findByText("One account")).toBeInTheDocument();
    expect(status.getByText("Groceries")).toBeInTheDocument();
    expect(status.getByText("Fun")).toBeInTheDocument();
    expect(status.queryByText("Savings")).not.toBeInTheDocument();
    // Σ TF without the overspent one is 1900, 400 more than the balance.
    expect(status.getByText(paragraph(`Short ${m("400.00")}`))).toBeInTheDocument();
    expect(status.getByText(paragraph(`Left in buckets ${m("1850.00")}`))).toBeInTheDocument();
    // The title names the account; the list doesn't again.
    expect(status.getAllByText("Main account")).toHaveLength(1);
    unmount();

    apiMock.on("GET /api/v1/buckets", { body: [groceries, rent, hobby, fun] });
    withPreferences({ dashboard: { bucket_status: { mode: "account", account_id: buffer.id } } });
    renderRoute("/");
    const empty = await widget("Buffer account");
    expect(
      await empty.findByText(
        paragraph("Buffer account has no buckets yet. Create one in Bucket setup."),
      ),
    ).toBeInTheDocument();
    expect(empty.getByRole("link", { name: "Create one in Bucket setup" })).toHaveAttribute(
      "href",
      "/buckets/setup",
    );
  });

  it("says when One account's account is gone, offering to choose another", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "account", account_id: "9999" } } });
    renderRoute("/");
    const status = await widget("Bucket status");
    expect(
      await status.findByText("The account this widget showed has been deleted."),
    ).toBeInTheDocument();
    await userEvent.click(status.getByRole("button", { name: "Choose another account" }));
    const box = await screen.findByRole("dialog", { name: "Bucket status settings" });
    const dialog = within(box);
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await choose(box, "Account", "Main account");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout(
        { bucket_status: { mode: "account", account_id: main.id } },
        desktopWidgets({ bucket_status: { mode: "account", account_id: "9999" } }),
      ),
    ]);
    expect(await (await widget("Main account")).findByText("Groceries")).toBeInTheDocument();
  });

  it("chooses One account in the settings", async () => {
    renderRoute("/");
    const status = await widget("Bucket status");
    await userEvent.click(
      await status.findByRole("button", { name: "Settings for Bucket status" }),
    );
    const box = await screen.findByRole("dialog", { name: "Bucket status settings" });
    await choose(box, "Show", "One account");
    expect(within(box).getByRole("button", { name: "Save" })).toBeDisabled();
    await choose(box, "Account", "Buffer account");
    await userEvent.click(within(box).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
        savedLayout({ bucket_status: { mode: "account", account_id: buffer.id } }),
      ]);
    });
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
      savedLayout(
        { bucket_status: { mode: "all" }, recent_transactions: { count: 10 } },
        desktopWidgets({ bucket_status: { mode: "all" } }),
      ),
    ]);
  });

  it("shows reversed and moved ones when asked (#91)", async () => {
    withPreferences({ dashboard: { bucket_status: { mode: "all" } } });
    renderRoute("/");
    const recent = await widget("Recent transactions");
    await userEvent.click(
      await recent.findByRole("button", { name: "Settings for Recent transactions" }),
    );
    const box = await screen.findByRole("dialog", { name: "Recent transactions settings" });
    const dialog = within(box);
    await userEvent.click(dialog.getByRole("checkbox", { name: "Show reversed & moved" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(apiMock.calls("GET /api/v1/transactions").at(-1)?.query.has("reversed")).toBe(false);
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      savedLayout(
        {
          bucket_status: { mode: "all" },
          recent_transactions: { count: 5, show_reversed: true },
        },
        desktopWidgets({ bucket_status: { mode: "all" } }),
      ),
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

  it("says when One account's account is gone (#135)", async () => {
    withPreferences({ dashboard: { accounts: { mode: "account", account_id: "9999" } } });
    renderRoute("/");
    const accounts = await widget("Account balances");
    expect(
      await accounts.findByText("The account this widget showed has been deleted."),
    ).toBeInTheDocument();
    expect(accounts.queryByRole("link", { name: "Main account" })).not.toBeInTheDocument();
    await userEvent.click(accounts.getByRole("button", { name: "Choose another account" }));
    expect(
      await screen.findByRole("dialog", { name: "Account balances settings" }),
    ).toBeInTheDocument();
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
    const confirm = await screen.findByRole("dialog", { name: "Reset this layout?" });
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
    // Only the desktop layout is reset; the mobile one is still the copy.
    await waitFor(() => {
      expect(patches()).toEqual([savedLayout({}, [{ id: "x", type: "health", width: "full" }])]);
    });
  });

  describe("desktop and mobile layouts (#99)", () => {
    const health = { id: "h", type: "health", width: "half" } as const;
    const cycleWidget = {
      id: "c",
      type: "cycle",
      width: "full",
      cycle: { show_next: true },
    } as const;
    const both = () => {
      withPreferences({ dashboard: { widgets: [health], mobile_widgets: [cycleWidget] } });
    };

    it("shows the mobile layout on a phone, and the desktop one on wider screens", async () => {
      both();
      viewport.width = 390;
      const { unmount } = renderRoute("/");
      expect(await screen.findByRole("region", { name: "Cycle" })).toBeInTheDocument();
      expect(shown()).toEqual(["Cycle"]);
      unmount();

      viewport.width = 1280;
      renderRoute("/");
      expect(await screen.findByRole("region", { name: "Budget health" })).toBeInTheDocument();
      expect(shown()).toEqual(["Budget health"]);
    });

    it("edits the mobile layout on a phone, keeping the desktop one", async () => {
      both();
      viewport.width = 390;
      const bar = await editMode();
      expect(bar.getByText(/^You're editing the mobile layout/)).toBeInTheDocument();
      expect(bar.getByRole("radio", { name: "Mobile" })).toBeChecked();
      await userEvent.click(screen.getByRole("button", { name: "Remove Cycle" }));
      await userEvent.click(bar.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(patches()).toEqual([{ dashboard: { widgets: [health], mobile_widgets: [] } }]);
      });
    });

    it("edits both layouts from a wide screen, saving them together", async () => {
      both();
      const bar = await editMode();
      expect(bar.getByText(/^You're editing the desktop layout/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Remove Budget health" }));
      expect(shown()).toEqual([]);

      await userEvent.click(bar.getByRole("radio", { name: "Mobile" }));
      expect(bar.getByText(/^You're editing the mobile layout/)).toBeInTheDocument();
      expect(shown()).toEqual(["Cycle"]);
      // One column, as on a phone: no widths to choose.
      expect(
        screen.queryByRole("button", { name: "Make Cycle half width" }),
      ).not.toBeInTheDocument();
      await userEvent.click(bar.getByRole("button", { name: "Add widget" }));
      const picker = await screen.findByRole("dialog", { name: "Add widget" });
      await userEvent.click(within(picker).getByRole("button", { name: /^Budget health/ }));
      await waitFor(() => {
        expect(shown()).toEqual(["Cycle", "Budget health"]);
      });

      // Switching back keeps both drafts.
      await userEvent.click(bar.getByRole("radio", { name: "Desktop" }));
      expect(shown()).toEqual([]);
      await userEvent.click(bar.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(patches()).toHaveLength(1);
      });
      const [saved] = patches() as { dashboard: { widgets: object[]; mobile_widgets: object[] } }[];
      expect(saved?.dashboard.widgets).toEqual([]);
      expect(saved?.dashboard.mobile_widgets).toEqual([
        cycleWidget,
        expect.objectContaining({ type: "health", width: "half" }),
      ]);
    });

    it("throws away the changes to both layouts with Cancel", async () => {
      both();
      const bar = await editMode();
      await userEvent.click(screen.getByRole("button", { name: "Remove Budget health" }));
      await userEvent.click(bar.getByRole("radio", { name: "Mobile" }));
      await userEvent.click(screen.getByRole("button", { name: "Remove Cycle" }));
      await userEvent.click(bar.getByRole("button", { name: "Cancel" }));
      expect(await screen.findByRole("region", { name: "Budget health" })).toBeInTheDocument();
      expect(patches()).toEqual([]);
    });

    it("copies the desktop layout into the mobile one after asking", async () => {
      both();
      const bar = await editMode();
      await userEvent.click(bar.getByRole("radio", { name: "Mobile" }));
      await userEvent.click(bar.getByRole("button", { name: "Copy from desktop" }));
      const confirm = await screen.findByRole("dialog", { name: "Replace this layout?" });
      expect(
        within(confirm).getByText(/replaces the mobile layout's widgets with a copy/),
      ).toBeInTheDocument();
      await userEvent.click(within(confirm).getByRole("button", { name: "Copy from desktop" }));
      await waitFor(() => {
        expect(shown()).toEqual(["Budget health"]);
      });
      await userEvent.click(bar.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(patches()).toEqual([{ dashboard: { widgets: [health], mobile_widgets: [health] } }]);
      });
    });

    it("resets only the mobile layout, to its own default", async () => {
      both();
      viewport.width = 390;
      const bar = await editMode();
      await userEvent.click(bar.getByRole("button", { name: "Reset to default" }));
      const confirm = await screen.findByRole("dialog", { name: "Reset this layout?" });
      await userEvent.click(within(confirm).getByRole("button", { name: "Reset to default" }));
      await waitFor(() => {
        expect(shown()).toEqual(["Bucket status", "Cycle", "Recent transactions"]);
      });
      await userEvent.click(bar.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(patches()).toEqual([
          { dashboard: { widgets: [health], mobile_widgets: mobileWidgets() } },
        ]);
      });
    });

    it("saves a widget's settings on a phone to the mobile layout only", async () => {
      withPreferences({
        dashboard: { widgets: [{ ...cycleWidget, width: "half" }], mobile_widgets: [cycleWidget] },
      });
      viewport.width = 390;
      renderRoute("/");
      const cycleCard = await widget("Cycle");
      await userEvent.click(cycleCard.getByRole("button", { name: "Settings for Cycle" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Cycle settings" }));
      await userEvent.click(dialog.getByRole("checkbox", { name: "Show the next planned cycle" }));
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(patches()).toEqual([
          {
            dashboard: {
              widgets: [{ ...cycleWidget, width: "half" }],
              mobile_widgets: [{ ...cycleWidget, cycle: { show_next: false } }],
            },
          },
        ]);
      });
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

describe("In/out widget", () => {
  const inOut = (settings?: components["schemas"]["InOutWidgetSettings"]) => {
    withPreferences({
      dashboard: {
        widgets: [
          { id: "io", type: "in_out", width: "half", ...(settings ? { in_out: settings } : {}) },
        ],
      },
    });
  };
  const euro = account({ id: "3456", name: "Euro account", currency: "EUR" });
  /** A figure's link, named with the amount as formatted (labels keep their spaces). */
  const figure = (name: string, amount: string) =>
    `${name}: ${formatMoney(amount, "NOK")}. Show the transactions.`;

  beforeEach(() => {
    apiMock.on("GET /api/v1/reports/flows", {
      body: [
        {
          account_id: main.id,
          income: "20000.00",
          expenses: "8000.00",
          transfers_in: "500.00",
          transfers_out: "2000.00",
        },
        {
          account_id: buffer.id,
          income: "100.00",
          expenses: "0.00",
          transfers_in: "2000.00",
          transfers_out: "500.00",
        },
        {
          account_id: euro.id,
          income: "50.00",
          expenses: "0.00",
          transfers_in: "0.00",
          transfers_out: "0.00",
        },
      ],
    });
  });

  it("says when its account is gone, instead of showing all accounts (#135)", async () => {
    inOut({ figures: ["income", "expenses", "balance"], period: "month", account_id: "9999" });
    renderRoute("/");
    const box = await widget("Money in and out");
    expect(
      await box.findByText("The account this widget showed has been deleted."),
    ).toBeInTheDocument();
    expect(box.queryByRole("link", { name: /Income:/ })).not.toBeInTheDocument();
    await userEvent.click(box.getByRole("button", { name: "Choose another account" }));
    expect(
      await screen.findByRole("dialog", { name: "Money in and out settings" }),
    ).toBeInTheDocument();
  });

  it("sums this month on all accounts in the app's currency, linking each figure", async () => {
    apiMock.on("GET /api/v1/accounts", { body: [main, buffer, euro] });
    inOut();
    renderRoute("/");
    const io = await widget("Money in and out");
    const income = await io.findByRole("link", {
      name: figure("Income", "20100.00"),
    });
    const month = periodSpan("month", 30, null);
    expect(income).toHaveAttribute(
      "href",
      `/transactions?cycle_id=all&from=${month?.from}&to=${month?.to}&type=INC`,
    );
    expect(io.getByRole("link", { name: figure("Expenses", "8000.00") })).toBeInTheDocument();
    expect(io.getByText(`+${m("12100.00")}`)).toBeInTheDocument();
    expect(io.getByText(/^This month \(.*\) · All accounts$/)).toBeInTheDocument();
    expect(io.getByText("1 account in another currency isn't included.")).toBeInTheDocument();
    const [query] = apiMock.calls("GET /api/v1/reports/flows").map((c) => c.query);
    expect(query?.get("from")).toBe(startAtFor(month?.from ?? ""));
    expect(query?.get("to")).toBe(endAtFor(month?.to ?? ""));
  });

  it("makes the amounts smaller, or puts them in rows, when they don't fit", async () => {
    // jsdom has no layout: each amount is 150px wide at 20px, the widget's
    // content `width` px wide, and there are three columns 16px apart.
    let width = 450;
    const style = window.getComputedStyle.bind(window);
    const spies = [
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        return { width: this.hasAttribute("data-amount") ? 150 : 0 } as DOMRect;
      }),
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width),
      vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
        const s = style(el, pseudo);
        return el instanceof HTMLElement && el.hasAttribute("data-amount")
          ? Object.defineProperty(s, "fontSize", { value: "20px" })
          : s;
      }),
    ];
    try {
      inOut();
      const first = renderRoute("/");
      const io = await widget("Money in and out");
      await io.findByRole("link", { name: figure("Income", "20100.00") });
      // 139px columns: 120px at 16px fits.
      expect(
        io.getByRole("link", { name: figure("Income", "20100.00") }).parentElement,
      ).toHaveAttribute("data-layout", "small");
      first.unmount();

      width = 300;
      renderRoute("/");
      const narrow = await widget("Money in and out");
      const income = await narrow.findByRole("link", { name: figure("Income", "20100.00") });
      expect(income.parentElement).toHaveAttribute("data-layout", "rows");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("counts transfers on one account, over the last days", async () => {
    inOut({ figures: ["income", "balance"], period: "days", days: 7, account_id: main.id });
    renderRoute("/");
    const io = await widget("Money in and out");
    expect(await io.findByRole("link", { name: figure("Income", "20500.00") })).toHaveAttribute(
      "href",
      expect.stringContaining("account_id=1234") as unknown,
    );
    expect(io.getByText(`+${m("10500.00")}`)).toBeInTheDocument();
    expect(io.queryByText("Expenses")).not.toBeInTheDocument();
    expect(io.getByText(/^Last 7 days \(.*\) · Main account$/)).toBeInTheDocument();
    const [query] = apiMock.calls("GET /api/v1/reports/flows").map((c) => c.query);
    expect(query?.get("from")).toBe(startAtFor(addDays(today(), -6)));
  });

  it("saves its settings", async () => {
    inOut();
    renderRoute("/");
    const io = await widget("Money in and out");
    await userEvent.click(await io.findByRole("button", { name: "Settings for Money in and out" }));
    const box = await screen.findByRole("dialog", { name: "Money in and out settings" });
    const dialog = within(box);
    await userEvent.click(dialog.getByRole("checkbox", { name: "Expenses" }));
    await userEvent.click(dialog.getByRole("checkbox", { name: "Income" }));
    await userEvent.click(dialog.getByRole("checkbox", { name: "Balance" }));
    expect(dialog.getByText("Choose at least one figure.")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("checkbox", { name: "Balance" }));
    await userEvent.click(dialog.getByRole("checkbox", { name: "Income" }));
    await choose(box, "Period", "The last few days");
    const days = dialog.getByRole("textbox", { name: "Number of days" });
    await userEvent.clear(days);
    await userEvent.type(days, "14");
    await choose(box, "Accounts", "Buffer account");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences").map((c) => c.body)).toEqual([
      {
        dashboard: {
          widgets: [
            {
              id: "io",
              type: "in_out",
              width: "half",
              in_out: {
                figures: ["income", "balance"],
                period: "days",
                days: 14,
                account_id: buffer.id,
              },
            },
          ],
          // The mobile layout is the copy of the saved layout as it was.
          mobile_widgets: [
            {
              id: "io",
              type: "in_out",
              width: "half",
              in_out: { figures: ["income", "expenses", "balance"], period: "month" },
            },
          ],
        },
      },
    ]);
  });
});

describe("Module widget (#201)", () => {
  const stats = "GET /api/v1/stats/series";
  const spending: components["schemas"]["SavedModule"] = {
    id: "g-1",
    name: "Monthly spending",
    period: "last-6-months",
    module: {
      id: "m-1",
      type: "graph",
      graph: { kind: "bar", metric: "spending", resolution: "month", group_by: "bucket" },
    },
  };
  const moduleWidget = (savedId: string | null, saved = [spending]) => {
    withPreferences({
      saved_modules: saved,
      dashboard: {
        widgets: [
          {
            id: "gw",
            type: "module",
            width: "full",
            ...(savedId ? { module: { saved_module_id: savedId } } : {}),
          },
        ],
      },
    });
  };
  /** The first day of the month n months before this one, as a date. */
  const monthsAgo = (n: number) => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth() - n, 1);
    return `${String(first.getFullYear())}-${String(first.getMonth() + 1).padStart(2, "0")}-01`;
  };

  beforeEach(() => {
    apiMock.on(stats, (req) => ({
      body: {
        intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
        series: [
          { currency: "NOK", account_id: main.id, bucket_id: groceries.id, values: ["120.00"] },
        ],
      },
    }));
  });

  it("shows its saved graph under its name, and opens it on Stats", async () => {
    moduleWidget("g-1");
    const { router } = renderRoute("/");
    const box = await widget("Monthly spending");
    await waitFor(() => {
      expect(apiMock.calls(stats)).not.toHaveLength(0);
    });
    const q = apiMock.calls(stats).at(-1)?.query;
    expect(q?.get("metric")).toBe("spending");
    expect(q?.get("group_by")).toBe("bucket");
    expect(q?.get("from")).toBe(startAtFor(monthsAgo(5)));
    const open = box.getByRole("link", { name: "Open in Stats" });
    expect(open).toHaveAttribute(
      "href",
      "/stats?kind=bar&metric=spending&period=last-6-months&res=month&group=bucket&saved=g-1",
    );
    await userEvent.click(await box.findByTestId("graph-widget"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/stats");
    });
    expect(router.state.location.search).toContain("saved=g-1");
  });

  it("draws a graph module's comparison, but not its breakdown", async () => {
    moduleWidget("g-1", [
      {
        ...spending,
        period: "previous-month",
        compare_to: "last_year",
        module: { ...spending.module, compare: "both", breakdown: "month" },
      },
    ]);
    renderRoute("/");
    await widget("Monthly spending");
    const prev = monthsAgo(1);
    const lastYear = `${String(Number(prev.slice(0, 4)) - 1)}${prev.slice(4)}`;
    await waitFor(() => {
      const froms = apiMock.calls(stats).map((c) => c.query.get("from"));
      expect(froms).toContain(startAtFor(prev));
      expect(froms).toContain(startAtFor(lastYear));
    });
    // One graph and its comparison; no months to break it down by.
    expect(new Set(apiMock.calls(stats).map((c) => c.query.get("from"))).size).toBe(2);
  });

  it("draws a pie compactly, without links to transactions", async () => {
    const pie = {
      ...spending,
      module: {
        id: "m-1",
        type: "graph" as const,
        graph: {
          kind: "pie" as const,
          metric: "spending" as const,
          resolution: "month" as const,
          group_by: "bucket" as const,
        },
      },
    };
    moduleWidget("g-1", [pie]);
    renderRoute("/");
    const box = await widget("Monthly spending");
    const list = within(await box.findByTestId("pie-list"));
    expect(list.getByText("Groceries")).toBeInTheDocument();
    expect(list.queryAllByRole("link")).toHaveLength(0);
  });

  it("shows a transactions module in full, over its own last N months", async () => {
    moduleWidget("g-2", [
      {
        id: "g-2",
        name: "Latest food",
        period: "last-3-months",
        module: { id: "m-1", type: "transactions", transactions: { bucket_ids: [groceries.id] } },
      },
    ]);
    const { router } = renderRoute("/");
    const box = await widget("Latest food");
    expect(await box.findByText("Rema 1000")).toBeInTheDocument();
    const q = apiMock.calls("GET /api/v1/transactions").at(-1)?.query;
    expect(q?.get("from")).toBe(startAtFor(monthsAgo(2)));
    expect(q?.getAll("bucket_id")).toEqual([groceries.id]);
    expect(box.getByRole("link", { name: "Open in Stats" })).toHaveAttribute(
      "href",
      "/stats?saved=g-2",
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("says when its saved module was deleted, offering to pick another", async () => {
    const other = { ...spending, id: "g-2", name: "Income" };
    const list = {
      ...spending,
      id: "g-3",
      name: "List",
      module: { id: "m-1", type: "transactions" as const, transactions: {} },
    };
    moduleWidget("g-9", [other, list]);
    renderRoute("/");
    const box = await widget("Module");
    expect(box.getByText("This saved module was deleted.")).toBeInTheDocument();
    expect(apiMock.calls(stats)).toHaveLength(0);
    await userEvent.click(box.getByRole("button", { name: "Pick a module" }));
    const dialog = await screen.findByRole("dialog", { name: "Module settings" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await choose(dialog, "Saved module", "List");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body).toMatchObject({
        dashboard: { widgets: [{ id: "gw", type: "module", module: { saved_module_id: "g-3" } }] },
      });
    });
  });

  it("points to the Stats screen when nothing is saved yet", async () => {
    moduleWidget(null, []);
    renderRoute("/");
    const box = await widget("Module");
    expect(box.getByRole("link", { name: "Stats & reports" })).toHaveAttribute("href", "/stats");
  });

  it("is added from Add widget by picking a saved module", async () => {
    withPreferences({ saved_modules: [spending] });
    renderRoute("/");
    await userEvent.click(await screen.findByRole("button", { name: "Edit dashboard" }));
    const bar = within(await screen.findByRole("region", { name: "Edit dashboard" }));
    await userEvent.click(bar.getByRole("button", { name: "Add widget" }));
    const picker = await screen.findByRole("dialog", { name: "Add widget" });
    await userEvent.click(within(picker).getByRole("button", { name: /^Module/ }));
    const box = await screen.findByRole("dialog", { name: "Add widget: Module" });
    expect(within(box).getByRole("button", { name: "Add" })).toBeDisabled();
    await choose(box, "Saved module", "Monthly spending");
    await userEvent.click(within(box).getByRole("button", { name: "Add" }));
    await userEvent.click(bar.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      const body = apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body as {
        dashboard: { widgets: object[] };
      };
      expect(body.dashboard.widgets.at(-1)).toEqual({
        id: expect.stringMatching(/^[A-Za-z0-9_-]{1,40}$/) as unknown,
        type: "module",
        width: "full",
        module: { saved_module_id: "g-1" },
      });
    });
  });
});
