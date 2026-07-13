// Run the Sherwood points indexer against Robinhood Chain testnet.
//   node scripts/points-testnet.mjs   (or: npm run points:testnet)
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveNetwork } from "./lib/network.mjs";

const ROOT = process.cwd();
const env = { ...process.env };
for (const f of [".env", ".env.local"]) {
  if (!existsSync(resolve(ROOT, f))) continue;
  for (const line of readFileSync(resolve(ROOT, f), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) { const v = m[2].replace(/\s+#.*$/, "").trim(); if (v) env[m[1]] = v; }
  }
}
if (env.INSECURE_TLS === "1") env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { RPC_URL, CHAIN_ID, deployFile, pointsData } = resolveNetwork(env, ROOT);
const dep = JSON.parse(readFileSync(resolve(ROOT, deployFile), "utf8"));
env.POOL_ADDRESS = dep.pool;
env.RPC_URL = RPC_URL;
env.CHAIN_ID = String(CHAIN_ID);
env.POINTS_FROM_BLOCK = env.POINTS_FROM_BLOCK || String(dep.fromBlock ?? 0);
env.POINTS_DATA = env.POINTS_DATA || pointsData;

const r = spawnSync("npx", ["tsx", "points/src/server.ts"], { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 1);
