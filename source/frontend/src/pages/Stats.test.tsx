import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { components } from "@/api/schema";
import type { GraphSettings } from "@/lib/graphs";
import { apiMock, testUser, type MockRequest } from "@/test/api";
import { account, bucket } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

type Preferences = components["schemas"]["Preferences"];

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

const lastQuery = () => apiMock.calls(stats).at(-1)?.query;

async function pick(label: string | RegExp, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Stats", () => {
  it("shows this cycle's spending as bars, in the app's currency", async () => {
    const { router } = renderRoute("/stats");
    expect(await screen.findByRole("tab", { name: "Graphs", selected: true })).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Save graph…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save graph" }));
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
        saved_graphs: [{ id: "g-1", name: "Monthly spending", graph }],
      });
    });
    await waitFor(() => {
      expect(router.state.location.search).toContain("saved=g-1");
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Saved graphs" })).toHaveValue(
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
        saved_graphs: [
          { id: "g-1", name: "Monthly spending", graph: { ...graph, metric: "income" } },
        ],
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = within(await screen.findByRole("dialog", { name: "Rename graph" }));
    await userEvent.clear(rename.getByRole("textbox", { name: "Name" }));
    await userEvent.type(rename.getByRole("textbox", { name: "Name" }), "Income");
    await userEvent.click(rename.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(prefs.saved_graphs?.[0]?.name).toBe("Income");
    });

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const del = within(await screen.findByRole("dialog", { name: "Delete graph" }));
    expect(del.getByText(/Delete the saved graph "Income"\?/)).toBeInTheDocument();
    await userEvent.click(del.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(prefs.saved_graphs).toEqual([]);
    });
    await waitFor(() => {
      expect(router.state.location.search).not.toContain("saved=");
    });
    // The settings stay on screen.
    expect(router.state.location.search).toContain("metric=income");
  });

  it("opens a saved graph", async () => {
    prefs.saved_graphs = [
      {
        id: "g-1",
        name: "Food by week",
        graph: {
          kind: "line",
          metric: "spending",
          period: "last-90-days",
          resolution: "week",
          bucket_ids: [food.id],
        },
      },
    ];
    const { router } = renderRoute("/stats");
    await pick("Saved graphs", "Food by week");
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

    await userEvent.click(screen.getByRole("button", { name: "Save graph…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Save graph" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "Buckets");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences").at(-1)?.body).toEqual({
        saved_graphs: [
          {
            id: "g-1",
            name: "Buckets",
            graph: {
              kind: "pie",
              metric: "spending",
              period: "current-month",
              resolution: "day",
              group_by: "bucket",
              pie_labels: "slices",
            },
          },
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
    prefs = { ...prefs, saved_graphs: [{ id: "g-1", name: "Spending", graph }] };
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
      type: "graph",
      width: "full",
      graph: { saved_graph_id: "g-1" },
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
        "It's on the Dashboard in 2 widgets, which will say the graph was deleted.",
      ),
    ).toBeInTheDocument();
  });
});
