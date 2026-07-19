import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./appkit"; // initialize Reown AppKit (createAppKit) before any hook runs
import "./styles.css";
import { isWoodieApp, isTwa } from "./pwa";
import { AppProviders } from "./privy";

// Launched as the installed WOODIE app? Boot straight into the copilot + tag the root for styling.
if (isWoodieApp()) {
  document.documentElement.classList.add("woodie-app");
  if (!location.hash.startsWith("#/woodie")) location.hash = "#/woodie";
}
// Android TWA draws edge-to-edge on newer Androids but env(safe-area-inset-*) isn't always
// populated. When the viewport spans the whole screen (system bars overlap content), tag the root
// so CSS can float the chrome clear of the bars with a fixed floor.
if (isTwa()) {
  document.documentElement.classList.add("twa");
  const probe = () => document.documentElement.classList.toggle("e2e", screen.height - window.innerHeight < 24);
  probe();
  window.addEventListener("resize", probe);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>
);

// Register the PWA service worker (installable + offline app shell) — PRODUCTION ONLY. In dev the
// SW caches JS modules and serves stale code across reloads, so unregister it and drop its caches.
if ("serviceWorker" in navigator) {
  if ((import.meta as any).env?.PROD) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  } else {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    if ("caches" in window) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}
