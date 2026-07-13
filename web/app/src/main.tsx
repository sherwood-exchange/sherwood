import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./appkit"; // initialize Reown AppKit (createAppKit) before any hook runs
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the PWA service worker (installable + offline app shell).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
