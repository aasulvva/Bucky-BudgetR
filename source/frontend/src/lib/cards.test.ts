import { account, creditCard } from "@/test/fixtures";

import {
  cardChanged,
  cardDraft,
  cardFields,
  cardLine,
  cardNear,
  cardProblems,
  cardShort,
  cardsDefaultingTo,
  dayLabel,
  dayOptions,
  defaultAccountChoices,
  negate,
  withoutCards,
} from "./cards";
import { formatMoney } from "./money";

const money = (a: string) => formatMoney(a, "NOK");
const visa = (balance: string, card = creditCard()) =>
  account({ id: "9000", name: "Visa", type: "credit_card", balance, credit_card: card });

describe("credit cards (#260)", () => {
  it("names the days, with 31 as the last day", () => {
    expect(dayLabel(15)).toBe("15");
    expect(dayLabel(31)).toBe("Last day");
    const days = dayOptions();
    expect(days).toHaveLength(29);
    expect(days.at(-1)).toEqual({ value: "31", label: "Last day" });
    expect(days.map((d) => d.value)).not.toContain("29");
  });

  it("says what's owed and available, in credit, or past the limit", () => {
    expect(cardLine(visa("-4520.00"))).toBe(
      `Owed ${money("4520")} · ${money("15480")} of ${money("20000")} available`,
    );
    expect(cardLine(visa("250.00", creditCard({ owed: "0.00", available: "20250.00" })))).toBe(
      `${money("250")} in credit · ${money("20250")} of ${money("20000")} available`,
    );
    const past = visa("-20100.00", creditCard({ owed: "20100.00", available: "-100.00" }));
    expect(cardLine(past)).toBe(
      `Owed ${money("20100")} · ${money("100")} past the ${money("20000")} limit`,
    );
    expect(cardShort(past)).toBe(`${money("100")} past the limit`);
    expect(cardShort(visa("-4520.00"))).toBe(`${money("15480")} available`);
    expect(cardLine(account({ id: "1234", name: "Main" }))).toBeNull();
  });

  it("is near the limit from 90 %", () => {
    expect(cardNear(visa("-4520.00"))).toBe(false);
    expect(
      cardNear(visa("-18000.00", creditCard({ owed: "18000.00", available: "2000.00" }))),
    ).toBe(true);
    expect(
      cardNear(visa("-17999.99", creditCard({ owed: "17999.99", available: "2000.01" }))),
    ).toBe(false);
  });

  it("offers usage and savings accounts in the currency as the default account", () => {
    const main = account({ id: "1234", name: "Main" });
    const buffer = account({ id: "2345", name: "Buffer", type: "savings" });
    const fund = account({ id: "3456", name: "Fund", type: "fund" });
    const euro = account({ id: "4567", name: "Euro", currency: "EUR" });
    const card = visa("0.00");
    const all = [main, buffer, fund, euro, card];
    expect(defaultAccountChoices(all, "NOK")).toEqual([main, buffer]);
    expect(withoutCards(all)).toEqual([main, buffer, fund, euro]);
    expect(cardsDefaultingTo(all, "1234")).toEqual([card]);
    expect(cardsDefaultingTo(all, "2345")).toEqual([]);
  });

  it("turns the form's fields into the API's, and says what's missing", () => {
    const draft = cardDraft(creditCard({ default_account_id: null }));
    expect(cardProblems(draft)).toEqual({});
    expect(cardFields(draft)).toEqual({
      credit_limit: "20000.00",
      statement_day: 1,
      due_day: 15,
      minimum_payment: "300.00",
    });
    expect(cardChanged(draft, creditCard({ default_account_id: null }))).toBe(false);
    expect(
      cardChanged({ ...draft, defaultAccount: "1234" }, creditCard({ default_account_id: null })),
    ).toBe(true);
    expect(
      cardProblems({
        defaultAccount: null,
        limit: "0.00",
        statementDay: null,
        dueDay: "15",
        minimum: null,
      }),
    ).toEqual({ limit: "aboveZero", minimum: "aboveZero", statementDay: "chooseDay" });
    expect(negate("4520.00")).toBe("-4520.00");
  });
});
