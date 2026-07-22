// WoodieApp — the WOODIE trading app. A FOMO-style, mobile-first surface over Sherwood: a Discover
// feed of live token markets (with a top-movers ticker, live price flashes and liquidity signals),
// a per-token page with a chart + stats + slide-to-buy quick trade, a live-valued Portfolio, and the
// WOODIE copilot chat as its own tab (the intelligence layer FOMO doesn't have). Market data comes
// from DexScreener (Robinhood Chain); execution reuses the same AggRouter path as the Swap page (see
// trade.ts); everything is zero-custody — the user signs each trade. Chat is the existing <Woodie>
// component, seeded from "Ask WOODIE about $X".
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import type { NetworkConfig, TokenInfo } from "./config";
import { Woodie, type WoodieProps } from "./Woodie";
import { TokenAvatar } from "./TokenUI";
import { createChart, ColorType } from "lightweight-charts";
import { fetchMarkets, fetchTokenDetail, fetchDexInfo, priceOnlyMarket, dexEmbed, WETH_ADDR, type Market } from "./dexscreener";
import { fetchGtMarkets, fetchGtToken, fetchGtInfo, fetchTrades, fetchOhlcv, gtEmbed, type GtTrade, type Candle } from "./geckoterminal";
import { STOCK_INFO } from "./stocks-info";
import { executePublicSwap, executeTransfer, quoteTrade, quoteShielded, analyzeRoute, publicClientFor, fetchUsdPrices, importToken, type RouteAnalysis } from "./trade";
import { xchainQuotesAll, X_ASSETS, ETH_BASE_ID, type XQuote } from "./xchain";
import { toast, dismiss } from "./Toast";

const MEMES = new Set(["CASHCAT", "HOODRAT", "JUGGERNAUT", "VIRTUAL", "VEX", "SWOOD"]);
const lc = (s: string) => s.toLowerCase();
const catLabel = (t: TokenInfo): string | null => (t.stock ? "Stock" : MEMES.has(t.symbol) ? "Community" : t.symbol === "ETH" ? null : null);

// ---- formatting ----------------------------------------------------------
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const sub = (k: number) => String(k).split("").map((d) => SUBSCRIPT[+d]).join("");
const fmtPrice = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n >= 1000) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(4);
  if (n >= 0.001) return "$" + n.toFixed(5);
  // sub-milli: DexScreener-style $0.0ₖ<sig> where k = leading zeros after the decimal
  const zeros = Math.floor(-Math.log10(n));
  const sig = String(Math.round(n * Math.pow(10, zeros + 4))).replace(/0+$/, "") || "0";
  return `$0.0${sub(zeros)}${sig}`;
};
const fmtCompact = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const s = n < 0 ? "-" : ""; n = Math.abs(n);
  if (n >= 1e9) return s + "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return s + "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return s + "$" + (n / 1e3).toFixed(1) + "K";
  return s + "$" + n.toFixed(n < 1 ? 2 : 0);
};
const fmtPct = (n: number | null | undefined): string => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const trimAmt = (s: string) => (s.includes(".") ? s.replace(/(\.\d{6})\d+$/, "$1").replace(/\.?0+$/, "").replace(/\.$/, "") : s);
const fmtBal = (v: bigint | undefined, dec: number) => (v == null ? "0" : trimAmt(formatUnits(v, dec)));
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- GT market cache (localStorage) --------------------------------------
// The GeckoTerminal fill-in markets survive reloads: the free-tier budget is too small to re-crawl
// the uncharted tokens on every visit. Slightly stale stats are fine for the feed.
const GTM_KEY = "woodie:gtmarkets";
function loadGtCache(): Record<string, Market> {
  try {
    const { t, v } = JSON.parse(localStorage.getItem(GTM_KEY) || "");
    return Date.now() - t < 15 * 60_000 ? v : {};
  } catch { return {}; }
}
function saveGtCache(v: Record<string, Market>): void {
  try { localStorage.setItem(GTM_KEY, JSON.stringify({ t: Date.now(), v })); } catch { /* quota */ }
}

// ---- watchlist (localStorage) --------------------------------------------
const WL_KEY = "woodie:watchlist";
export interface Watchlist { has: (addr: string) => boolean; toggle: (addr: string) => void; count: number; }
function useWatchlist(): Watchlist {
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(WL_KEY) || "[]")); } catch { return new Set(); }
  });
  const toggle = (addr: string) => setSet((prev) => {
    const n = new Set(prev), a = lc(addr);
    if (n.has(a)) n.delete(a); else n.add(a);
    try { localStorage.setItem(WL_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  return { has: (addr) => set.has(lc(addr)), toggle, count: set.size };
}

const StarBtn = ({ on, onClick, size = 20 }: { on: boolean; onClick: (e: React.MouseEvent) => void; size?: number }) => (
  <span role="button" tabIndex={0} className={`star ${on ? "on" : ""}`} aria-label={on ? "Remove from watchlist" : "Add to watchlist"}
    onClick={(e) => { e.stopPropagation(); onClick(e); }}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onClick(e as any); } }}>
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21l1.2-6.5L2.5 9.9 9.1 9z" /></svg>
  </span>
);

// ==========================================================================

type Tab = "discover" | "portfolio" | "chat";

export function WoodieApp(props: WoodieProps) {
  const { net } = props;
  const tradable = useMemo(() => net.tokens.filter((t) => t.symbol !== "WETH"), [net]);
  const addrOf = (t: TokenInfo) => lc(t.native ? WETH_ADDR : t.address);

  const [markets, setMarkets] = useState<Record<string, Market>>({});
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [flash, setFlash] = useState<Record<string, "up" | "down">>({});
  const prevPx = useRef<Record<string, number>>({});
  const fallbackPx = useRef<Record<string, number>>({}); // cached on-chain prices for unindexed tokens
  const gtCache = useRef<Record<string, Market>>(loadGtCache()); // GeckoTerminal markets (DexScreener gaps) — persisted so a reload doesn't respend GT quota
  const cycle = useRef(0);
  const [tab, setTab] = useState<Tab>("discover");
  const [open, setOpen] = useState<TokenInfo | null>(null);
  const [chatSeed, setChatSeed] = useState<{ text: string; key: number }>({ text: "", key: 0 });
  const wl = useWatchlist();

  // deep-link: a token page lives at #/woodie/<SYMBOL> so it's shareable and the back button closes it
  const openToken = (t: TokenInfo) => {
    setOpen(t);
    const h = `#/woodie/${encodeURIComponent(t.symbol)}`;
    if (location.hash !== h) location.hash = h;
  };
  const closeToken = () => { setOpen(null); if (!/^#\/woodie\/?$|^#\/plan/.test(location.hash)) location.hash = "#/woodie"; };
  useEffect(() => {
    const sync = () => {
      const sym = decodeURIComponent(location.hash.split("/")[2] || "").toUpperCase();
      if (!sym) { setOpen(null); return; }
      const t = tradable.find((x) => x.symbol.toUpperCase() === sym);
      if (t) setOpen(t); // unknown symbol (e.g. an imported token) → leave the current sheet as-is
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [tradable]);

  // poll DexScreener for the whole universe every 20s; flash rows whose price moved
  useEffect(() => {
    let alive = true;
    const addrs = tradable.map(addrOf);
    const load = async () => {
      try {
        const m = await fetchMarkets(addrs);
        if (!alive) return;
        // On-chain fallback for tokens DexScreener doesn't price (thin/unindexed pools, esp. stocks),
        // so every listed token shows a price even without a DexScreener pair. Cached and refreshed
        // every ~60s (3rd cycle) to keep RPC light — these pools barely move intra-minute.
        const applyGt = (cache: Record<string, Market>) => {
          for (const [a, gm] of Object.entries(cache)) {
            if (!m[a] || (!m[a].pairAddress && gm.pairAddress)) m[a] = gm; // fill gaps, add a chart, keep DexScreener
          }
        };
        const applyFallback = (px: Record<string, number>) => {
          for (const [a, p] of Object.entries(px)) {
            if (m[a]) { if (m[a].priceUsd == null) m[a].priceUsd = p; }
            else m[a] = priceOnlyMarket(a, p);
          }
        };
        applyGt(gtCache.current);
        applyFallback(fallbackPx.current);
        // Every ~3 min, refresh the secondary sources for whatever still lacks a chart / price.
        const needGt = tradable.filter((t) => m[addrOf(t)]?.pairAddress == null && t.symbol !== "USDG" && t.symbol !== "ETH");
        if (needGt.length && cycle.current % 9 === 0) {
          try {
            const gt = await fetchGtMarkets(needGt.map(addrOf));
            if (!alive) return;
            gtCache.current = { ...gtCache.current, ...gt };
            saveGtCache(gtCache.current);
            applyGt(gt);
          } catch { /* secondary best-effort */ }
        }
        const missing = tradable.filter((t) => m[addrOf(t)]?.priceUsd == null && t.symbol !== "USDG");
        if (missing.length && cycle.current % 3 === 0) {
          try {
            const px = await fetchUsdPrices(net, missing);
            if (!alive) return;
            fallbackPx.current = { ...fallbackPx.current, ...px };
            applyFallback(px);
          } catch { /* fallback best-effort */ }
        }
        cycle.current++;
        const fl: Record<string, "up" | "down"> = {};
        for (const [a, mk] of Object.entries(m)) {
          const p = mk.priceUsd, prev = prevPx.current[a];
          if (p != null && prev != null && p !== prev) fl[a] = p > prev ? "up" : "down";
          if (p != null) prevPx.current[a] = p;
        }
        setMarkets(m); setLoaded(true); setUpdatedAt(Date.now());
        if (Object.keys(fl).length) { setFlash(fl); setTimeout(() => { if (alive) setFlash({}); }, 900); }
      } catch { /* keep prior data */ }
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [tradable]);

  const marketOf = (t: TokenInfo): Market | undefined => markets[addrOf(t)];
  const priceUsdOf = (t: TokenInfo): number | null => marketOf(t)?.priceUsd ?? (t.symbol === "USDG" ? 1 : null);

  const totalUsd = useMemo(() => {
    let s = 0;
    for (const t of tradable) {
      const bal = (props.clear[t.symbol] ?? 0n) + (props.shielded[t.symbol] ?? 0n);
      if (bal <= 0n) continue;
      const px = priceUsdOf(t);
      if (px != null) s += Number(formatUnits(bal, t.decimals)) * px;
    }
    return s;
  }, [tradable, props.clear, props.shielded, markets]);

  function seedChat(text: string) {
    setChatSeed({ text, key: Date.now() });
    closeToken(); setTab("chat");
  }

  return (
    <div className="wapp">
      <div className="wapp-body">
        {tab === "discover" && (
          <div className="wapp-tab" key="discover">
            <DiscoverTab tradable={tradable} markets={markets} loaded={loaded} flash={flash} addrOf={addrOf} onOpen={openToken} net={net} wl={wl} updatedAt={updatedAt} />
          </div>
        )}
        {tab === "portfolio" && (
          <div className="wapp-tab" key="portfolio">
            <PortfolioTab tradable={tradable} priceUsdOf={priceUsdOf} marketOf={marketOf} totalUsd={totalUsd}
              clear={props.clear} shielded={props.shielded} onOpen={openToken} isConnected={props.isConnected} onConnect={props.onConnect}
              net={net} address={props.address} walletProvider={props.walletProvider} shieldToken={props.shieldToken} />
          </div>
        )}
        {/* Chat stays mounted so its history survives tab switches; just hidden when inactive. */}
        <div className="wapp-chat" style={{ display: tab === "chat" ? "block" : "none" }}>
          <Woodie {...props} seed={chatSeed.text} seedKey={chatSeed.key} />
        </div>
      </div>

      {open && (
        <TokenSheet
          token={open} market={marketOf(open)} priceUsdOf={priceUsdOf} explorer={net.explorer || "https://robinhoodchain.blockscout.com"} wl={wl}
          onClose={closeToken} onAsk={() => seedChat(`What's happening with $${open.symbol}? Should I be watching it?`)} onSeed={seedChat}
          onTraded={() => fetchMarkets(tradable.map(addrOf)).then(setMarkets).catch(() => {})}
          {...props}
        />
      )}

      <nav className="wapp-nav" aria-label="WOODIE app">
        <NavBtn active={tab === "discover"} onClick={() => setTab("discover")} label="Discover" icon={<IconSpark />} />
        <NavBtn active={tab === "portfolio"} onClick={() => setTab("portfolio")} label="Portfolio"
          icon={<IconWallet />} badge={props.isConnected && totalUsd > 0 ? fmtCompact(totalUsd) : undefined} />
        <NavBtn active={tab === "chat"} onClick={() => setTab("chat")} label="WOODIE" icon={<IconLeaf />} />
      </nav>
    </div>
  );
}

// ---- Discover ------------------------------------------------------------

type Filter = "trending" | "watch" | "stock" | "community" | "all";

function DiscoverTab({ tradable, markets, loaded, flash, addrOf, onOpen, net, wl, updatedAt }: {
  tradable: TokenInfo[]; markets: Record<string, Market>; loaded: boolean; flash: Record<string, "up" | "down">;
  addrOf: (t: TokenInfo) => string; onOpen: (t: TokenInfo) => void; net: NetworkConfig; wl: Watchlist; updatedAt: number;
}) {
  const [filter, setFilter] = useState<Filter>("trending");
  const [q, setQ] = useState("");
  const [imported, setImported] = useState<TokenInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(id); }, []);
  const ago = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null;
  const agoTxt = ago == null ? "" : ago < 5 ? "now" : ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

  const swood = useMemo(() => tradable.find((t) => t.symbol === "SWOOD"), [tradable]);

  // Paste a contract address → resolve & offer to trade any token, even off the allowlist.
  const query = q.trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(query);
  const known = isAddr && tradable.some((t) => t.address.toLowerCase() === query.toLowerCase());
  useEffect(() => {
    if (!isAddr || known) { setImported(null); setImporting(false); return; }
    let alive = true; setImporting(true); setImported(null);
    importToken(net, query).then((t) => { if (alive) { setImported(t); setImporting(false); } }).catch(() => { if (alive) setImporting(false); });
    return () => { alive = false; };
  }, [query, isAddr, known, net]);

  const rows = useMemo(() => {
    const ql = query.toLowerCase();
    // SWOOD is pinned as the featured card above the list — drop it from the list unless searching.
    let list = tradable.filter((t) => t.symbol !== "USDG" && !(!ql && filter !== "watch" && t.symbol === "SWOOD"));
    if (ql) list = list.filter((t) => t.symbol.toLowerCase().includes(ql) || (t.name ?? "").toLowerCase().includes(ql));
    else if (filter === "watch") list = list.filter((t) => wl.has(addrOf(t)));
    else if (filter === "stock") list = list.filter((t) => t.stock);
    else if (filter === "community") list = list.filter((t) => MEMES.has(t.symbol));
    const vol = (t: TokenInfo) => markets[addrOf(t)]?.vol24 ?? -1;
    const liq = (t: TokenInfo) => markets[addrOf(t)]?.liqUsd ?? -1;
    if (filter === "trending" && !ql) list = [...list].sort((a, b) => vol(b) - vol(a));
    else list = [...list].sort((a, b) => liq(b) - liq(a) || a.symbol.localeCompare(b.symbol));
    return list;
  }, [tradable, markets, filter, query, addrOf, wl.count]);

  // top movers (by |24h change|) for the ticker
  const movers = useMemo(() => {
    return tradable
      .map((t) => ({ t, m: markets[addrOf(t)] }))
      .filter((x) => x.m?.chg24 != null && x.t.symbol !== "USDG")
      .sort((a, b) => Math.abs(b.m!.chg24!) - Math.abs(a.m!.chg24!))
      .slice(0, 8);
  }, [tradable, markets, addrOf]);

  return (
    <div className="disc">
      <header className="disc-head">
        <div className="disc-title-row">
          <h1 className="disc-title">Discover</h1>
          <span className="live-dot" title={`Prices updated ${agoTxt}`}><i /> Live{agoTxt && <span className="live-ago"> · {agoTxt}</span>}</span>
        </div>
        <p className="disc-sub">Real markets on Sherwood · private by default</p>
      </header>

      {movers.length > 2 && (
        <div className="ticker" aria-hidden>
          <div className="ticker-track">
            {[...movers, ...movers].map(({ t, m }, i) => (
              <button key={i} className="ticker-item" onClick={() => onOpen(t)} tabIndex={-1}>
                <TokenAvatar sym={t.symbol} logo={t.logo} size={18} />
                <span className="ticker-sym">{t.symbol}</span>
                <span className={m!.chg24! >= 0 ? "up" : "down"}>{fmtPct(m!.chg24)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="disc-search">
        <IconSearch />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search token or ticker" spellCheck={false} />
        {q && <button className="disc-clear" onClick={() => setQ("")} aria-label="Clear">×</button>}
      </div>
      {!q && (
        <div className="disc-filters">
          {([["trending", "🔥 Trending"], ["watch", `⭐ Watchlist${wl.count ? ` ${wl.count}` : ""}`], ["stock", "Stocks"], ["community", "Community"], ["all", "All"]] as [Filter, string][]).map(([f, label]) => (
            <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      )}

      {isAddr && !known && (
        importing ? <div className="import-row muted">Looking up token…</div>
          : imported ? (
            <TokenRow idx={0} token={imported} market={markets[lc(imported.address)]} imported
              starred={wl.has(imported.address)} onStar={() => wl.toggle(imported.address)} onClick={() => onOpen(imported)} />
          ) : <div className="import-row muted">No ERC-20 token found at that address.</div>
      )}

      {!q && filter !== "watch" && swood && (
        <FeaturedCard token={swood} market={markets[addrOf(swood)]} starred={wl.has(addrOf(swood))} onStar={() => wl.toggle(addrOf(swood))} onClick={() => onOpen(swood)} />
      )}

      <div className="disc-list">
        {!loaded
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : rows.map((t, i) => (
            <TokenRow key={t.symbol} idx={i} rank={filter === "trending" && !q ? i + 1 : undefined}
              token={t} market={markets[addrOf(t)]} flash={flash[addrOf(t)]}
              starred={wl.has(addrOf(t))} onStar={() => wl.toggle(addrOf(t))} onClick={() => onOpen(t)} />
          ))}
        {loaded && rows.length === 0 && (
          <p className="disc-empty muted">{filter === "watch" ? "No favorites yet. Tap ⭐ on any token to add it here." : `No tokens match “${q}”.`}</p>
        )}
      </div>

      <p className="disc-attrib">Live prices &amp; charts by DexScreener · GeckoTerminal · on-chain</p>
    </div>
  );
}

function FeaturedCard({ token, market, starred, onStar, onClick }: { token: TokenInfo; market?: Market; starred?: boolean; onStar?: () => void; onClick: () => void }) {
  return (
    <button className="feat" onClick={onClick}>
      <div className="feat-body">
        <TokenAvatar sym={token.symbol} logo={token.logo} size={52} />
        <div className="feat-id">
          <span className="feat-sym"><span className="feat-star" title="Featured">★</span>{token.symbol} <span className="feat-tag">Protocol token</span></span>
          <span className="feat-name">Sherwood — stake $SWOOD for a share of every swap fee</span>
        </div>
        <div className="feat-px">
          <span className="feat-price">{fmtPrice(market?.priceUsd)}</span>
          <ChangePill v={market?.chg24} />
        </div>
        {onStar && <StarBtn on={!!starred} onClick={onStar} size={18} />}
      </div>
    </button>
  );
}

function liqDot(liq: number | null | undefined) {
  if (liq == null) return null;
  const cls = liq >= 200_000 ? "deep" : liq >= 40_000 ? "med" : "thin";
  const label = cls === "deep" ? "Deep liquidity" : cls === "med" ? "Medium liquidity" : "Thin liquidity — watch price impact";
  return <i className={`liq-dot ${cls}`} title={label} />;
}

function TokenRow({ token, market, rank, idx, flash, imported, starred, onStar, onClick }: {
  token: TokenInfo; market?: Market; rank?: number; idx: number; flash?: "up" | "down";
  imported?: boolean; starred?: boolean; onStar?: () => void; onClick: () => void;
}) {
  const cat = imported ? "Imported" : catLabel(token);
  return (
    <button className={`trow ${flash ? "flash-" + flash : ""}`} style={{ ["--i" as any]: idx }} onClick={onClick}>
      {rank != null && <span className="trow-rank">{rank}</span>}
      <TokenAvatar sym={token.symbol} logo={token.logo} size={40} />
      <div className="trow-id">
        <span className="trow-sym">{token.symbol}{liqDot(market?.liqUsd)}</span>
        <span className="trow-name">{cat ? <span className="trow-cat">{cat}</span> : null}{token.name ?? token.symbol}</span>
      </div>
      <div className="trow-vol">
        {market?.vol24 != null && <span className="trow-vol-n">{fmtCompact(market.vol24)}</span>}
        {market?.vol24 != null && <span className="trow-vol-l">24h vol</span>}
      </div>
      <div className="trow-px">
        <span className="trow-px-n">{fmtPrice(market?.priceUsd)}</span>
        <ChangePill v={market?.chg24} />
      </div>
      {onStar && <StarBtn on={!!starred} onClick={onStar} size={18} />}
    </button>
  );
}

function SkeletonRow() {
  return (
    <div className="trow skel">
      <span className="sk sk-ava" />
      <div className="trow-id"><span className="sk sk-line w40" /><span className="sk sk-line w60" /></div>
      <div className="trow-px"><span className="sk sk-line w50" /><span className="sk sk-line w30" /></div>
    </div>
  );
}

function ChangePill({ v, big }: { v: number | null | undefined; big?: boolean }) {
  if (v == null) return <span className={`pill flat ${big ? "big" : ""}`}>—</span>;
  const up = v >= 0;
  return <span className={`pill ${up ? "up" : "down"} ${big ? "big" : ""}`}>{up ? "▲" : "▼"} {Math.abs(v).toFixed(2)}%</span>;
}

// ---- Token page (chart + stats + quick trade) ----------------------------

function TokenSheet({ token, market, priceUsdOf, explorer, wl, onClose, onAsk, onSeed, onTraded, ...props }: WoodieProps & {
  token: TokenInfo; market?: Market; priceUsdOf: (t: TokenInfo) => number | null; explorer: string; wl: Watchlist;
  onClose: () => void; onAsk: () => void; onSeed: (text: string) => void; onTraded: () => void;
}) {
  const [detail, setDetail] = useState<Market | null>(market ?? null);
  const [gtPool, setGtPool] = useState<string | null>(market?.pairAddress ?? null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [chartKind, setChartKind] = useState<"candle" | "line">("candle");
  const [chartLoading, setChartLoading] = useState(true);
  const [tf, setTf] = useState<"24H" | "7D" | "30D">("24H");
  const [copied, setCopied] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [links, setLinks] = useState<{ sites: string[]; socials: { type: string; url: string }[]; desc?: string; holders?: number; verified?: boolean } | null>(null);
  const addr = token.native ? WETH_ADDR : token.address;

  // socials / website / holders — merged from GeckoTerminal (rich) + DexScreener (often more socials)
  useEffect(() => {
    let alive = true; setLinks(null);
    (async () => {
      const [gi, di] = await Promise.all([fetchGtInfo(addr).catch(() => null), fetchDexInfo(addr).catch(() => null)]);
      if (!alive) return;
      const sites = Array.from(new Set([...(gi?.websites ?? []), ...((di?.websites ?? []).map((w) => w.url))].filter(Boolean)));
      const socials: { type: string; url: string }[] = [];
      const push = (type: string, url?: string) => { if (url && !socials.some((s) => s.url === url)) socials.push({ type, url }); };
      if (gi?.twitter) push("twitter", gi.twitter);
      if (gi?.telegram) push("telegram", gi.telegram);
      if (gi?.discord) push("discord", gi.discord);
      if (gi?.farcaster) push("farcaster", gi.farcaster);
      for (const s of (di?.socials ?? [])) push(s.type, s.url);
      setLinks({ sites, socials, desc: gi?.description, holders: gi?.holders, verified: gi?.verified });
    })();
    return () => { alive = false; };
  }, [addr]);

  // Pull DexScreener + GeckoTerminal in parallel: DexScreener for the richest stats, GeckoTerminal
  // for a pool we can draw a native chart from (and as a stats fallback for uncharted tokens).
  useEffect(() => {
    let alive = true; setLoadingDetail(true);
    const dsP = fetchTokenDetail(addr).catch(() => ({ market: null as Market | null }));
    const gtP = fetchGtToken(addr, undefined, true).catch(() => null);
    // Two-stage on purpose: DexScreener answers in ~1s while GeckoTerminal can sit behind its
    // rate-limit queue for 10s+ — publish the DS result the moment it lands (stats + a pool for the
    // chart/embed), then let the GT result upgrade it. Awaiting both before showing anything held
    // the whole sheet hostage to GT's 429 backoff.
    dsP.then((d) => {
      if (!alive || !d.market) return;
      setDetail((cur) => cur ?? d.market);
      if (d.market.pairAddress) setGtPool((cur) => cur ?? d.market!.pairAddress);
    });
    (async () => {
      const [d, gt] = await Promise.all([dsP, gtP]);
      if (!alive) return;
      const chosen = (d.market?.pairAddress ? d.market : null) ?? gt ?? d.market ?? null;
      if (chosen) setDetail(chosen);
      // any pool address (GeckoTerminal's, or the DexScreener pair which doubles as a GT pool for
      // v2/v3) can drive the OHLCV chart — resilient to GeckoTerminal rate-limits on fetchGtToken.
      setGtPool((cur) => cur ?? gt?.pairAddress ?? chosen?.pairAddress ?? market?.pairAddress ?? null);
      setLoadingDetail(false);
    })();
    return () => { alive = false; };
  }, [addr]);

  // recent trades for the activity feed
  const [trades, setTrades] = useState<GtTrade[] | null>(null);
  useEffect(() => {
    if (!gtPool) { setTrades(null); return; }
    let alive = true;
    fetchTrades(gtPool, addr, 25, undefined, true).then((t) => { if (alive) setTrades(t); }).catch(() => {});
    return () => { alive = false; };
  }, [gtPool]);

  // native chart series from GeckoTerminal OHLCV
  useEffect(() => {
    if (!gtPool) { setCandles(null); setChartLoading(false); return; }
    let alive = true; setChartLoading(true);
    const [timeframe, limit] = tf === "24H" ? (["hour", 24] as const) : tf === "7D" ? (["hour", 168] as const) : (["day", 30] as const);
    let tries = 0;
    const attempt = () => {
      fetchOhlcv(gtPool, addr, timeframe, limit, undefined, true, (detail ?? market)?.priceUsd ?? priceUsdOf(token)).then((rows) => {
        if (!alive) return;
        if (rows.length > 2) { setCandles(rows); setChartLoading(false); }
        else if (tries++ < 1) { setTimeout(attempt, 1200); }        // transient miss → retry once
        else { setCandles(null); setChartLoading(false); }
      }).catch(() => { if (alive) { if (tries++ < 1) setTimeout(attempt, 1200); else { setCandles(null); setChartLoading(false); } } });
    };
    attempt();
    return () => { alive = false; };
  }, [gtPool, tf]);

  const m = detail ?? market;
  const stock = token.stock ? STOCK_INFO[token.symbol] : undefined;
  const about = links?.desc || stock?.blurb;
  const clearBal = props.clear[token.symbol] ?? 0n;
  const shBal = props.shielded[token.symbol] ?? 0n;
  const totalBal = clearBal + shBal;
  const posValue = m?.priceUsd != null ? Number(formatUnits(totalBal, token.decimals)) * m.priceUsd : null;

  async function copyAddr() {
    try { await navigator.clipboard.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* no clipboard */ }
  }

  return (
    <div className="sheet" role="dialog" aria-label={`${token.symbol} market`}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet-card">
        <div className="sheet-grab" onClick={onClose} />
        <header className="sheet-head">
          <button className="sheet-back" onClick={onClose} aria-label="Back">←</button>
          <TokenAvatar sym={token.symbol} logo={token.logo} size={38} />
          <div className="sheet-id">
            <span className="sheet-sym">{token.symbol}{links?.verified && <span className="verified-chip" title="Verified on GeckoTerminal">✓</span>}</span>
            <span className="sheet-name">{token.name ?? token.symbol}</span>
          </div>
          <StarBtn on={wl.has(addr)} onClick={() => wl.toggle(addr)} size={22} />
          <button className="btn ghost sm sheet-ask" onClick={onAsk} title="Ask WOODIE about this token">Ask WOODIE</button>
        </header>

        <div className="sheet-priceline">
          <span className="sheet-price">{fmtPrice(m?.priceUsd)}</span>
          <ChangePill v={m?.chg24} big />
        </div>

        {links && (links.sites.length > 0 || links.socials.length > 0 || links.holders != null) && (
          <div className="sheet-social">
            {links.sites[0] && <a className="soc" href={links.sites[0]} target="_blank" rel="noreferrer" title="Website"><IconGlobe /></a>}
            {links.socials.map((s) => <a key={s.url} className="soc" href={s.url} target="_blank" rel="noreferrer" title={s.type}>{socIcon(s.type)}</a>)}
            {links.holders != null && <span className="soc-holders">{links.holders.toLocaleString()} holders</span>}
          </div>
        )}
        {(about || stock) && (
          <div className="sheet-about">
            {stock && <span className="sheet-tag">🏛 Tokenized stock · {stock.sector}</span>}
            {about && <p className="sheet-desc">{about}</p>}
          </div>
        )}

        <div className="sheet-chart">
          {candles
            ? <div className="pchart-wrap">
                <TVChart candles={candles} kind={chartKind} />
                <div className="pchart-toolbar">
                  <div className="pchart-kind">
                    <button className={`kbtn ${chartKind === "candle" ? "on" : ""}`} onClick={() => setChartKind("candle")} title="Candlestick" aria-label="Candlestick">◧</button>
                    <button className={`kbtn ${chartKind === "line" ? "on" : ""}`} onClick={() => setChartKind("line")} title="Line" aria-label="Line">∿</button>
                  </div>
                  <div className="pchart-tf">{(["24H", "7D", "30D"] as const).map((t) => <button key={t} className={`tfbtn ${tf === t ? "on" : ""}`} onClick={() => setTf(t)}>{t}</button>)}</div>
                </div>
              </div>
            : (m?.source === "dex" && m.pairAddress) || gtPool
              // Native candles aren't in yet (the GT API queue is slow/rate-limited) but the pool IS
              // charted — show the indexer's own embed immediately so a chart is on screen within a
              // second; the native chart swaps in whenever its data lands.
              ? <iframe title={`${token.symbol} chart`} src={m?.source === "dex" && m.pairAddress ? dexEmbed(m.pairAddress) : gtEmbed(gtPool!)} />
              : chartLoading
                ? <div className="sheet-chart-skel"><span className="sk" /></div>
                : <div className="sheet-chart-none muted">{m?.priceUsd != null ? `Not enough on-chain trading to chart ${token.symbol} yet.` : `No live market for ${token.symbol} yet.`}</div>}
        </div>

        <div className="sheet-stats">
          {loadingDetail && m?.liqUsd == null && m?.vol24 == null
            ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="stat"><span className="sk sk-line w40" /><span className="sk sk-line w60" /></div>)
            : <>
          <Stat label="Liquidity" value={fmtCompact(m?.liqUsd)} />
          <Stat label="24h Volume" value={fmtCompact(m?.vol24)} />
          <Stat label="1h" value={fmtPct(m?.chg1)} tone={m?.chg1} />
          <Stat label="6h" value={fmtPct(m?.chg6)} tone={m?.chg6} />
            </>}
        </div>
        {(m?.buys24 != null || m?.sells24 != null) && <BuySellBar buys={m?.buys24 ?? 0} sells={m?.sells24 ?? 0} />}

        {props.isConnected && totalBal > 0n && (
          <div className="sheet-position">
            <div className="pos-top"><span className="pos-label">Your position</span>{m?.chg24 != null && <ChangePill v={m.chg24} />}</div>
            <div className="pos-val">{posValue != null ? fmtCompact(posValue) : "—"}</div>
            <div className="pos-sub">
              <span>{trimAmt(formatUnits(totalBal, token.decimals))} {token.symbol}</span>
              {shBal > 0n && <span className="pos-shield">🛡 {trimAmt(formatUnits(shBal, token.decimals))} private</span>}
            </div>
          </div>
        )}

        <TradePanel token={token} priceUsdOf={priceUsdOf} onTraded={onTraded} onSeed={onSeed} {...props} />

        <div className="sheet-foot">
          {!token.native && (
            <button className="sheet-link" onClick={copyAddr}>{copied ? "✓ Copied" : <>{shortAddr(addr)} <IconCopy /></>}</button>
          )}
          <a className="sheet-link" href={`${explorer}/token/${addr}`} target="_blank" rel="noreferrer">Explorer ↗</a>
          {m?.url && <a className="sheet-link" href={m.url} target="_blank" rel="noreferrer">{m.source === "gt" ? "GeckoTerminal ↗" : "DexScreener ↗"}</a>}
        </div>

        {trades && trades.length > 0 && (
          <div className="sheet-trades">
            <div className="st-head">Recent activity</div>
            <div className="st-list">
              {trades.slice(0, 15).map((t, i) => (
                <a key={i} className="st-row" href={`${explorer}/tx/${t.tx}`} target="_blank" rel="noreferrer">
                  <span className={`st-kind ${t.kind}`}>{t.kind === "buy" ? "Buy" : "Sell"}</span>
                  <span className="st-usd">{fmtCompact(t.usd)}</span>
                  <span className="st-maker">{shortAddr(t.maker)}</span>
                  <span className="st-time">{timeAgo(t.ts)}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const timeAgo = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  const mn = Math.round(s / 60); if (mn < 60) return mn + "m";
  const h = Math.round(mn / 60); if (h < 24) return h + "h";
  return Math.round(h / 24) + "d";
};

/** TradingView Lightweight Charts — interactive candlestick / area chart, themed, from GT OHLCV. */
function TVChart({ candles, kind }: { candles: Candle[]; kind: "candle" | "line" }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const series = useRef<any>(null);

  useEffect(() => {
    if (!box.current) return;
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue("--moon-dim").trim() || "#90a096";
    const grid = "rgba(255,255,255,0.05)", border = "rgba(255,255,255,0.08)";
    const c = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text, fontFamily: "IBM Plex Mono, ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      width: box.current.clientWidth, height: box.current.clientHeight,
    });
    chart.current = c;
    const ro = new ResizeObserver(() => box.current && c.applyOptions({ width: box.current.clientWidth, height: box.current.clientHeight }));
    ro.observe(box.current);
    return () => { ro.disconnect(); c.remove(); chart.current = null; series.current = null; };
  }, []);

  useEffect(() => {
    const c = chart.current; if (!c) return;
    if (series.current) { c.removeSeries(series.current); series.current = null; }
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue("--up").trim() || "#34d399";
    const down = css.getPropertyValue("--down").trim() || "#ff6b5e";
    const lime = css.getPropertyValue("--lime").trim() || "#c6f432";
    if (kind === "candle") {
      const s = c.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
      s.setData(candles.map((k) => ({ time: k.t as any, open: k.o, high: k.h, low: k.l, close: k.c })));
      series.current = s;
    } else {
      const s = c.addAreaSeries({ lineColor: lime, topColor: "rgba(198,244,50,0.28)", bottomColor: "rgba(198,244,50,0)", lineWidth: 2, priceLineVisible: false });
      s.setData(candles.map((k) => ({ time: k.t as any, value: k.c })));
      series.current = s;
    }
    c.timeScale().fitContent();
  }, [kind, candles]);

  return <div ref={box} className="tvchart" />;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  const cls = tone == null ? "" : tone >= 0 ? "up" : "down";
  return (
    <div className="stat">
      <span className="stat-l">{label}</span>
      <span className={`stat-v ${cls}`}>{value}</span>
    </div>
  );
}

function BuySellBar({ buys, sells }: { buys: number; sells: number }) {
  const total = buys + sells || 1;
  const buyPct = Math.round((buys / total) * 100);
  return (
    <div className="bsbar">
      <div className="bsbar-row"><span className="up">Buys {buys.toLocaleString()}</span><span className="down">{sells.toLocaleString()} Sells</span></div>
      <div className="bsbar-track"><div className="bsbar-fill" style={{ width: `${buyPct}%` }} /></div>
    </div>
  );
}

// ---- Quick trade ---------------------------------------------------------

const BUY_PRESETS: Record<string, string[]> = { ETH: ["0.01", "0.05", "0.1", "0.25"], USDG: ["10", "50", "100", "250"] };

const SHIELD_SLIP_BPS = 300n; // 3% floor for shielded swaps (matches WOODIE's shielded_swap)

function TradePanel({ token, priceUsdOf, onTraded, onSeed, ...props }: WoodieProps & {
  token: TokenInfo; priceUsdOf: (t: TokenInfo) => number | null; onTraded: () => void; onSeed: (text: string) => void;
}) {
  const { net, tokenBySymbol, clear, shielded, isConnected, onConnect } = props;
  const [mode, setMode] = useState<"public" | "private">("public");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [payWith, setPayWith] = useState<"ETH" | "USDG">("ETH");
  const [amount, setAmount] = useState("");
  const [recv, setRecv] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const explorer = net.explorer || "https://robinhoodchain.blockscout.com";
  const priv = mode === "private";

  const [usdMode, setUsdMode] = useState(false);           // type a $ amount instead of a token amount
  const pay = tokenBySymbol(payWith);
  const tokenIn = side === "buy" ? pay : token;
  const tokenOut = side === "buy" ? token : pay;
  const bag = priv ? shielded : clear;                       // private trades spend shielded notes
  const balIn = tokenIn ? (bag[tokenIn.symbol] ?? 0n) : 0n;
  const priceIn = tokenIn ? priceUsdOf(tokenIn) : null;
  const canUsd = priceIn != null && priceIn > 0;
  // the token-unit amount actually swapped (USD input ÷ price), clamped to the token's decimals
  const amtToken = useMemo(() => {
    if (!amount || !tokenIn || Number(amount) <= 0) return "";
    const n = usdMode && canUsd ? Number(amount) / (priceIn as number) : Number(amount);
    if (!isFinite(n) || n <= 0) return "";
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(tokenIn.decimals, 18), useGrouping: false });
  }, [amount, usdMode, canUsd, priceIn, tokenIn]);

  useEffect(() => {
    setRecv(null);
    if (!tokenIn || !tokenOut || !amtToken) return;
    let alive = true;
    setQuoting(true);
    const id = setTimeout(async () => {
      try {
        const amt = parseUnits(amtToken, tokenIn.decimals);
        const out = priv
          ? await quoteShielded(net, tokenIn, tokenOut, amt)
          : await quoteTrade(publicClientFor(net), tokenIn, tokenOut, amt);
        if (alive) setRecv(out);
      } catch { if (alive) setRecv(null); } finally { if (alive) setQuoting(false); }
    }, 380);
    return () => { alive = false; clearTimeout(id); setQuoting(false); };
  }, [amtToken, tokenIn, tokenOut, net, priv]);

  const recvUsd = useMemo(() => {
    if (recv == null || !tokenOut) return null;
    const px = priceUsdOf(tokenOut);
    return px == null ? null : Number(formatUnits(recv, tokenOut.decimals)) * px;
  }, [recv, tokenOut, priceUsdOf]);

  const payUsd = useMemo(() => {
    if (!amount || Number(amount) <= 0) return null;
    if (usdMode) return Number(amount);
    return priceIn == null ? null : Number(amount) * priceIn;
  }, [amount, usdMode, priceIn]);

  function setPct(p: number) {
    if (side !== "sell" || !tokenIn) return;
    setUsdMode(false);
    setAmount(trimAmt(formatUnits((balIn * BigInt(p)) / 100n, tokenIn.decimals)));
  }
  function setMax() {
    if (!tokenIn) return;
    if (usdMode && canUsd) setAmount(String(Math.floor(Number(formatUnits(balIn, tokenIn.decimals)) * (priceIn as number) * 100) / 100));
    else setAmount(trimAmt(formatUnits(balIn, tokenIn.decimals)));
  }

  // In private mode you spend shielded notes; if there are none of the input asset, hand off to
  // WOODIE to shield first (it builds the shield → private-swap plan).
  const needShield = priv && isConnected && balIn <= 0n;
  function shieldHandoff() {
    const amt = amtToken || (side === "buy" ? (payWith === "ETH" ? "0.05" : "100") : "");
    onSeed(side === "buy"
      ? `Shield ${amt} ${payWith}, then privately swap it into ${token.symbol}.`
      : `Shield ${amt} ${token.symbol} so I can privately sell it.`);
  }

  async function doTrade() {
    if (!isConnected) { onConnect(); return; }
    if (!tokenIn || !tokenOut || !amtToken) return;
    const verb = side === "buy" ? "Buying" : "Selling";
    setBusy(true);
    const id = toast({ kind: "busy", msg: `${priv ? "Privately " + verb.toLowerCase() : verb} ${token.symbol}…` });
    try {
      const amt = parseUnits(amtToken, tokenIn.decimals);
      if (amt > balIn) throw new Error(`Not enough ${priv ? "shielded " : ""}${tokenIn.symbol}. You have ${fmtBal(balIn, tokenIn.decimals)}.`);
      if (priv) {
        const expected = await quoteShielded(net, tokenIn, tokenOut, amt);
        const minOut = expected != null && expected > 0n ? (expected * (10000n - SHIELD_SLIP_BPS)) / 10000n : 0n;
        await props.swapMulti(tokenIn, amt, tokenOut, minOut); // shielded swap — drives its own desk toast
        dismiss(id);
      } else {
        const { hash } = await executePublicSwap({
          net, walletProvider: props.walletProvider, address: props.address as Address,
          tokenIn, tokenOut, amountIn: amt,
          onStage: (s) => toast({ id, kind: "busy", msg: s === "approve" ? `Approving ${tokenIn.symbol}…` : `${verb} ${token.symbol}…` }),
        });
        toast({ id, kind: "ok", msg: `${side === "buy" ? "Bought" : "Sold"} ${token.symbol}.`, hash, explorer });
      }
      setAmount(""); setRecv(null); onTraded();
    } catch (e: any) {
      toast({ id, kind: "error", msg: humanErr(e) });
    } finally { setBusy(false); }
  }

  const canTrade = !!tokenIn && !!tokenOut && !!amtToken && !busy && !needShield;
  const slideLabel = `Slide to ${side} ${token.symbol}${priv ? " privately" : ""}`;

  return (
    <div className="trade">
      <div className="trade-modes">
        <button className={`tmode ${!priv ? "on" : ""}`} onClick={() => setMode("public")}>Public</button>
        <button className={`tmode priv ${priv ? "on" : ""}`} onClick={() => setMode("private")}>🛡 Private</button>
      </div>

      <div className="trade-side">
        <button className={`ts-btn buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmount(""); }}>Buy</button>
        <button className={`ts-btn sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button>
      </div>

      <div className="trade-payrow">
        <span className="trade-label">{side === "buy" ? "Pay with" : "Receive in"}</span>
        <div className="trade-seg">
          {(["ETH", "USDG"] as const).map((s) => (
            <button key={s} className={`seg ${payWith === s ? "on" : ""}`} onClick={() => setPayWith(s)}>{s}</button>
          ))}
        </div>
      </div>

      <div className="trade-input">
        {usdMode && <span className="trade-usd-sign">$</span>}
        <input inputMode="decimal" placeholder="0.0" value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        <div className="trade-input-r">
          <button className="trade-unit" onClick={() => canUsd && setUsdMode((v) => !v)} disabled={!canUsd}
            title={canUsd ? "Switch between token and USD amount" : undefined}>
            {usdMode ? "USD" : (side === "buy" ? payWith : token.symbol)} {canUsd && <span className="trade-unit-swap">⇅</span>}
          </button>
          <span className="trade-input-usd">
            {usdMode
              ? (amtToken ? `≈ ${trimAmt(amtToken)} ${tokenIn?.symbol}` : "")
              : (payUsd != null ? fmtCompact(payUsd) : "")}
          </span>
        </div>
      </div>

      <div className="trade-presets">
        {side === "buy"
          ? (usdMode ? ["10", "50", "100", "250"] : BUY_PRESETS[payWith]).map((v) => <button key={v} className="preset" onClick={() => setAmount(v)}>{usdMode ? "$" + v : v}</button>)
          : [25, 50, 100].map((p) => <button key={p} className="preset" onClick={() => setPct(p)}>{p}%</button>)}
        {side === "buy" && <button className="preset" onClick={setMax}>Max</button>}
        <span className="trade-bal">{priv && <span className="bal-shield">🛡 </span>}{fmtBal(balIn, tokenIn?.decimals ?? 18)} {tokenIn?.symbol}</span>
      </div>

      <div className="trade-recv">
        <span className="muted">You receive</span>
        <span className="trade-recv-v">
          {quoting ? <span className="dots"><span/><span/><span/></span> : recv != null && tokenOut ? `≈ ${trimAmt(formatUnits(recv, tokenOut.decimals))} ${tokenOut.symbol}` : "—"}
          {recvUsd != null && <span className="trade-recv-usd"> · {fmtCompact(recvUsd)}</span>}
        </span>
      </div>

      <RoutePanel net={net} tokenIn={tokenIn} tokenOut={tokenOut} amtToken={amtToken} mode={mode} />

      {!isConnected ? (
        <button className="btn block trade-connect" onClick={onConnect}>Connect wallet</button>
      ) : needShield ? (
        <div className="trade-shieldhint">
          <span>You have no shielded {tokenIn?.symbol}. Shield funds into the private pool first.</span>
          <button className="btn sm block" onClick={shieldHandoff}>Shield with WOODIE →</button>
        </div>
      ) : (
        <SlideToConfirm label={slideLabel} color={side === "buy" ? "buy" : "sell"} disabled={!canTrade} onConfirm={doTrade} />
      )}
    </div>
  );
}

/** Cross-chain router — bring funds from another chain (Houdini) to buy this token. Compares the
 *  cheapest vs fastest route to ETH@Base (Sherwood's gateway); execution completes in the Bridge. */
function CrossChainBuy({ net, token }: { net: NetworkConfig; token: TokenInfo }) {
  const [open, setOpen] = useState(false);
  const [srcId, setSrcId] = useState(X_ASSETS.find((a) => a.symbol === "USDC" && a.chain === "base")?.id || X_ASSETS[0].id);
  const [amount, setAmount] = useState("");
  const [quotes, setQuotes] = useState<XQuote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const src = X_ASSETS.find((a) => a.id === srcId);

  useEffect(() => {
    if (!open || !amount || Number(amount) <= 0 || srcId === ETH_BASE_ID) { setQuotes(null); return; }
    let alive = true; setLoading(true);
    const id = setTimeout(async () => {
      try { const q = await xchainQuotesAll(net, srcId, ETH_BASE_ID, Number(amount)); if (alive) setQuotes(q); }
      catch { if (alive) setQuotes(null); } finally { if (alive) setLoading(false); }
    }, 500);
    return () => { alive = false; clearTimeout(id); };
  }, [open, srcId, amount, net]);

  const valid = (quotes ?? []).filter((q) => q.amountOut > 0);
  const best = valid.length ? valid.reduce((a, b) => (b.amountOut > a.amountOut ? b : a)) : null;
  const fastest = valid.length ? valid.reduce((a, b) => ((b.duration ?? 1e9) < (a.duration ?? 1e9) ? b : a)) : null;
  const eta = (d?: number) => (d == null ? "—" : d < 60 ? `${Math.round(d)}s` : `${Math.round(d / 60)}m`);
  const typeLabel = (q: XQuote) => q.type === "private" ? "Private" : q.type === "dex" ? "On-chain" : q.swapName || "CEX";

  const Card = ({ q, tag }: { q: XQuote; tag: string }) => (
    <div className="xcc-route">
      <div className="xcc-route-top"><span className="xcc-tag">{tag}</span><span className="xcc-type">{typeLabel(q)}</span></div>
      <div className="xcc-out">≈ {trimAmt(String(q.amountOut))} ETH<span className="muted"> on Base</span></div>
      <div className="xcc-meta muted">{q.amountOutUsd != null ? `${fmtCompact(q.amountOutUsd)} · ` : ""}ETA {eta(q.duration)}</div>
    </div>
  );

  return (
    <div className="xcc">
      <button className="xcc-head" onClick={() => setOpen((o) => !o)}>
        <span>🌉 Pay from another chain</span>
        <span className="route-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="xcc-body">
          <div className="xcc-inrow">
            <select className="xcc-src" value={srcId} onChange={(e) => setSrcId(e.target.value)}>
              {X_ASSETS.filter((a) => a.id !== ETH_BASE_ID).map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.label}</option>)}
            </select>
            <input className="xcc-amt" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <span className="xcc-unit">{src?.symbol}</span>
          </div>
          {loading && !valid.length ? <p className="xcc-note muted">Finding routes…</p>
            : best ? (
              <>
                <div className="xcc-routes">
                  <Card q={best} tag="$ Cheapest" />
                  {fastest && fastest.quoteId !== best.quoteId && <Card q={fastest} tag="⚡ Fastest" />}
                </div>
                <p className="xcc-note muted">Lands as ETH on Base → the Bridge relays it into Robinhood Chain, then buy {token.symbol}.</p>
                <a className="btn block sm" href="#/bridge">Continue in Bridge →</a>
              </>
            ) : amount && Number(amount) > 0 ? <p className="xcc-note muted">No route for that amount.</p>
              : <p className="xcc-note muted">Bridge BTC, SOL, ETH, USDC & more into Sherwood — cheapest or fastest.</p>}
        </div>
      )}
    </div>
  );
}

/** Multirouter panel — best route across every DEX + price impact + public-vs-private comparison. */
function RoutePanel({ net, tokenIn, tokenOut, amtToken, mode }: {
  net: NetworkConfig; tokenIn?: TokenInfo; tokenOut?: TokenInfo; amtToken: string; mode: "public" | "private";
}) {
  const [an, setAn] = useState<RouteAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!tokenIn || !tokenOut || !amtToken || Number(amtToken) <= 0) { setAn(null); return; }
    let alive = true; setLoading(true);
    const id = setTimeout(async () => {
      try { const r = await analyzeRoute(net, tokenIn, tokenOut, parseUnits(amtToken, tokenIn.decimals)); if (alive) setAn(r); }
      catch { if (alive) setAn(null); } finally { if (alive) setLoading(false); }
    }, 550);
    return () => { alive = false; clearTimeout(id); };
  }, [net, tokenIn, tokenOut, amtToken]);

  if (!tokenIn || !tokenOut || !amtToken || Number(amtToken) <= 0) return null;
  const pub = an?.pub;
  const pubOut = pub?.out ?? null, privOut = an?.privateOut ?? null;
  const better = pubOut != null && privOut != null ? (pubOut >= privOut ? "public" : "private") : null;
  const fmtOut = (v: bigint | null) => (v != null && tokenOut ? trimAmt(formatUnits(v, tokenOut.decimals)) : "—");

  return (
    <div className="route">
      <button className="route-head" onClick={() => setOpen((o) => !o)}>
        <span className="route-title">Best route</span>
        <span className="route-best">{loading && !pub ? "finding…" : pub ? `${pub.best} · ${pub.checked} DEX checked` : "—"}</span>
        <span className="route-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && pub && (
        <div className="route-body">
          <div className="route-row"><span>Path</span><span>{pub.legs.length ? pub.legs.map((l) => `${l.sym} → ${l.venue}`).join(" · ") : "Direct"}</span></div>
          <div className="route-row"><span>Hops</span><span>{pub.hops <= 1 ? "Direct (1 hop)" : `${pub.hops} hops`}</span></div>
          {pub.impactBps != null && <div className="route-row"><span>Price impact</span><span className={pub.impactBps > 100 ? "down" : pub.impactBps > 30 ? "" : "up"}>{(pub.impactBps / 100).toFixed(2)}%</span></div>}
          {pub.alts.length > 0 && <div className="route-row"><span>Also checked</span><span className="route-alts">{pub.alts.map((a) => `${a.src} −${(a.deltaBps / 100).toFixed(1)}%`).join(" · ")}</span></div>}
          <div className="route-compare">
            <div className={`rc ${mode === "public" ? "on" : ""} ${better === "public" ? "win" : ""}`}>
              <span>Public</span><b>{fmtOut(pubOut)}</b>{better === "public" && <em>cheapest</em>}
            </div>
            <div className={`rc priv ${mode === "private" ? "on" : ""} ${better === "private" ? "win" : ""}`}>
              <span>🛡 Private</span><b>{fmtOut(privOut)}</b>{better === "private" && <em>cheapest</em>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Slide-to-confirm track — the FOMO-style buy gesture. Drag the thumb to the end to fire. */
function SlideToConfirm({ label, color, disabled, onConfirm }: { label: string; color: "buy" | "sell"; disabled?: boolean; onConfirm: () => Promise<void> | void }) {
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [busy, setBusy] = useState(false);
  const drag = useRef(false);
  const THUMB = 54;
  const maxX = () => Math.max(0, (track.current?.clientWidth ?? 260) - THUMB - 8);

  function down(e: React.PointerEvent) { if (disabled || busy) return; drag.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function move(e: React.PointerEvent) {
    if (!drag.current) return;
    const rect = track.current!.getBoundingClientRect();
    setX(Math.max(0, Math.min(maxX(), e.clientX - rect.left - THUMB / 2)));
  }
  async function up() {
    if (!drag.current) return; drag.current = false;
    if (x >= maxX() * 0.9) { setX(maxX()); await fire(); } else setX(0);
  }
  async function fire() { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setX(0); } }

  const pct = maxX() > 0 ? x / maxX() : 0;
  return (
    <div ref={track} className={`slide ${color} ${disabled ? "off" : ""}`}
      onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="slide-fill" style={{ width: x + THUMB + 4 }} />
      <span className="slide-label" style={{ opacity: 1 - pct * 0.85 }}>{busy ? "Confirming…" : label}</span>
      <div className="slide-thumb" style={{ transform: `translateX(${x}px)` }} onPointerDown={down}
        role="button" tabIndex={0} aria-label={label}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled && !busy) fire(); }}>
        {busy ? <span className="slide-spin" /> : <span className="slide-chevrons">›››</span>}
      </div>
    </div>
  );
}

// ---- Portfolio -----------------------------------------------------------

function PortfolioTab({ tradable, priceUsdOf, marketOf, totalUsd, clear, shielded, onOpen, isConnected, onConnect, net, address, walletProvider, shieldToken }: {
  tradable: TokenInfo[]; priceUsdOf: (t: TokenInfo) => number | null; marketOf: (t: TokenInfo) => Market | undefined;
  totalUsd: number; clear: Record<string, bigint>; shielded: Record<string, bigint>; onOpen: (t: TokenInfo) => void;
  isConnected: boolean; onConnect: () => void;
  net: NetworkConfig; address?: string; walletProvider: any; shieldToken: (t: TokenInfo, amount: bigint) => Promise<void>;
}) {
  const [act, setAct] = useState<"send" | "receive" | "shield" | "swap" | null>(null);
  const [copied, setCopied] = useState(false);
  const copyAddr = async () => { if (!address) return; try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* */ } };
  const holdings = useMemo(() => {
    return tradable.map((t) => {
      const bal = clear[t.symbol] ?? 0n, sh = shielded[t.symbol] ?? 0n, total = bal + sh;
      if (total <= 0n) return null;
      const px = priceUsdOf(t);
      const units = Number(formatUnits(total, t.decimals));
      const value = px == null ? null : units * px;
      return { t, sh, units, value, chg: marketOf(t)?.chg24 ?? null };
    }).filter(Boolean) as { t: TokenInfo; sh: bigint; units: number; value: number | null; chg: number | null }[];
  }, [tradable, clear, shielded, priceUsdOf, marketOf]);

  const sorted = [...holdings].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const priced = holdings.filter((h) => h.value != null && h.chg != null);
  const totalPriced = priced.reduce((s, h) => s + (h.value ?? 0), 0);
  const wChg = totalPriced > 0 ? priced.reduce((s, h) => s + (h.value ?? 0) * (h.chg ?? 0), 0) / totalPriced : null;

  if (!isConnected) return (
    <div className="pf">
      <header className="disc-head"><h1 className="disc-title">Portfolio</h1></header>
      <div className="pf-empty">
        <div className="pf-empty-ic"><IconWallet /></div>
        <p className="muted">Connect your wallet to see your holdings, valued live.</p>
        <button className="btn" onClick={onConnect}>Connect wallet</button>
      </div>
    </div>
  );

  const acts: { k: "send" | "receive" | "swap" | "shield"; label: string; icon: React.ReactNode }[] = [
    { k: "send", label: "Send", icon: <IconSend /> },
    { k: "receive", label: "Receive", icon: <IconReceive /> },
    { k: "swap", label: "Swap", icon: <IconSwap /> },
    { k: "shield", label: "Shield", icon: <IconShield /> },
  ];

  return (
    <div className="pf">
      <header className="disc-head">
        <h1 className="disc-title">Wallet</h1>
        {address && <button className="wpf-addr" onClick={copyAddr}>{copied ? "✓ Copied" : <>{shortAddr(address)} <IconCopy /></>}</button>}
      </header>
      <div className="pf-total">
        <div className="pf-total-l">Total value</div>
        <div className="pf-total-v">{fmtCompact(totalUsd)}</div>
        {wChg != null && <div className="pf-total-chg"><ChangePill v={wChg} big /> <span className="muted">24h</span></div>}
      </div>

      <div className="wpf-actions">
        {acts.map((a) => (
          <button key={a.k} className="pf-act" onClick={() => setAct(a.k)}>
            <span className="pf-act-ic">{a.icon}</span><span>{a.label}</span>
          </button>
        ))}
      </div>

      {act && <WalletActionSheet kind={act} onClose={() => setAct(null)} net={net} address={address} walletProvider={walletProvider}
        tradable={tradable} clear={clear} priceUsdOf={priceUsdOf} shieldToken={shieldToken} onOpen={onOpen} />}
      {sorted.length > 0 && (
        <div className="pf-alloc">
          {sorted.slice(0, 8).map((h) => {
            const w = totalUsd > 0 && h.value != null ? (h.value / totalUsd) * 100 : 0;
            return <span key={h.t.symbol} className="pf-alloc-seg" style={{ width: `${Math.max(w, 1.5)}%` }} title={`${h.t.symbol} ${w.toFixed(1)}%`} data-sym={h.t.symbol} />;
          })}
        </div>
      )}
      <div className="pf-list">
        {sorted.length === 0 && <p className="disc-empty muted">No holdings yet. Head to Discover to make your first trade.</p>}
        {sorted.map((h, i) => (
          <button key={h.t.symbol} className="pfrow" style={{ ["--i" as any]: i }} onClick={() => onOpen(h.t)}>
            <TokenAvatar sym={h.t.symbol} logo={h.t.logo} size={38} />
            <div className="pfrow-id">
              <span className="trow-sym">{h.t.symbol}</span>
              <span className="pfrow-units">{trimAmt(h.units.toString())} {h.t.symbol}{h.sh > 0n && <span className="pfrow-shield" title="Shielded (private)"> · 🛡 private</span>}</span>
            </div>
            <div className="trow-px">
              <span className="trow-px-n">{h.value != null ? fmtCompact(h.value) : "—"}</span>
              <ChangePill v={h.chg} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Wallet action sheet — Send (public transfer), Receive (address), Shield (into private pool), Swap. */
function WalletActionSheet({ kind, onClose, net, address, walletProvider, tradable, clear, shieldToken, onOpen }: {
  kind: "send" | "receive" | "shield" | "swap"; onClose: () => void; net: NetworkConfig; address?: string; walletProvider: any;
  tradable: TokenInfo[]; clear: Record<string, bigint>; priceUsdOf: (t: TokenInfo) => number | null;
  shieldToken: (t: TokenInfo, amount: bigint) => Promise<void>; onOpen: (t: TokenInfo) => void;
}) {
  const explorer = net.explorer || "https://robinhoodchain.blockscout.com";
  const held = useMemo(() => tradable.filter((t) => (clear[t.symbol] ?? 0n) > 0n && t.symbol !== "WETH"), [tradable, clear]);
  const [sym, setSym] = useState(held[0]?.symbol ?? "");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const token = tradable.find((t) => t.symbol === sym);
  const bal = token ? (clear[token.symbol] ?? 0n) : 0n;
  const title = kind === "send" ? "Send" : kind === "receive" ? "Receive" : kind === "shield" ? "Shield" : "Swap";

  async function run(fn: () => Promise<void>, verb: string, ok: string) {
    if (!token || !amount || Number(amount) <= 0) return;
    setBusy(true);
    const id = toast({ kind: "busy", msg: `${verb} ${token.symbol}…` });
    try {
      if (parseUnits(amount, token.decimals) > bal) throw new Error(`Not enough ${token.symbol}. You have ${fmtBal(bal, token.decimals)}.`);
      await fn();
      toast({ id, kind: "ok", msg: ok });
      onClose();
    } catch (e: any) { toast({ id, kind: "error", msg: humanErr(e) }); } finally { setBusy(false); }
  }
  const doSend = () => run(async () => {
    const { hash } = await executeTransfer({ net, walletProvider, address: address as Address, token: token!, amount: parseUnits(amount, token!.decimals), to });
    toast({ kind: "ok", msg: `Sent ${amount} ${token!.symbol}.`, hash, explorer });
  }, "Sending", `Sent ${amount} ${sym}.`);
  const doShield = () => run(async () => { await shieldToken(token!, parseUnits(amount, token!.decimals)); }, "Shielding", `Shielded ${amount} ${sym}.`);

  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet-card">
        <div className="sheet-grab" onClick={onClose} />
        <header className="sheet-head"><button className="sheet-back" onClick={onClose} aria-label="Back">←</button><span className="sheet-sym">{title}</span></header>

        {kind === "receive" && (
          <div className="ws-receive">
            <p className="ws-label">Your Robinhood Chain address</p>
            <div className="ws-addr">{address}</div>
            <button className="btn block" onClick={async () => { try { await navigator.clipboard.writeText(address || ""); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* */ } }}>{copied ? "✓ Copied" : "Copy address"}</button>
            <p className="ws-note muted">Only send <b>Robinhood Chain (4663)</b> assets here. Sending from another network will lose funds.</p>
          </div>
        )}

        {(kind === "send" || kind === "shield") && (held.length === 0 ? (
          <p className="ws-note muted">Nothing to {kind} yet — buy something first.</p>
        ) : (
          <div className="ws-form">
            <label className="ws-label">Token</label>
            <select className="ws-select" value={sym} onChange={(e) => { setSym(e.target.value); setAmount(""); }}>
              {held.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol} · {trimAmt(formatUnits(clear[t.symbol] ?? 0n, t.decimals))}</option>)}
            </select>
            <label className="ws-label">Amount</label>
            <div className="ws-amt">
              <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              <button className="preset" onClick={() => token && setAmount(trimAmt(formatUnits(bal, token.decimals)))}>Max</button>
            </div>
            <span className="ws-bal muted">Balance {fmtBal(bal, token?.decimals ?? 18)} {sym}</span>
            {kind === "send" && <><label className="ws-label">Recipient</label><input className="ws-to" placeholder="0x… address" value={to} onChange={(e) => setTo(e.target.value.trim())} /></>}
            {kind === "shield" && <p className="ws-note muted">Moves {sym} into the private pool — untraceable, spendable via 🛡 Private swaps.</p>}
            <button className="btn block" disabled={busy || !amount || Number(amount) <= 0 || (kind === "send" && !to)} onClick={kind === "send" ? doSend : doShield}>
              {busy ? "Confirming…" : kind === "send" ? `Send ${sym}` : `Shield ${sym}`}
            </button>
          </div>
        ))}

        {kind === "swap" && (
          <div className="ws-swap">
            <div className="disc-search"><IconSearch /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pick a token to swap" spellCheck={false} /></div>
            <div className="ws-swaplist">
              {tradable.filter((t) => t.symbol !== "WETH" && t.symbol !== "USDG" && (!q || t.symbol.toLowerCase().includes(q.toLowerCase()) || (t.name ?? "").toLowerCase().includes(q.toLowerCase()))).slice(0, 24).map((t) => (
                <button key={t.symbol} className="trow" onClick={() => { onClose(); onOpen(t); }}>
                  <TokenAvatar sym={t.symbol} logo={t.logo} size={34} />
                  <div className="trow-id"><span className="trow-sym">{t.symbol}</span><span className="trow-name">{t.name ?? t.symbol}</span></div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- bits ----------------------------------------------------------------

function humanErr(e: any): string {
  const m = String(e?.shortMessage ?? e?.message ?? e ?? "");
  if (/user rejected|denied|4001/i.test(m)) return "You cancelled the transaction.";
  if (/insufficient funds/i.test(m)) return "Not enough balance to cover this trade + gas.";
  if (/No route|No public liquidity|Not enough/i.test(m)) return m;
  return m.length > 120 ? m.slice(0, 117) + "…" : m || "Something went wrong.";
}

function NavBtn({ active, onClick, label, icon, badge }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode; badge?: string }) {
  return (
    <button className={`wnav-btn ${active ? "on" : ""}`} onClick={onClick}>
      <span className="wnav-ic">{icon}{badge && <span className="wnav-badge">{badge}</span>}</span>
      <span>{label}</span>
    </button>
  );
}
const IconSpark = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-6 4 4 5-8 4 6" /></svg>);
const IconWallet = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M16 12h4M3 9h13" /></svg>);
const IconLeaf = () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-6 8-9 16-9 0 8-3 16-9 16z" /><path d="M4 20c3-3 6-5 9-6" /></svg>);
const IconSearch = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>);
const IconSend = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>);
const IconReceive = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>);
const IconSwap = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0 3 3m-3-3-3 3" /></svg>);
const IconShield = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6z" /></svg>);
const IconGlobe = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /></svg>);
const IconX = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2h3.3l-7.2 8.3L23.5 22h-6.6l-5.2-6.8L5.7 22H2.4l7.7-8.8L1 2h6.8l4.7 6.2L18.9 2Zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20Z" /></svg>);
const IconTelegram = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.7 19c-.2 1-.9 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.7 13.2l-4.6-1.4c-1-.3-1-1 .2-1.5l18-6.9c.8-.3 1.6.2 1.6 1Z" /></svg>);
const IconDiscord = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 5.6A17 17 0 0 0 15.3 4l-.3.5a13 13 0 0 1 3.7 1.9 12.6 12.6 0 0 0-10.8 0A13 13 0 0 1 11.6 4.5L11.3 4A17 17 0 0 0 7 5.6C3.6 10.6 2.7 15.4 3.2 20.2a17.2 17.2 0 0 0 5.2 2.6l.6-1a11 11 0 0 1-1.8-.9l.4-.3a12.3 12.3 0 0 0 10.5 0l.4.3c-.6.4-1.2.7-1.8.9l.6 1a17.1 17.1 0 0 0 5.2-2.6c.6-5.6-.9-10.3-3-14.6ZM9.3 16.9c-1 0-1.9-1-1.9-2.1 0-1.2.8-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.8 2.1-1.9 2.1Zm5.4 0c-1 0-1.9-1-1.9-2.1 0-1.2.8-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.8 2.1-1.9 2.1Z" /></svg>);
const IconFarcaster = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16v3h-1.5v12H20v3h-6v-3h1.5v-4.5h-9V18H8v3H2v-3h1.5V6H4V3Zm3 4.5V12h10V7.5H7Z" /></svg>);
function socIcon(type: string) {
  const t = type.toLowerCase();
  if (t === "twitter" || t === "x") return <IconX />;
  if (t === "telegram") return <IconTelegram />;
  if (t === "discord") return <IconDiscord />;
  if (t === "farcaster" || t === "warpcast") return <IconFarcaster />;
  return <IconGlobe />;
}
const IconCopy = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>);
