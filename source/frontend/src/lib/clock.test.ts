import { now, setServerClock } from "./clock";

afterEach(() => {
  setServerClock(null);
  vi.useRealTimers();
});

describe("clock", () => {
  it("is the device's time unless the server's clock is moved", () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z") });
    expect(now().toISOString()).toBe("2026-10-27T12:00:00.000Z");

    setServerClock({
      now: "2026-12-24T18:00:00Z",
      real_now: "2026-10-27T11:59:00Z",
      mode: "running",
    });
    // The server's offset applies to the device's time: the server's real
    // time was a minute behind.
    expect(now().toISOString()).toBe("2026-12-24T18:01:00.000Z");
    vi.advanceTimersByTime(60_000);
    expect(now().toISOString()).toBe("2026-12-24T18:02:00.000Z");

    setServerClock({
      now: "2026-12-31T23:00:00Z",
      real_now: "2026-10-27T12:01:00Z",
      mode: "frozen",
    });
    vi.advanceTimersByTime(60_000);
    expect(now().toISOString()).toBe("2026-12-31T23:00:00.000Z");

    setServerClock({ now: "2026-10-27T12:02:00Z", real_now: "2026-10-27T12:02:00Z", mode: "real" });
    expect(now().toISOString()).toBe("2026-10-27T12:02:00.000Z");
  });
});
