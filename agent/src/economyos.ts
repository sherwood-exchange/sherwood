// economyOS — an autonomous GAME agent (Virtuals Protocol) for the Sherwood economy.
//
// Sherwood is a privacy DEX on Robinhood Chain: shield → swap public liquidity → settle
// privately, plus a public any-token aggregator, a cross-chain private bridge, and the $SWOOD
// utility token (fee discounts, staking/revenue-share, governance). economyOS is the on-chain
// "economic OS": it reads Sherwood's live state and explains/quotes the economy through GAME
// functions. Plug in a Virtuals GAME API key (GAME_API_KEY) to launch it.
import {
  GameAgent, GameWorker, GameFunction,
  ExecutableGameFunctionResponse, ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { createPublicClient, http, formatUnits, formatEther, getAddress, type Address } from "viem";
import { liveQuote, bridgeQuote, resolveToken, quotePublic } from "./quote.js";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
dotenv.config();

// ---- Sherwood on-chain constants (Robinhood Chain mainnet, chainId 4663) ----
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SITE = "https://sherwood.spot";
const A = {
  SWOOD: "0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  aggRouter: "0x01bfe0d5d43be24f2edf626bdd2ff41af5dc4e0c",
  staking: "0x34677e5dd609d79ca2a413c51976154db7c1973f",
  governor: "0x0b6c6f778e7ac3dd576658fbc35a0ac643f79fd7",
  pool: "0x6504c957ec52b279667e6836b102a0c2586e919c",
} as const;
const pc = createPublicClient({ transport: http(RPC) });

const ERC20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const STAKING_ABI = [
  { name: "totalStaked", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "stakedOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "earned", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "rewardRate", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const AGG_ABI = [{ name: "feeBpsFor", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const GOV_ABI = [
  { name: "proposalCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "proposals", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ name: "proposer", type: "address" }, { name: "description", type: "string" }, { name: "start", type: "uint64" }, { name: "end", type: "uint64" }, { name: "forVotes", type: "uint256" }, { name: "againstVotes", type: "uint256" }] },
] as const;

const ok = (m: string) => new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, m);
const fail = (m: string) => new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, m);

// ---- functions (each wraps a live piece of the Sherwood economy) ----

const explainSherwood = new GameFunction({
  name: "explain_sherwood",
  description: "Explain what Sherwood is: the privacy DEX, its features, and how it works. Use for intros and 'what is Sherwood' questions.",
  args: [] as const,
  executable: async () => ok(
    "Sherwood is a privacy DEX on Robinhood Chain (Arbitrum Orbit L2). Shield your assets into private notes, " +
    "swap through public Uniswap v2/v3/v4 liquidity, and settle privately — zero-knowledge (Groth16), gasless via a relayer. " +
    "Features: shielded swaps, a public any-token aggregator (~500+ tokens), a private cross-chain bridge (68 chains via Relay), " +
    "tokenized stocks (AAPL/TSLA/NVDA) + memes, and the $SWOOD token (fee discounts, staking revenue-share, governance). " +
    `Non-custodial; keys derive from a wallet signature and never leave the browser. Leave no trace. → ${SITE}`
  ),
});

const swoodUtility = new GameFunction({
  name: "get_swood_utility",
  description: "Explain the $SWOOD token utility (fee discounts, staking/revenue-share, governance) and report live total staked.",
  args: [] as const,
  executable: async (_a, logger) => {
    try {
      const total = (await pc.readContract({ address: getAddress(A.staking), abi: STAKING_ABI, functionName: "totalStaked" })) as bigint;
      logger(`totalStaked=${total}`);
      return ok(
        "$SWOOD (CA " + A.SWOOD + ") powers the Sherwood economy:\n" +
        "• Fee discounts — public-swap fee 0.30% base → 0.15% at 100k → 0% at 1M $SWOOD held.\n" +
        "• Revenue share — stake $SWOOD to earn a share of protocol swap fees, streamed in USDG.\n" +
        "• Governance — staked $SWOOD is voting power on listings + protocol params.\n" +
        `Total staked right now: ${Number(formatUnits(total, 18)).toLocaleString()} $SWOOD. Stake/vote → ${SITE}/#/stake`
      );
    } catch (e: any) { return fail(`read failed: ${e.message}`); }
  },
});

const stakingStats = new GameFunction({
  name: "get_staking_stats",
  description: "Report $SWOOD staking stats: total staked, reward rate, and — if a wallet address is given — that wallet's stake, claimable USDG, and share.",
  args: [{ name: "address", description: "Optional wallet address (0x…) to report personal staking stats for" }] as const,
  executable: async (args, logger) => {
    try {
      const total = (await pc.readContract({ address: getAddress(A.staking), abi: STAKING_ABI, functionName: "totalStaked" })) as bigint;
      let personal = "";
      if (args.address && /^0x[0-9a-fA-F]{40}$/.test(String(args.address))) {
        const a = getAddress(String(args.address));
        const [st, ea] = await Promise.all([
          pc.readContract({ address: getAddress(A.staking), abi: STAKING_ABI, functionName: "stakedOf", args: [a] }) as Promise<bigint>,
          pc.readContract({ address: getAddress(A.staking), abi: STAKING_ABI, functionName: "earned", args: [a] }) as Promise<bigint>,
        ]);
        const share = total > 0n ? (Number(st) / Number(total)) * 100 : 0;
        personal = ` | ${a.slice(0, 8)}…: ${Number(formatUnits(st, 18)).toLocaleString()} staked (${share.toFixed(2)}%), ${Number(formatUnits(ea, 6)).toFixed(4)} USDG claimable`;
      }
      logger(`total=${total}`);
      return ok(`Total staked: ${Number(formatUnits(total, 18)).toLocaleString()} $SWOOD.${personal} Stake → ${SITE}/#/stake`);
    } catch (e: any) { return fail(`read failed: ${e.message}`); }
  },
});

const feeTier = new GameFunction({
  name: "get_fee_tier",
  description: "Report the public-swap protocol fee (in %) a given wallet currently pays, based on its $SWOOD balance.",
  args: [{ name: "address", description: "Wallet address (0x…) to check the fee tier for" }] as const,
  executable: async (args) => {
    try {
      if (!args.address || !/^0x[0-9a-fA-F]{40}$/.test(String(args.address))) return fail("provide a valid 0x address");
      const a = getAddress(String(args.address));
      const bps = (await pc.readContract({ address: getAddress(A.aggRouter), abi: AGG_ABI, functionName: "feeBpsFor", args: [a] })) as bigint;
      const bal = (await pc.readContract({ address: getAddress(A.SWOOD), abi: ERC20, functionName: "balanceOf", args: [a] })) as bigint;
      return ok(`${a.slice(0, 8)}… holds ${Number(formatUnits(bal, 18)).toLocaleString()} $SWOOD → public-swap fee ${(Number(bps) / 100).toFixed(2)}%${bps === 0n ? " (zero — 1M+ holder)" : ". Hold more $SWOOD to cut it (0.15% at 100k, 0% at 1M)."}`);
    } catch (e: any) { return fail(`read failed: ${e.message}`); }
  },
});

const governance = new GameFunction({
  name: "get_governance",
  description: "List the latest Sherwood governance proposals and their live vote tallies (staked-$SWOOD-weighted).",
  args: [] as const,
  executable: async (_a, logger) => {
    try {
      const count = Number(await pc.readContract({ address: getAddress(A.governor), abi: GOV_ABI, functionName: "proposalCount" }));
      logger(`proposalCount=${count}`);
      if (count === 0) return ok(`No governance proposals yet. Stake 100k+ $SWOOD to open the first one → ${SITE}/#/govern`);
      const lines: string[] = [];
      for (let i = count - 1; i >= 0 && i >= count - 5; i--) {
        const p = (await pc.readContract({ address: getAddress(A.governor), abi: GOV_ABI, functionName: "proposals", args: [BigInt(i)] })) as any;
        const forV = p.forVotes ?? p[4], againstV = p.againstVotes ?? p[5];
        const tot = forV + againstV;
        const pct = tot > 0n ? Number((forV * 100n) / tot) : 0;
        lines.push(`#${i}: "${(p.description ?? p[1]).slice(0, 80)}" — ${pct}% for`);
      }
      return ok(`Governance (${count} proposals): ${lines.join(" | ")}. Vote → ${SITE}/#/govern`);
    } catch (e: any) { return fail(`read failed: ${e.message}`); }
  },
});

const tokenUniverse = new GameFunction({
  name: "get_token_universe",
  description: "Report how many tokens are tradable on the Sherwood public aggregator, and optionally search for a token by name/symbol.",
  args: [{ name: "query", description: "Optional token name or symbol to search for" }] as const,
  executable: async (args) => {
    try {
      const list = (await (await fetch(`${SITE}/tokenlist.json`)).json()) as Array<{ symbol: string; name: string; address: string }>;
      const q = String(args.query ?? "").trim().toLowerCase();
      if (!q) return ok(`Sherwood's public aggregator routes ${list.length}+ Robinhood Chain tokens (v2/v3/v4), plus any token by pasting its address. Swap → ${SITE}/#/swap`);
      const hits = list.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).slice(0, 8);
      if (!hits.length) return ok(`No listed token matches "${q}". You can still swap it by pasting its address at ${SITE}/#/swap`);
      return ok(`Matches for "${q}": ${hits.map((t) => `${t.symbol} (${t.name})`).join(", ")}. Swap → ${SITE}/#/swap`);
    } catch (e: any) { return fail(`fetch failed: ${e.message}`); }
  },
});

const bridgeInfo = new GameFunction({
  name: "get_bridge_info",
  description: "Explain Sherwood's Private Bridge and list how many chains it reaches (via Relay).",
  args: [] as const,
  executable: async (_a, logger) => {
    try {
      const chains = (await (await fetch("https://api.relay.link/chains")).json())?.chains ?? [];
      const n = Array.isArray(chains) ? chains.filter((c: any) => c.vmType === "evm").length : 68;
      logger(`relay chains=${n}`);
      return ok(
        `Sherwood's Private Bridge moves value in/out of Robinhood Chain to ${n}+ chains via Relay. ` +
        `Bridge-out unshields via the relayer to a fresh, gas-seeded address (never your main wallet) then bridges — nothing links it to your shielded pool. Bridge-in lands shielded. → ${SITE}/#/bridge`
      );
    } catch (e: any) { return fail(`fetch failed: ${e.message}`); }
  },
});

const liveSwapQuote = new GameFunction({
  name: "get_live_quote",
  description: "Get a live indicative swap price on Sherwood: how much token_out you get for a given amount of token_in, routed through the ETH hub (v2/v3/v4). Tokens are symbols (ETH, USDG, AAPL, SWOOD, …) or 0x addresses.",
  args: [
    { name: "token_in", description: "Token to sell — a symbol (ETH, USDG, AAPL, TSLA, NVDA, SWOOD, VIRTUAL, …) or a 0x address" },
    { name: "token_out", description: "Token to buy — a symbol or a 0x address" },
    { name: "amount", description: "Human amount of token_in to sell, e.g. \"1\" or \"250\"" },
  ] as const,
  executable: async (args, logger) => {
    try {
      if (!args.token_in || !args.token_out || !args.amount) return fail("provide token_in, token_out and amount");
      const q = await liveQuote(String(args.token_in), String(args.token_out), String(args.amount));
      logger(`${q.amountIn} ${q.inSym} -> ${q.amountOut} ${q.outSym}`);
      return ok(
        `Live quote: ${q.amountIn} ${q.inSym} → ~${q.amountOut} ${q.outSym}${q.usd ? ` (≈ $${q.usd})` : ""}. ` +
        `${q.rate}. Indicative on-chain spot (excl. gas/slippage; public-swap fee 0–0.30% by $SWOOD held). Swap → ${SITE}/#/swap`
      );
    } catch (e: any) { return fail(`quote failed: ${e.message}`); }
  },
});

const liveBridgeQuote = new GameFunction({
  name: "get_bridge_quote",
  description: "Get a live indicative Private Bridge quote: how much ETH lands on a destination chain when bridging ETH out of Robinhood Chain via Relay.",
  args: [
    { name: "amount", description: "Human amount of ETH to bridge out, e.g. \"0.1\"" },
    { name: "chain", description: "Destination chain — a name (base, arbitrum, optimism, ethereum, …) or numeric chain id" },
  ] as const,
  executable: async (args, logger) => {
    try {
      if (!args.amount || !args.chain) return fail("provide amount and chain");
      const q = await bridgeQuote(String(args.amount), String(args.chain));
      logger(`bridge ${args.amount} ETH -> ${q.chain}`);
      return ok(
        `Bridge ${args.amount} ETH → ${q.chain}: receive ~${q.outAmount} ${q.outSym}` +
        `${q.feeUsd != null ? `, fee ≈ $${q.feeUsd.toFixed(2)}` : ""}${q.etaSec != null ? `, ~${q.etaSec}s` : ""}. ` +
        `Indicative (via Relay). Sherwood unshields to a fresh gas-seeded address first, so nothing links it to your pool. → ${SITE}/#/bridge`
      );
    } catch (e: any) { return fail(`bridge quote failed: ${e.message}`); }
  },
});

// Core Robinhood Chain assets checked by the portfolio reader.
const PORTFOLIO_TOKENS: Array<{ symbol: string; address: string; decimals: number }> = [
  { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
  { symbol: "SWOOD", address: A.SWOOD, decimals: 18 },
  { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18 },
  { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18 },
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18 },
  { symbol: "VIRTUAL", address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", decimals: 18 },
  { symbol: "CASHCAT", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", decimals: 18 },
  { symbol: "HOODRAT", address: "0x8e62F281f282686fCa6dCB39288069a93fC23F1c", decimals: 18 },
  { symbol: "VEX", address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", decimals: 18 },
  { symbol: "JUGGERNAUT", address: "0xD7321801CAae694090694Ff55A9323139F043B88", decimals: 18 },
];
const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const portfolio = new GameFunction({
  name: "get_portfolio",
  description: "Report a wallet's holdings on Robinhood Chain: ETH + Sherwood token balances and their USD value (priced via Sherwood quotes). For any 0x address.",
  args: [{ name: "address", description: "Wallet 0x address to analyze on Robinhood Chain" }] as const,
  executable: async (args, logger) => {
    try {
      if (!args.address || !/^0x[0-9a-fA-F]{40}$/.test(String(args.address))) return fail("provide a valid 0x address");
      const a = getAddress(String(args.address));
      const eth = (await pc.getBalance({ address: a })) as bigint;
      const bals = await Promise.all(PORTFOLIO_TOKENS.map((t) =>
        pc.readContract({ address: getAddress(t.address), abi: ERC20, functionName: "balanceOf", args: [a] }).catch(() => 0n) as Promise<bigint>));
      const held = PORTFOLIO_TOKENS.map((t, i) => ({ ...t, bal: bals[i] })).filter((t) => t.bal > 0n);
      logger(`eth=${eth} held=${held.length}`);

      const lines: string[] = []; let totalUsd = 0;
      if (eth > 0n) {
        let usd = 0; try { const q = await quotePublic(await resolveToken("ETH"), await resolveToken("USDG"), eth); usd = q ? Number(formatUnits(q, 6)) : 0; } catch { /* */ }
        totalUsd += usd; lines.push(`ETH ${Number(formatEther(eth)).toLocaleString(undefined, { maximumFractionDigits: 6 })}${usd ? ` (≈ $${usd.toFixed(2)})` : ""}`);
      }
      for (const t of held) {
        const amt = Number(formatUnits(t.bal, t.decimals));
        let usd = 0;
        if (t.address.toLowerCase() === USDG_ADDR.toLowerCase()) usd = amt;
        else { try { const q = await quotePublic(await resolveToken(t.symbol), await resolveToken("USDG"), t.bal); usd = q ? Number(formatUnits(q, 6)) : 0; } catch { /* illiquid */ } }
        totalUsd += usd;
        lines.push(`${t.symbol} ${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })}${usd ? ` (≈ $${usd.toFixed(2)})` : ""}`);
      }
      if (!lines.length) return ok(`${a.slice(0, 8)}… holds no ETH or listed Sherwood tokens on Robinhood Chain.`);
      return ok(`${a.slice(0, 8)}… on Robinhood Chain — total ≈ $${totalUsd.toFixed(2)}: ${lines.join(", ")}. (Sherwood-listed assets; priced via on-chain quotes.) → ${SITE}`);
    } catch (e: any) { return fail(`portfolio read failed: ${e.message}`); }
  },
});

// ---- worker + agent ----
/** All economy functions, exported so they can also be run standalone (see ask.ts) without GAME. */
export const economyFunctions = [explainSherwood, swoodUtility, stakingStats, feeTier, governance, tokenUniverse, bridgeInfo, liveSwapQuote, liveBridgeQuote, portfolio];

/** Run one economy function by name, off the GAME loop — returns its feedback string. */
export async function callByName(name: string, args: Record<string, string> = {}): Promise<string> {
  const fn = economyFunctions.find((f) => f.name === name);
  if (!fn) throw new Error(`unknown function "${name}". Available: ${economyFunctions.map((f) => f.name).join(", ")}`);
  const resp: any = await fn.executable(args as any, (m: string) => console.error(`  · ${m}`));
  return resp?.feedback ?? String(resp);
}

const economyWorker = new GameWorker({
  id: "sherwood_economy",
  name: "Sherwood Economy",
  description: "Reads Sherwood's live on-chain economy on Robinhood Chain: live swap/bridge quotes, the aggregator, $SWOOD utility, staking revenue-share, governance, the private bridge, and the token universe.",
  functions: economyFunctions,
});

// ---- optional X / Twitter worker (A) ----
// Auth once to get an access token:  npx @virtuals-protocol/game-twitter-node auth -k <GAME_API_KEY>
// then put the printed apx-… token in .env as GAME_TWITTER_ACCESS_TOKEN. Without it, economyOS runs
// read-only (no posting). economyOS composes posts from its live economy functions — never invents figures.
const workers: any[] = [economyWorker];
if (process.env.GAME_TWITTER_ACCESS_TOKEN) {
  try {
    const token = process.env.GAME_TWITTER_ACCESS_TOKEN;
    const pluginMod: any = await import("@virtuals-protocol/game-twitter-plugin");
    // CJS/ESM interop: the real class lands at .default.default in this build.
    const TwitterPlugin = pluginMod.default?.default ?? pluginMod.default ?? pluginMod.TwitterPlugin;
    // The GAME-hosted access token (apx-…) is passed as gameTwitterAccessToken to TwitterApi.
    const { TwitterApi } = await import("@virtuals-protocol/game-twitter-node");
    const twitterClient = new (TwitterApi as any)({ gameTwitterAccessToken: token });
    const twitterPlugin = new TwitterPlugin({ twitterClient });
    workers.push(twitterPlugin.getWorker());
    console.log("[economyOS] X worker enabled — economyOS can post/reply on X.");
  } catch (e: any) {
    console.log(`[economyOS] X worker not loaded (${e.message}). Run: npm i @virtuals-protocol/game-twitter-plugin @virtuals-protocol/game-twitter-node`);
  }
}

export const economyOS = new GameAgent(process.env.GAME_API_KEY!, {
  name: "economyOS",
  goal: "Be the economic operating system for Sherwood: inform people accurately about the private-DEX economy on Robinhood Chain, quote live state (live swap/bridge prices, $SWOOD utility, staking, governance, token universe), and grow understanding + participation. When an X worker is available, post concise, substantive updates and reply to questions — always grounded in live numbers from your functions, never hype without substance.",
  description: "You are economyOS, the on-chain economic agent for Sherwood — a privacy DEX on Robinhood Chain. Voice: precise, calm, a little mysterious ('leave no trace'). You explain private swaps, the any-token aggregator, tokenized stocks, the private bridge, and $SWOOD utility (fee discounts, staking revenue-share, governance), and you can quote live swap/bridge prices. You read live state via your functions and never invent numbers. If you can post on X, keep posts short, specific, and true to on-chain data. You never give financial advice; you explain how the system works.",
  workers,
  getAgentState: async () => {
    const total = (await pc.readContract({ address: getAddress(A.staking), abi: STAKING_ABI, functionName: "totalStaked" }).catch(() => 0n)) as bigint;
    return { chain: "Robinhood Chain (4663)", site: SITE, swood: A.SWOOD, total_staked_swood: formatUnits(total, 18) };
  },
});

economyOS.setLogger((a, msg) => console.log(`[${a.name}] ${msg}`));

// Run the GAME loop only when this file is the entrypoint (so ask.ts can import it safely).
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

/** Init with backoff — GAME's reasoning backend (/v2/maps) can 503 during platform upgrades. */
async function startLoop() {
  const MAX = 8;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      await economyOS.init();
      console.log("[economyOS] initialised — starting heartbeat (60s).");
      await economyOS.run(60, { verbose: true });
      return;
    } catch (e: any) {
      const code = e?.response?.status;
      const upgrading = code === 400 || code === 503 || /503|Temporarily Unavailable|Bad Request/i.test(e?.message ?? "");
      const wait = Math.min(60, 5 * attempt);
      console.error(
        `[economyOS] init failed (attempt ${attempt}/${MAX}${code ? `, HTTP ${code}` : ""}). ` +
        (upgrading
          ? "GAME's reasoning backend is temporarily unavailable — it's being upgraded (see app.virtuals.io). "
          : `${e?.message ?? e}. `) +
        `Retrying in ${wait}s. Meanwhile economyOS's functions work offline: \`npm run ask -- get_live_quote ETH USDG 1\``
      );
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  console.error("[economyOS] GAME loop could not start after retries. The functions still work standalone via `npm run ask`. Try again once GAME's upgrade completes.");
  process.exitCode = 1;
}

if (isEntry) {
  if (process.env.GAME_API_KEY) startLoop();
  else console.log("economyOS built. Set GAME_API_KEY (from Virtuals) in .env to run the agent loop, or use `npm run ask` to call functions offline.");
}
