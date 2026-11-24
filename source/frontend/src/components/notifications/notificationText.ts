import { useTranslation } from "react-i18next";

import type { Notification } from "@/api/notifications";
import { useSavingsTargets } from "@/api/savings";
import { useSchedules } from "@/api/schedules";
import { useScheduleText } from "@/components/schedules/scheduleText";
import { useLookups } from "@/components/transactions/lookups";
import { formatDate, formatDateTime } from "@/lib/dates";
import { compareAmounts, formatMoney } from "@/lib/money";

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

/** Where a card's interest reminder opens: its Interest and fees (#263). */
export function interestPath(cardId: string): string {
  return `/accounts?interest=${encodeURIComponent(cardId)}`;
}

/** Where a card bill's notification opens: the card's Bill panel (#262). */
export function billPath(cardId: string): string {
  return `/accounts?bill=${encodeURIComponent(cardId)}`;
}

/** How each notification reads, from its kind and fields (#57). */
export function useNotificationText(): (n: Notification) => NotificationText {
  const { t } = useTranslation();
  const names = useLookups();
  const schedules = useSchedules().data ?? [];
  const targets = useSavingsTargets().data ?? [];
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
      case "savings_transfer": {
        const target = targets.find((x) => x.id === n.target_id);
        return {
          ...base,
          title: t("notifications.savings.title", {
            name: target?.name ?? `#${n.target_id ?? ""}`,
          }),
          body: t(
            target?.account_id === null
              ? "notifications.savings.bodyBucket"
              : "notifications.savings.body",
            { amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "" },
          ),
          link: "/savings",
          open: t("notifications.savings.open"),
        };
      }
      case "savings_short": {
        const target = targets.find((x) => x.id === n.target_id);
        return {
          ...base,
          title: n.target_id
            ? t("notifications.savingsShort.title", { name: target?.name ?? `#${n.target_id}` })
            : t("notifications.savingsShort.titleDistributor"),
          body: t("notifications.savingsShort.body", {
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
            account: names.accountName(n.account_id ?? ""),
          }),
          link: "/savings",
          open: t("notifications.savings.open"),
        };
      }
      case "bsu_over_limit":
      case "bsu_withdrawal": {
        const over = n.kind === "bsu_over_limit";
        return {
          ...base,
          title: t(over ? "notifications.bsu.overTitle" : "notifications.bsu.withdrawalTitle", {
            name: names.accountName(n.account_id ?? ""),
          }),
          body: t(over ? "notifications.bsu.overBody" : "notifications.bsu.withdrawalBody", {
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
            date: n.at ? formatDateTime(n.at) : "",
          }),
          link: "/accounts",
          open: t("notifications.bsu.open"),
        };
      }
      case "credit_limit": {
        const over = n.severity === "alert";
        return {
          ...base,
          title: t(over ? "notifications.card.overTitle" : "notifications.card.nearTitle", {
            name: names.accountName(n.account_id ?? ""),
          }),
          body: t(over ? "notifications.card.overBody" : "notifications.card.nearBody", {
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
          }),
          link: "/accounts",
          open: t("notifications.card.open"),
        };
      }
      case "card_bill":
      case "card_bill_due":
      case "card_bill_carried": {
        const money = (a: string | null) => (a ? formatMoney(a, n.currency ?? undefined) : "");
        const vars = {
          name: names.accountName(n.account_id ?? ""),
          amount: money(n.amount),
          minimum: money(n.minimum),
          date: n.at ? formatDate(n.at) : "",
        };
        const minimumLeft = n.minimum !== null && compareAmounts(n.minimum, "0") > 0;
        const key = {
          card_bill: "ready",
          card_bill_due: "due",
          card_bill_carried: "carried",
        } as const;
        const k = key[n.kind];
        return {
          ...base,
          // Carried over with the minimum left is past due.
          title: t(
            k === "carried" && minimumLeft
              ? "notifications.cardBill.pastDueTitle"
              : `notifications.cardBill.${k}Title`,
            vars,
          ),
          body: t(
            minimumLeft
              ? `notifications.cardBill.${k}Body`
              : `notifications.cardBill.${k}BodyMinimumPaid`,
            vars,
          ),
          link: billPath(n.account_id ?? ""),
          open: t("notifications.cardBill.open"),
        };
      }
      case "card_interest":
        return {
          ...base,
          title: t("notifications.cardInterest.title", {
            name: names.accountName(n.account_id ?? ""),
          }),
          body: t("notifications.cardInterest.body", {
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
            date: n.at ? formatDate(n.at) : "",
          }),
          link: interestPath(n.account_id ?? ""),
          open: t("notifications.cardInterest.open"),
        };
      case "bucket_charge":
        return {
          ...base,
          title: t("notifications.bucketCharge.title", {
            bucket: names.bucketName(n.bucket_id ?? ""),
            amount: n.amount ? formatMoney(n.amount, n.currency ?? undefined) : "",
          }),
          body: t("notifications.bucketCharge.body", { counterparty: n.counterparty ?? "" }),
          link: `/transactions?bucket_id=${encodeURIComponent(n.bucket_id ?? "")}&cycle_id=${encodeURIComponent(n.cycle_id ?? "")}&system=1`,
          open: t("notifications.bucketCharge.open"),
        };
    }
  };
}
