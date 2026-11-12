import { Anchor, Box, Group, Text } from "@mantine/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

/** One large figure: its label, its formatted amount, and where it opens. */
export interface FlowFigureItem {
  key: string;
  label: string;
  amount: string;
  color?: string;
  /** Where it opens, labelled; without, it's text. */
  link?: { to: string; label: string };
}

/** Side by side in large or small type, or one figure per row. */
type Layout = "large" | "small" | "rows";
const FONT_SIZE: Record<Layout, number> = { large: 20, small: 16, rows: 18 };
const GAP = 16;

/**
 * The layout the figures fit in: side by side while the widest amount fits
 * its column, at the large size or else the small one, and in rows when
 * neither fits. An amount's width scales with its font size, so measuring
 * it in any layout tells all three apart.
 */
function useFiguresLayout(count: number, amounts: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("large");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      // Width per pixel of font size, for the widest amount.
      const perPx = Math.max(
        0,
        ...[...el.querySelectorAll<HTMLElement>("[data-amount]")].map(
          (a) =>
            a.getBoundingClientRect().width /
            (Number.parseFloat(getComputedStyle(a).fontSize) || 1),
        ),
      );
      const column = (el.clientWidth - GAP * (count - 1)) / count;
      // Nothing measured (e.g. hidden): keep the large layout.
      const fits = (l: Layout) => perPx === 0 || perPx * FONT_SIZE[l] <= column;
      setLayout(fits("large") ? "large" : fits("small") ? "small" : "rows");
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [count, amounts]);
  return { ref, layout };
}

/**
 * Figures in large type, side by side while they fit and else one per row,
 * as the In/out/balance widget (#90) and a compact In/out/balance module
 * (#203) show them.
 */
export function FlowFigures({ figures }: { figures: FlowFigureItem[] }) {
  const { ref, layout } = useFiguresLayout(figures.length, figures.map((f) => f.amount).join("|"));
  const stacked = layout === "rows";
  return (
    <Box
      ref={ref}
      data-layout={layout}
      style={
        stacked
          ? { display: "flex", flexDirection: "column", gap: 4 }
          : {
              display: "grid",
              gridTemplateColumns: `repeat(${String(figures.length)}, minmax(0, 1fr))`,
              gap: GAP,
            }
      }
    >
      {figures.map((f) => {
        const value = (
          <Text
            data-amount
            fz={FONT_SIZE[layout]}
            fw={700}
            c={f.color}
            style={{ whiteSpace: "nowrap", width: "max-content" }}
          >
            {f.amount}
          </Text>
        );
        const body = stacked ? (
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {f.label}
            </Text>
            {value}
          </Group>
        ) : (
          <>
            <Text size="xs" c="dimmed">
              {f.label}
            </Text>
            {value}
          </>
        );
        return f.link ? (
          <Anchor
            key={f.key}
            component={Link}
            to={f.link.to}
            underline="never"
            c="var(--mantine-color-text)"
            aria-label={f.link.label}
          >
            {body}
          </Anchor>
        ) : (
          <Box key={f.key}>{body}</Box>
        );
      })}
    </Box>
  );
}
