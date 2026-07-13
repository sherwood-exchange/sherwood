// Live quoting for economyOS — self-contained port of Sherwood's public aggregator routing
// (web/app/src/aggregator.ts) plus Relay bridge quotes. Any token routes to any other through the
// native-ETH hub: tokenIn -> ETH -> tokenOut, with each side's "spoke" (v4/v3/v2, or a 2-hop v2 via
// an intermediate token like $SWOOD -> VIRTUAL -> WETH) resolved on-demand. Mirrors AggRouter.sol so
// indicative quotes track on-chain execution.
import { createPublicClient, http, formatUnits, parseUnits, getAddress, type Address, type PublicClient } from "viem";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SITE = "https://sherwood.spot";
export const pc: PublicClient = createPublicClient({ transport: http(RPC) });

export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const V3_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const V2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f";
const ZERO = "0x0000000000000000000000000000000000000000";

const lc = (a: string) => a.toLowerCase();
export const isHub = (a: string) => lc(a) === lc(WETH) || lc(a) === lc(NATIVE);

/** How to swap a token to/from the ETH hub. kind: 0=v4, 1=v3, 2=v2, 3=v2 two-hop via `via`. */
export interface Spoke { kind: 0 | 1 | 2 | 3; pool: Address; fee: number; ts: number; via?: Address; pool2?: Address; }
export interface Tok { address: Address; symbol: string; name: string; decimals: number; spoke?: Spoke | null; }

const V4_PK = { name: "poolKey", type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
const V4_ABI = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "tuple", components: [V4_PK, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
  outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;
const V3_ABI = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }] as const;
const V3_FAC_ABI = [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }] as const;
const V2_FAC_ABI = [{ type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] }] as const;
const V2_PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;

const V4_FEES: [number, number][] = [[500, 10], [3000, 60], [10000, 200], [50000, 1000], [100, 1]];
const V3_FEES = [3000, 10000, 500, 100];

async function v4Quote(c: PublicClient, cin: string, erc20: string, fee: number, ts: number, amt: bigint): Promise<bigint> {
  const { result } = await c.simulateContract({ address: V4_QUOTER as Address, abi: V4_ABI, functionName: "quoteExactInputSingle",
    args: [{ poolKey: { currency0: NATIVE as Address, currency1: erc20 as Address, fee, tickSpacing: ts, hooks: NATIVE as Address }, zeroForOne: lc(cin) === lc(NATIVE), exactAmount: amt, hookData: "0x" }] }) as { result: readonly [bigint, bigint] };
  return result[0];
}
async function v3Quote(c: PublicClient, tin: string, tout: string, fee: number, amt: bigint): Promise<bigint> {
  const { result } = await c.simulateContract({ address: V3_QUOTER as Address, abi: V3_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: tin as Address, tokenOut: tout as Address, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] }) as { result: readonly [bigint, ...unknown[]] };
  return result[0];
}
async function v2Quote(c: PublicClient, pair: string, tin: string, amt: bigint): Promise<bigint> {
  const [r, t0] = await Promise.all([
    c.readContract({ address: pair as Address, abi: V2_PAIR_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
    c.readContract({ address: pair as Address, abi: V2_PAIR_ABI, functionName: "token0" }) as Promise<Address>]);
  const [rIn, rOut] = lc(tin) === lc(t0) ? [r[0], r[1]] : [r[1], r[0]];
  const f = amt * 997n;
  return (f * rOut) / (rIn * 1000n + f);
}

/** Resolve the deepest way to swap `token` <-> ETH (v4/v3/v2), or null for the WETH/native hub. */
export async function resolveSpoke(c: PublicClient, token: string, decimals: number): Promise<Spoke | null> {
  if (isHub(token)) return null;
  const ref = 10n ** BigInt(decimals);
  let best: { out: bigint; spoke: Spoke } | null = null;
  const consider = (out: bigint, spoke: Spoke) => { if (out > 0n && (!best || out > best!.out)) best = { out, spoke }; };
  await Promise.all(V4_FEES.map(async ([fee, ts]) => { try { consider(await v4Quote(c, token, token, fee, ts, ref), { kind: 0, pool: ZERO as Address, fee, ts }); } catch { /* no pool */ } }));
  const v3pools = await Promise.all(V3_FEES.map((fee) => c.readContract({ address: V3_FACTORY as Address, abi: V3_FAC_ABI, functionName: "getPool", args: [token as Address, WETH as Address, fee] }).catch(() => ZERO as Address)));
  await Promise.all(V3_FEES.map(async (fee, i) => { if (lc(v3pools[i] as string) === lc(ZERO)) return; try { consider(await v3Quote(c, token, WETH, fee, ref), { kind: 1, pool: v3pools[i] as Address, fee, ts: 0 }); } catch { /* */ } }));
  try {
    const pair = (await c.readContract({ address: V2_FACTORY as Address, abi: V2_FAC_ABI, functionName: "getPair", args: [token as Address, WETH as Address] })) as Address;
    if (lc(pair) !== lc(ZERO)) consider(await v2Quote(c, pair, token, ref), { kind: 2, pool: pair, fee: 0, ts: 0 });
  } catch { /* */ }
  return best ? best!.spoke : null;
}

async function toEth(c: PublicClient, t: Tok, amt: bigint): Promise<bigint> {
  if (isHub(t.address)) return amt;
  const s = t.spoke; if (!s) throw new Error(`no route for ${t.symbol}`);
  if (s.kind === 0) return v4Quote(c, t.address, t.address, s.fee, s.ts, amt);
  if (s.kind === 1) return v3Quote(c, t.address, WETH, s.fee, amt);
  if (s.kind === 2) return v2Quote(c, s.pool, t.address, amt);
  return v2Quote(c, s.pool2!, s.via!, await v2Quote(c, s.pool, t.address, amt)); // kind 3: token->via->WETH
}
async function fromEth(c: PublicClient, t: Tok, eth: bigint): Promise<bigint> {
  if (isHub(t.address)) return eth;
  const s = t.spoke; if (!s) throw new Error(`no route for ${t.symbol}`);
  if (s.kind === 0) return v4Quote(c, NATIVE, t.address, s.fee, s.ts, eth);
  if (s.kind === 1) return v3Quote(c, WETH, t.address, s.fee, eth);
  if (s.kind === 2) return v2Quote(c, s.pool, WETH, eth);
  return v2Quote(c, s.pool, s.via!, await v2Quote(c, s.pool2!, WETH, eth)); // kind 3: WETH->via->token
}

/** Expected output for a public tokenIn -> tokenOut swap through the ETH hub (raw units), or null. */
export async function quotePublic(tokenIn: Tok, tokenOut: Tok, amountIn: bigint): Promise<bigint | null> {
  try {
    if (amountIn <= 0n || lc(tokenIn.address) === lc(tokenOut.address)) return null;
    return await fromEth(pc, tokenOut, await toEth(pc, tokenIn, amountIn));
  } catch { return null; }
}

// ---- token resolution (symbol or address) via the bundled token list ----
let LIST: any[] | null = null;
async function list(): Promise<any[]> {
  if (LIST) return LIST;
  try { LIST = (await (await fetch(`${SITE}/tokenlist.json`)).json()) as any[]; } catch { LIST = []; }
  return LIST!;
}
const ALIASES: Record<string, Tok> = {
  ETH: { address: NATIVE as Address, symbol: "ETH", name: "Ether", decimals: 18, spoke: null },
  WETH: { address: WETH as Address, symbol: "WETH", name: "Wrapped Ether", decimals: 18, spoke: null },
};

/** Resolve a user-supplied symbol or 0x address into a routable token (spoke resolved on demand). */
export async function resolveToken(idOrSymbol: string): Promise<Tok> {
  const q = String(idOrSymbol || "").trim();
  if (!q) throw new Error("empty token");
  const up = q.toUpperCase();
  if (ALIASES[up]) return ALIASES[up];
  const items = await list();
  let e: any;
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) e = items.find((t) => lc(t.address) === lc(q));
  else e = items.find((t) => t.symbol?.toUpperCase() === up) || items.find((t) => t.symbol?.toUpperCase().includes(up) || t.name?.toUpperCase().includes(up));

  let address: Address, symbol: string, name: string, decimals: number, presetSpoke: Spoke | null | undefined;
  if (e) {
    address = getAddress(e.address); symbol = e.symbol; name = e.name || e.symbol; decimals = e.decimals ?? 18;
    presetSpoke = e.spoke ? { kind: e.spoke.kind, pool: e.spoke.pool, fee: e.spoke.fee ?? 0, ts: e.spoke.ts ?? 0, via: e.spoke.via, pool2: e.spoke.pool2 } : undefined;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    address = getAddress(q); symbol = up.slice(0, 6); name = "token";
    decimals = Number(await pc.readContract({ address, abi: ERC20, functionName: "decimals" }).catch(() => 18));
    try { symbol = String(await pc.readContract({ address, abi: ERC20, functionName: "symbol" })); } catch { /* */ }
  } else {
    throw new Error(`unknown token "${q}" — pass a symbol from the token list or a 0x address`);
  }
  if (isHub(address)) return { address, symbol, name, decimals, spoke: null };
  const spoke = presetSpoke !== undefined ? presetSpoke : await resolveSpoke(pc, address, decimals);
  if (!spoke) throw new Error(`no liquidity route found for ${symbol}`);
  return { address, symbol, name, decimals, spoke };
}

export interface QuoteResult { inSym: string; outSym: string; amountIn: string; amountOut: string; rate: string; usd?: string; }

/** Human-facing live swap quote for `amountIn` of `inId` -> `outId`. */
export async function liveQuote(inId: string, outId: string, amountIn: string): Promise<QuoteResult> {
  const tin = await resolveToken(inId);
  const tout = await resolveToken(outId);
  const amt = parseUnits(String(amountIn), tin.decimals);
  const out = await quotePublic(tin, tout, amt);
  if (out === null || out === 0n) throw new Error(`no quote for ${tin.symbol}->${tout.symbol} (illiquid or unroutable)`);
  const outH = Number(formatUnits(out, tout.decimals));
  const inH = Number(amountIn);
  const rate = inH > 0 ? outH / inH : 0;
  // best-effort USD: value the input in USDG unless it already is USDG
  let usd: string | undefined;
  try {
    if (lc(tin.address) === lc(USDG)) usd = inH.toFixed(2);
    else if (lc(tout.address) === lc(USDG)) usd = outH.toFixed(2);
    else {
      const usdg = await resolveToken(USDG);
      const u = await quotePublic(tin, usdg, amt);
      if (u && u > 0n) usd = Number(formatUnits(u, usdg.decimals)).toFixed(2);
    }
  } catch { /* usd optional */ }
  return {
    inSym: tin.symbol, outSym: tout.symbol,
    amountIn: inH.toLocaleString(undefined, { maximumFractionDigits: 6 }),
    amountOut: outH.toLocaleString(undefined, { maximumFractionDigits: 6 }),
    rate: `1 ${tin.symbol} ≈ ${rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tout.symbol}`,
    usd,
  };
}

// ---- bridge quote (Relay) ----
const RELAY = "https://api.relay.link";
const PLACEHOLDER = "0x1111111111111111111111111111111111111111"; // for indicative quotes only

export interface BridgeQuote { chain: string; outAmount: string; outSym: string; feeUsd?: number; etaSec?: number; }

/** Indicative Relay bridge quote: `amountEth` ETH out of Robinhood Chain to `destChainQuery`. */
export async function bridgeQuote(amountEth: string, destChainQuery: string): Promise<BridgeQuote> {
  const chains = (await (await fetch(`${RELAY}/chains`)).json())?.chains ?? [];
  const q = String(destChainQuery || "").trim().toLowerCase();
  const dest = chains.find((c: any) => String(c.id) === q || c.name?.toLowerCase() === q || c.displayName?.toLowerCase() === q || c.displayName?.toLowerCase().includes(q) || c.name?.toLowerCase().includes(q));
  if (!dest) throw new Error(`unknown destination chain "${destChainQuery}"`);
  const body = {
    user: PLACEHOLDER, recipient: PLACEHOLDER, originChainId: 4663, destinationChainId: dest.id,
    originCurrency: NATIVE, destinationCurrency: NATIVE, amount: parseUnits(String(amountEth), 18).toString(), tradeType: "EXACT_INPUT",
  };
  const r = await fetch(`${RELAY}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.message ?? j?.error ?? `Relay quote failed (${r.status})`);
  const out = j.details?.currencyOut;
  return {
    chain: dest.displayName ?? dest.name,
    outAmount: Number(formatUnits(BigInt(out?.amount ?? "0"), out?.currency?.decimals ?? 18)).toLocaleString(undefined, { maximumFractionDigits: 6 }),
    outSym: out?.currency?.symbol ?? "ETH",
    feeUsd: j.fees?.relayer?.amountUsd ? Number(j.fees.relayer.amountUsd) : undefined,
    etaSec: j.details?.timeEstimate,
  };
}
