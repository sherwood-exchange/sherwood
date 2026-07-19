// Public-aggregator quoting + routing (non-shielded "Swap" mode). Routes any token to any other
// through the native-ETH hub: tokenIn -> ETH -> tokenOut. Each side's "spoke" (how to swap that
// token to/from ETH) is resolved on-demand across Uniswap v4 (native-ETH pools), v3 and v2
// (WETH pools) — so ANY token on Robinhood Chain works, not just a bundled list. Mirrors
// AggRouter.sol so quotes match on-chain execution.
import type { Address, PublicClient } from "viem";

export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const NATIVE = "0x0000000000000000000000000000000000000000";
const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const V3_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const V2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f";
// Sherwood's OWN UniswapV2 factory — probed alongside so seeded Sherwood pairs can win routing
// (AggRouter executes any pair passed in the spoke; volume through these pairs counts as
// "Sherwood" on DexScreener/GeckoTerminal, which group by factory).
const SHERWOOD_V2_FACTORY = "0xA51e442369154e2204F8A165A92C5C71C53d6bfa";
const ZERO = "0x0000000000000000000000000000000000000000";

const lc = (a: string) => a.toLowerCase();
export const isHub = (a: string) => lc(a) === lc(WETH) || lc(a) === lc(NATIVE);

/** How to swap a token to/from the ETH hub. kind: 0=v4, 1=v3, 2=v2, 3=2-hop-via-VIRTUAL.
 *  `src` is a display-only venue label (not sent on-chain) so the UI can show which DEX won. */
export interface Spoke { kind: 0 | 1 | 2 | 3; pool: Address; fee: number; ts: number; via?: Address; pool2?: Address; src?: string; }
/** A single candidate route considered for one token↔ETH leg (for the "routes checked" comparison). */
export interface RouteCand { src: string; out: bigint; spoke: Spoke; }
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

/** A token in the public swap UI. `spoke` is resolved on selection (null for WETH/ETH hub). */
export interface AggToken { address: Address; symbol: string; name: string; decimals: number; logo?: string; fee?: number; ts?: number; spoke?: Spoke | null; }

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

const V4_FEES: [number, number][] = [[500, 10], [3000, 60], [10000, 200], [50000, 1000], [100, 1]];
const V3_FEES = [3000, 10000, 500, 100];

async function v4Quote(pc: PublicClient, cin: string, erc20: string, fee: number, ts: number, amt: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({ address: V4_QUOTER as Address, abi: V4_ABI, functionName: "quoteExactInputSingle",
    args: [{ poolKey: { currency0: NATIVE as Address, currency1: erc20 as Address, fee, tickSpacing: ts, hooks: NATIVE as Address }, zeroForOne: lc(cin) === lc(NATIVE), exactAmount: amt, hookData: "0x" }] }) as { result: readonly [bigint, bigint] };
  return result[0];
}
async function v3Quote(pc: PublicClient, tin: string, tout: string, fee: number, amt: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({ address: V3_QUOTER as Address, abi: V3_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: tin as Address, tokenOut: tout as Address, amountIn: amt, fee, sqrtPriceLimitX96: 0n }] }) as { result: readonly [bigint, ...unknown[]] };
  return result[0];
}
// feeNum defaults to 997 (0.3%); pass a lower value for non-standard pairs (SWOOD/VIRTUAL ~1.3% → 985).
async function v2Quote(pc: PublicClient, pair: string, tin: string, amt: bigint, feeNum = 997n): Promise<bigint> {
  const [r, t0] = await Promise.all([
    pc.readContract({ address: pair as Address, abi: V2_PAIR_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
    pc.readContract({ address: pair as Address, abi: V2_PAIR_ABI, functionName: "token0" }) as Promise<Address>]);
  const [rIn, rOut] = lc(tin) === lc(t0) ? [r[0], r[1]] : [r[1], r[0]];
  const f = amt * feeNum;
  return (f * rOut) / (rIn * 1000n + f);
}

// VIRTUAL hub for tokens with no direct WETH pair but a token/VIRTUAL v2 pair (e.g. $SWOOD).
// Routed token -> VIRTUAL -> WETH (kind 3). Spoke.fee carries the first-hop v2 fee numerator
// (997 unless the pair is non-standard). Add entries here for VIRTUAL-quoted tokens.
const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const PAIR_VIRTUAL_WETH = "0xd95e8e2Cd04c207625C6F23c974d365a5F3A91D3"; // VIRTUAL/WETH
const KIND3: Record<string, { pool: Address; fee: number }> = {
  // SWOOD via SWOOD/VIRTUAL pair (keeps ~1.3% → fee numerator 985)
  ["0xb1cb27f78b7335df8c3d8ebf0881a15bed6beb60"]: { pool: "0xabc83c3F04C3dEc51CE32F8aa83bE281E1B27Dad" as Address, fee: 985 },
};

const feePct = (fee: number) => `${(fee / 10000).toString()}%`; // v3/v4 fee is in pips (3000 = 0.3%)

// Extra v2-style DEX factories on Robinhood Chain (PancakeSwap, RobinSwap, SwapHood…). They're
// Uniswap-V2 forks so the same getPair/getReserves probing works; add addresses as they're found.
// AggRouter.sol executes any pair passed in the spoke, so a winning pool from any of these routes.
const EXTRA_V2: [string, string][] = [
  // [factoryAddress, "DEX name"] — e.g. ["0x…", "PancakeSwap v2"], ["0x…", "RobinSwap"]
];

/** Probe every DEX route for `token` <-> ETH and return ALL candidates (best-first) + the winner.
 *  Powers the multirouter comparison UI. `resolveSpoke` just takes `.best`. */
export async function resolveRoutes(pc: PublicClient, token: string, decimals: number, hint?: { fee?: number; ts?: number }): Promise<{ best: Spoke | null; cands: RouteCand[] }> {
  if (isHub(token)) return { best: null, cands: [] };
  const ref = 10n ** BigInt(decimals); // ~1 token
  const cands: RouteCand[] = [];
  const add = (src: string, out: bigint, spoke: Spoke) => { if (out > 0n) cands.push({ src, out, spoke: { ...spoke, src } }); };
  // v4 (native-ETH pools) — hint first, then the standard fee ladder
  const v4tiers = hint?.fee != null && hint?.ts != null ? [[hint.fee, hint.ts] as [number, number], ...V4_FEES] : V4_FEES;
  await Promise.all(v4tiers.map(async ([fee, ts]) => { try { add(`Uniswap v4 · ${feePct(fee)}`, await v4Quote(pc, token, token, fee, ts, ref), { kind: 0, pool: ZERO as Address, fee, ts }); } catch { /* no pool */ } }));
  // v3 (WETH pools)
  const v3pools = await Promise.all(V3_FEES.map((fee) => pc.readContract({ address: V3_FACTORY as Address, abi: V3_FAC_ABI, functionName: "getPool", args: [token as Address, WETH as Address, fee] }).catch(() => ZERO as Address)));
  await Promise.all(V3_FEES.map(async (fee, i) => { if (lc(v3pools[i]) === lc(ZERO)) return; try { add(`Uniswap v3 · ${feePct(fee)}`, await v3Quote(pc, token, WETH, fee, ref), { kind: 1, pool: v3pools[i], fee, ts: 0 }); } catch { /* */ } }));
  // v2 (WETH pair) — the original factory, Sherwood's own, and any extra forks; best output wins
  await Promise.all(([[V2_FACTORY, "Uniswap v2"], [SHERWOOD_V2_FACTORY, "Sherwood v2"], ...EXTRA_V2] as [string, string][]).map(async ([fac, name]) => {
    try {
      const pair = (await pc.readContract({ address: fac as Address, abi: V2_FAC_ABI, functionName: "getPair", args: [token as Address, WETH as Address] })) as Address;
      if (lc(pair) !== lc(ZERO)) add(name, await v2Quote(pc, pair, token, ref), { kind: 2, pool: pair, fee: 0, ts: 0 });
    } catch { /* no pair on this factory */ }
  }));
  // kind 3: token -> VIRTUAL -> WETH, for tokens with no direct WETH pair (e.g. $SWOOD)
  const k3 = KIND3[lc(token)];
  if (k3) {
    try {
      const out = await v2Quote(pc, PAIR_VIRTUAL_WETH, VIRTUAL, await v2Quote(pc, k3.pool, token, ref, BigInt(k3.fee)));
      add("2-hop · via VIRTUAL", out, { kind: 3, pool: k3.pool, fee: k3.fee, ts: 0, via: VIRTUAL as Address, pool2: PAIR_VIRTUAL_WETH as Address });
    } catch { /* */ }
  }
  // dedupe by venue label (keep the deepest), then sort best-first
  const bySrc = new Map<string, RouteCand>();
  for (const c of cands) { const p = bySrc.get(c.src); if (!p || c.out > p.out) bySrc.set(c.src, c); }
  const uniq = [...bySrc.values()].sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  return { best: uniq[0]?.spoke ?? null, cands: uniq };
}

/** Resolve the single best token<->ETH spoke (back-compat wrapper over resolveRoutes). */
export async function resolveSpoke(pc: PublicClient, token: string, decimals: number, hint?: { fee?: number; ts?: number }): Promise<Spoke | null> {
  return (await resolveRoutes(pc, token, decimals, hint)).best;
}

async function toEth(pc: PublicClient, t: AggToken, amt: bigint): Promise<bigint> {
  if (isHub(t.address)) return amt;
  const s = t.spoke; if (!s) throw new Error("unresolved spoke");
  if (s.kind === 0) return v4Quote(pc, t.address, t.address, s.fee, s.ts, amt);
  if (s.kind === 1) return v3Quote(pc, t.address, WETH, s.fee, amt); // WETH ≈ ETH (unwrap 1:1)
  if (s.kind === 2) return v2Quote(pc, s.pool, t.address, amt, BigInt(s.fee || 997));
  // kind 3: token -> via -> WETH (first hop may be non-standard fee, second is standard)
  return v2Quote(pc, s.pool2!, s.via!, await v2Quote(pc, s.pool, t.address, amt, BigInt(s.fee || 997)));
}
async function fromEth(pc: PublicClient, t: AggToken, eth: bigint): Promise<bigint> {
  if (isHub(t.address)) return eth;
  const s = t.spoke; if (!s) throw new Error("unresolved spoke");
  if (s.kind === 0) return v4Quote(pc, NATIVE, t.address, s.fee, s.ts, eth);
  if (s.kind === 1) return v3Quote(pc, WETH, t.address, s.fee, eth);
  if (s.kind === 2) return v2Quote(pc, s.pool, WETH, eth, BigInt(s.fee || 997));
  // kind 3: WETH -> via -> token (second hop into the token may be non-standard fee)
  return v2Quote(pc, s.pool, s.via!, await v2Quote(pc, s.pool2!, WETH, eth), BigInt(s.fee || 997));
}

/** Expected output for a public tokenIn -> tokenOut swap through the ETH hub, or null on failure. */
export async function quotePublic(pc: PublicClient, tokenIn: AggToken, tokenOut: AggToken, amountIn: bigint): Promise<bigint | null> {
  try {
    if (amountIn <= 0n || lc(tokenIn.address) === lc(tokenOut.address)) return null;
    return await fromEth(pc, tokenOut, await toEth(pc, tokenIn, amountIn));
  } catch {
    return null;
  }
}

const venueOf = (s: Spoke) => s.src ?? (s.kind === 0 ? "Uniswap v4" : s.kind === 1 ? "Uniswap v3" : s.kind === 2 ? "Uniswap v2" : "2-hop");

export interface RouteQuote {
  out: bigint | null;
  best: string;                 // winning venue label
  legs: { sym: string; venue: string }[];
  hops: number;                 // pool hops (fewer = cheaper gas)
  impactBps: number | null;     // price impact vs a tiny reference trade
  checked: number;              // how many DEX routes were probed
  alts: { src: string; deltaBps: number }[]; // runner-up venues vs the winner (per leg)
}

/** Full multirouter analysis for a public swap: probe every DEX for both legs, pick the best, and
 *  report the winning path, price impact, venues checked, and runner-up routes. Heavier than
 *  quotePublic (probes all DEXes) — call it per token-pair, not per keystroke. */
export async function quotePublicRoute(pc: PublicClient, tokenIn: AggToken, tokenOut: AggToken, amountIn: bigint): Promise<RouteQuote> {
  const [rin, rout] = await Promise.all([
    isHub(tokenIn.address) ? Promise.resolve({ best: null as Spoke | null, cands: [] as RouteCand[] }) : resolveRoutes(pc, tokenIn.address, tokenIn.decimals),
    isHub(tokenOut.address) ? Promise.resolve({ best: null as Spoke | null, cands: [] as RouteCand[] }) : resolveRoutes(pc, tokenOut.address, tokenOut.decimals),
  ]);
  const ain: AggToken = { ...tokenIn, spoke: isHub(tokenIn.address) ? null : rin.best };
  const aout: AggToken = { ...tokenOut, spoke: isHub(tokenOut.address) ? null : rout.best };
  const out = amountIn > 0n ? await quotePublic(pc, ain, aout, amountIn) : null;

  let impactBps: number | null = null;
  if (amountIn > 0n && out != null && out > 0n) {
    try {
      const tiny = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
      const spot = await quotePublic(pc, ain, aout, tiny);
      if (spot != null && spot > 0n) {
        const exec = Number(out) / Number(amountIn), ref = Number(spot) / Number(tiny);
        impactBps = ref > 0 ? Math.max(0, Math.round((1 - exec / ref) * 10000)) : null;
      }
    } catch { /* impact best-effort */ }
  }

  const legs: { sym: string; venue: string }[] = [];
  if (ain.spoke) legs.push({ sym: tokenIn.symbol, venue: venueOf(ain.spoke) });
  if (aout.spoke) legs.push({ sym: tokenOut.symbol, venue: venueOf(aout.spoke) });
  const hops = (ain.spoke ? (ain.spoke.kind === 3 ? 2 : 1) : 0) + (aout.spoke ? (aout.spoke.kind === 3 ? 2 : 1) : 0);
  const best = legs.map((l) => l.venue).join(" + ") || "Direct";

  // runner-up venues (next best per leg) with their shortfall vs the winner
  const alts: { src: string; deltaBps: number }[] = [];
  for (const r of [rin, rout]) {
    if (r.cands.length < 2) continue;
    const win = r.cands[0].out;
    for (const c of r.cands.slice(1, 3)) {
      const d = win > 0n ? Math.round(Number(win - c.out) * 10000 / Number(win)) : 0;
      alts.push({ src: c.src, deltaBps: d });
    }
  }
  return { out, best, legs, hops, impactBps, checked: rin.cands.length + rout.cands.length, alts };
}
