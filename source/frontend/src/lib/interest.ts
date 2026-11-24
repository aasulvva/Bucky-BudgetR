// Interest registered on an account (Accounts, #21 and #70).

import type { Account } from "@/api/accounts";
import i18n from "@/i18n";

/** The tag on interest incomes; a fixed word, so it's the same in every language. */
export const INTEREST_TAG = "interest";

/** The counterparty of interest: the account's bank, else "Interest" in the user's language. */
export function interestCounterparty(account: Account): string {
  return account.bank || i18n.t("accounts.interestCounterparty");
}

// A credit card's interest and fees (#263): expenses to the card's bank.

/** The tag on a card's fees; a fixed word, as INTEREST_TAG is. */
export const FEE_TAG = "fee";

export type ChargeTag = typeof INTEREST_TAG | typeof FEE_TAG;

/** The counterparty of a card's interest or fee: its bank, else "Interest" or "Fee". */
export function chargeCounterparty(card: Account, tag: ChargeTag): string {
  if (card.bank) return card.bank;
  return i18n.t(
    tag === FEE_TAG ? "cards.charges.feeCounterparty" : "accounts.interestCounterparty",
  );
}
