// App deployment config. Switch NETWORK to target Robinhood Chain testnet/mainnet.
// For the local demo, paste addresses from deploy/e2e.local.json.

import type { Artifacts } from "@sherwood/client";

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Native gas token shielded via its wrapped ERC20 (`address` = the WETH contract):
   *  shield wraps ETH→WETH first, withdraw-to-self unwraps WETH→ETH after. */
  native?: boolean;
  /** Listed but not shieldable/tradable (shown greyed with a "halted" badge). */
  halted?: boolean;
  /** Token logo (served from /public/tokens). Falls back to a ticker gradient if absent. */
  logo?: string;
}

export interface NetworkConfig {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  pool: `0x${string}`;
  relayerUrl?: string;
  pointsUrl?: string;
  explorer?: string;
  quoter?: `0x${string}`;
  /** Non-custodial public swap router (aggregator "Swap" mode). */
  publicRouter?: `0x${string}`;
  /** Generic multi-DEX (v2/v3/v4) aggregation router for the public "Swap" mode. */
  aggRouter?: `0x${string}`;
  /** $SWOOD staking / revenue-share contract. */
  swoodStaking?: `0x${string}`;
  /** $SWOOD signaling governance contract. */
  swoodGovernor?: `0x${string}`;
  poolFee: number;
  /** Block the pool was deployed at — clients replay events from here to rebuild the
   *  tree. Omit (defaults to 0) for local anvil; required on a high-block live chain. */
  fromBlock?: bigint;
  tokens: TokenInfo[];
}

// Production builds inject the public endpoints via Vite env (see deploy/vps/);
// fall back to the local dev defaults when unset.
const ENV: Record<string, string | undefined> = (import.meta as any).env ?? {};

// Circuit artifacts served statically (copied into public/circuits by setup).
export const ARTIFACTS: Artifacts = {
  wasm: "/circuits/transaction.wasm",
  zkey: "/circuits/transaction_final.zkey",
};

// Message the wallet signs to derive the (deterministic) Sherwood account. Domain-
// separated by chainId + pool + version so the SAME wallet yields a DIFFERENT account
// per network/pool, and a signature captured for one context cannot unlock another (M-2).
export const ACCOUNT_VERSION = "v1";
export function accountMessage(net: { chainId: number; pool: string }): string {
  return (
    "Sherwood — derive my shielded account.\n" +
    "Sign to access your private notes. This does not send a transaction.\n\n" +
    `network: ${net.chainId}\npool: ${net.pool}\nversion: ${ACCOUNT_VERSION}`
  );
}

export const NETWORKS: Record<string, NetworkConfig> = {
  "rh-mainnet": {
    key: "rh-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    // The Robinhood RPC is DNS-blocked on some ISPs (needs a VPN). The browser reads chain
    // state from here, so default to the VPS CORS proxy (browser -> VPS IP -> Robinhood RPC)
    // which sidesteps the block. Override with VITE_RPC_URL to hit the RPC directly.
    rpcUrl: ENV.VITE_RPC_URL || "http://158.220.120.179:8791",
    // from deploy/mainnet.json (npm run mainnet:deploy, 2026-07-11 — multi-DEX executor +
    // tokenized-stock routes; settable swapExecutor so future routes need no pool redeploy)
    pool: "0x6504c957ec52b279667e6836b102a0c2586e919c",
    fromBlock: 6756577n, // pool's deploy block — replay from here, not 0
    // relayer + points run on the VPS (deploy/vps). VITE_* injected in a prod build;
    // fall back to the VPS HTTP endpoints (note: mixed-content — serve the app over HTTP,
    // or put the relayer behind HTTPS, to call these from an https:// page).
    relayerUrl: ENV.VITE_RELAYER_URL || "http://158.220.120.179:8790",
    pointsUrl: ENV.VITE_POINTS_URL || "http://158.220.120.179:8788",
    explorer: "https://robinhoodchain.blockscout.com",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", // truthy so the swap form shows live quotes (routing.ts does the multi-DEX quote)
    publicRouter: "0xb40472a8370ac0045b20af398dd8181e320fdaff", // PublicRouter.sol — v4-only public swap (superseded by aggRouter)
    aggRouter: "0x01bfe0d5d43be24f2edf626bdd2ff41af5dc4e0c", // AggRouter.sol — v2/v3/v4 + 2-hop, $SWOOD-tiered fee
    swoodStaking: "0x34677e5dd609d79ca2a413c51976154db7c1973f", // SwoodStaking.sol — stake $SWOOD, earn USDG fees
    swoodGovernor: "0x0b6c6f778e7ac3dd576658fbc35a0ac643f79fd7", // SwoodGovernor.sol — $SWOOD signaling governance

    poolFee: 3000,
    // Allowlisted assets (ASSETS in .env): WETH(=ETH) + USDG + 5 meme + 3 tokenized stocks.
    // Swaps route through the WETH hub across Uniswap v2/v3/v4 (see routing.ts + SwapExecutor.sol);
    // stocks route stock↔ETH↔WETH via hookless v4 pools (fee 5%, ts 1000).
    tokens: [
      { symbol: "ETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, native: true, logo: "/tokens/eth.png" },
      { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, logo: "/tokens/weth.png" },
      { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, logo: "/tokens/usdg.png" },
      { symbol: "CASHCAT", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", decimals: 18, logo: "/tokens/cashcat.jpg" },
      { symbol: "JUGGERNAUT", address: "0xD7321801CAae694090694Ff55A9323139F043B88", decimals: 18 },
      { symbol: "HOODRAT", address: "0x8e62F281f282686fCa6dCB39288069a93fC23F1c", decimals: 18, logo: "/tokens/hoodrat.jpg" },
      { symbol: "VIRTUAL", address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", decimals: 18, logo: "/tokens/virtual.png" },
      { symbol: "VEX", address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", decimals: 18, logo: "/tokens/vex.jpg" },
      // Tokenized stocks — now tradable via hookless ETH-paired v4 pools (routed through the ETH hub).
      { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, logo: "/tokens/aapl.png" },
      { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, logo: "/tokens/tsla.png" },
      { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, logo: "/tokens/nvda.png" },
    ],
  },
};

export const DEFAULT_NETWORK = "rh-mainnet";

/** Build the local network config from a fresh E2EDeploy output (deploy/e2e.local.json,
 *  copied to public/local-deploy.json). Keeps the demo wired across redeploys. */
export function localFromDeploy(d: any): NetworkConfig {
  return {
    ...NETWORKS.local,
    pool: d.pool,
    quoter: d.quoter,
    tokens: [
      { symbol: "USDG", address: d.usdg, decimals: 6 },
      { symbol: "AAPLx", address: d.aapl, decimals: 18 },
    ],
  };
}
