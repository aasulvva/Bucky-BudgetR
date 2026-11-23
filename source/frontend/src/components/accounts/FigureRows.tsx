// Rows of figures on an account card on Accounts (#261, #272): a label on the
// left and its value on the right, with a progress bar and a note under it.

import { Box, Group, Progress, Stack, Text } from "@mantine/core";

const ORANGE = "var(--mantine-color-orange-text)";

export interface FigureRow {
  label: string;
  /** As shown: an amount, or "x of y". */
  value: string;
  /** The label and value in orange. */
  orange?: boolean;
  /** A bar under the row, 0–100. */
  bar?: { percent: number; label: string; orange?: boolean };
  /** Under the row on the right, dimmed: what the bar is of, e.g. the limit. */
  end?: string;
  /** Under the row, dimmed. */
  note?: string;
  /** Under the row, in orange: what's short, over or not covered. */
  warning?: string;
}

/** The rows as a description list, a line above them. */
export function FigureRows({ label, rows }: { label: string; rows: FigureRow[] }) {
  return (
    <Stack
      gap={6}
      pt="xs"
      component="dl"
      aria-label={label}
      m={0}
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
    >
      {rows.map((r) => (
        <Box key={r.label}>
          <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
            <Text component="dt" size="sm" c={r.orange ? ORANGE : "dimmed"} style={{ minWidth: 0 }}>
              {r.label}
            </Text>
            <Text
              component="dd"
              size="sm"
              m={0}
              c={r.orange ? ORANGE : undefined}
              style={{ whiteSpace: "nowrap" }}
            >
              {r.value}
            </Text>
          </Group>
          {r.bar && (
            <Progress
              value={Math.min(100, Math.max(0, r.bar.percent))}
              color={r.bar.orange ? "orange" : undefined}
              size="sm"
              mt={4}
              aria-label={r.bar.label}
            />
          )}
          {[r.note, r.warning, r.end].some(Boolean) && (
            <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start" mt={2}>
              <div style={{ minWidth: 0 }}>
                {r.note && (
                  <Text size="xs" c="dimmed">
                    {r.note}
                  </Text>
                )}
                {r.warning && (
                  <Text size="xs" c={ORANGE}>
                    {r.warning}
                  </Text>
                )}
              </div>
              {r.end && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {r.end}
                </Text>
              )}
            </Group>
          )}
        </Box>
      ))}
    </Stack>
  );
}
