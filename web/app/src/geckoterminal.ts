// GeckoTerminal market data for Robinhood Chain (network slug "robinhood"). Used as a SECONDARY
// source behind DexScreener: it indexes pools DexScreener misses (notably the v4 tokenized-stock
// pools — APLD, CRCL, NU, $SWOOD…), and it exposes an embeddable chart, so it gives those tokens a
// real chart + full stats instead of an on-chain price alone.
//
// Free tier is ~30 req/min, so callers must query sparingly: the discover feed refreshes the few
// DexScreener-missing tokens on a slow cycle (cached), and the token page fetches one token on open.
import type { Market } from "./dexscreener";

// GeckoTerminal's Cloudflare blocks cross-origin browser requests, so the API is reached through a
// same-origin proxy (Vite /gtproxy in dev, a Caddy /gtproxy route in prod). Override with VITE_GT_BASE.
const GT = ((import.meta as any).env?.VITE_GT_BASE as string | undefined) || "/gtproxy/api/v2";
const NET = "robinhood";
const lc = (s: string) => s.toLowerCase();
const num = (v: any): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));

// GeckoTerminal's free tier is ~30 req/min per IP and throttles bursts, which returned 429s and
// left charts blank: the discover feed's background refresh (one call per uncharted token) could
// exhaust the whole budget right before the user opened a token page. So GT requests go through a
// single paced queue with two priorities — token-page calls (chart, trades) jump ahead of the
// background feed — and 429s back off and retry in place.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// In production /gtproxy hits our own VPS cache (which does its own upstream pacing), so the
// client barely needs to pace; in dev the Vite proxy talks straight to GT's per-IP free tier.
const GAP_MS = (import.meta as any).env?.PROD ? 250 : 1600;
interface GtJob { url: string; opts?: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void; }
const gtJobs: GtJob[] = [];
let gtPumping = false;
let gtLast = 0;
const gtInflight = new Map<string, Promise<Response>>(); // dedup identical URLs (StrictMode double-effects, twin components)
function gtFetch(url: string, opts?: RequestInit, priority = false): Promise<Response> {
  let p = gtInflight.get(url);
  if (!p) {
    p = new Promise<Response>((resolve, reject) => {
      const job: GtJob = { url, opts, resolve, reject };
      if (priority) gtJobs.unshift(job); else gtJobs.push(job);
      void pump();
    });
    gtInflight.set(url, p);
    p.finally(() => gtInflight.delete(url)).catch(() => {});
  }
  // every consumer gets a clone — the shared original is never consumed, so join order can't race
  return p.then((r) => r.clone());
}
async function pump(): Promise<void> {
  if (gtPumping) return;
  gtPumping = true;
  try {
    while (gtJobs.length) {
      const job = gtJobs.shift()!;
      if (job.opts?.signal?.aborted) { job.reject(new DOMException("Aborted", "AbortError")); continue; }
      const wait = GAP_MS - (Date.now() - gtLast);
      if (wait > 0) await sleep(wait);
      gtLast = Date.now();
      try {
        let res = await fetch(job.url, job.opts);
        for (let i = 0; i < 3 && res.status === 429; i++) { // back off 1.5s, 3s, 4.5s on rate-limit
          await sleep(1500 * (i + 1));
          gtLast = Date.now();
          res = await fetch(job.url, job.opts);
        }
        job.resolve(res);
      } catch (e) { job.reject(e); }
    }
  } finally { gtPumping = false; }
}

// The free-tier budget is tiny (and shared across every tab / the whole CGNAT IP), so successful
// responses are cached in sessionStorage with a TTL — reopening a token page or flipping timeframes
// must not respend quota it already spent.
function cacheGet<T>(key: string, ttlMs: number, store: Storage | undefined = typeof sessionStorage !== "undefined" ? sessionStorage : undefined): T | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t > ttlMs ? null : (v as T);
  } catch { return null; }
}
function cacheSet(key: string, v: unknown, store: Storage | undefined = typeof sessionStorage !== "undefined" ? sessionStorage : undefined): void {
  try { store?.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch { /* quota/private mode */ }
}
const LS = typeof localStorage !== "undefined" ? localStorage : undefined;

interface GtPool {
  attributes: {
    address: string; name: string;
    base_token_price_usd?: string; quote_token_price_usd?: string; token_price_usd?: string;
    price_change_percentage?: { h1?: string; h6?: string; h24?: string };
    volume_usd?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
    reserve_in_usd?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
}

/** GeckoTerminal chart embed URL for a pool (chart-only, dark). */
export function gtEmbed(pool: string): string {
  return `https://www.geckoterminal.com/${NET}/pools/${pool}?embed=1&info=0&swaps=0`;
}

// GT keeps a pool's RAW on-chain token ordering, while DexScreener normalizes it (the interesting
// token is always "base"). The v4 stock pools are ordered USDG/<stock>, so asking GT for OHLCV
// without a side renders the USDG leg — a flat $1 chart. Remember each pool's ordering (seeded free
// from every pools response; fetched once and cached long otherwise) so chart + trades can ask for
// the correct side.
// A pool's token ordering NEVER changes, so the side cache lives in localStorage with a long TTL —
// the extra pool-info lookup is paid at most once per pool, ever, not once per session.
const poolSideKey = (pool: string) => `gt:side:${lc(pool)}`;
function seedPoolSide(pool: string, baseId?: string, quoteId?: string): void {
  if (baseId || quoteId) cacheSet(poolSideKey(pool), { base: lc(baseId ?? ""), quote: lc(quoteId ?? "") }, LS);
}
async function poolSideFor(pool: string, token: string, signal?: AbortSignal, priority = false): Promise<"base" | "quote"> {
  const a = lc(token);
  let side = cacheGet<{ base: string; quote: string }>(poolSideKey(pool), 30 * 24 * 3600_000, LS);
  if (!side) {
    try {
      const r = await gtFetch(`${GT}/networks/${NET}/pools/${lc(pool)}`, { headers: { accept: "application/json" }, signal }, priority);
      if (r.ok) {
        const rel = (await r.json())?.data?.relationships;
        side = { base: lc(rel?.base_token?.data?.id ?? ""), quote: lc(rel?.quote_token?.data?.id ?? "") };
        cacheSet(poolSideKey(pool), side, LS);
      }
    } catch { /* unknown — default to base below */ }
  }
  return side?.quote?.endsWith(a) ? "quote" : "base";
}

/** Fetch the deepest pool for a token from GeckoTerminal → a Market (source "gt"). null if unindexed.
 *  Prefers pools where the token is the base asset (correct price + change sign); falls back to a
 *  quote-position pool (price only, change nulled to avoid an inverted sign). */
export async function fetchGtToken(address: string, signal?: AbortSignal, priority = false): Promise<Market | null> {
  const a = lc(address);
  const cached = cacheGet<Market>(`gt:tok:${a}`, 3 * 60_000);
  if (cached) return cached;
  let pools: GtPool[] = [];
  try {
    const r = await gtFetch(`${GT}/networks/${NET}/tokens/${a}/pools`, { headers: { accept: "application/json" }, signal }, priority);
    if (!r.ok) return null;
    pools = ((await r.json())?.data ?? []) as GtPool[];
  } catch { return null; }
  for (const p of pools) seedPoolSide(p.attributes.address, p.relationships?.base_token?.data?.id, p.relationships?.quote_token?.data?.id);

  let best: GtPool | null = null, bestIsBase = false, bestScore = -1;
  for (const p of pools) {
    const baseId = lc(p.relationships?.base_token?.data?.id ?? "");
    const quoteId = lc(p.relationships?.quote_token?.data?.id ?? "");
    const isBase = baseId.endsWith(a), isQuote = quoteId.endsWith(a);
    if (!isBase && !isQuote) continue;
    const liq = num(p.attributes.reserve_in_usd) ?? 0;
    const score = (isBase ? 1e15 : 0) + liq; // base-position pools win, then deepest
    if (score > bestScore) { bestScore = score; best = p; bestIsBase = isBase; }
  }
  if (!best) return null;

  const at = best.attributes;
  const price = num(at.token_price_usd) ?? (bestIsBase ? num(at.base_token_price_usd) : num(at.quote_token_price_usd));
  if (price == null) return null;
  const chg = bestIsBase ? at.price_change_percentage : undefined; // only trustworthy for the base token
  const market: Market = {
    address: a, priceUsd: price,
    chg1: num(chg?.h1), chg6: num(chg?.h6), chg24: num(chg?.h24),
    vol24: num(at.volume_usd?.h24), liqUsd: num(at.reserve_in_usd),
    buys24: at.transactions?.h24?.buys ?? null, sells24: at.transactions?.h24?.sells ?? null,
    pairAddress: at.address, quoteSymbol: null,
    url: `https://www.geckoterminal.com/${NET}/pools/${at.address}`, source: "gt",
  };
  cacheSet(`gt:tok:${a}`, market);
  return market;
}

export interface GtInfo {
  websites: string[]; twitter?: string; telegram?: string; discord?: string; farcaster?: string;
  description?: string; holders?: number; verified?: boolean; imageUrl?: string;
}
/** Rich token metadata — socials, description, holder count, verified flag. null if not indexed. */
export async function fetchGtInfo(address: string, signal?: AbortSignal): Promise<GtInfo | null> {
  const key = `gt:info:${lc(address)}`;
  const cached = cacheGet<GtInfo>(key, 30 * 60_000);
  if (cached) return cached;
  try {
    const r = await gtFetch(`${GT}/networks/${NET}/tokens/${lc(address)}/info`, { headers: { accept: "application/json" }, signal });
    if (!r.ok) return null;
    const a = (await r.json())?.data?.attributes;
    if (!a) return null;
    const holders = typeof a.holders === "number" ? a.holders : typeof a.holders?.count === "number" ? a.holders.count : undefined;
    const info: GtInfo = {
      websites: Array.isArray(a.websites) ? a.websites.filter(Boolean) : [],
      twitter: a.twitter_handle ? `https://x.com/${String(a.twitter_handle).replace(/^@/, "")}` : undefined,
      telegram: a.telegram_handle ? `https://t.me/${String(a.telegram_handle).replace(/^@/, "")}` : undefined,
      discord: a.discord_url || undefined,
      farcaster: a.farcaster_url || undefined,
      description: a.description || undefined,
      holders,
      verified: !!a.gt_verified,
      imageUrl: a.image_url && a.image_url !== "missing.png" ? a.image_url : undefined,
    };
    cacheSet(key, info);
    return info;
  } catch { return null; }
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; }
/** OHLC series for a pool → drives the native token-page chart. Ascending, unique by time.
 *  `token` picks the correct side of the pool (see poolSideFor) — without it, tokens sitting in the
 *  quote position (all the v4 USDG/<stock> pools) chart their USDG leg instead. */
export async function fetchOhlcv(pool: string, token: string, timeframe: "minute" | "hour" | "day" = "hour", limit = 48, signal?: AbortSignal, priority = false, expectedUsd?: number | null): Promise<Candle[]> {
  const key = `gt:ohlcv:${lc(pool)}:${lc(token)}:${timeframe}:${limit}`;
  const cached = cacheGet<Candle[]>(key, 5 * 60_000);
  if (cached) return cached;
  const side = await poolSideFor(pool, token, signal, priority);
  try {
    const r = await gtFetch(`${GT}/networks/${NET}/pools/${pool}/ohlcv/${timeframe}?aggregate=1&limit=${limit}&currency=usd&token=${side}`, { headers: { accept: "application/json" }, signal }, priority);
    if (!r.ok) return [];
    const list: number[][] = (await r.json())?.data?.attributes?.ohlcv_list ?? [];
    const rows = list
      .map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] }))
      .filter((p) => p.c != null && !isNaN(p.c))
      .sort((a, b) => a.t - b.t);
    // Sanity gate: when the side lookup couldn't run (rate-limited) poolSideFor guessed "base" —
    // for the USDG/<stock> pools that returns USDG's flat-$1 series. The caller knows roughly what
    // the token trades at, so a >3× disagreement means we charted the wrong leg: discard, flip the
    // remembered side (self-healing, no extra request), and let the caller's retry fetch correctly.
    const last = rows.length ? rows[rows.length - 1].c : null;
    if (expectedUsd != null && expectedUsd > 0 && last != null && last > 0 && (last > expectedUsd * 3 || last < expectedUsd / 3)) {
      const a = lc(token);
      cacheSet(poolSideKey(pool), side === "base" ? { base: "", quote: a } : { base: a, quote: "" }, LS);
      return [];
    }
    if (rows.length) cacheSet(key, rows);
    return rows;
  } catch { return []; }
}

export interface GtTrade { kind: "buy" | "sell"; usd: number; maker: string; ts: number; tx: string; }
/** Recent trades for a pool → the token-page activity feed (buy/sell, USD size, maker, time).
 *  GT's `kind` is from the pool's raw base token's perspective; when `token` sits in the quote
 *  position (the v4 USDG/<stock> pools) it's flipped so "Buy" means buying OUR token. */
export async function fetchTrades(pool: string, token: string, limit = 25, signal?: AbortSignal, priority = false): Promise<GtTrade[]> {
  const key = `gt:tr:${lc(pool)}`;
  const cachedAll = cacheGet<{ side: string; trades: GtTrade[] }>(key, 60_000);
  const side = cachedAll?.side ?? (await poolSideFor(pool, token, signal, priority));
  if (cachedAll && cachedAll.side === side) return cachedAll.trades.slice(0, limit);
  try {
    const r = await gtFetch(`${GT}/networks/${NET}/pools/${pool}/trades`, { headers: { accept: "application/json" }, signal }, priority);
    if (!r.ok) return [];
    const d: any[] = (await r.json())?.data ?? [];
    const trades = d.slice(0, limit).map((t) => {
      const a = t.attributes;
      let kind: "buy" | "sell" = a.kind === "sell" ? "sell" : "buy";
      if (side === "quote") kind = kind === "buy" ? "sell" : "buy";
      return { kind, usd: Number(a.volume_in_usd) || 0, maker: a.tx_from_address || "", ts: Date.parse(a.block_timestamp) || 0, tx: a.tx_hash || "" } as GtTrade;
    });
    if (trades.length) cacheSet(key, { side, trades });
    return trades;
  } catch { return []; }
}

/** Fetch several tokens from GeckoTerminal (one call each — keep the list short). Keyed by address. */
export async function fetchGtMarkets(addresses: string[], signal?: AbortSignal): Promise<Record<string, Market>> {
  const out: Record<string, Market> = {};
  const results = await Promise.all(addresses.map((a) => fetchGtToken(a, signal).catch(() => null)));
  results.forEach((m, i) => { if (m) out[lc(addresses[i])] = m; });
  return out;
}
