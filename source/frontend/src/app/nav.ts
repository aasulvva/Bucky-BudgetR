// The navigation structure (spec §9, design session #8), used by the side menu
// (desktop), the bottom tabs and their sub-menus (mobile), and the router.
// The same groups appear on both. Settings and Admin aren't in the navigation:
// they sit in the profile menu, with sign out.

import {
  IconAdjustments,
  IconChartPie,
  IconHome,
  IconListDetails,
  IconPlus,
  type Icon,
} from "@tabler/icons-react";

import type en from "@/i18n/locales/en.json";

export interface NavItem {
  path: string;
  /** Its name, under nav.items in the translations. */
  key: keyof typeof en.nav.items;
  /** The issue that builds this screen, shown on its placeholder. */
  issue: number;
  /** Comes after the MVP; shown as "Later". */
  later?: boolean;
}

export interface NavTab {
  /** Also its name, under nav.tabs in the translations. */
  id: keyof typeof en.nav.tabs;
  /** The name for the narrow mobile tab bar, if the name is too long. */
  short?: keyof typeof en.nav.tabs;
  icon: Icon;
  items: NavItem[];
  /** The raised centre action on mobile, a button on desktop. */
  action?: boolean;
}

export const navTabs: NavTab[] = [
  {
    id: "overview",
    icon: IconHome,
    items: [{ path: "/", key: "dashboard", issue: 29 }],
  },
  {
    id: "transactions",
    icon: IconListDetails,
    items: [{ path: "/transactions", key: "transactions", issue: 25 }],
  },
  {
    id: "new",
    icon: IconPlus,
    action: true,
    items: [{ path: "/transactions/new", key: "newTransaction", issue: 24 }],
  },
  {
    id: "budget",
    short: "budgetShort",
    icon: IconChartPie,
    items: [
      { path: "/buckets", key: "buckets", issue: 23 },
      { path: "/accounts", key: "accounts", issue: 21 },
      { path: "/cycles", key: "cycles", issue: 22 },
      { path: "/savings", key: "savings", issue: 35, later: true },
      { path: "/stats", key: "stats", issue: 122 },
    ],
  },
  {
    id: "setup",
    icon: IconAdjustments,
    items: [
      { path: "/accounts/setup", key: "accountSetup", issue: 21 },
      { path: "/buckets/setup", key: "bucketSetup", issue: 23 },
      { path: "/budget", key: "budgetSetup", issue: 28 },
      { path: "/savings/setup", key: "savingsSetup", issue: 35, later: true },
    ],
  },
];

/**
 * The profile menu's screens, with a description under nav.descriptions.
 * Admin is only shown to admins.
 */
export const profileItems: (NavItem & {
  key: keyof typeof en.nav.descriptions;
  adminOnly?: boolean;
})[] = [
  { path: "/settings", key: "settings", issue: 20 },
  { path: "/admin", key: "admin", issue: 30, adminOnly: true },
];

export const navItems: NavItem[] = [...navTabs.flatMap((t) => t.items), ...profileItems];

/**
 * The item a path belongs to, and its tab (none for the profile menu's
 * screens): the item with the longest path that the path equals or is nested
 * under ("/accounts/1234" belongs to "/accounts").
 */
export function findNav(pathname: string): { tab?: NavTab; item: NavItem } | undefined {
  let best: { tab?: NavTab; item: NavItem } | undefined;
  const consider = (item: NavItem, tab?: NavTab) => {
    const matches =
      pathname === item.path || (item.path !== "/" && pathname.startsWith(`${item.path}/`));
    if (matches && (!best || item.path.length > best.item.path.length)) best = { tab, item };
  };
  for (const tab of navTabs) {
    for (const item of tab.items) consider(item, tab);
  }
  for (const item of profileItems) consider(item);
  return best;
}
