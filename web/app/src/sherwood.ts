// Thin wrapper around the SDK client for the UI: builds + submits the four
// actions, routing through the relayer when configured (gasless / unlinkable),
// else via the user's own wallet.
import {
  SherwoodClient,
  ERC20_ABI,
  SHERWOOD_ABI,
  serializeBuiltTx,
  quoteExactInputSingle,
  applySlippage,
  type BuiltTx,
  type PublicAddress,
  type ClientState,
} from "@sherwood/client";
import { maxUint256, type Address } from "viem";
import { ARTIFACTS, type NetworkConfig, type TokenInfo } from "./config";
import type { Connection } from "./wallet";
import { makeWorkerProver } from "./worker-prover";
import { quoteRoute } from "./routing";

const cacheKey = (net: NetworkConfig, addr: string) => `sherwood:${net.chainId}:${net.pool}:${addr}`;

// Robinhood Chain is a fast L2 (~0.1s blocks) with a moving base fee, and wallets tend to
// estimate maxFeePerGas with little headroom — so a tx can be rejected with "max fee per gas
// less than block base fee" when the base fee ticks up between signing and inclusion. Read
// the latest base fee and give a 2x buffer (priority fee is 0 on this chain). Falls back to
// letting the wallet estimate if the block has no baseFeePerGas.
async function feeOverrides(conn: Connection): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | {}> {
  try {
    const block = await conn.publicClient.getBlock({ blockTag: "latest" });
    if (block.baseFeePerGas == null) return {};
    return { maxFeePerGas: block.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n };
  } catch {
    return {};
  }
}

export function makeClient(conn: Connection, net: NetworkConfig): SherwoodClient {
  const client = new SherwoodClient({
    publicClient: conn.publicClient as any,
    pool: net.pool,
    keypair: conn.keypair,
    artifacts: ARTIFACTS,
    fullProve: makeWorkerProver(), // proving runs in a Web Worker (no UI freeze)
    autoApproveDeposits: true, // demo ASP: treat every deposit label as approvable
    fromBlock: net.fromBlock, // replay from the pool's deploy block on live chains
    sender: conn.address, // wallet that submits shields — deposit labels bind to it (C-1)
  });
  // warm-start from the persistent cache so we don't rescan all history
  try {
    const cached = localStorage.getItem(cacheKey(net, conn.address));
    if (cached) client.load(JSON.parse(cached) as ClientState);
  } catch {
    /* stale/incompatible cache — ignore, fall back to full scan */
  }
  return client;
}

/** Is the connected wallet the pool's Association-Set Provider? */
export async function isAsp(conn: Connection, net: NetworkConfig): Promise<boolean> {
  try {
    const asp = (await conn.publicClient.readContract({ address: net.pool, abi: SHERWOOD_ABI, functionName: "asp" })) as Address;
    return asp.toLowerCase() === conn.address.toLowerCase();
  } catch {
    return false;
  }
}

/** True if the pool's on-chain association root differs from the client's local
 *  set — i.e. there are approvable deposits not yet published. */
export async function needsAspApproval(conn: Connection, net: NetworkConfig, client: SherwoodClient): Promise<boolean> {
  const onchain = (await conn.publicClient.readContract({ address: net.pool, abi: SHERWOOD_ABI, functionName: "associationRoot" })) as bigint;
  return client.assoc.root() !== onchain;
}

/** ASP action: publish the client's association-set root on-chain so pending
 *  deposits become spendable. Requires the connected wallet to be the pool's ASP. */
export async function publishAssociationRoot(conn: Connection, net: NetworkConfig, client: SherwoodClient): Promise<string> {
  const hash = await conn.walletClient.writeContract({
    account: conn.address,
    address: net.pool,
    abi: SHERWOOD_ABI,
    functionName: "setAssociationRoot",
    args: [client.assoc.root()],
    chain: undefined,
    ...(await feeOverrides(conn)),
  });
  await conn.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Persist the client's incremental-sync state to localStorage. */
export function saveCache(client: SherwoodClient, net: NetworkConfig, addr: string): void {
  try {
    localStorage.setItem(cacheKey(net, addr), JSON.stringify(client.snapshot()));
  } catch {
    /* quota / serialization issue — non-fatal */
  }
}

/** Live quote for the swap form; null if the network has no quoter configured. */
export async function quoteSwap(
  conn: Connection,
  net: NetworkConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number
): Promise<{ amountOut: bigint; minOut: bigint } | null> {
  // Multi-DEX route quote (WETH hub across Uniswap v2/v3/v4) — mirrors the SwapExecutor.
  const out = await quoteRoute(conn.publicClient as any, tokenIn, tokenOut, amountIn);
  if (out == null || out === 0n) return null;
  return { amountOut: out, minOut: applySlippage(out, slippageBps) };
}

export async function ensureApproval(conn: Connection, net: NetworkConfig, token: Address, needed: bigint) {
  const allowance = (await conn.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [conn.address, net.pool],
  })) as bigint;
  if (allowance >= needed) return;
  const hash = await conn.walletClient.writeContract({
    account: conn.address,
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [net.pool, maxUint256],
    chain: undefined,
    ...(await feeOverrides(conn)),
  });
  await conn.publicClient.waitForTransactionReceipt({ hash });
}

const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

/** Wrap `amount` of native ETH into WETH so it can be shielded (ERC20-only pool). */
export async function wrapEth(conn: Connection, weth: Address, amount: bigint): Promise<void> {
  const hash = await conn.walletClient.writeContract({ account: conn.address, address: weth, abi: WETH_ABI, functionName: "deposit", value: amount, chain: undefined, ...(await feeOverrides(conn)) });
  await conn.publicClient.waitForTransactionReceipt({ hash });
}

/** Unwrap `amount` of WETH back into native ETH (after unshielding to your own address). */
export async function unwrapEth(conn: Connection, weth: Address, amount: bigint): Promise<void> {
  const hash = await conn.walletClient.writeContract({ account: conn.address, address: weth, abi: WETH_ABI, functionName: "withdraw", args: [amount], chain: undefined, ...(await feeOverrides(conn)) });
  await conn.publicClient.waitForTransactionReceipt({ hash });
}

/** Shield is always submitted by the user's own funded wallet (it pulls tokens). */
export async function submitSelf(conn: Connection, net: NetworkConfig, tx: BuiltTx): Promise<string> {
  const hash = await conn.walletClient.writeContract({
    account: conn.address,
    address: net.pool,
    abi: SHERWOOD_ABI,
    functionName: "transact",
    args: [tx.proof as any, tx.extData as any],
    chain: undefined,
    ...(await feeOverrides(conn)),
  });
  await conn.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Transfer / unshield / swap go through the relayer if set (breaks the address
 *  link); otherwise fall back to the user's wallet. */
export async function submitRelayed(conn: Connection, net: NetworkConfig, tx: BuiltTx): Promise<string> {
  if (!net.relayerUrl) return submitSelf(conn, net, tx);
  const res = await fetch(net.relayerUrl.replace(/\/$/, "") + "/transact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeBuiltTx(tx)),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail || body.error || "relayer rejected the transaction");
  return body.txHash as string;
}

export const relayerAddress = async (net: NetworkConfig): Promise<Address | null> => {
  if (!net.relayerUrl) return null;
  try {
    const r = await fetch(net.relayerUrl.replace(/\/$/, "") + "/info");
    return (await r.json()).relayer as Address;
  } catch {
    return null;
  }
};

export type { PublicAddress, TokenInfo };
