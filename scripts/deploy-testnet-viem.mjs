// viem-based deployer for the Sherwood stack — no forge/rustls at deploy time, so
// it works over AV/proxy-intercepted TLS when INSECURE_TLS=1 (Node/OpenSSL can skip
// the bad cert that rustls rejects with CaUsedAsEndEntity). Reads forge-compiled
// artifacts from out/ (run `forge build` first), deploys + links the Poseidon
// libraries, and writes deploy/testnet.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveNetwork } from "./lib/network.mjs";

const env = { ...process.env };
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) {
      const v = m[2].replace(/\s+#.*$/, "").trim();
      if (v) env[m[1]] = v; // .env.local overrides .env
    }
  }
}
if (env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { NETWORK, rh, RPC_URL: rpc, CHAIN_ID: chainId, deployFile: DEPLOY_FILE } = resolveNetwork(env);
const chainName = rh.name;
const pk = env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) throw new Error("DEPLOYER_PRIVATE_KEY missing/invalid");
const assets = (env.ASSETS || "").split(",").map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a));
if (!assets.length) throw new Error("ASSETS empty");
const levels = Number(env.LEVELS || 23);
const account = privateKeyToAccount(pk);
const owner = env.OWNER ? getAddress(env.OWNER) : account.address;
const asp = env.ASP ? getAddress(env.ASP) : owner;

const chain = defineChain({ id: chainId, name: chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const art = (file, contract) => {
  const a = JSON.parse(readFileSync(`out/${file}.sol/${contract}.json`, "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object, linkReferences: a.bytecode.linkReferences || {} };
};

async function deploy(name, { abi, bytecode }, args = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed (${hash})`);
  console.log(`  ${name.padEnd(15)} ${r.contractAddress}`);
  return r.contractAddress;
}

// replace __$…$__ library placeholders with deployed addresses per linkReferences
function link(bytecode, linkReferences, addrs) {
  let hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  for (const file in linkReferences) {
    for (const lib in linkReferences[file]) {
      const a = addrs[lib];
      if (!a) throw new Error(`missing address for library ${lib}`);
      const clean = a.toLowerCase().replace(/^0x/, "");
      for (const { start, length } of linkReferences[file][lib]) {
        if (length !== 20) throw new Error("unexpected link length");
        hex = hex.slice(0, start * 2) + clean + hex.slice((start + length) * 2);
      }
    }
  }
  return "0x" + hex;
}

async function main() {
  const bal = await pub.getBalance({ address: account.address });
  console.log(`Deployer ${account.address}  gas ${bal} wei  chainId ${await pub.getChainId()}`);
  if (bal === 0n) throw new Error(NETWORK === "mainnet"
    ? "deployer has 0 gas ETH — fund the deployer address with real ETH before deploying to mainnet"
    : "deployer has 0 gas ETH — fund at https://faucet.testnet.chain.robinhood.com");

  console.log("Poseidon libraries:");
  const t3 = await deploy("PoseidonT3", art("PoseidonT3", "PoseidonT3"));
  const t6 = await deploy("PoseidonT6", art("PoseidonT6", "PoseidonT6"));

  console.log("Core:");
  const verifier = await deploy("Groth16Verifier", art("Verifier", "Groth16Verifier"));
  // SwapExecutor now targets Uniswap v4 directly (Universal Router + USDG routing),
  // with the v4 addresses hardcoded — no router arg. `router` kept for the deploy record.
  const router = env.ROUTER ? getAddress(env.ROUTER) : "0x0000000000000000000000000000000000000000";
  const executor = await deploy("SwapExecutor", art("SwapExecutor", "SwapExecutor"), []);

  const sh = art("Sherwood", "Sherwood");
  const linked = link(sh.bytecode, sh.linkReferences, { PoseidonT3: t3, PoseidonT6: t6 });
  const pool = await deploy("Sherwood", { abi: sh.abi, bytecode: linked }, [verifier, executor, levels, owner, asp, assets]);

  writeFileSync(DEPLOY_FILE, JSON.stringify({ verifier, router, executor, pool, assets, poseidonT3: t3, poseidonT6: t6 }, null, 2));
  console.log(`\n✓ deployed via viem. ${DEPLOY_FILE} written. pool = ${pool}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("DEPLOY FAIL:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
