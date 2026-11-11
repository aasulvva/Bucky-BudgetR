import { formatLocale, setLocale } from "./locale";

afterEach(() => {
  setLocale(undefined);
  vi.restoreAllMocks();
});

describe("formatLocale (#192)", () => {
  it("is the browser's formatting locale, not its page language", () => {
    const real = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...real,
      locale: "nb-NO",
    });
    expect(navigator.language).toBe("en-US");
    expect(formatLocale()).toBe("nb-NO");
  });

  it("is the preference when there is one", () => {
    setLocale("de-DE");
    expect(formatLocale()).toBe("de-DE");
  });
});
