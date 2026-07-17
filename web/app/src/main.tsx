import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./appkit"; // initialize Reown AppKit (createAppKit) before any hook runs
import "./styles.css";
import { isWoodieApp } from "./pwa";
import { AppProviders } from "./privy";

// Launched as the installed WOODIE app? Boot straight into the copilot + tag the root for styling.
if (isWoodieApp()) {
  document.documentElement.classList.add("woodie-app");
  if (!location.hash.startsWith("#/woodie")) location.hash = "#/woodie";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>
);

// Register the PWA service worker (installable + offline app shell).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
