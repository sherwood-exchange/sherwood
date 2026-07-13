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
// USDG uses fee 500/ts 10; tokenized stocks use fee 50000/ts 1000 (deepest hookless pools).
const V4_STOCK_FEE = 50000, V4_STOCK_TS = 1000;
async function v4Out(pc: PublicClient, cin: string, erc20: string, fee: number, ts: number, amtIn: bigint): Promise<bigint> {
  const r = (await pc.readContract({ address: A.V4_QUOTER as Address, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: { currency0: A.NATIVE as Address, currency1: erc20 as Address, fee, tickSpacing: ts, hooks: A.NATIVE as Address }, zeroForOne: lc(cin) === lc(A.NATIVE), exactAmount: amtIn, hookData: "0x" }] })) as readonly [bigint, bigint];
  return r[0];
}
const isStock = (t: string) => t === lc(A.AAPL) || t === lc(A.TSLA) || t === lc(A.NVDA);

async function toWeth(pc: PublicClient, token: string, amt: bigint): Promise<bigint> {
  const t = lc(token);
  if (t === lc(A.WETH)) return amt;
  if (t === lc(A.USDG)) return v4Out(pc, A.USDG, A.USDG, 500, 10, amt);
  if (t === lc(A.CASHCAT) || t === lc(A.JUGGERNAUT)) return v3Out(pc, token, A.WETH, 10000, amt);
  if (t === lc(A.HOODRAT)) return v2Out(pc, A.PAIR_HOODRAT, token, amt);
  if (t === lc(A.VIRTUAL)) return v2Out(pc, A.PAIR_VIRTUAL, token, amt);
  if (t === lc(A.VEX)) return v2Out(pc, A.PAIR_VIRTUAL, A.VIRTUAL, await v2Out(pc, A.PAIR_VEX, A.VEX, amt));
  if (isStock(t)) return v4Out(pc, token, token, V4_STOCK_FEE, V4_STOCK_TS, amt); // stock -> ETH(=WETH)
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
  if (isStock(t)) return v4Out(pc, A.NATIVE, token, V4_STOCK_FEE, V4_STOCK_TS, weth); // ETH(=WETH) -> stock
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
