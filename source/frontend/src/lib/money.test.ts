import {
  addAmounts,
  compareAmounts,
  currencyOptions,
  formatAmountInput,
  formatMoney,
  isValidAmount,
  multiplyAmount,
  parseAmount,
  percentOf,
  subtractAmounts,
} from "./money";

// ICU uses (narrow) no-break spaces; compare with plain ones.
const plain = (s: string) => s.replace(/\s/g, " ");

describe("formatMoney", () => {
  it("formats decimal strings exactly, even beyond 2^53", () => {
    expect(plain(formatMoney("1234.50", "NOK", "en-US"))).toBe("NOK 1,234.50");
    expect(plain(formatMoney("-1234.50", "NOK", "en-US"))).toBe("-NOK 1,234.50");
    expect(plain(formatMoney("0.00", "NOK", "en-US"))).toBe("NOK 0.00");
    expect(plain(formatMoney("12345678901234567.89", "NOK", "en-US"))).toBe(
      "NOK 12,345,678,901,234,567.89",
    );
  });

  it("uses the locale's conventions", () => {
    const nb = plain(formatMoney("1234.50", "NOK", "nb-NO"));
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

describe("amount arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(addAmounts("0.10", "0.20")).toBe("0.30");
    expect(addAmounts("12345678901234567.89", "0.11")).toBe("12345678901234568.00");
    expect(addAmounts()).toBe("0.00");
    expect(subtractAmounts("5.00", "7.25")).toBe("-2.25");
    expect(subtractAmounts("-0.05", "-0.05")).toBe("0.00");
  });

  it("takes the API's short forms", () => {
    expect(addAmounts("20000", "1.5")).toBe("20001.50");
  });

  it("compares", () => {
    expect(compareAmounts("1.00", "1")).toBe(0);
    expect(compareAmounts("-1.00", "0.00")).toBe(-1);
    expect(compareAmounts("0.01", "0.00")).toBe(1);
  });

  it("multiplies by a factor, rounding half away from zero", () => {
    expect(multiplyAmount("1500", "1.5")).toBe("2250.00");
    expect(multiplyAmount("0.05", "1.5")).toBe("0.08");
    expect(multiplyAmount("-0.05", "1.5")).toBe("-0.08");
    expect(multiplyAmount("333.33", "1")).toBe("333.33");
  });

  it("gives a percentage, rounded down", () => {
    expect(percentOf("800", "4000")).toBe(20);
    expect(percentOf("2", "3")).toBe(66);
    expect(percentOf("5000", "4000")).toBe(125);
    expect(percentOf("100", "0")).toBe(0);
  });
});

describe("formatMoney with another currency", () => {
  it("uses that currency", () => {
    expect(plain(formatMoney("10.00", "SEK", "en-US"))).toBe("SEK 10.00");
    expect(plain(formatMoney("10.00", "EUR", "en-US"))).toBe("€10.00");
  });
});

describe("currencyOptions", () => {
  it("offers currencies with at most two decimals", () => {
    const codes = currencyOptions("en").map((o) => o.value);
    expect(codes).toEqual(expect.arrayContaining(["NOK", "EUR", "USD", "JPY"]));
    expect(codes).not.toContain("KWD");
    expect(currencyOptions("en").find((o) => o.value === "NOK")?.label).toBe(
      "NOK · Norwegian Krone",
    );
  });
});
