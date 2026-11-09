// Interest registered on an account (Accounts, #21 and #70).

import type { Account } from "@/api/accounts";
import i18n from "@/i18n";

/** The tag on interest incomes; a fixed word, so it's the same in every language. */
export const INTEREST_TAG = "interest";

/** The counterparty of interest: the account's bank, else "Interest" in the user's language. */
export function interestCounterparty(account: Account): string {
  return account.bank || i18n.t("accounts.interestCounterparty");
}
