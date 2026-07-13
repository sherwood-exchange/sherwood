// Single source of truth for which Robinhood Chain network a script targets.
//
// Precedence for the network:
//   1. process.env.NETWORK  — set explicitly by the npm script (authoritative; the
//      .env parse below writes to a local object, never to process.env, so this survives).
//   2. NETWORK in .env       — the "active" network the repo is configured for.
//   3. derived from CHAIN_ID  — 46630 => testnet, anything else => mainnet.
//
// Chain params (rpcUrl, chainId, explorer, tokens) come from deploy/robinhood-chain.json
// keyed by the resolved network. .env's RPC_URL / CHAIN_ID act as overrides, but ONLY when
// they belong to the active (.env) network — so `NETWORK=testnet npm run ...` never picks up
// a mainnet RPC_URL from .env, and vice-versa. This is what stops a testnet command from
// silently hitting mainnet.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function resolveNetwork(env, root = process.cwd()) {
  const forced = process.env.NETWORK;                 // from npm script
  const declared = env.NETWORK;                       // from .env
  const NETWORK = forced || declared || (Number(env.CHAIN_ID) === 46630 ? "testnet" : "mainnet");

  const cfg = JSON.parse(readFileSync(resolve(root, "deploy/robinhood-chain.json"), "utf8"));
  const rh = cfg[NETWORK];
  if (!rh) throw new Error(`unknown NETWORK "${NETWORK}" (expected "mainnet" or "testnet")`);

  // .env overrides apply only when the resolved network is the one .env is configured for.
  const activeIsDotenv =
    !forced || forced === declared || (!declared && Number(env.CHAIN_ID) === rh.chainId);
  const RPC_URL = (activeIsDotenv && env.RPC_URL) ? env.RPC_URL : rh.rpcUrl;
  const CHAIN_ID = (activeIsDotenv && env.CHAIN_ID) ? Number(env.CHAIN_ID) : rh.chainId;

  return {
    NETWORK,
    rh,
    RPC_URL,
    CHAIN_ID,
    isTestnet: NETWORK === "testnet",
    deployFile: `deploy/${NETWORK}.json`,
    pointsData: `points-data/${NETWORK}.json`,
    explorerTx: (h) => `${rh.explorer}/tx/${h}`,
  };
}
