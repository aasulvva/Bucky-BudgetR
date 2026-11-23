import { within } from "@testing-library/react";

/**
 * The amount on a row of an account's breakdown (a dt and its dd), with
 * ICU's no-break spaces as plain ones, as the tests' money helpers give it.
 */
export function amountOf(list: HTMLElement, label: string): string | undefined {
  const dd = within(list).getByText(label).closest("dt")?.nextElementSibling;
  return dd?.textContent.replace(/\s/g, " ");
}
