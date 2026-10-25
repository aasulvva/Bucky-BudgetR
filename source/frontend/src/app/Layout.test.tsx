import { screen, within } from "@testing-library/react";

import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

import { findNav, navItems, navTabs } from "./nav";

afterEach(() => {
  viewport.width = 1280;
});

describe("routes", () => {
  it.each(navItems.filter((i) => i.path !== "/settings"))(
    "$path shows its placeholder",
    async (item) => {
      renderRoute(item.path);
      expect(
        await screen.findByRole("heading", { level: 2, name: item.label }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: `#${item.issue}` })).toBeInTheDocument();
    },
  );

  it("shows not found for unknown paths", async () => {
    renderRoute("/nope");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});

describe("desktop layout", () => {
  it("lists every screen in the side menu", async () => {
    renderRoute("/accounts");
    const nav = await screen.findByRole("navigation");
    for (const item of navItems) {
      expect(within(nav).getByRole("link", { name: item.label })).toHaveAttribute(
        "href",
        item.path,
      );
    }
    expect(within(nav).getByRole("link", { name: "Accounts" })).toHaveAttribute("data-active");
  });
});

describe("mobile layout", () => {
  beforeEach(() => {
    viewport.width = 390;
  });

  it("shows the bottom tabs and the sub-menu of the current tab", async () => {
    renderRoute("/buckets");
    await screen.findByRole("heading", { level: 2, name: "Buckets" });

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const footer = screen.getByRole("contentinfo");
    for (const tab of navTabs.filter((t) => !t.action)) {
      expect(
        within(footer).getByRole("link", { name: tab.shortLabel ?? tab.label }),
      ).toBeInTheDocument();
    }
    expect(within(footer).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(footer).getByRole("link", { name: "New transaction" })).toHaveAttribute(
      "href",
      "/transactions/new",
    );

    // Overview holds three screens, so it gets a sub-menu.
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("has no sub-menu for single-screen tabs", async () => {
    renderRoute("/transactions");
    await screen.findByRole("heading", { level: 2, name: "Transactions" });
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });
});

describe("findNav", () => {
  it("picks the most specific item", () => {
    expect(findNav("/")?.item.label).toBe("Dashboard");
    expect(findNav("/accounts/1234")?.item.label).toBe("Accounts");
    expect(findNav("/accounts/setup")?.item.label).toBe("Account setup");
    expect(findNav("/transactions/new")?.tab.id).toBe("new");
    expect(findNav("/accountsx")).toBeUndefined();
  });
});
