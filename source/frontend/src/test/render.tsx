import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { createQueryClient } from "@/api/queryClient";
import { routes } from "@/app/routes";
import { theme } from "@/theme";

function Providers({ children }: { children: ReactElement }) {
  // The app's client, with its session and error handling, minus retries.
  const [client] = useState(() => {
    const c = createQueryClient();
    c.setDefaultOptions({ queries: { ...c.getDefaultOptions().queries, retry: false } });
    return c;
  });
  // env="test" turns off Mantine's transitions and portals: in jsdom a
  // transition never finishes, so a menu would stay hidden.
  return (
    <MantineProvider theme={theme} env="test">
      <Notifications />
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MantineProvider>
  );
}

/** Renders a component with the app's providers. */
export function renderWithProviders(ui: ReactElement) {
  return render(<Providers>{ui}</Providers>);
}

/** Renders the whole app at a path, with the real routes and layout. */
export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, ...renderWithProviders(<RouterProvider router={router} />) };
}
