import { act, screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";

import { figuresLayout } from "@/lib/flowFigures";

import { FlowFigures } from "./FlowFigures";

describe("figuresLayout", () => {
  // Three columns 16px apart: a 450px width gives 139.33px columns.
  it("puts the figures side by side in large type while the widest fits its column", () => {
    expect(figuresLayout({ large: 139, small: 112 }, 450, 3)).toBe("large");
  });

  it("goes small, then to rows, as the column narrows", () => {
    expect(figuresLayout({ large: 150, small: 120 }, 450, 3)).toBe("small");
    expect(figuresLayout({ large: 150, small: 120 }, 300, 3)).toBe("rows");
  });

  it("keeps the large layout when nothing was measured", () => {
    expect(figuresLayout({ large: 0, small: 0 }, 0, 3)).toBe("large");
  });
});

describe("FlowFigures", () => {
  const figures = [
    { key: "in", label: "Income", amount: "kr 20 100,00" },
    { key: "out", label: "Expenses", amount: "kr 8 000,00" },
    { key: "net", label: "Net", amount: "+kr 12 100,00" },
  ];

  it("measures hidden copies, and checks again only when the width changes", async () => {
    // jsdom has no layout: the hidden copies are 150px wide at the large
    // size and 120px at the small one; anything else measured would be 999.
    let width = 450;
    const measured: Record<string, number> = { large: 150, small: 120 };
    let resized: (() => void) | undefined;
    const Observer = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    } as unknown as typeof ResizeObserver;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return { width: measured[this.dataset.measure ?? ""] ?? 999 } as DOMRect;
      });
    const client = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => width);
    try {
      const { container } = renderWithProviders(<FlowFigures figures={figures} />);
      // Once the fonts have loaded.
      await act(async () => {
        await document.fonts.ready;
      });
      const box = container.querySelector(
        "[data-layout=large], [data-layout=small], [data-layout=rows]",
      );
      expect(box).toHaveAttribute("data-layout", "small");
      expect(screen.getByText("Income")).toBeInTheDocument();

      // A resize of the height only (the width is the same): no new check.
      measured.small = 200;
      act(() => resized?.());
      expect(box).toHaveAttribute("data-layout", "small");

      // A new width checks again.
      width = 1000;
      act(() => resized?.());
      expect(box).toHaveAttribute("data-layout", "large");
    } finally {
      rect.mockRestore();
      client.mockRestore();
      window.ResizeObserver = Observer;
    }
  });
});
