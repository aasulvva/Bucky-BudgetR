// Vitest setup: jest-dom matchers, the fake backend (test/api.ts) and the
// browser APIs Mantine needs that jsdom lacks.
import "@testing-library/jest-dom/vitest";

import { notifications } from "@mantine/notifications";
import { cleanup } from "@testing-library/react";

import { apiMock, fakeFetch } from "./api";

globalThis.fetch = fakeFetch as typeof fetch;

afterEach(() => {
  cleanup();
  apiMock.reset();
  // The notification store is global; don't let one test's toasts show in the next.
  notifications.clean();
  notifications.cleanQueue();
});

/** Width the stubbed matchMedia answers for; tests can change it. */
export const viewport = { width: 1280 };

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => {
    const min = /min-width:\s*([\d.]+)em/.exec(query);
    return {
      matches: min ? viewport.width >= Number(min[1]) * 16 : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  },
});

window.ResizeObserver = class {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
};

window.HTMLElement.prototype.scrollIntoView = () => undefined;
