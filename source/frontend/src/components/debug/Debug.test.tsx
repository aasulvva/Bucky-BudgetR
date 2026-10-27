import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { setServerClock } from "@/lib/clock";
import { apiMock } from "@/test/api";
import { renderWithProviders } from "@/test/render";

import { DebugButton, DebugRoot } from "./Debug";

const frozen = { now: "2026-12-24T18:00:00Z", real_now: "2026-10-27T12:00:00Z", mode: "frozen" };

function renderDebug() {
  return renderWithProviders(
    <>
      <DebugButton />
      <DebugRoot />
    </>,
  );
}

afterEach(() => {
  setServerClock(null);
});

describe("Debug settings", () => {
  it("shows nothing when the server has no debug routes", async () => {
    renderDebug();
    await vi.waitFor(() => {
      expect(apiMock.calls("GET /api/dev/clock")).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: "Debug settings" })).not.toBeInTheDocument();
  });

  it("shows the simulated time and moves the clock", async () => {
    apiMock.on("GET /api/dev/clock", { body: frozen });
    apiMock.on("PUT /api/dev/clock", (req) => {
      const { at } = req.body as { at: string | null };
      return {
        body:
          at === null ? { ...frozen, now: frozen.real_now, mode: "real" } : { ...frozen, now: at },
      };
    });
    renderDebug();

    expect(await screen.findByText(/Simulated time: .* \(frozen\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Debug settings" }));
    const drawer = within(await screen.findByRole("dialog", { name: "Debug settings" }));
    expect(drawer.getByText("Simulated, frozen")).toBeInTheDocument();

    await userEvent.click(drawer.getByRole("button", { name: "+1 day" }));
    expect(apiMock.calls("PUT /api/dev/clock").at(-1)?.body).toEqual({
      at: "2026-12-25T18:00:00.000Z",
      frozen: true,
    });

    await userEvent.click(drawer.getByRole("button", { name: "Back to real time" }));
    expect(apiMock.calls("PUT /api/dev/clock").at(-1)?.body).toEqual({ at: null, frozen: false });
  });

  it("saves and restores snapshots", async () => {
    apiMock.on("GET /api/dev/clock", { body: { ...frozen, mode: "real" } });
    const snapshot = {
      id: "7",
      name: "Before the cycle ends",
      user_id: "100001",
      username: "ola",
      own: false,
      taken_at: "2026-10-31T22:00:00Z",
      created_at: "2026-10-27T12:00:00Z",
      schema_version: 13,
      restorable: true,
      size: 2048,
    };
    apiMock.on("GET /api/dev/snapshots", { body: [snapshot] });
    apiMock.on("POST /api/dev/snapshots", { status: 201, body: snapshot });
    apiMock.on("POST /api/dev/snapshots/7/restore", { body: frozen });
    renderDebug();

    await userEvent.click(await screen.findByRole("button", { name: "Debug settings" }));
    const drawer = within(await screen.findByRole("dialog", { name: "Debug settings" }));
    await userEvent.click(drawer.getByRole("tab", { name: "Snapshots" }));

    await userEvent.type(drawer.getByLabelText("Name"), "Mid-cycle");
    await userEvent.click(drawer.getByRole("button", { name: "Save snapshot" }));
    expect(apiMock.calls("POST /api/dev/snapshots")[0]?.body).toEqual({ name: "Mid-cycle" });

    expect(await drawer.findByText("From ola")).toBeInTheDocument();
    await userEvent.click(drawer.getByRole("button", { name: "Restore" }));
    const confirm = within(
      await screen.findByRole("dialog", { name: "Restore “Before the cycle ends”?" }),
    );
    expect(
      confirm.getByText("It's ola's snapshot: you get a copy with new IDs."),
    ).toBeInTheDocument();
    await userEvent.click(confirm.getByRole("checkbox", { name: /Also set the time to/ }));
    await userEvent.click(confirm.getByRole("button", { name: "Restore" }));
    expect(apiMock.calls("POST /api/dev/snapshots/7/restore")[0]?.body).toEqual({
      set_clock: false,
    });
  });
});
