// Live swap quotes via Uniswap v3 QuoterV2. quoteExactInputSingle is a
// non-view function (it reverts to return data) so it is called with eth_call
// via simulateContract — no state change, no gas.

import type { PublicClient } from "viem";
import { getAddress } from "viem";
import { QUOTER_V2_ABI } from "./abi.js";

export interface QuoteParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  fee: number; // pool fee tier (e.g. 3000)
}

export interface Quote {
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Ask the on-chain QuoterV2 how much `tokenOut` `amountIn` of `tokenIn` yields. */
export async function quoteExactInputSingle(
  publicClient: PublicClient,
  quoter: `0x${string}`,
  p: QuoteParams
): Promise<Quote> {
  const { result } = await publicClient.simulateContract({
    address: getAddress(quoter),
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: getAddress(p.tokenIn),
        tokenOut: getAddress(p.tokenOut),
        amountIn: p.amountIn,
        fee: p.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const [amountOut, , , gasEstimate] = result as readonly [bigint, bigint, number, bigint];
  return { amountOut, gasEstimate };
}

/** Apply a slippage tolerance (in basis points) to a quote to get minAmountOut. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}
