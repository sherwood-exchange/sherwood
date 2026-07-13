// Run the Sherwood relayer against Robinhood Chain TESTNET.
//   node scripts/testnet-relayer.mjs   (or: npm run relayer:testnet)
//
// Loads .env + .env.local, points POOL_ADDRESS at deploy/testnet.json, and ensures
// the relayer runs from a SEPARATE, funded hot wallet (never your shielding wallet —
// otherwise relaying wouldn't break the address link). A generated relayer key is
// persisted to .env.local (gitignored) and reused across runs.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
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

const { NETWORK, rh, RPC_URL, CHAIN_ID, deployFile, explorerTx } = resolveNetwork(env, ROOT);
const dep = JSON.parse(readFileSync(resolve(ROOT, deployFile), "utf8"));
env.POOL_ADDRESS = dep.pool; // .env's POOL_ADDRESS is intentionally blank
env.RPC_URL = RPC_URL;       // pin child + viem client to the resolved network
env.CHAIN_ID = String(CHAIN_ID);

const { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEther, getAddress } = await import("viem");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");

const chain = defineChain({
  id: Number(env.CHAIN_ID), name: rh.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } }, testnet: true,
});
const transport = http(env.RPC_URL);
const pc = createPublicClient({ chain, transport });

const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
let relKey = env.RELAYER_PRIVATE_KEY;
const sameAsDeployer = relKey && relKey.toLowerCase() === env.DEPLOYER_PRIVATE_KEY.toLowerCase();

if (!relKey || sameAsDeployer) {
  // Generate a dedicated relayer key and persist it to .env.local (overrides .env).
  relKey = generatePrivateKey();
  appendFileSync(resolve(ROOT, ".env.local"), `\n# dedicated relayer hot wallet (${NETWORK}, gitignored)\nRELAYER_PRIVATE_KEY=${relKey}\n`);
  console.log("Generated a dedicated relayer wallet and saved it to .env.local");
}
env.RELAYER_PRIVATE_KEY = relKey;
const relayer = privateKeyToAccount(relKey);
console.log(`Relayer wallet: ${relayer.address}  (deployer: ${deployer.address})`);
if (relayer.address.toLowerCase() === deployer.address.toLowerCase()) throw new Error("relayer must differ from deployer");

// Fund the relayer if it is short on gas. Amounts are configurable and the top-up is
// capped to what the deployer can actually afford (minus a small reserve for the transfer's
// own gas) — on this L2 gas is ~0.13 gwei, so a fraction of an ETH lasts a long time.
const MIN_GAS = parseEther(env.RELAYER_MIN_GAS || "0.0015");
const GAS_RESERVE = parseEther(env.RELAYER_GAS_RESERVE || "0.0002");
let bal = await pc.getBalance({ address: relayer.address });
if (bal < MIN_GAS) {
  let topUp = parseEther(env.RELAYER_TOPUP || "0.002");
  const deployerBal = await pc.getBalance({ address: deployer.address });
  if (topUp + GAS_RESERVE > deployerBal) topUp = deployerBal > GAS_RESERVE ? deployerBal - GAS_RESERVE : 0n;
  if (topUp === 0n) {
    throw new Error(`deployer ${deployer.address} has ${formatEther(deployerBal)} ETH — not enough to fund the relayer. ` +
      `Top up the deployer, or send ETH directly to the relayer wallet ${relayer.address}.`);
  }
  console.log(`Relayer low on gas (${formatEther(bal)} ETH) — funding ${formatEther(topUp)} ETH from deployer…`);
  const wc = createWalletClient({ account: deployer, chain, transport });
  const hash = await wc.sendTransaction({ to: getAddress(relayer.address), value: topUp });
  await pc.waitForTransactionReceipt({ hash });
  bal = await pc.getBalance({ address: relayer.address });
  console.log(`  funded → ${explorerTx(hash)}`);
}
console.log(`Relayer gas: ${formatEther(bal)} ETH  pool ${env.POOL_ADDRESS}  chain ${env.CHAIN_ID}\n`);

// Hand off to the relayer HTTP service with the prepared environment.
const r = spawnSync("npx", ["tsx", "relayer/src/server.ts"], { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 1);
