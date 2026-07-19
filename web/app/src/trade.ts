// Public-swap executor shared by the WOODIE trading app's quick-trade panel. This is the exact
// AggRouter path the Swap page and WOODIE's confirm cards use: resolve each token's routing spoke,
// approve-if-needed, simulate the swap to learn the *deliverable* out amount (the off-chain quote
// misses the $SWOOD-tiered protocol fee and any transfer tax), then floor 0.5% under it and send.
import {
  createPublicClient, createWalletClient, custom, maxUint256, parseUnits, formatUnits, getAddress,
  type Address, type PublicClient,
} from "viem";
import { chainById, ERC20_ABI } from "@sherwood/client";
import type { NetworkConfig, TokenInfo } from "./config";
import { rpcTransport } from "./config";
import { quotePublic, quotePublicRoute, resolveSpoke, isHub, WETH, NATIVE as AGG_NATIVE, type AggToken, type RouteQuote } from "./aggregator";
import { quoteRoute } from "./routing";
import { AGG_ABI, spokeArg } from "./PublicSwap";

const PUB_SLIP_BPS = 100n; // 1% fallback slippage when simulation is unavailable

export function publicClientFor(net: NetworkConfig): PublicClient {
  return createPublicClient({ chain: chainById(net.chainId), transport: rpcTransport(net) }) as PublicClient;
}

/** Resolve a config TokenInfo into an AggToken (address + routing spoke) for the aggregator. */
export async function toAggToken(pc: PublicClient, t: TokenInfo): Promise<AggToken> {
  const address = (t.native ? AGG_NATIVE : t.address) as Address;
  const base = { address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals };
  if (isHub(address)) return { ...base, spoke: null };
  const spoke = await resolveSpoke(pc, address, t.decimals);
  if (!spoke) throw new Error(`No public liquidity route for ${t.symbol}.`);
  return { ...base, spoke };
}

/** Live public-quote: how much `tokenOut` you'd receive for `amountIn` of `tokenIn`. null = no route. */
export async function quoteTrade(pc: PublicClient, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<bigint | null> {
  if (amountIn <= 0n) return 0n;
  const [ain, aout] = await Promise.all([toAggToken(pc, tokenIn), toAggToken(pc, tokenOut)]);
  return quotePublic(pc, ain, aout, amountIn);
}

/** Shielded-swap quote — the pool routes through the same public liquidity (see quoteRoute), used to
 *  derive a minOut for swapMulti. Mirrors WOODIE's shielded_swap path. null = no route. */
export async function quoteShielded(net: NetworkConfig, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<bigint | null> {
  if (amountIn <= 0n) return 0n;
  const pc = publicClientFor(net);
  return quoteRoute(pc as any, tokenIn.address as Address, tokenOut.address as Address, amountIn);
}

/** On-chain USD prices (via quoteRoute → USDG) for tokens DexScreener doesn't index. Keyed by
 *  lowercase token address (native → WETH). Same pricing path the Portfolio page uses. */
export async function fetchUsdPrices(net: NetworkConfig, tokens: TokenInfo[]): Promise<Record<string, number>> {
  const usdg = net.tokens.find((t) => t.symbol === "USDG");
  if (!usdg) return {};
  const pc = publicClientFor(net);
  const out: Record<string, number> = {};
  await Promise.all(tokens.map(async (t) => {
    const key = (t.native ? WETH : t.address).toLowerCase();
    try {
      if (t.symbol === "USDG") { out[key] = 1; return; }
      const q = await quoteRoute(pc as any, (t.native ? WETH : t.address) as Address, usdg.address as Address, parseUnits("1", t.decimals));
      if (q && q > 0n) out[key] = Number(formatUnits(q, usdg.decimals));
    } catch { /* no route — leave unpriced */ }
  }));
  return out;
}

const ERC_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Resolve an arbitrary token address into a TokenInfo (symbol/name/decimals) so it can be traded
 *  even when it isn't on the Sherwood allowlist. null if the address is malformed / not a token. */
export async function importToken(net: NetworkConfig, address: string): Promise<TokenInfo | null> {
  let addr: Address;
  try { addr = getAddress(address) as Address; } catch { return null; }
  const pc = publicClientFor(net);
  try {
    const [symbol, name, decimals] = await Promise.all([
      pc.readContract({ address: addr, abi: ERC_META, functionName: "symbol" }).catch(() => addr.slice(2, 8).toUpperCase()),
      pc.readContract({ address: addr, abi: ERC_META, functionName: "name" }).catch(() => "Imported token"),
      pc.readContract({ address: addr, abi: ERC_META, functionName: "decimals" }).catch(() => 18),
    ]);
    return { symbol: String(symbol), address: addr, decimals: Number(decimals), name: String(name) } as TokenInfo;
  } catch { return null; }
}

export interface RouteAnalysis { pub: RouteQuote; privateOut: bigint | null; }
/** Multirouter analysis: best public route across every DEX + the private (shielded) quote, so the
 *  UI can show the winning venue, alternatives, price impact, and a public-vs-private comparison. */
export async function analyzeRoute(net: NetworkConfig, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<RouteAnalysis> {
  const pc = publicClientFor(net);
  const mk = (t: TokenInfo): AggToken => ({ address: (t.native ? AGG_NATIVE : t.address) as Address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals });
  const [pub, privateOut] = await Promise.all([
    quotePublicRoute(pc, mk(tokenIn), mk(tokenOut), amountIn),
    quoteRoute(pc as any, tokenIn.address as Address, tokenOut.address as Address, amountIn).catch(() => null),
  ]);
  return { pub, privateOut };
}

/** Public send — native ETH transfer or ERC-20 transfer to a clear 0x address. */
export async function executeTransfer(opts: {
  net: NetworkConfig; walletProvider: any; address: Address; token: TokenInfo; amount: bigint; to: string;
}): Promise<{ hash: `0x${string}` }> {
  const { net, walletProvider, address, token, amount, to } = opts;
  if (!walletProvider || !address) throw new Error("Connect your wallet first.");
  let dest: Address;
  try { dest = getAddress(to) as Address; } catch { throw new Error("That doesn't look like a valid address."); }
  const pc = publicClientFor(net);
  const wc = createWalletClient({ account: address, chain: chainById(net.chainId), transport: custom(walletProvider) });
  try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* wallet handles */ }
  const hash = token.native
    ? await wc.sendTransaction({ to: dest, value: amount, chain: chainById(net.chainId), account: address } as any)
    : await wc.writeContract({ address: token.address as Address, abi: ERC20_ABI, functionName: "transfer", args: [dest, amount] });
  await pc.waitForTransactionReceipt({ hash });
  return { hash };
}

export interface SwapResult { hash: `0x${string}`; }

/** Execute a public swap through the AggRouter. onStage reports "approve"/"swap" for UI toasts. */
export async function executePublicSwap(opts: {
  net: NetworkConfig; walletProvider: any; address: Address;
  tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: bigint;
  onStage?: (stage: "approve" | "swap") => void;
}): Promise<SwapResult> {
  const { net, walletProvider, address, tokenIn, tokenOut, amountIn } = opts;
  if (!net.aggRouter) throw new Error("Public swaps aren't configured on this network.");
  if (!walletProvider || !address) throw new Error("Connect your wallet first.");

  const pc = publicClientFor(net);
  const [ain, aout] = await Promise.all([toAggToken(pc, tokenIn), toAggToken(pc, tokenOut)]);
  const value = amountIn;
  const expected = await quotePublic(pc, ain, aout, value);
  if (expected == null || expected <= 0n) throw new Error("No route for that pair right now.");

  const wc = createWalletClient({ account: address, chain: chainById(net.chainId), transport: custom(walletProvider) });
  try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + net.chainId.toString(16) }] }); } catch { /* wallet handles manually */ }

  if (ain.address !== AGG_NATIVE) {
    const allow = (await pc.readContract({ address: ain.address, abi: ERC20_ABI, functionName: "allowance", args: [address, net.aggRouter as Address] })) as bigint;
    if (allow < value) {
      opts.onStage?.("approve");
      const ah = await wc.writeContract({ address: ain.address, abi: ERC20_ABI, functionName: "approve", args: [net.aggRouter as Address, maxUint256] });
      await pc.waitForTransactionReceipt({ hash: ah });
    }
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const swapArgs = (minOut: bigint) =>
    [ain.address, spokeArg(ain), aout.address, spokeArg(aout), value, minOut, deadline, address] as const;

  let minOut: bigint;
  try {
    const { result } = await pc.simulateContract({
      account: address, address: net.aggRouter as Address, abi: AGG_ABI, functionName: "swap",
      args: swapArgs(0n) as any, value: ain.address === AGG_NATIVE ? value : 0n,
    });
    minOut = ((result as bigint) * (10000n - 50n)) / 10000n; // 0.5% under the deliverable amount
  } catch {
    const feeBps = (await pc.readContract({
      address: net.aggRouter as Address,
      abi: [{ name: "feeBpsFor", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "feeBpsFor", args: [address],
    }).catch(() => 30n)) as bigint;
    const netOut = (expected * (10000n - feeBps)) / 10000n;
    minOut = (netOut * (10000n - PUB_SLIP_BPS)) / 10000n;
  }

  opts.onStage?.("swap");
  const hash = await wc.writeContract({
    address: net.aggRouter as Address, abi: AGG_ABI, functionName: "swap",
    args: swapArgs(minOut) as any, value: ain.address === AGG_NATIVE ? value : 0n,
  });
  await pc.waitForTransactionReceipt({ hash });
  return { hash };
}
