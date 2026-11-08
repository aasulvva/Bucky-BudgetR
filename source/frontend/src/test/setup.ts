// Vitest setup: jest-dom matchers, the fake backend (test/api.ts) and the
// browser APIs Mantine needs that jsdom lacks.
import "@testing-library/jest-dom/vitest";

import { notifications } from "@mantine/notifications";
import { cleanup } from "@testing-library/react";

import i18n from "@/i18n";

import { apiMock, fakeFetch } from "./api";

globalThis.fetch = fakeFetch as typeof fetch;

afterEach(() => {
  cleanup();
  apiMock.reset();
  // The notification store is global; don't let one test's toasts show in the next.
  notifications.clean();
  notifications.cleanQueue();
  // Tests are in English unless they switch.
  void i18n.changeLanguage("en");
  document.documentElement.lang = "en";
  localStorage.clear();
});

/** What the stubbed matchMedia answers for; tests can change it. */
export const viewport = { width: 1280, touch: false };

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => {
    const min = /min-width:\s*([\d.]+)em/.exec(query);
    let matches = min ? viewport.width >= Number(min[1]) * 16 : false;
    if (query.includes("pointer: coarse")) matches = viewport.touch;
    return {
      matches,
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

// jsdom has no font loading; Mantine's autosize Textarea listens for it.
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    ready: Promise.resolve(),
  },
});

window.HTMLElement.prototype.scrollIntoView = () => undefined;
