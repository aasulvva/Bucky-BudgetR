import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import type { GraphSettings } from "@/lib/graphs";
import { apiMock, testUser, type MockRequest } from "@/test/api";
import { account, bucket, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

type Preferences = components["schemas"]["Preferences"];
type SavedModule = components["schemas"]["SavedModule"];

const main = account({ id: "1234", name: "Main" });
const euro = account({ id: "3456", name: "Euro", currency: "EUR" });
const food = bucket({ id: "1000000001", name: "Food", source_account_id: "1234" });

const stats = "GET /api/v1/stats/series";

/** A series of zeros but one value, over the intervals the request's resolution would give (one here). */
function answer(req: MockRequest) {
  const from = req.query.get("from") ?? "";
  const to = req.query.get("to") ?? "";
  const value = req.query.get("metric") === "income" ? "0.00" : "120.00";
  return {
    body: {
      intervals: [{ start: from, end: to }],
      series: [
        { currency: "NOK", values: [value] },
        { currency: "EUR", values: ["5.00"] },
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
  apiMock.on("GET /api/v1/accounts", { body: [main, euro] });
  apiMock.on("GET /api/v1/buckets", { body: [food] });
  apiMock.on("GET /api/v1/tags", { body: [{ name: "food", last_used_at: null }] });
  apiMock.on(stats, answer);
});

/** A graph saved on Stats, as the API stores it (#201): its period apart. */
function saved(id: string, name: string, graph: GraphSettings): SavedModule {
  const { period, ...settings } = graph;
  return { id, name, period, module: { id: "m-1", type: "graph", graph: settings } };
}

const graph: GraphSettings = {
  kind: "bar",
  metric: "spending",
  period: "current-month",
  resolution: "day",
};

const lastQuery = () => apiMock.calls(stats).at(-1)?.query;

async function pick(label: string | RegExp, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Stats", () => {
  it("shows this cycle's spending as bars, in the app's currency", async () => {
    const { router } = renderRoute("/stats");
    expect(await screen.findByRole("tab", { name: "Stats", selected: true })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMock.calls(stats)).toHaveLength(1);
    });
    const q = lastQuery();
    expect(q?.get("metric")).toBe("spending");
    expect(q?.get("group_by")).toBe("none");
    expect(q?.get("resolution")).toBe("day");
    expect(q?.get("time_zone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(q?.get("transfers")).toBeNull();
    expect(
      await screen.findByText("1 account in another currency isn't included."),
    ).toBeInTheDocument();
    expect(router.state.location.search).toBe("");
  });

  it("keeps the settings in the URL and asks for them", async () => {
    const { router } = renderRoute("/stats");
    await pick("Show", "Income");
    await waitFor(() => {
      expect(lastQuery()?.get("metric")).toBe("income");
    });
    expect(router.state.location.search).toContain("metric=income");
    expect(await screen.findByText("Nothing to show for this period.")).toBeInTheDocument();

    await pick("Split", "Per bucket");
    await waitFor(() => {
      expect(lastQuery()?.get("group_by")).toBe("bucket");
    });
    expect(screen.getByRole("textbox", { name: /Series shown/ })).toHaveValue("5");

    // One account: its transfers count, in its currency.
    await userEvent.click(screen.getByRole("combobox", { name: /Accounts/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Euro" }));
    await waitFor(() => {
      expect(lastQuery()?.getAll("account_id")).toEqual(["3456"]);
    });
    expect(lastQuery()?.get("transfers")).toBe("true");
    expect(screen.queryByText(/another currency/)).not.toBeInTheDocument();
  });

  it("draws a line stepped and fits the Y axis, kept in the URL", async () => {
    const { router } = renderRoute("/stats");
    await userEvent.click(await screen.findByRole("radio", { name: "Line" }));
    expect(screen.getByRole("radio", { name: "Straight" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Include 0" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Stepped" }));
    await userEvent.click(screen.getByRole("radio", { name: "Fit to data" }));
    expect(router.state.location.search).toContain("kind=line");
    expect(router.state.location.search).toContain("step=1");
    expect(router.state.location.search).toContain("fit=1");
    // Bars aren't stepped; the Y axis setting stays.
    await userEvent.click(screen.getByRole("radio", { name: "Bars" }));
    expect(screen.queryByRole("radio", { name: "Stepped" })).not.toBeInTheDocument();
    expect(router.state.location.search).not.toContain("step=1");
    expect(router.state.location.search).toContain("fit=1");
  });

  it("shows a specific period from the URL, named in the summary", async () => {
    viewport.width = 375;
    renderRoute("/stats?kind=bar&metric=spending&period=quarter-2025-q4&res=month");
    expect(await screen.findByTestId("graph-summary")).toHaveTextContent(
      "Spending · Q4 2025 · Month",
    );
    await waitFor(() => {
      expect(lastQuery()?.get("from")).toBe(new Date(2025, 9, 1).toISOString());
    });
    expect(lastQuery()?.get("to")).toBe(new Date(2026, 0, 1).toISOString());
  });

  it("keeps per hour for a year, but draws coarser bars and says so", async () => {
    renderRoute("/stats?kind=bar&metric=spending&period=previous-year&res=hour");
    expect(await screen.findByRole("combobox", { name: "Show per" })).toHaveValue("Hour");
    await waitFor(() => {
      expect(lastQuery()?.get("resolution")).toBe("week");
    });
    expect(
      await screen.findByText("Shown per Week: a graph shows at most 60 bars."),
    ).toBeInTheDocument();
  });

  it("offers the last few cycles and years", async () => {
    const { router } = renderRoute("/stats");
    await pick("Period", "Last");
    await pick("Unit", "Cycles");
    expect(screen.getByRole("textbox", { name: /Number of cycles/ })).toHaveValue("3");
    expect(router.state.location.search).toContain("period=last-3-cycles");
    await pick("Unit", "Years");
    expect(router.state.location.search).toContain("period=last-3-years");
    await waitFor(() => {
      expect(lastQuery()?.get("from")).toBe(
        new Date(new Date().getFullYear() - 2, 0, 1).toISOString(),
      );
    });
  });

  it("opens the settings from the URL, and a balance has no bucket filters", async () => {
    renderRoute("/stats?kind=line&metric=balance&period=previous-year&res=month&group=account");
    await waitFor(() => {
      expect(lastQuery()?.get("metric")).toBe("balance");
    });
    expect(lastQuery()?.get("group_by")).toBe("account");
    expect(lastQuery()?.get("resolution")).toBe("month");
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("Previous");
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveValue("Year");
    expect(screen.queryByRole("combobox", { name: /Buckets/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Counterparty/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Running total/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Split" }));
    expect(screen.queryByRole("option", { name: "Per bucket" })).not.toBeInTheDocument();
  });

  it("saves, changes, renames and deletes a graph", async () => {
    const { router } = renderRoute("/stats?kind=bar&metric=spending&period=current-month&res=day");
    await userEvent.click(await screen.findByRole("button", { name: "Save module…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Monthly spending");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    const graph: GraphSettings = {
      kind: "bar",
      metric: "spending",
      period: "current-month",
      resolution: "day",
    };
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body).toEqual({
        saved_modules: [saved("g-1", "Monthly spending", graph)],
      });
    });
    await waitFor(() => {
      expect(router.state.location.search).toContain("saved=g-1");
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Saved modules" })).toHaveValue(
        "Monthly spending",
      );
    });
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    // A change shows as unsaved until it's saved.
    await pick("Show", "Income");
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body).toEqual({
        saved_modules: [saved("g-1", "Monthly spending", { ...graph, metric: "income" })],
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = within(await screen.findByRole("dialog", { name: "Rename module" }));
    await userEvent.clear(rename.getByRole("textbox", { name: "Name" }));
    await userEvent.type(rename.getByRole("textbox", { name: "Name" }), "Income");
    await userEvent.click(rename.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(prefs.saved_modules?.[0]?.name).toBe("Income");
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const del = within(await screen.findByRole("dialog", { name: "Delete module" }));
    expect(del.getByText(/Delete the saved module "Income"\?/)).toBeInTheDocument();
    await userEvent.click(del.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(prefs.saved_modules).toEqual([]);
    });
    await waitFor(() => {
      expect(router.state.location.search).not.toContain("saved=");
    });
    // The settings stay on screen.
    expect(router.state.location.search).toContain("metric=income");
  });

  it("opens a saved graph", async () => {
    prefs.saved_modules = [
      saved("g-1", "Food by week", {
        kind: "line",
        metric: "spending",
        period: "last-90-days",
        resolution: "week",
        bucket_ids: [food.id],
      }),
    ];
    const { router } = renderRoute("/stats");
    await pick("Saved modules", "Food by week");
    await waitFor(() => {
      expect(lastQuery()?.getAll("bucket_id")).toEqual([food.id]);
    });
    expect(lastQuery()?.get("resolution")).toBe("week");
    expect(router.state.location.search).toContain("saved=g-1");
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("Last");
    expect(screen.getByRole("textbox", { name: /Number of days/ })).toHaveValue("90");
  });

  it("puts the settings in a drawer on mobile", async () => {
    viewport.width = 375;
    renderRoute("/stats?kind=bar&metric=spending&period=last-30-days&res=week&group=bucket");
    expect(await screen.findByTestId("graph-summary")).toHaveTextContent(
      "Spending · Last 30 days · Week · Per bucket",
    );
    expect(screen.queryByRole("combobox", { name: "Show" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Graph settings" }));
    const drawer = within(await screen.findByRole("dialog", { name: "Graph settings" }));
    expect(drawer.getByRole("combobox", { name: "Show" })).toHaveValue("Spending");
  });

  it("draws spending per bucket as a pie with a list, and opens a slice's transactions", async () => {
    apiMock.on(stats, (req) => ({
      body: {
        intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
        series: [
          { account_id: "1234", bucket_id: "1000000001", currency: "NOK", values: ["300.00"] },
          { account_id: "1234", bucket_id: null, currency: "NOK", values: ["100.00"] },
        ],
      },
    }));
    const { router } = renderRoute(
      "/stats?kind=pie&metric=spending&period=current-month&res=day&group=bucket",
    );
    const list = within(await screen.findByTestId("pie-list"));
    expect(lastQuery()?.get("resolution")).toBe("total");
    expect(lastQuery()?.get("group_by")).toBe("bucket");
    const rows = list.getAllByRole("row").map((r) => r.textContent);
    expect(rows[1]).toMatch(/^Food.*300.*75%$/);
    expect(rows[2]).toMatch(/^No bucket.*100.*25%$/);
    expect(rows[3]).toMatch(/^Total.*400/);
    // The whole period has no resolution to pick.
    expect(screen.queryByRole("combobox", { name: "Show per" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Include 0" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Slices shown/ })).toHaveValue("5");

    await userEvent.click(list.getByRole("link", { name: "Food" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/transactions");
    });
    const q = new URLSearchParams(router.state.location.search);
    expect(q.get("bucket_id")).toBe("1000000001");
    expect(q.get("type")).toBe("EXP");
  });

  it("starts a pie per bucket, and per interval asks for a resolution without Top N", async () => {
    const { router } = renderRoute("/stats");
    await userEvent.click(await screen.findByRole("radio", { name: "Pie" }));
    await waitFor(() => {
      expect(lastQuery()?.get("group_by")).toBe("bucket");
    });
    expect(lastQuery()?.get("resolution")).toBe("total");
    expect(router.state.location.search).toContain("kind=pie");

    await pick("Split", "Per interval");
    await waitFor(() => {
      expect(lastQuery()?.get("group_by")).toBe("none");
    });
    expect(lastQuery()?.get("resolution")).not.toBe("total");
    expect(screen.queryByRole("textbox", { name: /Slices shown/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Show per" }));
    expect(screen.queryByRole("option", { name: "Whole period" })).not.toBeInTheDocument();
  });

  it("keeps the previous graph, dimmed, while a changed one loads (#167)", async () => {
    let release: () => void = () => undefined;
    apiMock.on(stats, (req) => {
      const intervals = [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }];
      if (req.query.get("group_by") === "account" && req.query.get("metric") !== "balance") {
        return {
          body: {
            intervals,
            series: [{ account_id: "1234", currency: "NOK", values: ["400.00"] }],
          },
        };
      }
      if (req.query.get("metric") !== "balance") {
        // Per bucket: the lines have no account.
        return {
          body: {
            intervals,
            series: [
              { bucket_id: "1000000001", currency: "NOK", values: ["300.00"] },
              { bucket_id: null, currency: "NOK", values: ["100.00"] },
            ],
          },
        };
      }
      return new Promise((resolve) => {
        release = () => {
          resolve({
            body: {
              intervals,
              series: [{ account_id: "1234", currency: "NOK", values: ["500.00"] }],
            },
          });
        };
      });
    });
    renderRoute("/stats?kind=pie&metric=spending&period=current-month&res=day&group=bucket");
    const rows = () =>
      within(screen.getByTestId("pie-list"))
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.textContent);
    const graph = () => screen.getByTestId("pie-list").closest("[data-loading], div[aria-busy]");
    await screen.findByTestId("pie-list");
    expect(rows()).toEqual([
      expect.stringMatching(/^Food/),
      expect.stringMatching(/^No bucket/),
      expect.stringMatching(/^Total/),
    ]);

    await pick("Show", "Balance");
    await waitFor(() => {
      expect(lastQuery()?.get("metric")).toBe("balance");
    });
    // The spending pie as it was, not its bucket lines read per account.
    expect(rows()).toEqual([
      expect.stringMatching(/^Food/),
      expect.stringMatching(/^No bucket/),
      expect.stringMatching(/^Total/),
    ]);
    expect(graph()).toHaveAttribute("aria-busy", "true");

    release();
    await waitFor(() => {
      expect(rows()).toEqual([expect.stringMatching(/^Main/), expect.stringMatching(/^Total/)]);
    });
    expect(graph()).toBeNull();

    // And back (still per account, as a balance pie was): no rows left over.
    await pick("Show", "Spending");
    await waitFor(() => {
      expect(rows()).toEqual([
        expect.stringMatching(/^Main.*400/),
        expect.stringMatching(/^Total/),
      ]);
    });
  });

  it("splits spending and income per counterparty, opening exactly its transactions (#170)", async () => {
    apiMock.on(stats, (req) => ({
      body: {
        intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
        series:
          req.query.get("group_by") === "counterparty"
            ? [
                { counterparty: "Rema 1000", currency: "NOK", values: ["300.00"] },
                { counterparty: null, currency: "NOK", values: ["100.00"] },
              ]
            : [{ currency: "NOK", values: ["400.00"] }],
      },
    }));
    const { router } = renderRoute(
      "/stats?kind=pie&metric=income&period=current-month&res=day&group=bucket",
    );
    await screen.findByTestId("pie-list");
    await pick("Split", "Per counterparty");
    await waitFor(() => {
      expect(lastQuery()?.get("group_by")).toBe("counterparty");
    });
    const list = within(await screen.findByTestId("pie-list"));
    expect(await list.findByRole("link", { name: "Rema 1000" })).toBeInTheDocument();
    expect(list.getByText("No counterparty")).toBeInTheDocument();
    expect(router.state.location.search).toContain("group=counterparty");

    // Not for a balance.
    await pick("Show", "Balance");
    await userEvent.click(screen.getByRole("combobox", { name: "Split" }));
    expect(screen.queryByRole("option", { name: "Per counterparty" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await pick("Show", "Income");
    await pick("Split", "Per counterparty");

    await userEvent.click(
      await within(await screen.findByTestId("pie-list")).findByRole("link", { name: "Rema 1000" }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/transactions");
    });
    const q = new URLSearchParams(router.state.location.search);
    expect(q.get("counterparty")).toBe("Rema 1000");
    expect(q.get("type")).toBe("INC");
  });

  it("shows balances per account in a pie, leaving out those below 0", async () => {
    apiMock.on(stats, (req) => ({
      body: {
        intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
        series: [
          { account_id: "1234", currency: "NOK", values: ["500.00"] },
          { account_id: "2345", currency: "NOK", values: ["-80.00"] },
        ],
      },
    }));
    renderRoute("/stats?kind=pie&metric=balance&period=current-month&res=day");
    expect(
      await screen.findByText("1 below 0 isn't shown: a pie can't show it."),
    ).toBeInTheDocument();
    expect(lastQuery()?.get("group_by")).toBe("account");
    expect(within(screen.getByTestId("pie-list")).getByText("Main")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Split" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Per account"]);
  });

  it("puts labels on the slices instead of the list, and saves the pie", async () => {
    const { router } = renderRoute(
      "/stats?kind=pie&metric=spending&period=current-month&res=day&group=bucket",
    );
    expect(await screen.findByTestId("pie-list")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "List" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "On the slices" }));
    expect(router.state.location.search).toContain("labels=slices");
    await waitFor(() => {
      expect(screen.queryByTestId("pie-list")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("pie")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save module…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Buckets");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body).toEqual({
        saved_modules: [
          saved("g-1", "Buckets", {
            kind: "pie",
            metric: "spending",
            period: "current-month",
            resolution: "day",
            group_by: "bucket",
            pie_labels: "slices",
          }),
        ],
      });
    });
  });

  it("puts a pie's settings in the mobile drawer, summarised", async () => {
    viewport.width = 375;
    renderRoute("/stats?kind=pie&metric=spending&period=current-year&res=month");
    expect(await screen.findByTestId("graph-summary")).toHaveTextContent(
      "Spending · This year · Month",
    );
    await userEvent.click(screen.getByRole("button", { name: "Graph settings" }));
    const drawer = within(await screen.findByRole("dialog", { name: "Graph settings" }));
    expect(drawer.getByRole("combobox", { name: "Split" })).toHaveValue("Per interval");
  });

  it("adds a saved graph to the Dashboard, and warns before deleting it there", async () => {
    const graph: GraphSettings = {
      kind: "bar",
      metric: "spending",
      period: "current-month",
      resolution: "day",
    };
    prefs = { ...prefs, saved_modules: [saved("g-1", "Spending", graph)] };
    renderRoute("/stats?kind=bar&metric=spending&period=current-month&res=day&saved=g-1");
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add to dashboard…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add to the Dashboard" }));
    expect(dialog.getByRole("radio", { name: "Desktop" })).toBeChecked();
    await userEvent.click(dialog.getByRole("radio", { name: "Both" }));
    await userEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await screen.findByText('Added "Spending" to the Dashboard.')).toBeInTheDocument();
    const body = apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body as Preferences;
    const widget = {
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,40}$/) as unknown,
      type: "module",
      width: "full",
      module: { saved_module_id: "g-1" },
    };
    // Nothing was saved: the defaults, with the widget at the end of each.
    expect(body.dashboard?.widgets?.at(-1)).toEqual(widget);
    expect(body.dashboard?.widgets).toHaveLength(6);
    expect(body.dashboard?.mobile_widgets?.at(-1)).toEqual(widget);
    expect(body.dashboard?.mobile_widgets).toHaveLength(4);

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(
      await screen.findByText(
        "It's on the Dashboard in 2 widgets, which will say the module was deleted.",
      ),
    ).toBeInTheDocument();
  });
  describe("per day, week, month or cycle, and the average line (#182)", () => {
    // A whole October and November so far.
    const months = (req: MockRequest) => ({
      body: {
        intervals: [
          { start: req.query.get("from") ?? "", end: new Date(2026, 10, 1).toISOString() },
          { start: new Date(2026, 10, 1).toISOString(), end: req.query.get("to") ?? "" },
        ],
        series: [{ currency: "NOK", values: ["310.00", "100.00"] }],
      },
    });
    const params = (router: { state: { location: { search: string } } }) =>
      new URLSearchParams(router.state.location.search);

    it("shows a graph per day with an average line, kept in the URL and saved", async () => {
      apiMock.on(stats, months);
      const { router } = renderRoute(
        "/stats?kind=bar&metric=spending&period=custom-2026-10-01-2026-11-10&res=month",
      );
      await pick("Show as", "Per day");
      expect(params(router).get("per")).toBe("day");
      expect(
        await screen.findByText(/^An amount per day, week, month or cycle/),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("switch", { name: /Average line/ }));
      expect(params(router).get("avg")).toBe("1");
      // A rate counts every interval: no note.
      expect(screen.queryByText(/whole month/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Save module…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Daily");
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.at(-1)?.module).toEqual({
          id: "m-1",
          type: "graph",
          graph: {
            kind: "bar",
            metric: "spending",
            resolution: "month",
            show_as: "day",
            average: true,
          },
        });
      });

      // As totals, the average leaves out the partial month.
      await pick("Show as", "Totals");
      expect(
        await screen.findByText("The average is of 1 whole month; partial ones don't count."),
      ).toBeInTheDocument();
      expect(params(router).has("per")).toBe(false);
    });

    it("has no Show as for a balance, nor per hour, and no average with a running total", async () => {
      const { router } = renderRoute(
        "/stats?kind=line&metric=balance&period=current-month&res=day",
      );
      expect(await screen.findByRole("switch", { name: /Average line/ })).toBeEnabled();
      expect(screen.queryByRole("combobox", { name: "Show as" })).not.toBeInTheDocument();

      await router.navigate("/stats?kind=line&metric=spending&period=current-day&res=hour");
      expect(await screen.findByRole("combobox", { name: "Show as" })).toBeDisabled();
      expect(screen.getByText("Per hour shows totals.")).toBeInTheDocument();

      await router.navigate(
        "/stats?kind=line&metric=spending&period=current-month&res=day&cum=1&avg=1",
      );
      expect(await screen.findByText("Not with a running total.")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: /Average line/ })).toBeDisabled();
      expect(params(router).get("avg")).toBe("1");
    });

    it("puts the unit in the mobile summary", async () => {
      viewport.width = 375;
      renderRoute("/stats?kind=bar&metric=spending&period=current-month&res=day&per=week&avg=1");
      expect(await screen.findByTestId("graph-summary")).toHaveTextContent(
        "Spending · This month · Day · Per week · Average line",
      );
    });
  });

  describe("a graph's comparison (#204)", () => {
    const fromCalls = () => apiMock.calls(stats).map((c) => c.query.get("from"));
    const params = (router: { state: { location: { search: string } } }) =>
      new URLSearchParams(router.state.location.search);

    it("compares with the period before or last year, kept in the URL, and saves it", async () => {
      const { router } = renderRoute(
        "/stats?kind=bar&metric=spending&period=current-month&res=day",
      );
      const d = new Date();
      await userEvent.click(await screen.findByRole("radio", { name: "Both" }));
      await waitFor(() => {
        expect(fromCalls()).toContain(new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString());
      });
      expect(params(router).get("compare")).toBe("both");
      expect(params(router).has("compare_to")).toBe(false);
      expect(screen.getByTestId("graph-compared")).toHaveTextContent(/^Compared with /);

      await pick("Compare with", "The same period last year");
      await waitFor(() => {
        expect(fromCalls()).toContain(new Date(d.getFullYear() - 1, d.getMonth(), 1).toISOString());
      });
      expect(params(router).get("compare_to")).toBe("last_year");

      await userEvent.click(screen.getByRole("button", { name: "Save module…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Spending");
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.at(-1)).toEqual({
          id: expect.stringMatching(/^g-\d+$/) as unknown,
          name: "Spending",
          period: "current-month",
          compare_to: "last_year",
          module: {
            id: "m-1",
            type: "graph",
            compare: "both",
            graph: { kind: "bar", metric: "spending", resolution: "day" },
          },
        });
      });
    });

    it("compares the last 7 days with the 7 days before", async () => {
      renderRoute("/stats?kind=bar&metric=spending&period=last-7-days&res=day&compare=difference");
      const d = new Date();
      await waitFor(() => {
        expect(fromCalls()).toContain(
          new Date(d.getFullYear(), d.getMonth(), d.getDate() - 13).toISOString(),
        );
      });
      expect(await screen.findByTestId("graph-compared")).toHaveTextContent(/^This period minus /);
      expect(screen.getByRole("radio", { name: "Difference" })).toBeChecked();
    });

    it("opens a saved graph's comparison, and a change to it is unsaved", async () => {
      prefs = {
        ...prefs,
        saved_modules: [
          {
            ...saved("g-1", "Spending", graph),
            compare_to: "last_year",
            module: {
              id: "m-1",
              type: "graph",
              compare: "both",
              graph: { kind: "bar", metric: "spending", resolution: "day" },
            },
          },
        ],
      };
      const { router } = renderRoute(
        "/stats?saved=g-1&kind=bar&metric=spending&period=current-month&res=day",
      );
      expect(await screen.findByRole("radio", { name: "Both" })).toBeChecked();
      expect(screen.getByRole("combobox", { name: "Compare with" })).toHaveValue(
        "The same period last year",
      );
      expect(params(router).has("compare")).toBe(false);
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("radio", { name: "Off" }));
      expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
      expect(params(router).get("compare")).toBe("off");
      expect(screen.queryByTestId("graph-compared")).not.toBeInTheDocument();
    });

    it("has no difference for a pie, and nothing to compare custom dates with", async () => {
      const { router } = renderRoute(
        "/stats?kind=pie&metric=spending&period=current-month&res=day&group=bucket",
      );
      // Its labels' Both, and the comparison's.
      expect(await screen.findAllByRole("radio", { name: "Both" })).toHaveLength(2);
      expect(screen.queryByRole("radio", { name: "Difference" })).not.toBeInTheDocument();
      await router.navigate(
        "/stats?kind=bar&metric=spending&period=custom-2026-01-01-2026-01-31&res=day&compare=both",
      );
      expect(await screen.findByText("Custom dates don't compare.")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Both" })).toBeDisabled();
      expect(screen.getByTestId("graph-compared")).toHaveTextContent(
        "There's no period before this one to compare with.",
      );
    });

    it("puts the comparison in the mobile drawer", async () => {
      viewport.width = 375;
      renderRoute("/stats?kind=bar&metric=spending&period=current-month&res=day");
      await userEvent.click(await screen.findByRole("button", { name: "Graph settings" }));
      const drawer = within(await screen.findByRole("dialog", { name: "Graph settings" }));
      await userEvent.click(drawer.getByRole("radio", { name: "Both" }));
      expect(await screen.findByTestId("graph-compared")).toHaveTextContent(/^Compared with /);
    });
  });

  describe("saved modules other than graphs (#201)", () => {
    const list: SavedModule = {
      id: "g-2",
      name: "Food list",
      period: "previous-month",
      module: { id: "m-1", type: "transactions", transactions: { bucket_ids: [food.id] } },
    };
    const txs = "GET /api/v1/transactions";

    beforeEach(() => {
      apiMock.on(txs, {
        body: {
          items: [transaction({ id: "100000000001", counterparty: "Rema 1000" })],
          next_cursor: null,
        },
      });
    });

    it("opens over any period, the last N months too, and saves its changes", async () => {
      prefs = { ...prefs, saved_modules: [saved("g-1", "Spending", graph), list] };
      renderRoute("/stats?saved=g-2");
      const module = await screen.findByRole("region", { name: "Transactions" });
      expect(await within(module).findByText("Rema 1000")).toBeInTheDocument();
      expect(apiMock.calls(txs).at(-1)?.query.getAll("bucket_id")).toEqual([food.id]);
      expect(screen.getByRole("combobox", { name: "Saved modules" })).toHaveValue("Food list");
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

      await pick("Period", "Last");
      await pick("Unit", "Months");
      const count = screen.getByRole("textbox", { name: /Number of months/ });
      await userEvent.clear(count);
      await userEvent.type(count, "3");
      await waitFor(() => {
        const d = new Date();
        expect(apiMock.calls(txs).at(-1)?.query.get("from")).toBe(
          new Date(d.getFullYear(), d.getMonth() - 2, 1).toISOString(),
        );
      });
      expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

      // Its settings apply as they change, as a graph's do (#204).
      const panel = within(screen.getByTestId("module-settings"));
      await userEvent.click(panel.getByRole("radio", { name: "Oldest first" }));
      await waitFor(() => {
        expect(apiMock.calls(txs).at(-1)?.query.get("order")).toBe("oldest");
      });

      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.[1]).toEqual({
          ...list,
          period: "last-3-months",
          module: {
            id: "m-1",
            type: "transactions",
            transactions: { bucket_ids: [food.id], order: "oldest" },
          },
        });
      });
      await waitFor(() => {
        expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
      });
    });

    it("lists the saved modules by type, and goes back to the graph when cleared", async () => {
      prefs = { ...prefs, saved_modules: [list, saved("g-1", "Spending", graph)] };
      const { router } = renderRoute("/stats?saved=g-2");
      await screen.findByRole("region", { name: "Transactions" });
      await userEvent.click(screen.getByRole("combobox", { name: "Saved modules" }));
      const listbox = await screen.findByRole("listbox");
      expect(
        within(listbox)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Spending", "Food list"]);
      expect(within(listbox).getByText("Graph")).toBeInTheDocument();
      expect(within(listbox).getByText("Transactions")).toBeInTheDocument();
      await userEvent.click(within(listbox).getByRole("option", { name: "Spending" }));
      await waitFor(() => {
        expect(router.state.location.search).toContain("saved=g-1");
      });
      expect(await screen.findByRole("combobox", { name: "Show" })).toHaveValue("Spending");
    });

    it("keeps a graph module's comparison when its graph is saved again", async () => {
      prefs = {
        ...prefs,
        saved_modules: [
          {
            ...saved("g-1", "Spending", graph),
            compare_to: "last_year",
            module: {
              id: "m-1",
              type: "graph",
              title: "Spent",
              compare: "both",
              breakdown: "month",
              graph: { kind: "bar", metric: "spending", resolution: "day" },
            },
          },
        ],
      };
      renderRoute("/stats?kind=bar&metric=spending&period=current-month&res=day&saved=g-1");
      await pick("Show", "Income");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.[0]).toEqual({
          id: "g-1",
          name: "Spending",
          period: "current-month",
          compare_to: "last_year",
          module: {
            id: "m-1",
            type: "graph",
            title: "Spent",
            compare: "both",
            breakdown: "month",
            graph: { kind: "bar", metric: "income", resolution: "day" },
          },
        });
      });
    });

    it("makes a module of another type over the graph's period, and saves it as new (#204)", async () => {
      const { router } = renderRoute(
        "/stats?kind=bar&metric=spending&period=last-3-months&res=month",
      );
      await userEvent.click(await screen.findByRole("radio", { name: "Transactions" }));
      const module = await screen.findByRole("region", { name: "Transactions" });
      expect(await within(module).findByText("Rema 1000")).toBeInTheDocument();
      const params = () => new URLSearchParams(router.state.location.search);
      expect(params().get("type")).toBe("transactions");
      expect(params().get("period")).toBe("last-3-months");
      const d = new Date();
      expect(apiMock.calls(txs).at(-1)?.query.get("from")).toBe(
        new Date(d.getFullYear(), d.getMonth() - 2, 1).toISOString(),
      );

      const panel = within(screen.getByTestId("module-settings"));
      await userEvent.click(panel.getByRole("radio", { name: "Oldest first" }));
      await waitFor(() => {
        expect(apiMock.calls(txs).at(-1)?.query.get("order")).toBe("oldest");
      });

      await userEvent.click(screen.getByRole("button", { name: "Save module…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Food");
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.at(-1)).toEqual({
          id: expect.stringMatching(/^g-\d+$/) as unknown,
          name: "Food",
          period: "last-3-months",
          module: { id: "m-1", type: "transactions", transactions: { order: "oldest" } },
        });
      });
      await waitFor(() => {
        expect(params().get("saved")).toBe(prefs.saved_modules?.at(-1)?.id);
      });
      expect(screen.getByRole("radio", { name: "Transactions" })).toBeChecked();

      // Back to a graph, over the same period.
      await userEvent.click(screen.getByRole("radio", { name: "Graph" }));
      await waitFor(() => {
        expect(params().has("saved")).toBe(false);
      });
      expect(params().has("type")).toBe(false);
      expect(params().get("period")).toBe("last-3-months");
      expect(await screen.findByRole("combobox", { name: "Show" })).toHaveValue("Spending");
    });

    it("opens another type from the URL, and a saved one sets the type (#204)", async () => {
      apiMock.on("GET /api/v1/stats/flows", (req) => ({
        body: {
          intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
          buckets: [],
          accounts: [],
        },
      }));
      const view = renderRoute("/stats?type=flows&period=last-3-months");
      expect(await screen.findByText("Nothing happened in this period.")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "In/out/balance" })).toBeChecked();
      const d = new Date();
      expect(apiMock.calls("GET /api/v1/stats/flows").at(-1)?.query.get("from")).toBe(
        new Date(d.getFullYear(), d.getMonth() - 2, 1).toISOString(),
      );
      view.unmount();

      prefs = { ...prefs, saved_modules: [list] };
      renderRoute("/stats?type=flows&saved=g-2");
      expect(await screen.findByRole("region", { name: "Transactions" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Transactions" })).toBeChecked();
    });

    it("sets an in/out/balance module's average in place, and saves it (#220)", async () => {
      apiMock.on("GET /api/v1/stats/flows", (req) => ({
        body: {
          intervals: [{ start: req.query.get("from") ?? "", end: req.query.get("to") ?? "" }],
          buckets: [],
          accounts: [],
        },
      }));
      renderRoute("/stats?type=flows&period=last-3-months");
      const panel = within(await screen.findByTestId("module-settings"));
      await userEvent.click(panel.getByRole("radio", { name: "Per month" }));
      expect(await screen.findByTestId("flow-average")).toHaveTextContent("Average per month");
      await waitFor(() => {
        expect(
          apiMock.calls("GET /api/v1/stats/flows").map((c) => c.query.get("resolution")),
        ).toContain("month");
      });

      await userEvent.click(screen.getByRole("button", { name: "Save module…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Save module" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Monthly");
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(prefs.saved_modules?.at(-1)?.module).toEqual({
          id: "m-1",
          type: "flows",
          flows: { average: "month" },
        });
      });
    });

    it("keeps a deleted module on screen, unsaved (#204)", async () => {
      prefs = { ...prefs, saved_modules: [list] };
      const { router } = renderRoute("/stats?saved=g-2");
      const module = await screen.findByRole("region", { name: "Transactions" });
      await within(module).findByText("Rema 1000");
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Delete module" }));
      await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
      await waitFor(() => {
        expect(router.state.location.search).not.toContain("saved=");
      });
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get("type")).toBe("transactions");
      expect(params.get("period")).toBe("previous-month");
      expect(prefs.saved_modules).toEqual([]);
      // Still its own bucket filter.
      expect(await screen.findByText("Rema 1000")).toBeInTheDocument();
      expect(apiMock.calls(txs).at(-1)?.query.getAll("bucket_id")).toEqual([food.id]);
    });

    it("picks the type from a select on phones (#204)", async () => {
      viewport.width = 375;
      const { router } = renderRoute("/stats");
      expect(await screen.findByRole("combobox", { name: "Type" })).toHaveValue("Graph");
      await pick("Type", "Budget vs spending");
      await waitFor(() => {
        expect(router.state.location.search).toContain("type=budget");
      });
      expect(await screen.findByRole("region", { name: "Budget vs spending" })).toBeInTheDocument();
    });

    it("puts a module's settings in a drawer on phones, summarised (#204)", async () => {
      viewport.width = 375;
      renderRoute("/stats?type=transactions&period=last-3-months");
      expect(await screen.findByTestId("module-summary")).toHaveTextContent(
        "Transactions · Last 3 months",
      );
      expect(screen.queryByTestId("module-settings")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Module settings" }));
      const drawer = within(await screen.findByRole("dialog", { name: "Module settings" }));
      await userEvent.click(drawer.getByRole("radio", { name: "Oldest first" }));
      await waitFor(() => {
        expect(apiMock.calls(txs).at(-1)?.query.get("order")).toBe("oldest");
      });
      await userEvent.type(drawer.getByRole("textbox", { name: /Title/ }), "Food");
      expect(await screen.findByRole("region", { name: "Food" })).toBeInTheDocument();
    });

    it("saves no more than 100", async () => {
      prefs = {
        ...prefs,
        saved_modules: Array.from({ length: 100 }, (_, i) =>
          saved(`g-${String(i + 1)}`, `Graph ${String(i + 1)}`, graph),
        ),
      };
      renderRoute("/stats?saved=g-1");
      expect(
        await screen.findByText(
          "You have 100 saved modules, the most there can be. Delete one to save another.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save as new…" })).toBeDisabled();
    });
  });
});
