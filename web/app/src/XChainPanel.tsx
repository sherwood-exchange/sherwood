// Private Route (#/bridge) — multichain private swap over the full Houdini catalog:
// ANY asset on ANY chain → ANY other, with a live routes panel (Best/Fastest, route-type
// badges, private multi-hop CEX preferred). ETH-on-Base stays the "gateway to Sherwood":
// land there, then Relay in + shield from the Desk. Keys live in the relayer /xchain proxy.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkConfig } from "./config";
import {
  ETH_BASE_ID, xchainProviders, xchainQuotesAll, xchainCreate, xchainStatus,
  xchainStatusLabel, xchainDone, xchainValidAddress, xchainTokenSearch,
  type XToken, type XQuote, type XOrder,
} from "./xchain";
import { TokenAvatar } from "./TokenUI";
import { toast } from "./Toast";

const LS_KEY = "sherwood-xchain-order";
const short = (s: string, n = 10) => (s.length > n * 2 + 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const fmt = (n: number, d = 6) => n.toLocaleString("en-US", { maximumFractionDigits: d, useGrouping: false });

const T = (id: string, symbol: string, chain: string, name: string, icon?: string): XToken =>
  ({ id, symbol, chain, name, icon: icon ?? `https://api.houdiniswap.com/assets/tokens/${symbol.toLowerCase()}-${chain}.png` });
/** Curated quick picks shown before any search. ETH@Base first — it's the Sherwood gateway. */
const POPULAR: XToken[] = [
  T("6689b73ec90e45f3b3e51590", "ETH", "base", "Ether (Base) — Sherwood gateway"),
  T("6689b73ec90e45f3b3e51551", "BTC", "bitcoin", "Bitcoin"),
  T("6689b73ec90e45f3b3e5155c", "XMR", "monero", "Monero"),
  T("6689b73ec90e45f3b3e51558", "SOL", "solana", "Solana"),
  T("6689b73ec90e45f3b3e51566", "ETH", "ethereum", "Ether"),
  T("6689b73ec90e45f3b3e5155d", "USDT", "tron", "Tether (Tron)"),
  T("6689b757c90e45f3b3e51805", "USDC", "base", "USDC (Base)"),
  T("6689b73ec90e45f3b3e5156c", "LTC", "litecoin", "Litecoin"),
  T("6689b73ec90e45f3b3e51563", "DOGE", "doge", "Dogecoin"),
];

const TYPE_BADGE: Record<string, string> = { private: "Private", standard: "Standard CEX", dex: "On-chain DEX" };

const RECENT_KEY = "sherwood-xr-recent";
const loadRecent = (): XToken[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };
const pushRecent = (t: XToken) => {
  try {
    const r = [t, ...loadRecent().filter((x) => x.id + x.chain !== t.id + t.chain)].slice(0, 4);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch { /* private mode */ }
};

/** Centered "Select a token" modal — search, past searches, Top / Stocks tabs, full catalog list. */
function TokenModal({ net, exclude, onPick, onClose }: { net: NetworkConfig; exclude?: string; onPick: (t: XToken) => void; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [cat, setCat] = useState<"top" | "stocks">("top");
  const [rows, setRows] = useState<XToken[] | null>(null);
  const [stocks, setStocks] = useState<XToken[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent] = useState<XToken[]>(loadRecent());
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  // search across the whole catalog (CEX-routable first)
  useEffect(() => {
    if (!term.trim()) { setRows(null); return; }
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await xchainTokenSearch(net, term, { anyRail: true });
        r.sort((a, b) => Number(b.hasCex ?? false) - Number(a.hasCex ?? false));
        setRows(r);
      } catch { setRows([]); }
      finally { setBusy(false); }
    }, 350);
    return () => { if (deb.current) clearTimeout(deb.current); };
  }, [term, net]);

  // Stocks tab: the tokenized-stock universe on Robinhood Chain (same-chain DEX routes)
  useEffect(() => {
    if (cat !== "stocks" || stocks != null) return;
    xchainTokenSearch(net, "", { anyRail: true, chain: "Robinhood", pageSize: 200 })
      .then((all) => setStocks(all.filter((t) => /^[A-Z]{1,5}$/.test(t.symbol))))
      .catch(() => setStocks([]));
  }, [cat, stocks, net]);

  const pick = (t: XToken) => { pushRecent(t); onPick(t); onClose(); };
  const base = term.trim() ? (rows ?? []) : cat === "top" ? POPULAR : (stocks ?? []);
  const list = base.filter((t) => t.id + t.chain !== exclude);

  return (
    <div className="xr-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="xr-modal" role="dialog" aria-label="Select a token">
        <div className="xr-mhead">
          <h3>Select a token</h3>
          <button type="button" className="xr-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <input autoFocus className="xr-search" placeholder="Search 1000+ tokens across 100 chains" value={term} onChange={(e) => setTerm(e.target.value)} />
        {!term.trim() && recent.length > 0 && (
          <>
            <p className="xr-mlabel">Past searches</p>
            <div className="xr-recent">
              {recent.map((t) => (
                <button key={t.id + t.chain} type="button" className="xr-chip" title={`${t.symbol} on ${t.chain}`} onClick={() => pick(t)}>
                  <TokenAvatar sym={t.symbol} logo={t.icon} size={26} />
                  <span>{t.symbol}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {!term.trim() && (
          <div className="xc-dir xr-cats" role="tablist">
            <button type="button" role="tab" aria-selected={cat === "top"} className={`xc-dirbtn ${cat === "top" ? "sel" : ""}`} onClick={() => setCat("top")}>Top</button>
            <button type="button" role="tab" aria-selected={cat === "stocks"} className={`xc-dirbtn ${cat === "stocks" ? "sel" : ""}`} onClick={() => setCat("stocks")}>Stocks</button>
          </div>
        )}
        <div className="xr-list">
          {busy && <div className="tp-empty">Searching…</div>}
          {!busy && cat === "stocks" && !term.trim() && stocks == null && <div className="tp-empty">Loading…</div>}
          {!busy && list.map((t) => (
            <button key={t.id + t.chain} type="button" className="xr-item" onClick={() => pick(t)}>
              <TokenAvatar sym={t.symbol} logo={t.icon} size={34} />
              <span className="xr-tokmeta">
                <b>{t.symbol} <em>{t.chain}</em></b>
                <i>{t.name ?? t.symbol}</i>
              </span>
            </button>
          ))}
          {!busy && term.trim() && rows != null && list.length === 0 && <div className="tp-empty">No match.</div>}
        </div>
      </div>
    </div>
  );
}

/** Token+chain button ("SOL · On Solana") that opens the Select-a-token modal. */
function TokenChainButton({ tok, onPick, net, exclude }: { tok: XToken; onPick: (t: XToken) => void; net: NetworkConfig; exclude?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="xr-tokbtn" onClick={() => setOpen(true)}>
        <TokenAvatar sym={tok.symbol} logo={tok.icon} size={30} />
        <span className="xr-tokmeta"><b>{tok.symbol}</b><i>On {tok.chain}</i></span>
        <svg className="tok-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <TokenModal net={net} exclude={exclude} onPick={onPick} onClose={() => setOpen(false)} />}
    </>
  );
}

export function XChainPanel({ net, address, isConnected, onConnect }: {
  net: NetworkConfig; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [from, setFrom] = useState<XToken>(POPULAR[1]); // BTC
  const [to, setTo] = useState<XToken>(POPULAR[0]);     // ETH@Base — Sherwood gateway
  const [amt, setAmt] = useState("");
  const [dest, setDest] = useState("");
  const [destOk, setDestOk] = useState<boolean | null>(null);
  const [quotes, setQuotes] = useState<XQuote[] | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [qErr, setQErr] = useState<string | null>(null);
  const [sort, setSort] = useState<"best" | "fastest">("best");
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<(XOrder & { toSherwood?: boolean }) | null>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); } catch { return null; }
  });
  const [status, setStatus] = useState<string | undefined>(order?.displayStatus);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { xchainProviders(net).then((p) => setEnabled(p.houdini)).catch(() => setEnabled(false)); }, [net]);

  // quotes: debounce on pair/amount
  useEffect(() => {
    setQuotes(null); setQErr(null); setSelId(null); setExpanded(false);
    const n = Number(amt);
    if (!(n > 0)) return;
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const qs = await xchainQuotesAll(net, from.id, to.id, n);
        setQuotes(qs);
        if (!qs.length) setQErr("No route for this pair/amount right now.");
      } catch (e: any) { setQErr(String(e?.message ?? e)); }
      finally { setQuoting(false); }
    }, 700);
    return () => { if (deb.current) clearTimeout(deb.current); };
  }, [from.id, to.id, amt, net]);

  // destination address validation + prefill for EVM-style chains
  useEffect(() => {
    const a = dest.trim();
    if (!a) { setDestOk(null); return; }
    let live = true;
    xchainValidAddress(net, to.chain, a).then((ok) => { if (live) setDestOk(ok); });
    return () => { live = false; };
  }, [dest, to.chain, net]);
  useEffect(() => {
    if (dest || !address) return;
    let live = true;
    xchainValidAddress(net, to.chain, address).then((ok) => { if (live && ok) setDest(address); });
    return () => { live = false; };
  }, [to.chain, address]);

  // poll active order
  useEffect(() => {
    if (!order || xchainDone(status)) return;
    const t = setInterval(async () => {
      try {
        const s = await xchainStatus(net, order.houdiniId);
        setStatus(s.displayStatus);
        if (s.displayStatus === "SWAP_COMPLETED") toast({ kind: "ok", msg: order.toSherwood
          ? `Private route done — ${s.outAmount} ${s.outSymbol} landed on Base. Relay it in + shield from your Desk.`
          : `Private route done — ${s.outAmount} ${s.outSymbol} delivered.` });
      } catch { /* transient */ }
    }, 15_000);
    return () => clearInterval(t);
  }, [order?.houdiniId, status, net]);

  const sorted = useMemo(() => {
    if (!quotes) return [];
    const arr = [...quotes];
    arr.sort((a, b) => (sort === "best" ? b.amountOut - a.amountOut : (a.duration ?? 999) - (b.duration ?? 999)));
    // private routes float above equals so the flagship path stays visible
    return arr;
  }, [quotes, sort]);
  const sel = sorted.find((q) => q.quoteId === selId) ?? sorted[0] ?? null;
  const shown = expanded ? sorted.slice(0, 30) : sorted.slice(0, 3);
  const toSherwood = to.id === ETH_BASE_ID;

  function flip() { const f = from; setFrom(to); setTo(f); setDest(""); setDestOk(null); }

  async function create() {
    if (!sel || !destOk) return;
    setCreating(true);
    try {
      const o = { ...(await xchainCreate(net, sel.quoteId, dest.trim())), toSherwood };
      setOrder(o); setStatus(o.displayStatus);
      try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch { /* private mode */ }
    } catch (e: any) { setQErr(String(e?.message ?? e)); }
    finally { setCreating(false); }
  }
  function clearOrder() { setOrder(null); setStatus(undefined); localStorage.removeItem(LS_KEY); }
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast({ kind: "ok", msg: "Copied." }); } catch { /* blocked */ } };

  if (enabled === false || enabled === null) return null;

  const cta = !Number(amt) ? "Enter an amount"
    : quoting ? "Finding routes…"
    : !sel ? "No route — try another pair/amount"
    : !dest.trim() ? "Enter the receiving address"
    : destOk === false ? `Invalid ${to.chain} address`
    : creating ? "Creating order…"
    : `Get deposit address — receive ≈ ${fmt(sel.amountOut)} ${to.symbol}`;

  if (order) {
    return (
      <section className="card xc" style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="xc-head"><h3 className="xc-title">Private route in flight</h3></div>
        <div className="xc-order">
          <div className="xc-row"><span>Send exactly</span><b>{order.inAmount} {order.inSymbol}</b></div>
          <div className="xc-row xc-addr"><span>to deposit address</span>
            <button type="button" className="xc-copy mono-sm" onClick={() => copy(order.depositAddress)}>{short(order.depositAddress, 14)} ⧉</button>
          </div>
          {order.depositTag && <div className="xc-row"><span>memo / tag (required!)</span><b>{order.depositTag}</b></div>}
          <div className="xc-row"><span>you'll receive</span><b>≈ {order.outAmount} {order.outSymbol}</b></div>
          <div className="xc-row"><span>status</span><b>{xchainStatusLabel(status)}</b></div>
          <div className="xc-row dim"><span>order</span><span className="mono-sm">{order.houdiniId}{order.expires ? ` · deposit before ${new Date(order.expires).toLocaleTimeString()}` : ""}</span></div>
          {status === "SWAP_COMPLETED" && order.toSherwood && (
            <p className="xc-next mono-sm">✓ Landed on Base. Open your <a href="#/">Desk</a> — the Relay bridge pulls it into Robinhood Chain and shields it.</p>
          )}
          <button className="btn ghost sm" onClick={clearOrder}>{xchainDone(status) ? "New private route" : "Hide (order keeps running)"}</button>
        </div>
      </section>
    );
  }

  return (
    <div className="xr">
      {/* ---- form ---- */}
      <section className="card xr-form">
        <div className="xr-panel">
          <span className="ap-label">From</span>
          <div className="xr-line">
            <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <TokenChainButton tok={from} net={net} exclude={to.id + to.chain} onPick={(t) => { setFrom(t); }} />
          </div>
          {sel?.amountInUsd != null && <span className="mono-sm muted">≈ ${fmt(sel.amountInUsd, 2)}</span>}
        </div>

        <button type="button" className="xr-flip" title="Flip direction" onClick={flip} aria-label="Flip">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" /></svg>
        </button>

        <div className="xr-panel">
          <div className="xr-toprow">
            <span className="ap-label">To</span>
            {sel?.type === "private" && <span className="xr-badge private">Private</span>}
          </div>
          <div className="xr-line">
            <span className="xr-out">{quoting ? "…" : sel ? fmt(sel.amountOut) : "0.0"}</span>
            <TokenChainButton tok={to} net={net} exclude={from.id + from.chain} onPick={(t) => { setTo(t); setDest(""); setDestOk(null); }} />
          </div>
          {sel?.amountOutUsd != null && <span className="mono-sm muted">≈ ${fmt(sel.amountOutUsd, 2)}</span>}
          {toSherwood && <span className="mono-sm muted">Sherwood gateway — land on Base, then Relay in + shield from your Desk.</span>}
        </div>

        <input className={`xc-payout mono-sm ${destOk === false ? "bad" : ""}`}
          placeholder={`Receiving ${to.symbol} address (on ${to.chain})`}
          value={dest} onChange={(e) => setDest(e.target.value)} />
        {qErr && <p className="xc-err mono-sm">{qErr}</p>}
        {!isConnected && !dest && <button className="btn ghost block" onClick={onConnect}>Connect wallet to prefill (optional)</button>}
        <button className="btn block" disabled={!sel || !destOk || creating || quoting} onClick={create}>{cta}</button>
      </section>

      {/* ---- routes ---- */}
      <section className="card xr-routes">
        <div className="xr-rhead">
          <h3 className="xc-title">Routes{sorted.length ? ` (${sorted.length})` : ""}</h3>
          <div className="xc-dir" role="tablist">
            <button type="button" role="tab" aria-selected={sort === "best"} className={`xc-dirbtn ${sort === "best" ? "sel" : ""}`} onClick={() => setSort("best")}>$ Best</button>
            <button type="button" role="tab" aria-selected={sort === "fastest"} className={`xc-dirbtn ${sort === "fastest" ? "sel" : ""}`} onClick={() => setSort("fastest")}>⚡ Fastest</button>
          </div>
        </div>
        {!Number(amt) ? (
          <p className="muted mono-sm" style={{ margin: 0 }}>Enter an amount to compare every route — private multi-hop, standard CEX and on-chain.</p>
        ) : quoting ? (
          <p className="muted mono-sm" style={{ margin: 0 }}>Scanning the network…</p>
        ) : !sorted.length ? (
          <p className="muted mono-sm" style={{ margin: 0 }}>{qErr ?? "No routes."}</p>
        ) : (
          <>
            {shown.map((q) => (
              <button key={q.quoteId} type="button" className={`xr-route ${q.type} ${sel?.quoteId === q.quoteId ? "sel" : ""}`} onClick={() => setSelId(q.quoteId)}>
                <div className="xr-rtop">
                  <span className={`xr-badge ${q.type}`}>{TYPE_BADGE[q.type] ?? q.type}</span>
                  {sel?.quoteId === q.quoteId && <span className="xr-check" aria-hidden>✓</span>}
                </div>
                <div className="xr-ramt">{fmt(q.amountOut)} <em>{to.symbol}</em></div>
                <div className="xr-rmeta mono-sm">
                  {q.duration != null && <span>~{q.duration}m</span>}
                  {q.amountOutUsd != null && <span>${fmt(q.amountOutUsd, 2)}</span>}
                  {q.swapName && <span>{q.swapName}</span>}
                </div>
              </button>
            ))}
            {sorted.length > shown.length && (
              <button type="button" className="btn ghost block sm" onClick={() => setExpanded(true)}>View more ({sorted.length - shown.length})</button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
