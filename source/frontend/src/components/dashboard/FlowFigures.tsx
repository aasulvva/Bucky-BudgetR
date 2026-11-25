import { Anchor, Box, Group, Text } from "@mantine/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { FONT_SIZE, GAP, MEASURED, figuresLayout, type Layout } from "@/lib/flowFigures";

import classes from "./FlowFigures.module.css";

/** One large figure: its label, its formatted amount, and where it opens. */
export interface FlowFigureItem {
  key: string;
  label: string;
  amount: string;
  color?: string;
  /** Where it opens, labelled; without, it's text. */
  link?: { to: string; label: string };
}

/**
 * Picks the layout from hidden copies of the amounts at each size, never
 * from the amounts shown, so the layout it picks can't change what it
 * measures: Safari's text doesn't scale exactly with its font size, and
 * measuring the shown amounts made it flip between layouts near a boundary.
 * It checks again only when the width or the amounts change, not when the
 * layout changes the height.
 */
function useFiguresLayout(count: number, amounts: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("large");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let checkedWidth = -1;
    const check = (force: boolean) => {
      const width = el.clientWidth;
      if (!force && width === checkedWidth) return;
      checkedWidth = width;
      const widest = (size: (typeof MEASURED)[number]) =>
        Math.max(
          0,
          ...[...el.querySelectorAll<HTMLElement>(`[data-measure="${size}"]`)].map(
            (a) => a.getBoundingClientRect().width,
          ),
        );
      setLayout(figuresLayout({ large: widest("large"), small: widest("small") }, width, count));
    };
    check(true);
    const observer = new ResizeObserver(() => {
      check(false);
    });
    observer.observe(el);
    // The amounts' widths change once the web font has loaded.
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) check(true);
    });
    return () => {
      live = false;
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
          ? { position: "relative", display: "flex", flexDirection: "column", gap: 4 }
          : {
              position: "relative",
              display: "grid",
              gridTemplateColumns: `repeat(${String(figures.length)}, minmax(0, 1fr))`,
              gap: GAP,
            }
      }
    >
      <Box
        aria-hidden
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        {MEASURED.flatMap((size) =>
          figures.map((f) => (
            <Text
              key={`${size}-${f.key}`}
              className={classes.measure}
              data-measure={size}
              data-text={f.amount}
              fz={FONT_SIZE[size]}
              fw={700}
              style={{ display: "block", whiteSpace: "nowrap", width: "max-content" }}
            />
          )),
        )}
      </Box>
      {figures.map((f) => {
        const value = (
          <Text
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
