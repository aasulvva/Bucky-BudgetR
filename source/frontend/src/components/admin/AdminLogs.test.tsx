import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { LogEntry } from "@/api/admin";
import { apiMock, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

const me = { ...testUser, id: "100001", username: "admin", admin: true };

function entry(overrides: Partial<LogEntry> & Pick<LogEntry, "id" | "message">): LogEntry {
  return {
    at: "2026-11-09T08:00:00Z",
    level: "info",
    kind: "event",
    attrs: {},
    ...overrides,
  };
}

const started = entry({
  id: 3,
  message: "cycle started",
  event: "cycle.started",
  user_id: "100001",
  username: "admin",
  attrs: { cycle_id: "100001000002" },
});
const created = entry({
  id: 2,
  message: "user created",
  kind: "audit",
  event: "user.created",
  request_id: "REQ2",
  user_id: "100001",
  username: "admin",
  attrs: { "target.username": "kari", credential: "link" },
});
const panic = entry({
  id: 1,
  message: "panic in handler",
  level: "error",
  kind: "log",
  request_id: "REQ1",
  attrs: { panic: "boom", stack: "goroutine 1 [running]:\nmain.main()" },
});

beforeEach(() => {
  apiMock.on("GET /api/v1/me", { body: me });
  apiMock.on("GET /api/v1/admin/users", { body: [] });
  apiMock.on("GET /api/v1/admin/logs", { body: { entries: [started, created, panic] } });
  apiMock.on("GET /api/v1/admin/log-settings", {
    body: { event_days: 30, error_days: 90, audit_days: 365 },
  });
});

afterEach(() => {
  viewport.width = 1280;
});

function lastQuery() {
  const calls = apiMock.calls("GET /api/v1/admin/logs");
  return calls[calls.length - 1]?.query;
}

async function pick(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Admin logs (#93)", () => {
  it("is a tab on Admin", async () => {
    const { router } = renderRoute("/admin");
    await userEvent.click(await screen.findByRole("tab", { name: "Logs" }));
    expect(router.state.location.pathname).toBe("/admin/logs");
    expect(await screen.findByText("Cycle started")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(router.state.location.pathname).toBe("/admin");
  });

  it("lists events, admin actions and errors, with their details", async () => {
    renderRoute("/admin/logs");
    expect(await screen.findByText("Cycle started")).toBeInTheDocument();
    expect(screen.getByText("User created for kari")).toBeInTheDocument();
    expect(screen.getByText("panic in handler")).toBeInTheDocument();
    expect(screen.getByText("Admin action")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();

    const row = within(screen.getByText("panic in handler").closest("tr") as HTMLElement);
    await userEvent.click(row.getByRole("button", { name: "Show details" }));
    const details = within(screen.getByTestId("log-details"));
    expect(details.getByText("boom")).toBeInTheDocument();
    expect(details.getByText("Stack trace")).toBeInTheDocument();
    expect(details.getByText(/goroutine 1/)).toBeInTheDocument();
  });

  it("filters, keeping the filters in the URL", async () => {
    const { router } = renderRoute("/admin/logs");
    await screen.findByText("Cycle started");
    expect(lastQuery()?.toString()).toBe("");

    await pick("Show", "Warnings and errors");
    expect(lastQuery()?.get("min_level")).toBe("warn");
    expect(router.state.location.search).toBe("?show=warn");

    // A reference shows everything for its request.
    await userEvent.click(screen.getByRole("button", { name: "Show everything for request REQ2" }));
    expect(lastQuery()?.get("request_id")).toBe("REQ2");
    expect(screen.getByRole("textbox", { name: "Reference" })).toHaveValue("REQ2");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("textbox", { name: "Reference" })).toHaveValue("");
  });

  it("opens an error's reference from the URL", async () => {
    renderRoute("/admin/logs?request=REQ1");
    await screen.findByText("panic in handler");
    expect(lastQuery()?.get("request_id")).toBe("REQ1");
    expect(screen.getByRole("textbox", { name: "Reference" })).toHaveValue("REQ1");
  });

  it("loads more", async () => {
    apiMock.on("GET /api/v1/admin/logs", (req) => ({
      body: req.query.get("before")
        ? { entries: [panic] }
        : { entries: [started, created], next_before: 2 },
    }));
    renderRoute("/admin/logs");
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("panic in handler")).toBeInTheDocument();
    expect(lastQuery()?.get("before")).toBe("2");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    apiMock.on("GET /api/v1/admin/logs", { body: { entries: [] } });
    renderRoute("/admin/logs?show=error");
    expect(await screen.findByText("Nothing matches these filters.")).toBeInTheDocument();
  });

  it("sets how long entries are kept", async () => {
    apiMock.on("PUT /api/v1/admin/log-settings", (req) => ({ body: req.body }));
    renderRoute("/admin/logs");
    await userEvent.click(await screen.findByRole("button", { name: "Retention" }));
    const dialog = within(await screen.findByRole("dialog", { name: "How long entries are kept" }));
    const events = dialog.getByRole("textbox", { name: "App events" });
    await userEvent.clear(events);
    await userEvent.type(events, "14");
    await userEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Retention saved.")).toBeInTheDocument();
    expect(apiMock.calls("PUT /api/v1/admin/log-settings")[0]?.body).toEqual({
      event_days: 14,
      error_days: 90,
      audit_days: 365,
    });
  });

  it("puts the filters in a drawer on mobile", async () => {
    viewport.width = 375;
    renderRoute("/admin/logs?show=audit");
    expect(await screen.findByText("Cycle started")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Show" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filters (1)" }));
    expect(await screen.findByRole("combobox", { name: "Show" })).toHaveValue("Admin actions");
  });
});
