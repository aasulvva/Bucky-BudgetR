import {
  activeFilters,
  DEFAULT_LOG_FILTERS,
  eventKey,
  filtersFromSearch,
  filtersToSearch,
  logQuery,
} from "./logs";

describe("log filters", () => {
  it("round-trip through the URL, leaving out the defaults", () => {
    const f = {
      show: "audit" as const,
      period: "custom" as const,
      from: "2026-11-01T00:00:00.000Z",
      to: null,
      user: "100002",
      request: "abc-1",
      q: " boom ",
    };
    const search = filtersToSearch(f);
    expect(search.toString()).toBe(
      "show=audit&period=custom&from=2026-11-01T00%3A00%3A00.000Z&user=100002&request=abc-1&q=boom",
    );
    expect(filtersFromSearch(search)).toEqual({ ...f, q: "boom" });
    expect(filtersToSearch(DEFAULT_LOG_FILTERS).toString()).toBe("");
  });

  it("ignore what they don't know", () => {
    expect(filtersFromSearch(new URLSearchParams("show=nope&period=year&request=a b"))).toEqual(
      DEFAULT_LOG_FILTERS,
    );
  });

  it("ask the API for what they show", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(logQuery(DEFAULT_LOG_FILTERS, now)).toEqual({});
    expect(logQuery({ ...DEFAULT_LOG_FILTERS, show: "warn", period: "week" }, now)).toEqual({
      min_level: "warn",
      from: "2026-11-02T12:00:00.000Z",
    });
    expect(
      logQuery(
        { ...DEFAULT_LOG_FILTERS, show: "event", period: "custom", to: "2026-11-05T00:00:00Z" },
        now,
      ),
    ).toEqual({ kind: "event", to: "2026-11-05T00:00:00Z" });
    expect(
      logQuery({ ...DEFAULT_LOG_FILTERS, user: "100001", request: "r1", q: "x" }, now),
    ).toEqual({ user_id: "100001", request_id: "r1", q: "x" });
  });

  it("count the filters in use", () => {
    expect(activeFilters(DEFAULT_LOG_FILTERS)).toBe(0);
    expect(activeFilters({ ...DEFAULT_LOG_FILTERS, show: "error", q: "boom" })).toBe(2);
  });

  it("name the events they know", () => {
    expect(eventKey("cycle.started")).toBe("cycle_started");
    expect(eventKey("user.admin_granted")).toBe("user_admin_granted");
    expect(eventKey("something.new")).toBeNull();
    expect(eventKey(undefined)).toBeNull();
  });
});
