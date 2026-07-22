// 0x (Matcha) Swap API client — talks to the relayer's /0x proxy (API key stays server-side).
// Adds best-execution same-chain swap routes on the big EVM chains to the Private Route panel:
// 100+ liquidity sources incl. private market makers, one approval + one tx, output to the taker.
import type { NetworkConfig } from "./config";

const base = (net: NetworkConfig) => (net.relayerUrl ?? "").replace(/\/$/, "") + "/0x";

/** Chains the 0x Swap API (v2) covers — route injection is gated on this set. */
export const ZEROEX_CHAINS = new Set([1, 10, 56, 130, 137, 146, 480, 5000, 8453, 34443, 42161, 43114, 57073, 59144, 80094, 81457, 534352]);
/** 0x sentinel for the chain's native asset. */
export const ZEROEX_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

async function req(net: NetworkConfig, path: string): Promise<any> {
  const r = await fetch(base(net) + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.detail ?? j?.error ?? `0x ${path.split("?")[0]} failed (${r.status})`);
  return j;
}

let ENABLEDP: Promise<boolean> | null = null;
export function zeroexEnabled(net: NetworkConfig): Promise<boolean> {
  ENABLEDP ??= req(net, "/providers").then((j) => !!j.zeroex).catch(() => false);
  return ENABLEDP;
}

export interface ZeroExPrice { buyAmount: bigint; sellAmount: bigint; liquidityAvailable: boolean }
export async function zeroexPrice(net: NetworkConfig, p: { chainId: number; sellToken: string; buyToken: string; sellAmount: bigint }): Promise<ZeroExPrice> {
  const j = await req(net, `/price?chainId=${p.chainId}&sellToken=${p.sellToken}&buyToken=${p.buyToken}&sellAmount=${p.sellAmount}`);
  if (j.liquidityAvailable === false) return { buyAmount: 0n, sellAmount: p.sellAmount, liquidityAvailable: false };
  return { buyAmount: BigInt(j.buyAmount ?? "0"), sellAmount: BigInt(j.sellAmount ?? p.sellAmount), liquidityAvailable: true };
}

export interface ZeroExQuote {
  buyAmount: bigint;
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint; gas?: bigint };
  /** Non-null when the sell token needs an ERC-20 approval to this spender first. */
  approvalSpender: `0x${string}` | null;
}
export async function zeroexQuote(net: NetworkConfig, p: { chainId: number; sellToken: string; buyToken: string; sellAmount: bigint; taker: string; slippageBps?: number }): Promise<ZeroExQuote> {
  const j = await req(net, `/quote?chainId=${p.chainId}&sellToken=${p.sellToken}&buyToken=${p.buyToken}&sellAmount=${p.sellAmount}&taker=${p.taker}${p.slippageBps ? `&slippageBps=${p.slippageBps}` : ""}`);
  if (j.liquidityAvailable === false) throw new Error("0x: no liquidity for this pair right now.");
  const t = j.transaction;
  if (!t?.to || !t?.data) throw new Error("0x returned no executable transaction.");
  const needsApproval = j.issues?.allowance != null;
  return {
    buyAmount: BigInt(j.buyAmount ?? "0"),
    tx: { to: t.to, data: t.data, value: BigInt(t.value ?? "0"), gas: t.gas ? BigInt(t.gas) : undefined },
    approvalSpender: needsApproval ? (j.issues.allowance.spender as `0x${string}`) : null,
  };
}

// ---- Cross-chain (bridge) ----
export interface ZeroExCrossQuote {
  quoteId: string;
  buyAmount: bigint;
  minBuyAmount: bigint;
  etaSec?: number;
  /** origin-chain tx to broadcast; only EVM ("evm") is executable from the web wallet. */
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint } | null;
  approvalSpender: `0x${string}` | null;
}
/** Cross-chain quotes (origin → destination). One call returns firm quotes with the origin tx.
 *  `originAddress` is baked into the tx, so re-fetch with the real wallet before executing. */
export async function zeroexCrossQuotes(net: NetworkConfig, p: {
  originChain: number; destinationChain: number; sellToken: string; buyToken: string;
  sellAmount: bigint; originAddress: string; destinationAddress?: string; slippageBps?: number; maxNumQuotes?: number;
}): Promise<ZeroExCrossQuote[]> {
  const qs = new URLSearchParams({
    originChain: String(p.originChain), destinationChain: String(p.destinationChain),
    sellToken: p.sellToken, buyToken: p.buyToken, sellAmount: String(p.sellAmount),
    originAddress: p.originAddress, sortQuotesBy: "price",
    maxNumQuotes: String(p.maxNumQuotes ?? 3),
  });
  if (p.destinationAddress) qs.set("destinationAddress", p.destinationAddress);
  if (p.slippageBps) qs.set("slippageBps", String(p.slippageBps));
  const j = await req(net, `/xquotes?${qs}`);
  if (j.liquidityAvailable === false) return [];
  return ((j.quotes ?? []) as any[]).map((q) => {
    const d = q.transaction?.details;
    const evm = q.transaction?.chainType === "evm" && d?.to && d?.data;
    return {
      quoteId: q.quoteId,
      buyAmount: BigInt(q.buyAmount ?? "0"),
      minBuyAmount: BigInt(q.minBuyAmount ?? q.buyAmount ?? "0"),
      etaSec: q.estimatedTimeSeconds,
      tx: evm ? { to: d.to, data: d.data, value: BigInt(d.value ?? "0") } : null,
      approvalSpender: q.issues?.allowance?.spender ?? null,
    } as ZeroExCrossQuote;
  });
}

export type ZeroExCrossStatus = "origin_tx_pending" | "origin_tx_succeeded" | "origin_tx_confirmed" | "origin_tx_reverted" | "bridge_pending" | "bridge_filled" | "bridge_failed" | "unknown";
export async function zeroexCrossStatus(net: NetworkConfig, originChain: number, originTxHash: string, quoteId?: string): Promise<{ status: ZeroExCrossStatus; destTxHash?: string }> {
  const qs = new URLSearchParams({ originChain: String(originChain), originTxHash });
  if (quoteId) qs.set("quoteId", quoteId);
  const j = await req(net, `/xstatus?${qs}`).catch(() => ({ status: "unknown" }));
  const txs: any[] = j.transactions ?? [];
  const dest = txs.length ? txs[txs.length - 1] : null;
  return { status: (j.status ?? "unknown") as ZeroExCrossStatus, destTxHash: dest?.txHash };
}
export const zeroexCrossDone = (s: ZeroExCrossStatus) => s === "bridge_filled" || s === "bridge_failed" || s === "origin_tx_reverted";
