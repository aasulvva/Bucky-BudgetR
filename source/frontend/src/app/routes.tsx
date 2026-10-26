import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

import NotFound from "@/pages/NotFound";
import { Placeholder } from "@/pages/Placeholder";

import { Layout } from "./Layout";
import { navItems } from "./nav";
import { RequireSession } from "./RequireSession";
import { RouteError } from "./RouteError";

type PageModule = Promise<{ default: ComponentType }>;

/** Screens that exist. Every other nav item gets a placeholder. */
const pages: Partial<Record<string, () => PageModule>> = {
  "/": () => import("@/pages/Dashboard"),
  "/accounts": () => import("@/pages/Accounts"),
  "/accounts/setup": () => import("@/pages/AccountSetup"),
  "/admin": () => import("@/pages/Admin"),
  "/buckets": () => import("@/pages/Buckets"),
  "/buckets/setup": () => import("@/pages/BucketSetup"),
  "/budget": () => import("@/pages/BudgetSetup"),
  "/cycles": () => import("@/pages/Cycles"),
  "/settings": () => import("@/pages/Settings"),
  "/transactions": () => import("@/pages/Transactions"),
  "/transactions/new": () => import("@/pages/NewTransaction"),
};

/** Screens outside the navigation. */
const extraPages: [string, () => PageModule][] = [
  ["/transactions/:id/edit", () => import("@/pages/EditTransaction")],
];

/** The paths whose screen is built, rather than a placeholder. */
export const builtPaths = Object.keys(pages);

const lazyPage = (load: () => PageModule) => async () => ({ Component: (await load()).default });

export const routes: RouteObject[] = [
  // Outside the app shell and the session guard.
  { path: "/login", lazy: lazyPage(() => import("@/pages/Login")) },
  { path: "/change-password", lazy: lazyPage(() => import("@/pages/ChangePassword")) },
  { path: "/set-password", lazy: lazyPage(() => import("@/pages/SetPassword")) },
  {
    element: <RequireSession />,
    children: [
      {
        element: <Layout />,
        children: [
          {
            errorElement: <RouteError />,
            children: [
              ...navItems.map((item): RouteObject => {
                const load = pages[item.path];
                return load
                  ? { path: item.path, lazy: lazyPage(load) }
                  : {
                      path: item.path,
                      element: <Placeholder item={item} />,
                    };
              }),
              ...extraPages.map(([path, load]): RouteObject => ({ path, lazy: lazyPage(load) })),
              { path: "*", element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
];
