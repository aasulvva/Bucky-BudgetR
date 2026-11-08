import { useTranslation } from "react-i18next";

import { useAccounts } from "@/api/accounts";
import { useLookups } from "@/components/transactions/lookups";
import { formatMoney } from "@/lib/money";
import { scheduleTitle, type Schedule } from "@/lib/schedules";

export interface ScheduleText {
  title: string;
  /** Signed: an expense is negative. Empty without the schedule. */
  amount: string;
  income: boolean;
}

/** How a schedule's transaction reads in a row: its title and its amount. */
export function useScheduleText(): (s: Schedule | undefined) => ScheduleText {
  const { t } = useTranslation();
  const names = useLookups();
  const accounts = useAccounts().data ?? [];
  return (s) => {
    if (!s) return { title: t("schedules.queue.unknown"), amount: "", income: false };
    const tx = s.transaction;
    const currency = accounts.find((a) => a.id === tx.account_id)?.currency;
    return {
      title: scheduleTitle(s, t, names.accountName),
      amount: formatMoney(tx.type === "EXP" ? `-${tx.amount}` : tx.amount, currency),
      income: tx.type === "INC",
    };
  };
}
