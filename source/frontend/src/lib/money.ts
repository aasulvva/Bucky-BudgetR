// Amounts travel as decimal strings ("-1234.50") and are never converted to
// floats. Intl.NumberFormat formats such strings exactly.

import { CURRENCY, getLocale } from "./locale";

/** A canonical API amount: optional minus, digits, exactly two decimals. */
const CANONICAL = /^-?\d+\.\d{2}$/;

type Decimal = `${number}`;

export function isValidAmount(value: string): boolean {
  return CANONICAL.test(value);
}

/** Formats an amount with the currency, e.g. "kr 1 234,50" or "NOK 1,234.50". */
export function formatMoney(amount: string, currency = CURRENCY, locale = getLocale()): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount as Decimal);
}

/** Formats an amount for editing: grouped, two decimals, no currency. */
export function formatAmountInput(amount: string, locale = getLocale()): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount as Decimal);
}

/** The currency symbol as the locale writes it, e.g. "kr" or "NOK". */
export function currencySymbol(currency = CURRENCY, locale = getLocale()): string {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}

/** The locale's decimal separator, e.g. "," for nb-NO. */
export function decimalSeparator(locale = getLocale()): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Parses what a user typed into a canonical amount ("1234.50"), or returns
 * null if it isn't a valid amount with at most two decimals.
 *
 * Accepts "." and "," as either decimal or grouping separator, and spaces or
 * apostrophes as grouping. If both "." and "," occur, the last one is the
 * decimal separator. A single separator counts as decimal if it is the
 * locale's decimal separator or isn't followed by exactly three digits.
 */
export function parseAmount(input: string, decimalSep = decimalSeparator()): string | null {
  let s = input.trim().replace(/[\s\u00a0\u202f']/g, "");
  let negative = false;
  if (/^[-\u2212]/.test(s)) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const at = Math.max(lastDot, lastComma);
    const single = s.indexOf(sep) === at;
    if (single && (sep === decimalSep || s.length - at - 1 !== 3)) decimalAt = at;
  }

  const intPart = decimalAt >= 0 ? s.slice(0, decimalAt) : s;
  const fracPart = decimalAt >= 0 ? s.slice(decimalAt + 1) : "";
  if (!isGrouped(intPart) || !/^\d{0,2}$/.test(fracPart)) return null;

  const digits = intPart.replace(/[.,]/g, "").replace(/^0+(?=\d)/, "") || "0";
  const cents = fracPart.padEnd(2, "0");
  const isZero = /^0+$/.test(digits + cents);
  return `${negative && !isZero ? "-" : ""}${digits}.${cents}`;
}

/** Plain digits, or digits grouped in threes by one kind of separator. */
function isGrouped(s: string): boolean {
  if (/^\d*$/.test(s)) return true;
  return /^\d{1,3}([.,]\d{3})+$/.test(s) && !(s.includes(".") && s.includes(","));
}

/** An amount in cents. Only valid amounts (see isValidAmount) are accepted. */
function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`not a canonical amount: ${amount}`);
  const cents = BigInt(`${m[2] ?? ""}${m[3] ?? ""}`);
  return m[1] === "-" ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
  return `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/**
 * The API sends amounts with up to two decimals ("20000", "1.5"); this makes
 * them canonical ("20000.00", "1.50") so they can be added up.
 */
export function canonicalAmount(amount: string): string {
  return parseAmount(amount, ".") ?? amount;
}

/** The sum of amounts, exactly. */
export function addAmounts(...amounts: string[]): string {
  return fromCents(amounts.reduce((sum, a) => sum + toCents(canonicalAmount(a)), 0n));
}

/** a − b, exactly. */
export function subtractAmounts(a: string, b: string): string {
  return fromCents(toCents(canonicalAmount(a)) - toCents(canonicalAmount(b)));
}

/** Compares two amounts: negative, 0 or positive, as a is less, equal or more. */
export function compareAmounts(a: string, b: string): number {
  const d = toCents(canonicalAmount(a)) - toCents(canonicalAmount(b));
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/**
 * Currencies to offer for a new account: ISO 4217 codes with at most two
 * decimals, as the API accepts (spec §2), with their names.
 */
export function currencyOptions(locale = getLocale()): { value: string; label: string }[] {
  const names = new Intl.DisplayNames(locale, { type: "currency" });
  return Intl.supportedValuesOf("currency")
    .filter(
      (code) =>
        (new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2) <= 2,
    )
    .map((code) => ({ value: code, label: `${code} · ${names.of(code) ?? code}` }));
}
