import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "node:path";

// The SDK (snarkjs / circomlibjs / ffjavascript) expects Node globals; polyfill
// Buffer/global/process for the browser. The SDK is consumed from its compiled
// dist so Vite doesn't have to resolve the source's explicit .js extensions.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
  ],
  resolve: {
    alias: {
      "@sherwood/client": resolve(__dirname, "../../client/dist/index.js"),
      // Force the SDK's deps to resolve from THIS app's node_modules so the
      // Buffer/process polyfill shims (which live here) are reachable.
      circomlibjs: resolve(__dirname, "node_modules/circomlibjs"),
      snarkjs: resolve(__dirname, "node_modules/snarkjs"),
      ffjavascript: resolve(__dirname, "node_modules/ffjavascript"),
      // The polyfill plugin injects these shim imports into root-tree deps (viem,
      // circomlibjs) that can't resolve them; pin them to absolute paths.
      "vite-plugin-node-polyfills/shims/buffer": resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/buffer/dist/index.js"),
      "vite-plugin-node-polyfills/shims/global": resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/global/dist/index.js"),
      "vite-plugin-node-polyfills/shims/process": resolve(__dirname, "node_modules/vite-plugin-node-polyfills/shims/process/dist/index.js"),
    },
    // Only dedupe the packages with the cross-tree Buffer-shim issue. Do NOT
    // dedupe @noble/* or viem: viem pins noble v1 (extensionless imports) while
    // the SDK uses noble v2 (.js exports) — collapsing them breaks resolution.
    dedupe: ["circomlibjs", "snarkjs", "ffjavascript"],
  },
  optimizeDeps: {
    include: ["snarkjs", "circomlibjs"],
    esbuildOptions: { target: "es2022" },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // Stable vendor chunks: app-code deploys no longer invalidate the heavy wallet/crypto
        // stack in users' caches, and the browser parses them in parallel with the app chunk.
        // NOTE: do NOT force the wallet stack (@privy-io/@reown/@walletconnect) into one chunk —
        // that drags their internally lazy-loaded modules into the eager payload and grows the
        // first load. Only pin the always-static vendors.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/viem\//.test(id)) return "vendor-viem";
          if (/node_modules\/lightweight-charts\//.test(id)) return "vendor-charts";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    fs: { allow: [resolve(__dirname, "../..")] },
    // GeckoTerminal's Cloudflare blocks browser (cross-origin) requests, so charts/trades fail
    // client-side. Proxy them same-origin here for local dev (production uses a Caddy /gtproxy route).
    proxy: {
      "/gtproxy": {
        target: "https://api.geckoterminal.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gtproxy/, ""),
      },
    },
  },
});
