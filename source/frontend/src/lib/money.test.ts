import { formatAmountInput, formatMoney, isValidAmount, parseAmount } from "./money";

// ICU uses (narrow) no-break spaces; compare with plain ones.
const plain = (s: string) => s.replace(/\s/g, " ");

describe("formatMoney", () => {
  it("formats decimal strings exactly, even beyond 2^53", () => {
    expect(plain(formatMoney("1234.50", "en-US"))).toBe("NOK 1,234.50");
    expect(plain(formatMoney("-1234.50", "en-US"))).toBe("-NOK 1,234.50");
    expect(plain(formatMoney("0.00", "en-US"))).toBe("NOK 0.00");
    expect(plain(formatMoney("12345678901234567.89", "en-US"))).toBe(
      "NOK 12,345,678,901,234,567.89",
    );
  });

  it("uses the locale's conventions", () => {
    const nb = plain(formatMoney("1234.50", "nb-NO"));
    expect(nb).toContain("1 234,50");
    expect(nb).toContain("kr");
  });
});

describe("parseAmount", () => {
  const cases: [string, string, string | null][] = [
    // input, locale decimal separator, expected
    ["1234.5", ".", "1234.50"],
    ["1234,5", ",", "1234.50"],
    ["1234,5", ".", "1234.50"], // not a valid group, so a decimal
    ["1 234,56", ",", "1234.56"],
    ["1\u00a0234,56", ",", "1234.56"],
    ["1,234.56", ".", "1234.56"],
    ["1.234,56", ",", "1234.56"],
    ["1,234", ".", "1234.00"], // grouping in an en locale
    ["1,234", ",", null], // three decimals in a nb locale
    ["1.234.567", ",", "1234567.00"],
    ["-12", ".", "-12.00"],
    ["\u221212,5", ",", "-12.50"],
    ["-0", ".", "0.00"],
    ["007.10", ".", "7.10"],
    [".5", ".", "0.50"],
    ["12.", ".", "12.00"],
    ["12345678901234567.89", ".", "12345678901234567.89"],
    ["1.234", ".", null], // three decimals
    ["1.2.3", ".", null],
    ["1,23,456", ".", null],
    ["12a", ".", null],
    ["", ".", null],
    ["-", ".", null],
    [".", ".", null],
  ];
  it.each(cases)("parses %j (decimal %j) as %j", (input, sep, want) => {
    expect(parseAmount(input, sep)).toBe(want);
  });

  it("round-trips the input format", () => {
    for (const locale of ["nb-NO", "en-US", "de-CH"]) {
      const sep = new Intl.NumberFormat(locale)
        .formatToParts(1.5)
        .find((p) => p.type === "decimal");
      expect(parseAmount(formatAmountInput("-1234567.80", locale), sep?.value)).toBe("-1234567.80");
    }
  });
});

describe("isValidAmount", () => {
  it("accepts only the canonical form", () => {
    expect(isValidAmount("1234.50")).toBe(true);
    expect(isValidAmount("-0.01")).toBe(true);
    expect(isValidAmount("1234.5")).toBe(false);
    expect(isValidAmount("1,234.50")).toBe(false);
  });
});
