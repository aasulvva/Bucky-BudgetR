import { createElement, lazy, Suspense, type ComponentType } from "react";

// The debug settings (#100) are for development only. The constant
// import.meta.env.DEV lets production builds drop Debug.tsx entirely; in
// development it loads on first use. Tests leave it out of the shell (Debug.test.tsx
// tests it directly).
const enabled = import.meta.env.DEV && import.meta.env.MODE !== "test";

const Nothing: ComponentType = () => null;

function devOnly(load: () => Promise<ComponentType>): ComponentType {
  const Lazy = lazy(async () => ({ default: await load() }));
  return function DevOnly() {
    return createElement(Suspense, { fallback: null }, createElement(Lazy));
  };
}

/** The fake time banner and the debug drawer, once in the shell. */
export const DebugRoot = enabled
  ? devOnly(() => import("./Debug").then((m) => m.DebugRoot))
  : Nothing;

/** The bug icon next to the user block (desktop). */
export const DebugButton = enabled
  ? devOnly(() => import("./Debug").then((m) => m.DebugButton))
  : Nothing;

/** The profile menu's debug item (mobile). */
export const DebugMenuItem = enabled
  ? devOnly(() => import("./Debug").then((m) => m.DebugMenuItem))
  : Nothing;
