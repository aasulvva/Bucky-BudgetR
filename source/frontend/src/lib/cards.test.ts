import type { Account } from "@/api/accounts";
import { account, creditCard } from "@/test/fixtures";

import {
  billState,
  cardChanged,
  cardDraft,
  cardFields,
  cardLine,
  cardNear,
  cardProblems,
  cardRow,
  cardShort,
  cardsDefaultingTo,
  dayLabel,
  dayOptions,
  EMPTY_CARD,
  defaultAccountChoices,
  negate,
  payAmount,
  payDay,
  releaseProblem,
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
      pay: { rule: "full", amount: null, days_before: 0, mode: "approve", auto_finalize: false },
    });
    expect(cardChanged(draft, creditCard({ default_account_id: null }))).toBe(false);
    expect(
      cardChanged({ ...draft, defaultAccount: "1234" }, creditCard({ default_account_id: null })),
    ).toBe(true);
    expect(
      cardProblems({
        ...EMPTY_CARD,
        limit: "0.00",
        dueDay: "15",
      }),
    ).toEqual({ limit: "aboveZero", minimum: "aboveZero", statementDay: "chooseDay" });
    expect(
      cardProblems({
        ...draft,
        payRule: "fixed",
        payAmount: null,
        autoFinalize: true,
        defaultAccount: null,
      }),
    ).toEqual({ payAmount: "aboveZero", autoFinalize: "needsDefault" });
    expect(negate("4520.00")).toBe("-4520.00");
  });

  describe("bills (#262)", () => {
    const statement = {
      id: "900020261201",
      statement_date: "2026-12-01",
      cutoff: "2026-11-30T23:00:00Z",
      due_date: "2026-12-15",
      amount: "4520.00",
      minimum: "300.00",
      paid: "0.00",
      left: "4520.00",
      minimum_left: "300.00",
      fixed: false,
      fixed_by: null,
      fixed_at: null,
    } as const;
    const card = (bill: Partial<NonNullable<Account["credit_card"]>["bill"]> = {}) =>
      account({
        id: "9000",
        name: "Visa",
        type: "credit_card",
        balance: "-4520.00",
        credit_card: creditCard({
          bill: {
            set_up: true,
            current: statement,
            previous: null,
            next_statement_date: "2027-01-01",
            payment: null,
            ...bill,
          },
        }),
      });
    const on = (day: string) => new Date(`${day}T12:00:00`);

    it("says where the bill stands", () => {
      expect(billState(account({ id: "1", name: "Main" }), 3)).toBeNull();
      expect(billState(card({ set_up: false }), 3, on("2026-12-05"))).toBe("locked");
      expect(billState(card({ current: null }), 3, on("2026-12-05"))).toBe("none");
      expect(billState(card(), 3, on("2026-12-05"))).toBe("open");
      expect(billState(card(), 3, on("2026-12-12"))).toBe("soon");
      expect(billState(card(), 3, on("2026-12-15"))).toBe("soon");
      expect(billState(card(), 3, on("2026-12-16"))).toBe("past");
      // With the minimum paid, what's left carries over: not past due.
      const minimumPaid = card({
        current: { ...statement, paid: "300.00", left: "4220.00", minimum_left: "0.00" },
      });
      expect(billState(minimumPaid, 3, on("2026-12-14"))).toBe("soon");
      expect(billState(minimumPaid, 3, on("2026-12-16"))).toBe("carried");
      expect(cardRow(minimumPaid, 3, on("2026-12-16"))?.color).toBeUndefined();
      const paid = card({
        current: { ...statement, paid: "4520.00", left: "0.00", minimum_left: "0.00" },
      });
      expect(billState(paid, 3, on("2026-12-16"))).toBe("paid");
      const scheduled = card({
        payment: {
          schedule_id: "1",
          rule: "full",
          amount: "4520.00",
          account_id: "1234",
          at: "2026-12-15T07:00:00Z",
          mode: "auto",
          state: "scheduled",
          reason: null,
        },
      });
      expect(billState(scheduled, 3, on("2026-12-14"))).toBe("scheduled");
      // Past due wins: a payment that hasn't come by then is late.
      expect(billState(scheduled, 3, on("2026-12-16"))).toBe("past");
    });

    it("works out what a payment pays, as the server does", () => {
      expect(payAmount("full", "4520.00", "300.00", null)).toBe("4520.00");
      expect(payAmount("minimum", "4520.00", "300.00", null)).toBe("300.00");
      expect(payAmount("fixed", "4520.00", "300.00", "1000.00")).toBe("1000.00");
      expect(payAmount("fixed", "200.00", "0.00", "1000.00")).toBe("200.00");
      expect(
        payDay(
          creditCard({
            pay: { rule: "full", amount: null, days_before: 3, mode: "auto", auto_finalize: false },
          }),
          "2026-12-01",
        ),
      ).toBe("2026-11-28");
    });

    it("says a card's line: the bill when it needs you, else what's available", () => {
      const money = (a: string) => formatMoney(a, "NOK");
      expect(cardRow(card(), 3, on("2026-12-05"))).toEqual({
        text: `${money("15480")} available`,
        color: undefined,
      });
      expect(cardRow(card(), 3, on("2026-12-13"))?.color).toBe("var(--mantine-color-orange-text)");
      expect(cardRow(card(), 3, on("2026-12-16"))).toEqual({
        text: `Bill ${money("4520")} past due`,
        color: "var(--mantine-color-red-text)",
      });
      expect(cardRow(card({ set_up: false }), 3)?.text).toBe("Set up bill");
    });

    it("checks what a payment releases on other accounts", () => {
      const visa = card();
      const buffer = account({
        id: "2345",
        name: "Buffer",
        card_holds: [{ card_id: "9000", amount: "500.00" }],
      });
      expect(releaseProblem(visa, [buffer], { "2345": "400.00" }, "1000.00")).toBeUndefined();
      expect(releaseProblem(visa, [buffer], { "2345": "600.00" }, "1000.00")).toMatch(/Buffer/);
      expect(releaseProblem(visa, [buffer], { "2345": "400.00" }, "300.00")).toBeDefined();
    });
  });
});
