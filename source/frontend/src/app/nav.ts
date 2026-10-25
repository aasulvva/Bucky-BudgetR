// The navigation structure, used by the side menu (desktop), the bottom tabs
// and sub-menus (mobile) and the router. The grouping is provisional until the
// design session in #8; rearrange it here.

import {
  IconChartPie,
  IconHome,
  IconListDetails,
  IconPlus,
  IconSettings,
  type Icon,
} from "@tabler/icons-react";

export interface NavItem {
  path: string;
  label: string;
  /** The issue that builds this screen, shown on its placeholder. */
  issue: number;
}

export interface NavTab {
  id: string;
  label: string;
  /** Label for the narrow mobile tab bar, if `label` is too long. */
  shortLabel?: string;
  icon: Icon;
  items: NavItem[];
  /** The raised centre action on mobile. */
  action?: boolean;
}

export const navTabs: NavTab[] = [
  {
    id: "overview",
    label: "Overview",
    icon: IconHome,
    items: [
      { path: "/", label: "Dashboard", issue: 29 },
      { path: "/accounts", label: "Accounts", issue: 21 },
      { path: "/buckets", label: "Buckets", issue: 23 },
    ],
  },
  {
    id: "transactions",
    label: "Transactions",
    icon: IconListDetails,
    items: [{ path: "/transactions", label: "Transactions", issue: 25 }],
  },
  {
    id: "new",
    label: "New",
    icon: IconPlus,
    action: true,
    items: [{ path: "/transactions/new", label: "New transaction", issue: 24 }],
  },
  {
    id: "budget",
    label: "Budget & Reporting",
    shortLabel: "Budget",
    icon: IconChartPie,
    items: [
      { path: "/budget", label: "Budget setup", issue: 28 },
      { path: "/buckets/setup", label: "Bucket setup", issue: 23 },
      { path: "/accounts/setup", label: "Account setup", issue: 21 },
      { path: "/savings", label: "Savings", issue: 35 },
      { path: "/savings/setup", label: "Savings setup", issue: 35 },
      { path: "/stats", label: "Stats & reports", issue: 34 },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: IconSettings,
    items: [
      { path: "/settings", label: "Settings", issue: 20 },
      { path: "/admin", label: "Admin", issue: 30 },
    ],
  },
];

export const navItems: NavItem[] = navTabs.flatMap((t) => t.items);

/**
 * The tab and item a path belongs to: the item with the longest path that the
 * path equals or is nested under ("/accounts/1234" belongs to "/accounts").
 */
export function findNav(pathname: string): { tab: NavTab; item: NavItem } | undefined {
  let best: { tab: NavTab; item: NavItem } | undefined;
  for (const tab of navTabs) {
    for (const item of tab.items) {
      const matches =
        pathname === item.path || (item.path !== "/" && pathname.startsWith(`${item.path}/`));
      if (matches && (!best || item.path.length > best.item.path.length)) best = { tab, item };
    }
  }
  return best;
}
