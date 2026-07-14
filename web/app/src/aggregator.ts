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
const ZERO = "0x0000000000000000000000000000000000000000";

const lc = (a: string) => a.toLowerCase();
export const isHub = (a: string) => lc(a) === lc(WETH) || lc(a) === lc(NATIVE);

/** How to swap a token to/from the ETH hub. kind: 0=v4, 1=v3, 2=v2. */
export interface Spoke { kind: 0 | 1 | 2 | 3; pool: Address; fee: number; ts: number; via?: Address; pool2?: Address; }
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

/** Resolve the deepest way to swap `token` <-> ETH, probing v4/v3/v2 with a reference amount.
 *  Returns null for WETH/native (hub tokens need no spoke). `hint` (fee/ts from the token list)
 *  is tried first as a fast path. */
export async function resolveSpoke(pc: PublicClient, token: string, decimals: number, hint?: { fee?: number; ts?: number }): Promise<Spoke | null> {
  if (isHub(token)) return null;
  const ref = 10n ** BigInt(decimals); // ~1 token
  let best: { out: bigint; spoke: Spoke } | null = null;
  const consider = (out: bigint, spoke: Spoke) => { if (out > 0n && (!best || out > best.out)) best = { out, spoke }; };
  // v4 (native-ETH pools) — hint first, then the standard fee ladder
  const v4tiers = hint?.fee != null && hint?.ts != null ? [[hint.fee, hint.ts] as [number, number], ...V4_FEES] : V4_FEES;
  await Promise.all(v4tiers.map(async ([fee, ts]) => { try { consider(await v4Quote(pc, token, token, fee, ts, ref), { kind: 0, pool: ZERO as Address, fee, ts }); } catch { /* no pool */ } }));
  // v3 (WETH pools)
  const v3pools = await Promise.all(V3_FEES.map((fee) => pc.readContract({ address: V3_FACTORY as Address, abi: V3_FAC_ABI, functionName: "getPool", args: [token as Address, WETH as Address, fee] }).catch(() => ZERO as Address)));
  await Promise.all(V3_FEES.map(async (fee, i) => { if (lc(v3pools[i]) === lc(ZERO)) return; try { consider(await v3Quote(pc, token, WETH, fee, ref), { kind: 1, pool: v3pools[i], fee, ts: 0 }); } catch { /* */ } }));
  // v2 (WETH pair)
  try {
    const pair = (await pc.readContract({ address: V2_FACTORY as Address, abi: V2_FAC_ABI, functionName: "getPair", args: [token as Address, WETH as Address] })) as Address;
    if (lc(pair) !== lc(ZERO)) consider(await v2Quote(pc, pair, token, ref), { kind: 2, pool: pair, fee: 0, ts: 0 });
  } catch { /* */ }
  // kind 3: token -> VIRTUAL -> WETH, for tokens with no direct WETH pair (e.g. $SWOOD)
  const k3 = KIND3[lc(token)];
  if (k3) {
    try {
      const out = await v2Quote(pc, PAIR_VIRTUAL_WETH, VIRTUAL, await v2Quote(pc, k3.pool, token, ref, BigInt(k3.fee)));
      consider(out, { kind: 3, pool: k3.pool, fee: k3.fee, ts: 0, via: VIRTUAL as Address, pool2: PAIR_VIRTUAL_WETH as Address });
    } catch { /* */ }
  }
  return best ? best.spoke : null;
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
