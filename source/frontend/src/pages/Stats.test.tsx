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

  it("has a Reports tab for later", async () => {
    const { router } = renderRoute("/stats");
    await userEvent.click(await screen.findByRole("tab", { name: "Reports" }));
    expect(router.state.location.pathname).toBe("/stats/reports");
    const link = await screen.findByRole("link", { name: "#125" });
    expect(link.parentElement).toHaveTextContent(/^Reports are coming in #125: modules/);
  });
});
