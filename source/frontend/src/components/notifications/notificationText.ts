import { useTranslation } from "react-i18next";

import type { Notification } from "@/api/notifications";
import { useSchedules } from "@/api/schedules";
import { useScheduleText } from "@/components/schedules/scheduleText";
import { useLookups } from "@/components/transactions/lookups";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

export interface NotificationText {
  title: string;
  body: string;
  /** Where Open goes, and its label. */
  link: string;
  open: string;
  /** Marks a task done ("the balance is right") rather than dismissing it. */
  done: boolean;
}

/** Where an investment account's notification opens: its Adjust balance. */
export function adjustPath(accountId: string): string {
  return `/accounts?adjust=${encodeURIComponent(accountId)}`;
}

/** How each notification reads, from its kind and fields (#57). */
export function useNotificationText(): (n: Notification) => NotificationText {
  const { t } = useTranslation();
  const names = useLookups();
  const schedules = useSchedules().data ?? [];
  const scheduleText = useScheduleText();
  return (n) => {
    const base = { done: false };
    switch (n.kind) {
      case "approval_queue": {
        const count = n.count ?? 0;
        const overdue = n.overdue ?? 0;
        return {
          ...base,
          title: t("notifications.queue.title", { count }),
          body:
            overdue > 0
              ? t("notifications.queue.overdue", { count: overdue })
              : t("notifications.queue.body"),
          link: "/transactions/scheduled",
          open: t("notifications.queue.open"),
        };
      }
      case "upcoming_bill": {
        const schedule = schedules.find((s) => s.id === n.schedule_id);
        const transfer = schedule?.transaction.type === "TRF";
        return {
          ...base,
          title: scheduleText(schedule).title,
          body: [
            t("notifications.bill.when", {
              amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
              date: n.at ? formatDateTime(n.at) : "",
            }),
            t(transfer ? "notifications.bill.transferHint" : "notifications.bill.expenseHint"),
          ].join(" "),
          link: "/transactions/scheduled",
          open: t("notifications.bill.open"),
        };
      }
      case "investment_balance": {
        const account = n.account_id ?? "";
        return {
          title: t("notifications.balance.title", { name: names.accountName(account) }),
          body: t("notifications.balance.body", { date: n.at ? formatDateTime(n.at) : "" }),
          link: adjustPath(account),
          open: t("notifications.balance.open"),
          done: true,
        };
      }
      case "bucket_uncovered":
        return {
          ...base,
          title: t("notifications.bucket.title", { name: names.bucketName(n.bucket_id ?? "") }),
          body: t("notifications.bucket.body", {
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
          }),
          link: "/buckets",
          open: t("notifications.bucket.open"),
        };
    }
  };
}
