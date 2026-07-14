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
  /** Human-readable name shown in pickers/portfolio (display-only). */
  name?: string;
  /** Tokenized stock — grouped under "Tokenized stocks" in pickers (display-only). */
  stock?: boolean;
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
    aggRouter: "0x0D4C62FC3FB81db8d2eDE03adf41Ac893621912D", // AggRouter.sol — v2/v3/v4 + 2-hop (fee-aware v2), $SWOOD-tiered fee
    swoodStaking: "0x34677e5dd609d79ca2a413c51976154db7c1973f", // SwoodStaking.sol — stake $SWOOD, earn USDG fees
    swoodGovernor: "0x0b6c6f778e7ac3dd576658fbc35a0ac643f79fd7", // SwoodGovernor.sol — $SWOOD signaling governance

    poolFee: 3000,
    // Allowlisted assets (setAsset on-chain): WETH(=ETH) + USDG + 5 meme + all 23 tokenized stocks.
    // Swaps route through the WETH hub across Uniswap v2/v3/v4 (see routing.ts + SwapExecutor.sol);
    // stocks route stock↔ETH↔WETH via hookless v4 pools on per-stock fee tiers (STOCKS in routing.ts,
    // mirrored on-chain in SwapExecutor.stockRoute).
    tokens: [
      { symbol: "ETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, name: "Ether", native: true, logo: "/tokens/eth.png" },
      { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, name: "Wrapped Ether", logo: "/tokens/weth.png" },
      { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, name: "Global Dollar", logo: "/tokens/usdg.png" },
      { symbol: "CASHCAT", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", decimals: 18, name: "Cash Cat", logo: "/tokens/cashcat.jpg" },
      { symbol: "JUGGERNAUT", address: "0xD7321801CAae694090694Ff55A9323139F043B88", decimals: 18, name: "Juggernaut" },
      { symbol: "HOODRAT", address: "0x8e62F281f282686fCa6dCB39288069a93fC23F1c", decimals: 18, name: "Hoodrat", logo: "/tokens/hoodrat.jpg" },
      { symbol: "VIRTUAL", address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", decimals: 18, name: "Virtual", logo: "/tokens/virtual.png" },
      { symbol: "VEX", address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", decimals: 18, name: "Vex", logo: "/tokens/vex.jpg" },
      // $SWOOD — the protocol token, shieldable/tradable via its SWOOD/VIRTUAL v2 pair
      // (2-hop SWOOD↔VIRTUAL↔WETH; the pair keeps ~1.3%, handled in routing.ts + SwapExecutor).
      { symbol: "SWOOD", address: "0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60", decimals: 18, name: "Sherwood", logo: "/tokens/swood.png" },
      // Tokenized stocks — hookless ETH-paired v4 pools (routed through the ETH hub).
      // Deep pools (5% tier): AAPL/TSLA/NVDA/AMD/SPCX/GOOGL. The rest sit on thinner
      // seed pools — fine for small private positions, watch price impact on size.
      { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, name: "Apple", stock: true, logo: "/tokens/aapl.png" },
      { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, name: "Tesla", stock: true, logo: "/tokens/tsla.png" },
      { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, name: "Nvidia", stock: true, logo: "/tokens/nvda.png" },
      { symbol: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", decimals: 18, name: "Advanced Micro Devices", stock: true, logo: "/tokens/amd.png" },
      { symbol: "SPCX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", decimals: 18, name: "SpaceX", stock: true, logo: "/tokens/spcx.png" },
      { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", decimals: 18, name: "Alphabet Class A", stock: true, logo: "/tokens/googl.png" },
      { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, name: "Amazon", stock: true, logo: "/tokens/amzn.png" },
      { symbol: "APLD", address: "0xb8DBf92F9741c9ac1c32115E78581f23509916FD", decimals: 18, name: "Applied Digital", stock: true, logo: "/tokens/apld.png" },
      { symbol: "COIN", address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18, name: "Coinbase", stock: true, logo: "/tokens/coin.png" },
      { symbol: "CRCL", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", decimals: 18, name: "Circle", stock: true, logo: "/tokens/crcl.png" },
      { symbol: "CRWV", address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", decimals: 18, name: "CoreWeave", stock: true, logo: "/tokens/crwv.png" },
      { symbol: "F", address: "0x25C288E6D899b9BC30160965aD9644c67e73bE0C", decimals: 18, name: "Ford", stock: true, logo: "/tokens/f.png" },
      { symbol: "GME", address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", decimals: 18, name: "GameStop", stock: true, logo: "/tokens/gme.png" },
      { symbol: "INTC", address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", decimals: 18, name: "Intel", stock: true, logo: "/tokens/intc.png" },
      { symbol: "MU", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", decimals: 18, name: "Micron", stock: true, logo: "/tokens/mu.png" },
      { symbol: "NU", address: "0x408c14038a04f7bD235329E26d2bf569ee20e250", decimals: 18, name: "Nubank", stock: true, logo: "/tokens/nu.png" },
      { symbol: "ORCL", address: "0xb0992820E760d836549ba69BC7598b4af75dEE03", decimals: 18, name: "Oracle", stock: true, logo: "/tokens/orcl.png" },
      { symbol: "PLTR", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", decimals: 18, name: "Palantir", stock: true, logo: "/tokens/pltr.png" },
      { symbol: "QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, name: "Invesco QQQ", stock: true, logo: "/tokens/qqq.png" },
      { symbol: "RKLB", address: "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2", decimals: 18, name: "Rocket Lab", stock: true, logo: "/tokens/rklb.png" },
      { symbol: "SLV", address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", decimals: 18, name: "iShares Silver Trust", stock: true, logo: "/tokens/slv.png" },
      { symbol: "SNDK", address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", decimals: 18, name: "SanDisk", stock: true, logo: "/tokens/sndk.png" },
      { symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, name: "SPDR S&P 500", stock: true, logo: "/tokens/spy.png" },
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
