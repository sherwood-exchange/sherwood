// Loads .env and runs the Robinhood Chain testnet deploy or test.
//   node scripts/testnet.mjs deploy   — forge script DeployTestnet (broadcast)
//   node scripts/testnet.mjs test     — tsx client/test/testnet.ts (real proofs)
// (forge must be on PATH for `deploy`; install via https://getfoundry.sh)
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolveNetwork } from "./lib/network.mjs";

const env = { ...process.env };
let loaded = false;
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  loaded = true;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) {
      const v = m[2].replace(/\s+#.*$/, "").trim();
      if (v) env[m[1]] = v; // .env.local overrides .env
    }
  }
}
if (!loaded) {
  console.error("no .env found — copy .env.example to .env and fill it in");
  process.exit(1);
}

const cmd = process.argv[2];
const { NETWORK, RPC_URL, CHAIN_ID } = resolveNetwork(env);
// Pin the resolved network into the env handed to child processes so they agree on the target.
env.NETWORK = NETWORK;
env.RPC_URL = RPC_URL;
env.CHAIN_ID = String(CHAIN_ID);
if (!env.RPC_URL || !/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_PRIVATE_KEY || "")) {
  console.error("Fill a valid 32-byte DEPLOYER_PRIVATE_KEY in .env first (RPC_URL comes from deploy/robinhood-chain.json).");
  process.exit(1);
}
console.log(`Target network: ${NETWORK}  chainId ${CHAIN_ID}  rpc ${RPC_URL}`);
// If your network intercepts TLS with an untrusted cert (e.g. a corporate proxy),
// set INSECURE_TLS=1 in .env — Node/viem will then skip cert validation.
if (env.INSECURE_TLS === "1") env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let r;
if (cmd === "deploy") {
  if (NETWORK === "mainnet" || env.INSECURE_TLS === "1") {
    // Mainnet: the viem deployer reads ASSETS (multi-asset), uses the real ROUTER, and
    // writes deploy/mainnet.json that the relayer/points scripts consume.
    // INSECURE_TLS=1: forge/rustls rejects the AV-intercepted cert; viem/OpenSSL works.
    console.log(`Deploying ${NETWORK} via viem (needs \`forge build\` artifacts in out/).`);
    r = spawnSync("node", ["scripts/deploy-testnet-viem.mjs"], { stdio: "inherit", env, shell: true });
  } else {
    r = spawnSync(
      "forge",
      ["script", "script/DeployTestnet.s.sol:DeployTestnet", "--rpc-url", env.RPC_URL, "--broadcast", "--private-key", env.DEPLOYER_PRIVATE_KEY],
      { stdio: "inherit", env, shell: true }
    );
  }
} else if (cmd === "test") {
  r = spawnSync("npx", ["tsx", "client/test/testnet.ts"], { stdio: "inherit", env, shell: true });
} else if (cmd === "relayer-test") {
  r = spawnSync("npx", ["tsx", "client/test/testnet-relayer.ts"], { stdio: "inherit", env, shell: true });
} else {
  console.error("usage: node scripts/testnet.mjs <deploy|test|relayer-test>");
  process.exit(1);
}
process.exit(r.status ?? 1);
