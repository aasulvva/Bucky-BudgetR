import { Badge, Indicator, VisuallyHidden } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useQueueCount } from "@/api/schedules";

/** What a screen reader hears for the count. */
function useCountText(): { count: number; overdue: boolean; text: string } {
  const { t } = useTranslation();
  const { count, overdue } = useQueueCount();
  const text = t(overdue ? "schedules.queue.countOverdue" : "schedules.queue.count", { count });
  return { count, overdue, text };
}

/**
 * How many scheduled transactions wait for approval (#155), red when one is
 * overdue; nothing while none wait.
 */
export function QueueBadge() {
  const { count, overdue, text } = useCountText();
  if (count === 0) return null;
  return (
    <Badge size="sm" circle={count < 10} color={overdue ? "red" : "blue"} data-testid="queue-badge">
      <span aria-hidden>{count}</span>
      <VisuallyHidden> {text}</VisuallyHidden>
    </Badge>
  );
}

/** The count as a dot with a number on an icon: the mobile bottom tab's. */
export function QueueIndicator({ children }: { children: ReactNode }) {
  const { count, overdue, text } = useCountText();
  return (
    <Indicator
      label={<span aria-hidden>{count}</span>}
      size={16}
      color={overdue ? "red" : "blue"}
      disabled={count === 0}
      offset={2}
    >
      {children}
      {count > 0 && <VisuallyHidden>{text} </VisuallyHidden>}
    </Indicator>
  );
}
