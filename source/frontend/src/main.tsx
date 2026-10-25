import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyLanguage, initialLanguage } from "./lib/language";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// The session guard switches to the user's language once it's known.
applyLanguage(initialLanguage());

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
