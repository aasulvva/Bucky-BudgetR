import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import { startAtFor } from "@/lib/cycles";
import { apiMock, testUser, type MockRequest } from "@/test/api";
import { account, bucket, transaction } from "@/test/fixtures";
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
    expect(await within(module).findByRole("region", { name: /15 Oct/ })).toBeInTheDocument();
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
});
