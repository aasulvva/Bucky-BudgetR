import {
  APP_VERSION,
  CHANGELOG,
  compareVersions,
  entriesSince,
  entryTitle,
  isFeatureUpdate,
  parseVersion,
  type ChangelogEntry,
} from "./changelog";

describe("CHANGELOG", () => {
  it("is newest first, each version one step after the one before", () => {
    for (const entry of CHANGELOG) expect(parseVersion(entry.version)).not.toBeNull();
    for (let i = 0; i + 1 < CHANGELOG.length; i++) {
      const [newer, older] = [CHANGELOG[i], CHANGELOG[i + 1]];
      if (!newer || !older) continue;
      const [a, b, c] = parseVersion(older.version) ?? [0, 0, 0];
      const next = [`v${a + 1}.00.00`, `v${a}.${pad(b + 1)}.00`, `v${a}.${pad(b)}.${pad(c + 1)}`];
      expect(next, `${newer.version} after ${older.version}`).toContain(newer.version);
      expect(newer.date >= older.date, `${newer.version} is dated before ${older.version}`).toBe(
        true,
      );
    }
    expect(APP_VERSION).toBe(CHANGELOG[0]?.version);
  });

  it("has a valid date and text in every language", () => {
    for (const entry of CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${entry.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(entry.date);
      for (const language of ["en", "nb", "nn"] as const) {
        expect(entry.title[language].trim()).not.toBe("");
        expect(entry.changes[language].length).toBeGreaterThan(0);
        // The same changes in every language.
        expect(entry.changes[language]).toHaveLength(entry.changes.en.length);
        for (const change of entry.changes[language]) expect(change.trim()).not.toBe("");
      }
    }
  });
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const entry = (version: string): ChangelogEntry => ({
  version,
  date: "2026-10-29",
  title: { en: "Title", nb: "Tittel", nn: "Tittel" },
  changes: { en: ["x"], nb: ["x"], nn: ["x"] },
});

describe("versions", () => {
  it("parses vX.YY.ZZ only", () => {
    expect(parseVersion("v1.04.00")).toEqual([1, 4, 0]);
    expect(parseVersion("v12.10.03")).toEqual([12, 10, 3]);
    expect(parseVersion("1.04.00")).toBeNull();
    expect(parseVersion("v1.4.0")).toBeNull();
  });

  it("compares them", () => {
    expect(compareVersions("v1.04.00", "v1.04.01")).toBeLessThan(0);
    expect(compareVersions("v1.10.00", "v1.09.99")).toBeGreaterThan(0);
    expect(compareVersions("v2.00.00", "v1.99.00")).toBeGreaterThan(0);
    expect(compareVersions("v1.04.00", "v1.04.00")).toBe(0);
  });

  it("titles a section with the template", () => {
    expect(entryTitle(entry("v1.04.00"), "nb")).toBe("Tittel (2026-10-29) - v1.04.00");
  });

  it("pops up for a feature or major update, not a patch", () => {
    expect(isFeatureUpdate(null, "v1.04.00")).toBe(true);
    expect(isFeatureUpdate("v1.03.00", "v1.04.00")).toBe(true);
    expect(isFeatureUpdate("v1.09.02", "v2.00.00")).toBe(true);
    expect(isFeatureUpdate("v1.04.00", "v1.04.01")).toBe(false);
    expect(isFeatureUpdate("v1.04.00", "v1.04.00")).toBe(false);
    // Seen a newer one (e.g. a rollback).
    expect(isFeatureUpdate("v1.05.00", "v1.04.00")).toBe(false);
  });

  it("lists what's newer than seen, or the newest", () => {
    const entries = ["v1.05.00", "v1.04.01", "v1.04.00", "v1.03.00"].map(entry);
    expect(entriesSince("v1.04.00", entries).map((e) => e.version)).toEqual([
      "v1.05.00",
      "v1.04.01",
    ]);
    expect(entriesSince(null, entries).map((e) => e.version)).toEqual(["v1.05.00"]);
  });
});
