// Multi-DEX swap quoting for the Sherwood swap form — mirrors the on-chain SwapExecutor.
// Every pair routes through the WETH hub: tokenIn -> WETH -> tokenOut. Each leg is quoted
// on its own Uniswap version: v4 (ETH/USDG), v3 (CASHCAT/JUGGERNAUT), v2 (HOODRAT/VIRTUAL/VEX).
import type { Address, PublicClient } from "viem";

const A = {
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  JUGGERNAUT: "0xD7321801CAae694090694Ff55A9323139F043B88",
  HOODRAT: "0x8e62F281f282686fCa6dCB39288069a93fC23F1c",
  VIRTUAL: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  VEX: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  // (remaining tokenized stocks live in STOCKS below)
  PAIR_HOODRAT: "0x451c0DA3b774045a822A129eeDcc5C667DcbfDD8",
  PAIR_VIRTUAL: "0xd95e8e2Cd04c207625C6F23c974d365a5F3A91D3",
  PAIR_VEX: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
  V3_QUOTER: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  V4_QUOTER: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  NATIVE: "0x0000000000000000000000000000000000000000",
} as const;
const lc = (a: string) => a.toLowerCase();

const V2_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const V3_QUOTER_ABI = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "view", inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] },
] as const;
const V4_POOLKEY = { name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;
const V4_QUOTER_ABI = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "view", inputs: [{ name: "p", type: "tuple", components: [V4_POOLKEY, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const;

async function v2Out(pc: PublicClient, pair: string, tokenIn: string, amtIn: bigint): Promise<bigint> {
  const [r, t0] = await Promise.all([
    pc.readContract({ address: pair as Address, abi: V2_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
    pc.readContract({ address: pair as Address, abi: V2_ABI, functionName: "token0" }) as Promise<Address>,
  ]);
  const inIs0 = lc(tokenIn) === lc(t0);
  const [rIn, rOut] = inIs0 ? [r[0], r[1]] : [r[1], r[0]];
  const fee = amtIn * 997n;
  return (fee * rOut) / (rIn * 1000n + fee);
}

async function v3Out(pc: PublicClient, tokenIn: string, tokenOut: string, fee: number, amtIn: bigint): Promise<bigint> {
  const r = (await pc.readContract({ address: A.V3_QUOTER as Address, abi: V3_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: tokenIn as Address, tokenOut: tokenOut as Address, amountIn: amtIn, fee, sqrtPriceLimitX96: 0n }] })) as readonly [bigint, ...unknown[]];
  return r[0];
}

// v4 native-ETH pool (ETH = address(0) < any ERC20, so currency0 = ETH, currency1 = erc20).
// USDG uses fee 500/ts 10; each tokenized stock's deepest hookless pool sits on its own
// fee tier. This map mirrors SwapExecutor.stockRoute on-chain — keep the two in sync.
const STOCKS: Record<string, { fee: number; ts: number }> = {
  [lc("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9")]: { fee: 50000, ts: 1000 }, // AAPL
  [lc("0x322F0929c4625eD5bAd873c95208D54E1c003b2d")]: { fee: 50000, ts: 1000 }, // TSLA
  [lc("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC")]: { fee: 50000, ts: 1000 }, // NVDA
  [lc("0x86923f96303D656E4aa86D9d42D1e57ad2023fdC")]: { fee: 50000, ts: 1000 }, // AMD
  [lc("0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa")]: { fee: 50000, ts: 1000 }, // SPCX
  [lc("0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3")]: { fee: 50000, ts: 1000 }, // GOOGL
  [lc("0x12f190a9F9d7D37a250758b26824B97CE941bF54")]: { fee: 10000, ts: 200 }, // AMZN
  [lc("0xb8DBf92F9741c9ac1c32115E78581f23509916FD")]: { fee: 10000, ts: 200 }, // APLD
  [lc("0x6330D8C3178a418788dF01a47479c0ce7CCF450b")]: { fee: 10000, ts: 200 }, // COIN
  [lc("0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3")]: { fee: 10000, ts: 200 }, // CRWV
  [lc("0x25C288E6D899b9BC30160965aD9644c67e73bE0C")]: { fee: 10000, ts: 200 }, // F
  [lc("0x1b0E319c6A659F002271B69dB8A7df2F911c153E")]: { fee: 10000, ts: 200 }, // GME
  [lc("0xc72b96e0E48ecd4DC75E1e45396e26300BC39681")]: { fee: 10000, ts: 200 }, // INTC
  [lc("0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD")]: { fee: 10000, ts: 200 }, // MU
  [lc("0x408c14038a04f7bD235329E26d2bf569ee20e250")]: { fee: 10000, ts: 200 }, // NU
  [lc("0xb0992820E760d836549ba69BC7598b4af75dEE03")]: { fee: 10000, ts: 200 }, // ORCL
  [lc("0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A")]: { fee: 10000, ts: 200 }, // PLTR
  [lc("0xD5f3879160bc7c32ebb4dC785F8a4F505888de68")]: { fee: 10000, ts: 200 }, // QQQ
  [lc("0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2")]: { fee: 10000, ts: 200 }, // RKLB
  [lc("0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f")]: { fee: 10000, ts: 200 }, // SLV
  [lc("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C")]: { fee: 10000, ts: 200 }, // SPY
  [lc("0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5")]: { fee: 100, ts: 1 }, // CRCL
  [lc("0xB90A19fF0Af67f7779afF50A882A9CfF42446400")]: { fee: 100, ts: 1 }, // SNDK
};
async function v4Out(pc: PublicClient, cin: string, erc20: string, fee: number, ts: number, amtIn: bigint): Promise<bigint> {
  const r = (await pc.readContract({ address: A.V4_QUOTER as Address, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: { currency0: A.NATIVE as Address, currency1: erc20 as Address, fee, tickSpacing: ts, hooks: A.NATIVE as Address }, zeroForOne: lc(cin) === lc(A.NATIVE), exactAmount: amtIn, hookData: "0x" }] })) as readonly [bigint, bigint];
  return r[0];
}
const isStock = (t: string) => STOCKS[t] !== undefined;

async function toWeth(pc: PublicClient, token: string, amt: bigint): Promise<bigint> {
  const t = lc(token);
  if (t === lc(A.WETH)) return amt;
  if (t === lc(A.USDG)) return v4Out(pc, A.USDG, A.USDG, 500, 10, amt);
  if (t === lc(A.CASHCAT) || t === lc(A.JUGGERNAUT)) return v3Out(pc, token, A.WETH, 10000, amt);
  if (t === lc(A.HOODRAT)) return v2Out(pc, A.PAIR_HOODRAT, token, amt);
  if (t === lc(A.VIRTUAL)) return v2Out(pc, A.PAIR_VIRTUAL, token, amt);
  if (t === lc(A.VEX)) return v2Out(pc, A.PAIR_VIRTUAL, A.VIRTUAL, await v2Out(pc, A.PAIR_VEX, A.VEX, amt));
  if (isStock(t)) return v4Out(pc, token, token, STOCKS[t].fee, STOCKS[t].ts, amt); // stock -> ETH(=WETH)
  throw new Error("unsupported token");
}

async function fromWeth(pc: PublicClient, token: string, weth: bigint): Promise<bigint> {
  const t = lc(token);
  if (t === lc(A.WETH)) return weth;
  if (t === lc(A.USDG)) return v4Out(pc, A.NATIVE, A.USDG, 500, 10, weth);
  if (t === lc(A.CASHCAT) || t === lc(A.JUGGERNAUT)) return v3Out(pc, A.WETH, token, 10000, weth);
  if (t === lc(A.HOODRAT)) return v2Out(pc, A.PAIR_HOODRAT, A.WETH, weth);
  if (t === lc(A.VIRTUAL)) return v2Out(pc, A.PAIR_VIRTUAL, A.WETH, weth);
  if (t === lc(A.VEX)) return v2Out(pc, A.PAIR_VEX, A.VIRTUAL, await v2Out(pc, A.PAIR_VIRTUAL, A.WETH, weth));
  if (isStock(t)) return v4Out(pc, A.NATIVE, token, STOCKS[t].fee, STOCKS[t].ts, weth); // ETH(=WETH) -> stock
  throw new Error("unsupported token");
}

/** Expected output for tokenIn -> tokenOut (via the WETH hub), or null on failure. */
export async function quoteRoute(pc: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    if (amountIn <= 0n || lc(tokenIn) === lc(tokenOut)) return null;
    return await fromWeth(pc, tokenOut, await toWeth(pc, tokenIn, amountIn));
  } catch {
    return null;
  }
}
