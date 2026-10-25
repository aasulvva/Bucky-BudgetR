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

export interface NavItem {
  path: string;
  label: string;
  /** The issue that builds this screen, shown on its placeholder. */
  issue: number;
  /** Comes after the MVP; shown as "Later". */
  later?: boolean;
}

export interface NavTab {
  id: string;
  label: string;
  /** Label for the narrow mobile tab bar, if `label` is too long. */
  shortLabel?: string;
  icon: Icon;
  items: NavItem[];
  /** The raised centre action on mobile, a button on desktop. */
  action?: boolean;
}

export const navTabs: NavTab[] = [
  {
    id: "overview",
    label: "Overview",
    icon: IconHome,
    items: [{ path: "/", label: "Dashboard", issue: 29 }],
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
      { path: "/buckets", label: "Buckets", issue: 23 },
      { path: "/accounts", label: "Accounts", issue: 21 },
      { path: "/cycles", label: "Cycles", issue: 22 },
      { path: "/savings", label: "Savings", issue: 35, later: true },
      { path: "/stats", label: "Stats & reports", issue: 34, later: true },
    ],
  },
  {
    id: "setup",
    label: "Setup",
    icon: IconAdjustments,
    items: [
      { path: "/accounts/setup", label: "Account setup", issue: 21 },
      { path: "/buckets/setup", label: "Bucket setup", issue: 23 },
      { path: "/budget", label: "Budget setup", issue: 28 },
      { path: "/savings/setup", label: "Savings setup", issue: 35, later: true },
    ],
  },
];

/** The profile menu's screens. Admin is only shown to admins. */
export const profileItems: (NavItem & { adminOnly?: boolean; description: string })[] = [
  { path: "/settings", label: "Settings", issue: 20, description: "Password, preferences, data" },
  {
    path: "/admin",
    label: "Admin",
    issue: 30,
    adminOnly: true,
    description: "Users, password resets",
  },
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
