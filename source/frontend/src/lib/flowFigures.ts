// How the In/out/balance figures (#90, #203) are laid out: side by side or
// in rows, from how wide their amounts are.

/** Side by side in large or small type, or one figure per row. */
export type Layout = "large" | "small" | "rows";
export const FONT_SIZE: Record<Layout, number> = { large: 20, small: 16, rows: 18 };
export const GAP = 16;
/** The sizes the hidden copies are measured at, for the side-by-side layouts. */
export const MEASURED = ["large", "small"] as const;

/**
 * The layout the figures fit in, from the widest amount at the large and the
 * small size and the width they share: side by side while it fits its
 * column, at the large size or else the small one, and in rows when neither
 * fits. Nothing measured (e.g. hidden) keeps the large layout.
 */
export function figuresLayout(
  widest: Record<(typeof MEASURED)[number], number>,
  width: number,
  count: number,
): Layout {
  if (widest.large === 0) return "large";
  const column = (width - GAP * (count - 1)) / count;
  if (widest.large <= column) return "large";
  return widest.small <= column ? "small" : "rows";
}
