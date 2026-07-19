// DexScreener market data for Robinhood Chain (chainId "robinhood"). Gives the WOODIE trading
// app FOMO-style stats — live USD price, 1h/6h/24h change, 24h volume, pool liquidity, and the
// buy/sell count — without us storing any price history. The list view batches /tokens (up to 30
// addresses per request, one round-trip); the token page deep-fetches a single token to pick the
// deepest pool for accurate stats + the right chart pair.
//
// Coverage note: ETH (WETH) has no direct DexScreener pair, so its USD price is derived from any
// WETH-quoted pair (priceUsd / priceNative). A handful of thin tokens (e.g. $SWOOD) aren't indexed
// at all — callers fall back to an on-chain quote for those.

const BASE = "https://api.dexscreener.com/latest/dex";
const CHAIN = "robinhood";
export const WETH_ADDR = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // == ETH in our config

export interface Market {
  address: string;                // lowercase token address
  priceUsd: number | null;
  chg1: number | null;            // % change, 1h
  chg6: number | null;
  chg24: number | null;
  vol24: number | null;           // USD
  liqUsd: number | null;
  buys24: number | null;
  sells24: number | null;
  pairAddress: string | null;     // deepest pair — used for the chart embed
  quoteSymbol: string | null;
  url: string | null;
  source: "dex" | "gt" | "onchain"; // which indexer priced it (picks the chart embed)
}

interface DsPair {
  chainId: string; dexId: string; pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string; priceNative?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  url?: string;
  info?: { websites?: { label?: string; url: string }[]; socials?: { type: string; url: string }[]; imageUrl?: string };
}

export interface DexInfo { websites: { label?: string; url: string }[]; socials: { type: string; url: string }[]; imageUrl?: string; }
/** Token socials/websites from DexScreener (carried on whichever pair has an `info` block). */
export async function fetchDexInfo(address: string, signal?: AbortSignal): Promise<DexInfo | null> {
  try {
    const pairs = await getJson(`${BASE}/tokens/${lc(address)}`, signal);
    const info = pairs.find((p) => p.info)?.info;
    if (!info) return null;
    return { websites: info.websites ?? [], socials: info.socials ?? [], imageUrl: info.imageUrl };
  } catch { return null; }
}

const num = (v: any): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const lc = (s: string) => s.toLowerCase();

function toMarket(addr: string, p: DsPair): Market {
  return {
    address: lc(addr),
    priceUsd: num(p.priceUsd),
    chg1: num(p.priceChange?.h1), chg6: num(p.priceChange?.h6), chg24: num(p.priceChange?.h24),
    vol24: num(p.volume?.h24), liqUsd: num(p.liquidity?.usd),
    buys24: num(p.txns?.h24?.buys), sells24: num(p.txns?.h24?.sells),
    pairAddress: p.pairAddress ?? null, quoteSymbol: p.quoteToken?.symbol ?? null,
    url: p.url ?? null, source: "dex",
  };
}

/** Deepest-liquidity pair for `addr` where it is the BASE token (so priceUsd is for that token). */
function pickBest(pairs: DsPair[], addr: string): DsPair | null {
  const a = lc(addr);
  let best: DsPair | null = null;
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    if (lc(p.baseToken?.address ?? "") !== a) continue;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

/** Derive ETH's USD price from any WETH-quoted pair: WETH_usd = priceUsd(base) / priceNative(base). */
function deriveEthUsd(pairs: DsPair[]): number | null {
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    if (lc(p.quoteToken?.address ?? "") !== WETH_ADDR) continue;
    const usd = num(p.priceUsd), native = num(p.priceNative);
    if (usd && native && native > 0) return usd / native;
  }
  return null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<DsPair[]> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const d = await r.json();
  return (d?.pairs ?? []) as DsPair[];
}

/** Batch market snapshot for the discover list. Keyed by lowercase token address.
 *  DexScreener caps a /tokens response at ~30 pairs total, so a big single batch starves the
 *  thinner tokens (they come back empty). We chunk small and fan the requests out in parallel so
 *  every token gets its own pair budget. */
export async function fetchMarkets(addresses: string[], signal?: AbortSignal): Promise<Record<string, Market>> {
  const uniq = Array.from(new Set(addresses.map(lc)));
  const out: Record<string, Market> = {};
  let ethUsd: number | null = null;
  const CHUNK = 5;
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));
  const results = await Promise.all(chunks.map((c) => getJson(`${BASE}/tokens/${c.join(",")}`, signal).catch(() => [] as DsPair[])));
  results.forEach((pairs, i) => {
    if (ethUsd == null) ethUsd = deriveEthUsd(pairs);
    for (const a of chunks[i]) {
      const best = pickBest(pairs, a);
      if (best) out[a] = toMarket(a, best);
    }
  });
  // Fill ETH/WETH from the derived native price (no % change available for it).
  if (ethUsd != null && !out[WETH_ADDR]) {
    out[WETH_ADDR] = {
      address: WETH_ADDR, priceUsd: ethUsd, chg1: null, chg6: null, chg24: null,
      vol24: null, liqUsd: null, buys24: null, sells24: null, pairAddress: null, quoteSymbol: null, url: null, source: "dex",
    };
  }
  return out;
}

/** Deep single-token fetch for the token page — all its pairs + the best market. */
export async function fetchTokenDetail(address: string, signal?: AbortSignal): Promise<{ market: Market | null; pairs: DsPair[] }> {
  let pairs: DsPair[] = [];
  try { pairs = await getJson(`${BASE}/tokens/${lc(address)}`, signal); } catch { return { market: null, pairs: [] }; }
  const best = pickBest(pairs, address);
  return { market: best ? toMarket(address, best) : null, pairs };
}

/** DexScreener chart embed URL for a pair (dark, chart-only). */
export function dexEmbed(pairAddress: string): string {
  return `https://dexscreener.com/${CHAIN}/${pairAddress}?embed=1&theme=dark&trades=0&info=0`;
}

/** Synthetic price-only market for a token DexScreener doesn't index (priced on-chain instead). */
export function priceOnlyMarket(address: string, priceUsd: number): Market {
  return {
    address: lc(address), priceUsd, chg1: null, chg6: null, chg24: null,
    vol24: null, liqUsd: null, buys24: null, sells24: null, pairAddress: null, quoteSymbol: null, url: null, source: "onchain",
  };
}
