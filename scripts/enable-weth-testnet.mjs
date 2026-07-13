// One-time: allowlist WETH on the live testnet pool and wrap a little ETH → WETH so
// there is a balance to shield. Idempotent. Run: node scripts/enable-weth-testnet.mjs
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
if (env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { createPublicClient, createWalletClient, http, defineChain, getAddress, formatUnits, parseEther } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");

const { rh, RPC_URL, CHAIN_ID, isTestnet, deployFile, explorerTx: explorer } = resolveNetwork(env, ROOT);
const dep = JSON.parse(readFileSync(resolve(ROOT, deployFile), "utf8"));
const pool = getAddress(dep.pool);
const WETH = getAddress(rh.tokens.WETH.address);

const chain = defineChain({ id: CHAIN_ID, name: rh.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } }, testnet: isTestnet });
const transport = http(RPC_URL);
const pc = createPublicClient({ chain, transport });
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const wc = createWalletClient({ account, chain, transport });

const POOL_ABI = [
  { type: "function", name: "supportedAsset", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setAsset", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

console.log(`pool ${pool}  WETH ${WETH}  deployer ${account.address}`);

// 1) allowlist WETH
const supported = await pc.readContract({ address: pool, abi: POOL_ABI, functionName: "supportedAsset", args: [WETH] });
if (supported) {
  console.log("WETH already allowlisted ✓");
} else {
  const owner = await pc.readContract({ address: pool, abi: POOL_ABI, functionName: "owner" });
  if (getAddress(owner) !== getAddress(account.address)) throw new Error(`deployer is not the pool owner (${owner})`);
  const h = await wc.writeContract({ address: pool, abi: POOL_ABI, functionName: "setAsset", args: [WETH, true] });
  await pc.waitForTransactionReceipt({ hash: h });
  console.log(`allowlisted WETH → ${explorer(h)}`);
}

// 2) wrap a little ETH so we can shield WETH
const WRAP = parseEther("0.001");
let wbal = await pc.readContract({ address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] });
if (wbal < WRAP) {
  const h = await wc.writeContract({ address: WETH, abi: WETH_ABI, functionName: "deposit", value: WRAP });
  await pc.waitForTransactionReceipt({ hash: h });
  wbal = await pc.readContract({ address: WETH, abi: WETH_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`wrapped ${formatUnits(WRAP, 18)} ETH → WETH → ${explorer(h)}`);
}
console.log(`deployer WETH balance: ${formatUnits(wbal, 18)}`);
console.log("done.");
