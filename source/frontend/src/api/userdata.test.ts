import { exportFileName, parseExport } from "./userdata";

const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    app: "bucky-budgetr",
    format: 1,
    user_id: "u1",
    username: "kari",
    exported_at: "2026-11-09T10:00:00Z",
    data: {
      tables: {
        bank_accounts: [{ id: "a1" }, { id: "a2", deleted: true }],
        buckets: [{ id: "b1", deleted: false }],
        cycles: [{ id: "c1" }, { id: "c2" }],
        transaction_headers: [
          { id: "t1", parent_id: null },
          { id: "t2", parent_id: "t1" },
          { id: "t3" },
        ],
      },
    },
    ...over,
  });

describe("parseExport", () => {
  it("sums up the file as the server counts it", () => {
    expect(parseExport(file())).toEqual({
      ok: true,
      preview: {
        userId: "u1",
        username: "kari",
        exportedAt: "2026-11-09T10:00:00Z",
        accounts: 1,
        buckets: 1,
        cycles: 2,
        transactions: 2,
        schedules: 0,
      },
    });
  });

  it("refuses what isn't an export, or is from a newer app", () => {
    for (const text of [
      "not json",
      "[1]",
      file({ app: "other" }),
      file({ format: "1" }),
      file({ data: null }),
    ]) {
      expect(parseExport(text)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(parseExport(file({ format: 2 }))).toEqual({ ok: false, reason: "newer" });
  });
});

describe("exportFileName", () => {
  it("names the file by user and local day", () => {
    expect(exportFileName("kari", new Date(2026, 0, 5, 23, 59))).toBe(
      "bucky-budgetr-kari-2026-01-05.json",
    );
  });
});
