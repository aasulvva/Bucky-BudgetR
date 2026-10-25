import { resolveLanguage } from "./language";

describe("resolveLanguage", () => {
  it("uses the preference first", () => {
    expect(resolveLanguage({ language: "nn", locale: "en-GB" }, ["nb-NO"])).toBe("nn");
  });

  it("follows the locale without a preference", () => {
    expect(resolveLanguage({ language: null, locale: "nb-NO" }, ["en-US"])).toBe("nb");
    expect(resolveLanguage({ locale: "nn-NO" }, [])).toBe("nn");
    // A locale in another language means English, whatever the browser says.
    expect(resolveLanguage({ locale: "de-DE" }, ["nb-NO"])).toBe("en");
  });

  it("follows the browser without a locale either", () => {
    expect(resolveLanguage({}, ["no", "en"])).toBe("nb");
    expect(resolveLanguage(undefined, ["nn-NO"])).toBe("nn");
    expect(resolveLanguage(undefined, ["fr-FR", "nb"])).toBe("nb");
    expect(resolveLanguage(undefined, ["en-US", "nb"])).toBe("en");
    expect(resolveLanguage(undefined, ["fr-FR"])).toBe("en");
  });
});
