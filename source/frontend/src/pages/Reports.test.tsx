import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import { endAtFor, startAtFor } from "@/lib/cycles";
import { formatDate, formatDay } from "@/lib/dates";
import { specificLabel } from "@/lib/graphs";
import { formatMoney } from "@/lib/money";
import { apiMock, problem, testUser, type MockRequest } from "@/test/api";
import { account, bucket, bucketFigures, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

type Preferences = components["schemas"]["Preferences"];
type ReportTemplate = components["schemas"]["ReportTemplate"];

const main = account({ id: "1234", name: "Main" });
const food = bucket({ id: "1000000001", name: "Food", source_account_id: "1234" });
const fun = bucket({ id: "1000000002", name: "Fun", source_account_id: "1234" });
const list = "GET /api/v1/transactions";
const stats = "GET /api/v1/stats/series";
const year = new Date().getFullYear();

/** One interval over the whole request, spending 120 on Food. */
function answer(req: MockRequest) {
  const from = req.query.get("from") ?? "";
  const to = req.query.get("to") ?? "";
  return {
    body: {
      intervals: [{ start: from, end: to }],
      series: [
        { currency: "NOK", bucket_id: "1000000001", account_id: "1234", values: ["120.00"] },
      ],
    },
  };
}

const flowsPath = "GET /api/v1/stats/flows";
const zero = {
  start: "0.00",
  refills: "0.00",
  income: "0.00",
  opening_funds: "0.00",
  adjustments_in: "0.00",
  adjustments_out: "0.00",
  transfers_in: "0.00",
  transfers_out: "0.00",
  spent: "0.00",
  overflow: "0.00",
  in: "0.00",
  out: "0.00",
  end: "0.00",
};
/** Food starts at 100, gets 1000 in and spends 400 per interval; Fun does nothing. */
function flowsAnswer(req: MockRequest) {
  const from = req.query.get("from") ?? "";
  const to = req.query.get("to") ?? "";
  const intervals =
    req.query.get("resolution") === "month"
      ? Array.from({ length: 12 }, (_, m) => ({
          start: startAtFor(`${String(year - 1)}-${String(m + 1).padStart(2, "0")}-01`),
          end:
            m === 11 ? to : startAtFor(`${String(year - 1)}-${String(m + 2).padStart(2, "0")}-01`),
        }))
      : [{ start: from, end: to }];
  const food = intervals.map((_, i) => ({
    ...zero,
    start: (100 + 600 * i).toFixed(2),
    refills: "1000.00",
    in: "1000.00",
    spent: "400.00",
    out: "400.00",
    end: (700 + 600 * i).toFixed(2),
  }));
  return {
    body: {
      intervals,
      buckets: [
        { bucket_id: "1000000001", account_id: "1234", currency: "NOK", values: food },
        {
          bucket_id: "1000000002",
          account_id: "1234",
          currency: "NOK",
          values: intervals.map(() => zero),
        },
      ],
      accounts: [
        {
          account_id: "1234",
          currency: "NOK",
          // From 1000, with the transfer out in its balance.
          values: intervals.map((_, i) => ({
            start: (1000 + 27600 * i).toFixed(2),
            income: "30000.00",
            expenses: "400.00",
            transfers_in: "0.00",
            transfers_out: "2000.00",
            end: (28600 + 27600 * i).toFixed(2),
          })),
        },
      ],
    },
  };
}

let prefs: Preferences;

beforeEach(() => {
  viewport.width = 1280;
  prefs = { ...testUser.preferences };
  apiMock.on("GET /api/v1/me", () => ({ body: { ...testUser, preferences: prefs } }));
  apiMock.on("PATCH /api/v1/me/preferences", (req) => {
    prefs = { ...prefs, ...(req.body as Preferences) };
    return { body: prefs };
  });
  apiMock.on("GET /api/v1/accounts", { body: [main] });
  apiMock.on("GET /api/v1/buckets", { body: [food, fun] });
  apiMock.on(stats, answer);
  apiMock.on(flowsPath, flowsAnswer);
});

const lastBody = () =>
  apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body as Preferences | undefined;

const modules = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));

const template = (over: Partial<ReportTemplate["report"]> = {}): ReportTemplate => ({
  id: "r-1",
  name: "Mine",
  report: {
    period: "previous-month",
    modules: [
      { id: "m-1", type: "graph", graph: { kind: "bar", metric: "spending", resolution: "day" } },
    ],
    ...over,
  },
});

describe("Reports", () => {
  it("opens the yearly report, comparing with the year before", async () => {
    const { router } = renderRoute("/stats");
    await userEvent.click(await screen.findByRole("tab", { name: "Reports" }));
    expect(router.state.location.pathname).toBe("/stats/reports");
    expect(await screen.findByRole("combobox", { name: "Report" })).toHaveValue("Yearly report");
    await waitFor(() => {
      expect(modules()).toEqual([
        "Spending · Pie · Per bucket",
        "Spending · Bars · Month",
        "Balance · Line · Month · Per account",
      ]);
    });
    // The previous year too, for the compared module.
    const froms = () => apiMock.calls(stats).map((c) => c.query.get("from"));
    await waitFor(() => {
      expect(froms()).toContain(startAtFor(`${String(year - 2)}-01-01`));
    });
    expect(froms()).toContain(startAtFor(`${String(year - 1)}-01-01`));
    expect(screen.getByText(`Compared with ${String(year - 2)}.`)).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("adds a module and saves the report as a template", async () => {
    const { router } = renderRoute("/stats/reports");
    await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
    const dialog = await screen.findByRole("dialog", { name: "Add module" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Show" }));
    await userEvent.click(await within(dialog).findByRole("option", { name: "Income" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Title/ }), "Pay");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Difference" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(modules()).toHaveLength(4);
    });
    expect(modules()[3]).toBe("Pay");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save report…" }));
    const save = await screen.findByRole("dialog", { name: "Save report" });
    await userEvent.type(within(save).getByRole("textbox", { name: "Name" }), "My year");
    await userEvent.click(within(save).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("?template=r-1");
    });
    const saved = lastBody()?.report_templates?.[0];
    expect(saved?.name).toBe("My year");
    expect(saved?.report.period).toBe("previous-year");
    expect(saved?.report.modules[3]).toEqual({
      id: "m-4",
      type: "graph",
      title: "Pay",
      compare: "difference",
      graph: { kind: "bar", metric: "income", resolution: "month" },
    });
    await waitFor(() => {
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("saves, renames and deletes a template", async () => {
    prefs = { ...prefs, report_templates: [template()] };
    const { router } = renderRoute("/stats/reports?template=r-1");
    expect(await screen.findByRole("combobox", { name: "Report" })).toHaveValue("Mine");
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    // Removing the only module changes the report.
    await waitFor(() => {
      expect(screen.getByText("No modules yet. Add one to build the report.")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastBody()?.report_templates?.[0]?.report.modules).toEqual([]);
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: "Rename report" });
    const name = within(rename).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Monthly");
    await userEvent.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastBody()?.report_templates?.[0]?.name).toBe("Monthly");
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const del = await screen.findByRole("dialog", { name: "Delete report" });
    await userEvent.click(within(del).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(lastBody()?.report_templates).toEqual([]);
    });
    expect(router.state.location.search).toBe("?starter=yearly");
  });

  it("breaks a module down by month, and not short periods", async () => {
    renderRoute("/stats/reports");
    const balance = await screen.findByRole("region", {
      name: "Balance · Line · Month · Per account",
    });
    await userEvent.click(within(balance).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit module" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "By month" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(within(balance).getAllByTestId("breakdown-part")).toHaveLength(12);
    });
    expect(within(balance).getByText(`January ${String(year - 1)}`)).toBeInTheDocument();
  });

  it("offers no breakdown for a month, nor comparison for custom dates", async () => {
    prefs = {
      ...prefs,
      report_templates: [
        template(),
        { ...template({ period: "custom-2026-01-01-2026-01-31" }), id: "r-2", name: "Custom" },
      ],
    };
    renderRoute("/stats/reports?template=r-1");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit module" });
    expect(within(dialog).getByRole("radio", { name: "By month" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "Both" })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("combobox", { name: "Report" }));
    await userEvent.click(await screen.findByRole("option", { name: "Custom" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    dialog = await screen.findByRole("dialog", { name: "Edit module" });
    expect(within(dialog).getByRole("radio", { name: "Both" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Compare with" })).toBeDisabled();
  });

  it("moves modules", async () => {
    renderRoute("/stats/reports");
    await waitFor(() => {
      expect(modules()).toHaveLength(3);
    });
    const [first] = screen.getAllByRole("region");
    if (!first) throw new Error("no module");
    expect(within(first).getByRole("button", { name: "Move up" })).toBeDisabled();
    await userEvent.click(within(first).getByRole("button", { name: "Move down" }));
    expect(modules()[1]).toBe("Spending · Pie · Per bucket");
  });

  it("adds a transactions module, a page at a time (#126)", async () => {
    apiMock.on(list, (req) =>
      req.query.get("cursor")
        ? { body: { items: [transaction({ id: "t2", counterparty: "Kiwi" })], next_cursor: null } }
        : {
            body: {
              items: [transaction({ id: "t1", counterparty: "Rema 1000" })],
              next_cursor: "c1",
            },
          },
    );
    renderRoute("/stats/reports");
    await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
    const dialog = await screen.findByRole("dialog", { name: "Add module" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Transactions" }));
    await userEvent.click(
      within(dialog).getByRole("switch", { name: "Show refills & adjustments" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const module = await screen.findByRole("region", { name: "Transactions" });
    expect(await within(module).findByText("Rema 1000")).toBeInTheDocument();
    const query = apiMock.calls(list)[0]?.query;
    expect(query?.get("from")).toBe(startAtFor(`${String(year - 1)}-01-01`));
    expect(query?.getAll("type")).toContain("REF");
    expect(query?.get("reversed")).toBe("false");
    expect(query?.get("limit")).toBe("50");
    expect(within(module).getByRole("link", { name: "Open in Transactions" })).toHaveAttribute(
      "href",
      `/transactions?cycle_id=all&from=${String(year - 1)}-01-01&to=${String(year - 1)}-12-31&system=1&reversed=0`,
    );

    await userEvent.click(within(module).getByRole("button", { name: "Load more" }));
    expect(await within(module).findByText("Kiwi")).toBeInTheDocument();
    expect(apiMock.calls(list).at(-1)?.query.get("cursor")).toBe("c1");
    expect(within(module).queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows a transactions module as a table with chosen columns and totals (#185)", async () => {
    const day = `${String(year - 1)}-06-15T10:00:00Z`;
    apiMock.on(list, {
      body: {
        items: [
          transaction({
            id: "t1",
            at: day,
            counterparty: "Rema 1000",
            bank_lines: [{ account_id: "1234", amount: "-250.00" }],
            bucket_lines: [
              { bucket_id: "1000000001", cycle_id: "100001000001", amount: "-200.00" },
              { bucket_id: "1000000002", cycle_id: "100001000001", amount: "-50.00" },
            ],
          }),
          transaction({
            id: "t2",
            at: day,
            type: "INC",
            counterparty: "Work",
            bank_lines: [{ account_id: "1234", amount: "1000.00" }],
          }),
        ],
        next_cursor: null,
      },
    });
    const { router } = renderRoute("/stats/reports");
    await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
    const dialog = await screen.findByRole("dialog", { name: "Add module" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Transactions" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Table" }));
    // Leave out tags, and put the amount before the account.
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Tags" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move Amount up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move Amount up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const module = await screen.findByRole("region", { name: "Transactions" });
    const table = await within(module).findByRole("table", { name: "Transactions" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Date", "Counterparty", "Amount", "Account", "Buckets"]);
    const rows = () =>
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent);
    const nok = (a: string) => formatMoney(a, "NOK");
    expect(rows()).toEqual([
      "DateCounterpartyAmountAccountBuckets",
      formatDay(`${String(year - 1)}-06-15`),
      `${formatDate(day)}Rema 1000${nok("-250.00")}MainFood ${nok("-200.00")} · Fun ${nok("-50.00")}`,
      `${formatDate(day)}Work+${nok("1000.00")}Main`,
      `Subtotal${nok("750.00")}`,
      `Total${nok("750.00")}`,
    ]);
    expect(within(table).getByRole("link", { name: "Rema 1000" })).toHaveAttribute(
      "href",
      expect.stringContaining("open=t1") as string,
    );

    // A row per bucket line.
    await userEvent.click(within(module).getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit module" });
    await userEvent.click(within(edit).getByRole("radio", { name: "One per bucket line" }));
    await userEvent.click(within(edit).getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(rows()).toContain(`${formatDate(day)}Rema 1000${nok("-50.00")}MainFun`);
    });

    await userEvent.click(screen.getByRole("button", { name: "Save report…" }));
    const save = await screen.findByRole("dialog", { name: "Save report" });
    await userEvent.type(within(save).getByRole("textbox", { name: "Name" }), "Table");
    await userEvent.click(within(save).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("?template=r-1");
    });
    expect(lastBody()?.report_templates?.[0]?.report.modules[3]).toEqual({
      id: "m-4",
      type: "transactions",
      transactions: {
        view: "table",
        columns: ["date", "counterparty", "amount", "account", "buckets"],
        rows: "bucket_line",
      },
    });
  });

  it("filters a saved transactions module by several buckets (#126)", async () => {
    apiMock.on(list, {
      body: { items: [transaction({ id: "t1", counterparty: "Rema 1000" })], next_cursor: null },
    });
    prefs = {
      ...prefs,
      report_templates: [
        template({
          modules: [
            {
              id: "m-1",
              type: "transactions",
              title: "Food and fun",
              transactions: { bucket_ids: ["1000000001", "1000000002"] },
            },
          ],
        }),
      ],
    };
    renderRoute("/stats/reports?template=r-1");
    const module = await screen.findByRole("region", { name: "Food and fun" });
    expect(await within(module).findByText("Rema 1000")).toBeInTheDocument();
    expect(within(module).getByText("Own buckets")).toBeInTheDocument();
    expect(apiMock.calls(list)[0]?.query.getAll("bucket_id")).toEqual(["1000000001", "1000000002"]);
    // The Transactions screen can't show two buckets yet (#162), but a row opens there.
    expect(
      within(module).queryByRole("link", { name: "Open in Transactions" }),
    ).not.toBeInTheDocument();
    expect(
      within(module)
        .getByRole("link", { name: /Rema 1000/ })
        .getAttribute("href"),
    ).toMatch(/^\/transactions\?cycle_id=all&from=.*&open=t1$/);
    // Editing shows its own settings, not a graph's.
    await userEvent.click(within(module).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit module" });
    expect(within(dialog).queryByRole("radio", { name: "Transactions" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Show reversed & moved" })).not.toBeChecked();
    expect(within(dialog).queryByText("Breakdown")).not.toBeInTheDocument();
  });

  it("groups a transactions module by month, oldest first (#126)", async () => {
    apiMock.on(list, {
      body: {
        items: [transaction({ id: "t1", counterparty: "Rema 1000", at: "2026-10-15T19:00:00Z" })],
        next_cursor: null,
      },
    });
    prefs = {
      ...prefs,
      report_templates: [
        template({ modules: [{ id: "m-1", type: "transactions", transactions: {} }] }),
      ],
    };
    renderRoute("/stats/reports?template=r-1");
    const module = await screen.findByRole("region", { name: "Transactions" });
    // Under the day's heading, as the locale writes it (CI runs in en-US).
    expect(
      await within(module).findByRole("region", { name: formatDay("2026-10-15") }),
    ).toBeInTheDocument();
    await userEvent.click(within(module).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit module" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Month" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Oldest first" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(module).findByRole("region", { name: "October 2026" })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMock.calls(list).at(-1)?.query.get("order")).toBe("oldest");
    });
  });

  it("adds an in/out/balance module with buckets and accounts (#126)", async () => {
    renderRoute("/stats/reports");
    await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
    const dialog = await screen.findByRole("dialog", { name: "Add module" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "In/out/balance" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Both" }));
    await userEvent.click(
      within(dialog).getByRole("switch", { name: "Count transfers between accounts" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const module = await screen.findByRole("region", { name: "In, out and balance" });
    const bucketsTable = await within(module).findByRole("table", { name: "Buckets" });
    const query = apiMock.calls(flowsPath)[0]?.query;
    expect(query?.get("from")).toBe(startAtFor(`${String(year - 1)}-01-01`));
    expect(query?.get("resolution")).toBe("total");
    const foodRow = within(bucketsTable).getByRole("row", { name: /Food/ });
    expect(
      within(foodRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "Food",
      formatMoney("100.00", "NOK"),
      formatMoney("1000.00", "NOK"),
      formatMoney("400.00", "NOK"),
      formatMoney("700.00", "NOK"),
    ]);
    // Nothing happened to Fun.
    expect(within(bucketsTable).queryByText("Fun")).not.toBeInTheDocument();
    expect(within(bucketsTable).getByRole("row", { name: /Total/ })).toBeInTheDocument();
    expect(within(foodRow).getByRole("link", { name: "Food" }).getAttribute("href")).toMatch(
      /^\/transactions\?.*bucket_id=1000000001/,
    );

    const accountsTable = within(module).getByRole("table", { name: "Accounts" });
    const mainRow = within(accountsTable).getByRole("row", { name: /Main/ });
    expect(
      within(mainRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "Main",
      formatMoney("30000.00", "NOK"),
      formatMoney("2400.00", "NOK"),
      formatMoney("27600.00", "NOK"),
    ]);
    expect(within(module).queryByText(/don't apply/)).not.toBeInTheDocument();
  });

  it("breaks a saved in/out/balance module down by month, with details (#126)", async () => {
    prefs = {
      ...prefs,
      report_templates: [
        template({
          period: "previous-year",
          tags: ["food"],
          modules: [
            {
              id: "m-1",
              type: "flows",
              flows: { bucket_ids: ["1000000001"], details: true, breakdown: "month" },
            },
          ],
        }),
      ],
    };
    renderRoute("/stats/reports?template=r-1");
    const module = await screen.findByRole("region", { name: "In, out and balance" });
    await waitFor(() => {
      expect(within(module).getAllByTestId("breakdown-part")).toHaveLength(12);
    });
    expect(within(module).getByText(`March ${String(year - 1)}`)).toBeInTheDocument();
    expect(within(module).getByText(/don't apply/)).toBeInTheDocument();
    const calls = apiMock.calls(flowsPath);
    expect(calls.map((c) => c.query.get("resolution")).sort()).toEqual(["month", "total"]);
    expect(calls[0]?.query.getAll("bucket_id")).toEqual(["1000000001"]);
    expect(calls[0]?.query.getAll("tag")).toEqual([]);
    const [whole] = within(module).getAllByRole("table", { name: "Buckets" });
    if (!whole) throw new Error("no table");
    expect(within(whole).getByRole("columnheader", { name: "Refills" })).toBeInTheDocument();
    expect(within(whole).getByRole("columnheader", { name: "Spent" })).toBeInTheDocument();
    expect(within(module).queryByRole("table", { name: "Accounts" })).not.toBeInTheDocument();
    // The second month starts where the first ends.
    const [, , second] = within(module).getAllByRole("table", { name: "Buckets" });
    if (!second) throw new Error("no table");
    const cells = within(within(second).getByRole("row", { name: /Food/ }))
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect([cells[1], cells.at(-1)]).toEqual([
      formatMoney("700.00", "NOK"),
      formatMoney("1300.00", "NOK"),
    ]);
  });

  describe("in/out/balance as a grid (#187)", () => {
    const flows = (settings: Record<string, unknown>) => {
      prefs = {
        ...prefs,
        report_templates: [
          template({
            period: "previous-year",
            modules: [{ id: "m-1", type: "flows", flows: settings }],
          }),
        ],
      };
      renderRoute("/stats/reports?template=r-1");
      return screen.findByRole("region", { name: "In, out and balance" });
    };
    const figure = (card: HTMLElement, label: string) =>
      card.querySelector(`[data-figure="${label}"]`)?.lastElementChild?.textContent;
    const change = (card: HTMLElement) => card.querySelector("[data-change]")?.textContent;
    const startEnd = (start: string, end: string) =>
      `Start ${formatMoney(start, "NOK")} → End ${formatMoney(end, "NOK")}`;

    it("shows a card per bucket and account, with details, balances and totals", async () => {
      // Fun overspends.
      apiMock.on(flowsPath, (req) => {
        const answer = flowsAnswer(req);
        const fun = answer.body.buckets[1];
        if (fun) {
          fun.values = fun.values.map(() => ({
            ...zero,
            spent: "50.00",
            out: "50.00",
            end: "-50.00",
          }));
        }
        return answer;
      });
      const module = await flows({ view: "grid", show: "both", details: true, balances: true });
      const foodCard = await within(module).findByRole("group", { name: "Food" });
      expect(within(module).queryByRole("table")).not.toBeInTheDocument();
      expect(within(foodCard).getByRole("link", { name: "Food" }).getAttribute("href")).toMatch(
        /^\/transactions\?.*bucket_id=1000000001/,
      );
      expect(change(foodCard)).toBe(`+${formatMoney("600.00", "NOK")}`);
      expect(foodCard.querySelector("[data-balances]")?.textContent).toBe(
        startEnd("100.00", "700.00"),
      );
      expect(figure(foodCard, "In")).toBe(formatMoney("1000.00", "NOK"));
      expect(figure(foodCard, "Refills")).toBe(formatMoney("1000.00", "NOK"));
      expect(figure(foodCard, "Spent")).toBe(formatMoney("400.00", "NOK"));
      // Parts that are 0 aren't listed.
      expect(figure(foodCard, "Overflow")).toBeUndefined();
      expect(within(foodCard).queryByText("Overspent")).not.toBeInTheDocument();

      const funCard = within(module).getByRole("group", { name: "Fun" });
      expect(within(funCard).getByText("Overspent")).toBeInTheDocument();
      expect(change(funCard)).toBe(formatMoney("-50.00", "NOK"));

      const [bucketsTotal, accountsTotal] = within(module).getAllByRole("group", {
        name: "Total",
      });
      if (!bucketsTotal || !accountsTotal) throw new Error("no totals");
      expect(change(bucketsTotal)).toBe(`+${formatMoney("550.00", "NOK")}`);
      expect(within(bucketsTotal).queryByRole("link")).not.toBeInTheDocument();

      // Main's uncounted transfer out is Other, so its balances add up.
      const mainCard = within(module).getByRole("group", { name: "Main" });
      expect(change(mainCard)).toBe(`+${formatMoney("27600.00", "NOK")}`);
      expect(mainCard.querySelector("[data-balances]")?.textContent).toBe(
        startEnd("1000.00", "28600.00"),
      );
      expect(figure(mainCard, "In")).toBe(formatMoney("30000.00", "NOK"));
      expect(figure(mainCard, "Out")).toBe(formatMoney("400.00", "NOK"));
      expect(figure(mainCard, "Other")).toBe(formatMoney("-2000.00", "NOK"));
      expect(within(module).getByText("Accounts")).toBeInTheDocument();
    });

    it("shows an account's net without balances, and a grid per month", async () => {
      const module = await flows({ view: "grid", show: "accounts", breakdown: "month" });
      await waitFor(() => {
        expect(within(module).getAllByTestId("breakdown-part")).toHaveLength(12);
      });
      const cards = within(module).getAllByRole("group", { name: "Main" });
      // The whole period's, then a card per month.
      expect(cards).toHaveLength(13);
      const [whole] = cards;
      if (!whole) throw new Error("no card");
      expect(change(whole)).toBe(`+${formatMoney("29600.00", "NOK")}`);
      expect(whole.querySelector("[data-balances]")).toBeNull();
      expect(figure(whole, "Other")).toBeUndefined();
      expect(within(module).queryByRole("group", { name: "Food" })).not.toBeInTheDocument();
    });

    it("adds balances to the accounts table", async () => {
      const module = await flows({ show: "accounts", balances: true });
      const table = await within(module).findByRole("table", { name: "Accounts" });
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((c) => c.textContent),
      ).toEqual(["Account", "Start", "In", "Out", "Net", "Other", "End"]);
      const cells = within(within(table).getByRole("row", { name: /Main/ }))
        .getAllByRole("cell")
        .map((c) => c.textContent);
      expect(cells).toEqual([
        "Main",
        formatMoney("1000.00", "NOK"),
        formatMoney("30000.00", "NOK"),
        formatMoney("400.00", "NOK"),
        formatMoney("29600.00", "NOK"),
        formatMoney("-2000.00", "NOK"),
        formatMoney("28600.00", "NOK"),
      ]);
    });

    it("starts a row that opened in the period with its opening", async () => {
      const opened = startAtFor(`${String(year - 1)}-07-03`);
      apiMock.on(flowsPath, (req) => {
        const answer = flowsAnswer(req);
        for (const a of answer.body.accounts) Object.assign(a, { opened_at: opened });
        return answer;
      });
      const module = await flows({ view: "grid", show: "accounts", balances: true });
      const mainCard = await within(module).findByRole("group", { name: "Main" });
      expect(mainCard.querySelector("[data-balances]")?.textContent).toBe(
        `Opened ${formatDate(opened)} with ${formatMoney("1000.00", "NOK")} → End ${formatMoney("28600.00", "NOK")}`,
      );
      // The total doesn't say it.
      const total = within(module).getByRole("group", { name: "Total" });
      expect(total.querySelector("[data-balances]")?.textContent).toBe(
        startEnd("1000.00", "28600.00"),
      );
    });

    it("notes the opening in the table", async () => {
      const opened = startAtFor(`${String(year - 1)}-07-03`);
      apiMock.on(flowsPath, (req) => {
        const answer = flowsAnswer(req);
        for (const a of answer.body.accounts) Object.assign(a, { opened_at: opened });
        return answer;
      });
      const module = await flows({ show: "accounts", balances: true });
      const table = await within(module).findByRole("table", { name: "Accounts" });
      const [name] = within(within(table).getByRole("row", { name: /Main/ })).getAllByRole("cell");
      expect(name?.textContent).toBe(`MainOpened ${formatDate(opened)}`);
    });

    it("chooses the grid and balances in the editor", async () => {
      renderRoute("/stats/reports");
      await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
      const dialog = await screen.findByRole("dialog", { name: "Add module" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "In/out/balance" }));
      await userEvent.click(within(dialog).getByRole("radio", { name: "Grid" }));
      expect(
        within(dialog).queryByRole("switch", { name: /^Show balances/ }),
      ).not.toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("radio", { name: "Both" }));
      await userEvent.click(within(dialog).getByRole("switch", { name: /^Show balances/ }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      const module = await screen.findByRole("region", { name: "In, out and balance" });
      const mainCard = await within(module).findByRole("group", { name: "Main" });
      expect(mainCard.querySelector("[data-balances]")?.textContent).toBe(
        startEnd("1000.00", "28600.00"),
      );
      expect(within(module).getByRole("group", { name: "Food" })).toBeInTheDocument();
    });
  });

  describe("budget vs spending (#126)", () => {
    const y = String(year - 1);
    // 24 of its 31 days are in last year: last year's.
    const january = cycle({
      id: "100001000101",
      start_at: startAtFor(`${String(year - 2)}-12-25`),
      end_at: endAtFor(`${y}-01-24`),
      state: "finished",
    });
    const november = cycle({
      id: "100001000102",
      start_at: startAtFor(`${y}-11-25`),
      end_at: endAtFor(`${y}-12-24`),
      state: "finished",
    });
    // 7 of its 31 days are in last year: this year's.
    const late = cycle({
      id: "100001000103",
      start_at: startAtFor(`${y}-12-25`),
      end_at: endAtFor(`${String(year)}-01-24`),
      state: "finished",
    });
    const cycles = [january, november, late];
    const figuresOf = (id: string) => `GET /api/v1/cycles/${id}/bucket-figures`;
    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent);
    const nok = (a: string) => formatMoney(a, "NOK");
    const label = (c: { id: string }) =>
      specificLabel({ kind: "specific", unit: "cycle", at: c.id }, cycles);

    beforeEach(() => {
      apiMock.on("GET /api/v1/cycles", { body: cycles });
      apiMock.on(figuresOf(january.id), {
        body: [
          bucketFigures({
            bucket_id: "1000000001",
            refills: "4000.00",
            budget: "4000.00",
            used: "3000.00",
            left: "1000.00",
          }),
          bucketFigures({
            bucket_id: "1000000002",
            refills: "1000.00",
            budget: "1000.00",
            used: "1200.00",
            left: "-200.00",
          }),
        ],
      });
      apiMock.on(figuresOf(november.id), {
        body: [
          bucketFigures({
            bucket_id: "1000000001",
            start: "1000.00",
            refills: "4000.00",
            budget: "5000.00",
            used: "2000.00",
            overflow: "500.00",
            capped: "500.00",
            left: "2500.00",
          }),
          bucketFigures({
            bucket_id: "1000000002",
            start: "-200.00",
            refills: "1000.00",
            budget: "800.00",
            left: "800.00",
          }),
        ],
      });
      apiMock.on(figuresOf(late.id), { body: [] });
    });

    it("adds a module with a summary and a table per cycle", async () => {
      renderRoute("/stats/reports");
      await userEvent.click(await screen.findByRole("button", { name: "Add module" }));
      const dialog = await screen.findByRole("dialog", { name: "Add module" });
      await userEvent.click(within(dialog).getByRole("radio", { name: "Budget vs spending" }));
      expect(within(dialog).queryByText("Breakdown")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("switch", { name: /Show each cycle/ })).toBeChecked();
      await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

      const module = await screen.findByRole("region", { name: "Budget vs spending" });
      const summary = await within(module).findByRole("table", { name: "All cycles" });
      // Food: 4000 + (5000 − 1000) put in, less 500 capped at its refill; 5000 used.
      expect(cells(within(summary).getByRole("row", { name: /Food/ }))).toEqual([
        "Food",
        nok("7500.00"),
        nok("5000.00"),
        "66%",
        nok("2500.00"),
        nok("2500.00"),
      ]);
      // Fun: the 200 overspent in January isn't more budget in November.
      expect(cells(within(summary).getByRole("row", { name: /Fun/ }))).toEqual([
        "Fun",
        nok("1800.00"),
        nok("1200.00"),
        "66%",
        nok("600.00"),
        nok("800.00"),
      ]);
      expect(cells(within(summary).getByRole("row", { name: /Total/ }))).toEqual([
        "Total",
        nok("9300.00"),
        nok("6200.00"),
        "66%",
        nok("3100.00"),
        nok("3300.00"),
      ]);
      // The cycle that starts last December is this year's.
      expect(within(module).getAllByTestId("budget-cycle")).toHaveLength(2);
      expect(within(module).queryByRole("table", { name: label(late) })).not.toBeInTheDocument();
      expect(apiMock.calls(figuresOf(late.id))).toHaveLength(0);

      const first = within(module).getByRole("table", { name: label(january) });
      const fun = within(first).getByRole("row", { name: /Fun/ });
      expect(cells(fun)).toEqual([
        "Fun",
        nok("1000.00"),
        nok("1200.00"),
        "120%",
        nok("-200.00"),
        nok("-200.00"),
      ]);
      expect(within(fun).getByRole("img", { name: "Over budget" })).toBeInTheDocument();
      expect(within(fun).getByRole("link", { name: "Fun" }).getAttribute("href")).toMatch(
        new RegExp(`from=${String(year - 2)}-12-25&to=${y}-01-24.*bucket_id=1000000002`),
      );
      // The January cycle starts the year before: shown whole, and marked.
      expect(within(module).getAllByText("Runs past the period")).toHaveLength(1);
      expect(within(module).queryByText(/don't apply/)).not.toBeInTheDocument();
    });

    it("shows a saved module's own buckets, with the report's tags noted", async () => {
      prefs = {
        ...prefs,
        report_templates: [
          template({
            period: "previous-year",
            tags: ["food"],
            modules: [{ id: "m-1", type: "budget", budget: { bucket_ids: ["1000000001"] } }],
          }),
        ],
      };
      renderRoute("/stats/reports?template=r-1");
      const module = await screen.findByRole("region", { name: "Budget vs spending" });
      const summary = await within(module).findByRole("table", { name: "All cycles" });
      expect(within(summary).getByRole("row", { name: /Food/ })).toBeInTheDocument();
      expect(within(module).queryByText("Fun")).not.toBeInTheDocument();
      expect(within(module).getByText(/don't apply/)).toBeInTheDocument();
      expect(within(module).getByText("Own buckets")).toBeInTheDocument();
    });

    it("shows only the summary when each cycle is off", async () => {
      prefs = {
        ...prefs,
        report_templates: [
          template({
            period: "previous-year",
            modules: [{ id: "m-1", type: "budget", budget: { per_cycle: false } }],
          }),
        ],
      };
      renderRoute("/stats/reports?template=r-1");
      const module = await screen.findByRole("region", { name: "Budget vs spending" });
      expect(await within(module).findByRole("table", { name: "All cycles" })).toBeInTheDocument();
      expect(within(module).queryByTestId("budget-cycle")).not.toBeInTheDocument();
    });

    it("says when no cycle has begun in the period", async () => {
      apiMock.on("GET /api/v1/cycles", { body: [] });
      prefs = {
        ...prefs,
        report_templates: [
          template({
            period: "previous-year",
            modules: [{ id: "m-1", type: "budget", budget: {} }],
          }),
        ],
      };
      renderRoute("/stats/reports?template=r-1");
      const module = await screen.findByRole("region", { name: "Budget vs spending" });
      expect(
        await within(module).findByText("No cycles have begun in this period."),
      ).toBeInTheDocument();
    });
  });

  describe("Export PDF (#127)", () => {
    const pdf = "POST /api/v1/reports/pdf";
    /** The previous month's name, e.g. "October 2026". */
    const lastMonth = () => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      const at = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      return specificLabel({ kind: "specific", unit: "month", at }, []);
    };
    let downloads: string[];
    beforeEach(() => {
      downloads = [];
      URL.createObjectURL = vi.fn(() => "blob:pdf");
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.download);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends the report on screen in this browser's language and time zone, and downloads it", async () => {
      apiMock.on(pdf, { body: "%PDF" });
      prefs = { ...prefs, report_templates: [template()] };
      renderRoute("/stats/reports?template=r-1");
      await userEvent.click(await screen.findByRole("button", { name: "Export PDF" }));
      await waitFor(() => {
        expect(downloads).toEqual([`Mine – ${lastMonth()}.pdf`]);
      });
      expect(apiMock.calls(pdf)[0]?.body).toEqual({
        name: "Mine",
        report: template().report,
        language: "en",
        locale: navigator.language,
        time_zone: "America/Los_Angeles",
      });
      expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
    });

    it("says when the server can't make PDFs", async () => {
      apiMock.on(pdf, problem(503, "pdf_unavailable", "PDF export isn't set up on this server."));
      renderRoute("/stats/reports");
      await userEvent.click(await screen.findByRole("button", { name: "Export PDF" }));
      expect(
        await screen.findByText(/PDF export isn't set up on this server, or its renderer/),
      ).toBeInTheDocument();
      expect(downloads).toEqual([]);
    });
  });
});
