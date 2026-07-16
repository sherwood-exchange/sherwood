// Cross-chain private ramp client — talks to the relayer's /xchain proxy (HoudiniSwap behind it;
// the API keys never reach the browser). Verified live 2026-07-15: Robinhood Chain itself is
// DEX-only in Houdini (no CEX rail), so the ramp is two legs:
//   IN : any asset → Houdini private/standard → ETH on Base (your own address) → Relay leg → shield
//   OUT: unshield → Relay to Base → Houdini → any asset (BTC, XMR, SOL, …)
import type { NetworkConfig } from "./config";

const base = (net: NetworkConfig) => (net.relayerUrl ?? "").replace(/\/$/, "") + "/xchain";
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };

/** ETH (native) on Base — the landing token for the Relay leg into Robinhood Chain. */
export const ETH_BASE_ID = "6689b73ec90e45f3b3e51590";

/** Curated source assets (Houdini token ids, all hasCex → routable via private multi-hop). */
export interface XAsset { id: string; symbol: string; chain: string; label: string; logo?: string }
export const X_ASSETS: XAsset[] = [
  { id: "6689b73ec90e45f3b3e51551", symbol: "BTC", chain: "bitcoin", label: "Bitcoin" },
  { id: "6689b73ec90e45f3b3e5155c", symbol: "XMR", chain: "monero", label: "Monero" },
  { id: "6689b73ec90e45f3b3e51558", symbol: "SOL", chain: "solana", label: "Solana" },
  { id: "6689b73ec90e45f3b3e51566", symbol: "ETH", chain: "ethereum", label: "Ether (mainnet)" },
  { id: "6689b73ec90e45f3b3e51590", symbol: "ETH", chain: "base", label: "Ether (Base)" },
  { id: "6689b73ec90e45f3b3e5155d", symbol: "USDT", chain: "tron", label: "USDT (Tron)" },
  { id: "6689b73ec90e45f3b3e51553", symbol: "USDT", chain: "ethereum", label: "USDT (Ethereum)" },
  { id: "6689b757c90e45f3b3e51805", symbol: "USDC", chain: "base", label: "USDC (Base)" },
  { id: "6689b73ec90e45f3b3e5159e", symbol: "USDC", chain: "solana", label: "USDC (Solana)" },
  { id: "6689b73ec90e45f3b3e5156c", symbol: "LTC", chain: "litecoin", label: "Litecoin" },
  { id: "6689b73ec90e45f3b3e51563", symbol: "DOGE", chain: "doge", label: "Dogecoin" },
];

export interface XQuote {
  quoteId: string; type: "private" | "standard" | "dex"; swap?: string; swapName?: string;
  amountIn: number; amountOut: number; amountInUsd?: number; amountOutUsd?: number; duration?: number;
  min?: number; max?: number;
}
export interface XOrder {
  houdiniId: string; depositAddress: string; depositTag?: string | null;
  inAmount: number; inSymbol: string; outAmount: number; outSymbol: string;
  expires?: string; eta?: number; displayStatus?: string; status?: number;
}
export interface XStatus {
  houdiniId: string; status: number; displayStatus?: string;
  inAmount?: number; inSymbol?: string; outAmount?: number; outSymbol?: string;
  outTransactionOutHash?: string; modified?: string;
}

async function req(net: NetworkConfig, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(base(net) + path, {
    ...init,
    headers: { "content-type": "application/json", "x-user-timezone": tz(), ...(init?.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message ?? j?.error ?? `xchain ${path} failed (${r.status})`);
  return j;
}

export const xchainProviders = (net: NetworkConfig): Promise<{ houdini: boolean; anyswap: boolean }> =>
  req(net, "/providers");

export interface XChainInfo { shortName: string; name: string; addressValidation?: string; memoNeeded?: boolean }
let CHAINSP: Promise<Map<string, XChainInfo>> | null = null;
/** Houdini chain metadata by shortName (cached) — used to validate destination addresses per chain. */
export function xchainChains(net: NetworkConfig): Promise<Map<string, XChainInfo>> {
  CHAINSP ??= req(net, "/chains").then((j: any) => {
    const m = new Map<string, XChainInfo>();
    for (const c of j.chains ?? j ?? []) m.set(String(c.shortName ?? c.name).toLowerCase(), {
      shortName: c.shortName, name: c.name, addressValidation: c.addressValidation, memoNeeded: !!c.memoNeeded,
    });
    return m;
  }).catch((e) => { CHAINSP = null; throw e; });
  return CHAINSP;
}
/** Validate a destination address for one of our curated chains (true when no regex is known). */
export async function xchainValidAddress(net: NetworkConfig, chain: string, addr: string): Promise<boolean> {
  try {
    const info = (await xchainChains(net)).get(chain.toLowerCase());
    if (!info?.addressValidation) return addr.trim().length > 10;
    return new RegExp(info.addressValidation).test(addr.trim());
  } catch { return addr.trim().length > 10; }
}

/** Best private + best standard quote for `amount` of `fromId` → `toId`. */
export async function xchainQuote(net: NetworkConfig, fromId: string, toId: string, amount: number): Promise<{ private?: XQuote; standard?: XQuote }> {
  const j = await req(net, "/quote", { method: "POST", body: JSON.stringify({ provider: "houdini", amount, from: fromId, to: toId }) });
  const quotes: XQuote[] = j.quotes ?? [];
  const best = (t: string) => quotes.filter((q) => q.type === t && q.amountOut > 0).sort((a, b) => b.amountOut - a.amountOut)[0];
  return { private: best("private"), standard: best("standard") };
}

/** ALL routes for a pair (the multichain routes panel), throws with the API's message on no-route. */
export async function xchainQuotesAll(net: NetworkConfig, fromId: string, toId: string, amount: number): Promise<XQuote[]> {
  const j = await req(net, "/quote", { method: "POST", body: JSON.stringify({ provider: "houdini", amount, from: fromId, to: toId }) });
  return ((j.quotes ?? []) as XQuote[]).filter((q) => q.amountOut > 0);
}

/** A token from Houdini's full multichain catalog (searchable picker). */
export interface XToken { id: string; symbol: string; chain: string; name?: string; icon?: string; hasCex?: boolean; hasDex?: boolean }
/** Search the catalog through the proxy. CEX-capable tokens only by default — cross-chain routing needs the CEX rail. */
export async function xchainTokenSearch(net: NetworkConfig, term: string, opts?: { anyRail?: boolean; chain?: string; pageSize?: number }): Promise<XToken[]> {
  const qs = new URLSearchParams({ pageSize: String(opts?.pageSize ?? 30) });
  if (term.trim()) qs.set("term", term.trim());
  if (opts?.chain) qs.set("chain", opts.chain);
  if (!opts?.anyRail) qs.set("hasCex", "true");
  const j = await req(net, `/tokens?${qs}`);
  return ((j.tokens ?? []) as any[]).map((t) => ({
    id: t.id, symbol: t.symbol, chain: t.chain, name: t.name, icon: t.icon, hasCex: t.hasCex, hasDex: t.hasDex,
  }));
}

/** Create the exchange; `addressTo` receives the funds (for the IN leg: your address on Base). */
export const xchainCreate = (net: NetworkConfig, quoteId: string, addressTo: string): Promise<XOrder> =>
  req(net, "/create", { method: "POST", body: JSON.stringify({ provider: "houdini", quoteId, addressTo }) });

export const xchainStatus = (net: NetworkConfig, houdiniId: string): Promise<XStatus> =>
  req(net, `/status?provider=houdini&id=${encodeURIComponent(houdiniId)}`);

/** Human line for Houdini's displayStatus. */
export function xchainStatusLabel(s?: string): string {
  switch (s) {
    case "WAITING_FOR_DEPOSIT": return "Waiting for your deposit…";
    case "DEPOSIT_DETECTED": return "Deposit detected — confirming…";
    case "EXCHANGE_IN_PROGRESS": return "Exchanging…";
    case "SENDING_TO_INTERMEDIARY": case "REACHED_INTERMEDIARY":
    case "INITIATING_SECOND_EXCHANGE": case "SECOND_EXCHANGE_IN_PROGRESS": return "Hopping through the second exchange (privacy leg)…";
    case "SENDING_TO_RECEIVER": return "Sending to your address…";
    case "SWAP_COMPLETED": return "Completed ✓";
    case "EXPIRED": return "Expired — no deposit arrived in time.";
    case "FAILED": return "Failed — contact support with your order id.";
    case "REFUNDED": return "Refunded.";
    default: return s ?? "…";
  }
}
export const xchainDone = (s?: string) => s === "SWAP_COMPLETED" || s === "EXPIRED" || s === "FAILED" || s === "REFUNDED" || s === "DELETED";
