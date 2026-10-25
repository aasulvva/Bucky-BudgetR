import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { routes } from "@/app/routes";
import { theme } from "@/theme";

function Providers({ children }: { children: ReactElement }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // env="test" turns off Mantine's transitions and portals: in jsdom a
  // transition never finishes, so a menu would stay hidden.
  return (
    <MantineProvider theme={theme} env="test">
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
