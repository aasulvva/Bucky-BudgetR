import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem, testUser } from "@/test/api";
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
  it("shows the top-level screens and the open groups", async () => {
    renderRoute("/accounts");
    const nav = await screen.findByRole("navigation");
    for (const label of ["Dashboard", "Transactions", "New transaction", "Buckets", "Cycles"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Accounts" })).toHaveAttribute("data-active");
    expect(within(nav).getByRole("link", { name: /Savings Later/ })).toHaveAttribute(
      "href",
      "/savings",
    );
    // Setup is closed until opened.
    expect(within(nav).queryByRole("link", { name: "Account setup" })).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByText("Setup"));
    expect(await within(nav).findByRole("link", { name: "Account setup" })).toHaveAttribute(
      "href",
      "/accounts/setup",
    );
  });

  it("opens the group of the current screen", async () => {
    renderRoute("/buckets/setup");
    const nav = await screen.findByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Bucket setup" })).toHaveAttribute("data-active");
  });

  it("has the profile menu at the bottom", async () => {
    renderRoute("/");
    const nav = await screen.findByRole("navigation");
    await userEvent.click(within(nav).getByRole("button", { name: /Profile/ }));
    const menu = await screen.findByRole("menu");
    expect(await within(menu).findByRole("menuitem", { name: /Settings/ })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(within(menu).getByText("kari · User")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Admin/ })).not.toBeInTheDocument();
  });

  it("shows Admin to admins", async () => {
    apiMock.on("GET /api/v1/me", { body: { ...testUser, admin: true } });
    renderRoute("/");
    const nav = await screen.findByRole("navigation");
    await userEvent.click(within(nav).getByRole("button", { name: /Profile/ }));
    const menu = await screen.findByRole("menu");
    expect(await within(menu).findByRole("menuitem", { name: /Admin/ })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  it("signs out to the login page", async () => {
    const { router } = renderRoute("/accounts");
    const nav = await screen.findByRole("navigation");
    await userEvent.click(within(nav).getByRole("button", { name: /Profile/ }));
    apiMock.on("GET /api/v1/me", problem(401, "unauthenticated", "Log in first."));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(apiMock.calls("POST /api/v1/auth/logout")).toHaveLength(1);
  });
});

describe("mobile layout", () => {
  beforeEach(() => {
    viewport.width = 390;
  });

  it("shows the bottom tabs and the screen's name", async () => {
    renderRoute("/transactions");
    await screen.findByRole("heading", { level: 2, name: "Transactions" });

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Transactions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profile" })).toBeInTheDocument();

    const footer = screen.getByRole("contentinfo");
    for (const tab of navTabs.filter((t) => !t.action)) {
      const name = tab.shortLabel ?? tab.label;
      const role = tab.items.length > 1 ? "button" : "link";
      expect(within(footer).getByRole(role, { name })).toBeInTheDocument();
    }
    expect(within(footer).getByRole("link", { name: "Transactions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(footer).getByRole("link", { name: "New transaction" })).toHaveAttribute(
      "href",
      "/transactions/new",
    );
  });

  it("opens a group's screens in a sheet", async () => {
    renderRoute("/buckets");
    await screen.findByRole("heading", { level: 2, name: "Buckets" });
    const footer = screen.getByRole("contentinfo");
    const budget = within(footer).getByRole("button", { name: "Budget" });
    expect(budget).toHaveAttribute("data-active");

    await userEvent.click(budget);
    const sheet = await screen.findByRole("dialog", { name: "Budget & Reporting" });
    expect(within(sheet).getByRole("link", { name: "Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(within(sheet).getByRole("link", { name: "Buckets" })).toHaveAttribute("data-active");
  });
});

describe("findNav", () => {
  it("picks the most specific item", () => {
    expect(findNav("/")?.item.label).toBe("Dashboard");
    expect(findNav("/accounts/1234")?.item.label).toBe("Accounts");
    expect(findNav("/accounts/setup")?.tab?.id).toBe("setup");
    expect(findNav("/transactions/new")?.tab?.id).toBe("new");
    expect(findNav("/accountsx")).toBeUndefined();
  });

  it("finds the profile menu's screens without a tab", () => {
    const settings = findNav("/settings");
    expect(settings?.item.label).toBe("Settings");
    expect(settings?.tab).toBeUndefined();
  });
});
