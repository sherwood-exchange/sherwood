// Private cross-chain ramp panel (Bridge page) — leg 1 of the two-leg IN route:
// any asset (BTC/XMR/SOL/…) → HoudiniSwap private multi-hop CEX → ETH on Base at YOUR address.
// Leg 2 is the existing Relay bridge above it (Base → Robinhood Chain → auto-shield).
// The relayer's /xchain proxy holds the API keys; this component never sees them.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkConfig } from "./config";
import {
  X_ASSETS, ETH_BASE_ID, xchainProviders, xchainQuote, xchainCreate, xchainStatus,
  xchainStatusLabel, xchainDone, type XAsset, type XQuote, type XOrder,
} from "./xchain";
import { toast } from "./Toast";

const LS_KEY = "sherwood-xchain-order";
const short = (s: string, n = 10) => (s.length > n * 2 + 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

export function XChainPanel({ net, address, isConnected, onConnect }: {
  net: NetworkConfig; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [asset, setAsset] = useState<XAsset>(X_ASSETS[0]);
  const [amt, setAmt] = useState("");
  const [payout, setPayout] = useState("");
  const [mode, setMode] = useState<"private" | "standard">("private");
  const [quotes, setQuotes] = useState<{ private?: XQuote; standard?: XQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<XOrder | null>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); } catch { return null; }
  });
  const [status, setStatus] = useState<string | undefined>(order?.displayStatus);
  const [err, setErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { xchainProviders(net).then((p) => setEnabled(p.houdini)).catch(() => setEnabled(false)); }, [net]);
  useEffect(() => { if (!payout && address) setPayout(address); }, [address]);

  // quote (debounced) whenever asset/amount change
  useEffect(() => {
    setQuotes(null); setErr(null);
    const n = Number(amt);
    if (!(n > 0)) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setQuoting(true);
      try { setQuotes(await xchainQuote(net, asset.id, ETH_BASE_ID, n)); }
      catch (e: any) { setErr(String(e?.message ?? e)); }
      finally { setQuoting(false); }
    }, 600);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [asset.id, amt, net]);

  // poll an active order
  useEffect(() => {
    if (!order || xchainDone(status)) return;
    const t = setInterval(async () => {
      try {
        const s = await xchainStatus(net, order.houdiniId);
        setStatus(s.displayStatus);
        if (s.displayStatus === "SWAP_COMPLETED") toast({ kind: "ok", msg: `Private route done — ${s.outAmount} ${s.outSymbol} arrived on Base. Use the Relay bridge above to pull it into Sherwood.` });
      } catch { /* transient */ }
    }, 15_000);
    return () => clearInterval(t);
  }, [order?.houdiniId, status, net]);

  const chosen = quotes?.[mode] ?? quotes?.private ?? quotes?.standard;
  const belowMin = chosen?.min != null && Number(amt) < chosen.min;

  async function create() {
    if (!chosen) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(payout.trim())) { setErr("Payout needs a valid 0x address (yours, on Base)."); return; }
    setCreating(true); setErr(null);
    try {
      const o = await xchainCreate(net, chosen.quoteId, payout.trim());
      setOrder(o); setStatus(o.displayStatus);
      localStorage.setItem(LS_KEY, JSON.stringify(o));
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setCreating(false); }
  }
  function clearOrder() { setOrder(null); setStatus(undefined); localStorage.removeItem(LS_KEY); }
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast({ kind: "ok", msg: "Copied." }); } catch { /* blocked */ } };

  if (enabled === false || enabled === null) return null; // keys unset / probing — feature hidden

  return (
    <section className="card xc">
      <div className="xc-head">
        <h3 className="xc-title">Arrive from anywhere — private route</h3>
        <p className="muted mono-sm xc-sub">
          BTC, XMR, SOL &amp; more → multi-hop CEX routing (HoudiniSwap) → ETH on Base at your address →
          Relay it in above &amp; shield. No wallet connection needed for the first leg.
        </p>
      </div>

      {order ? (
        <div className="xc-order">
          <div className="xc-row"><span>Send exactly</span><b>{order.inAmount} {order.inSymbol}</b></div>
          <div className="xc-row xc-addr">
            <span>to deposit address</span>
            <button type="button" className="xc-copy mono-sm" title="Copy address" onClick={() => copy(order.depositAddress)}>
              {short(order.depositAddress, 14)} ⧉
            </button>
          </div>
          {order.depositTag && <div className="xc-row"><span>memo / tag (required!)</span><b>{order.depositTag}</b></div>}
          <div className="xc-row"><span>you'll receive</span><b>≈ {order.outAmount} {order.outSymbol} on Base</b></div>
          <div className="xc-row"><span>status</span><b>{xchainStatusLabel(status)}</b></div>
          <div className="xc-row dim"><span>order</span><span className="mono-sm">{order.houdiniId}{order.expires ? ` · deposit before ${new Date(order.expires).toLocaleTimeString()}` : ""}</span></div>
          {status === "SWAP_COMPLETED" && (
            <p className="xc-next mono-sm">✓ Funds are on Base. Switch the bridge above to <b>IN</b> from Base — it pulls them into Robinhood Chain and shields them.</p>
          )}
          <button className="btn ghost sm" onClick={clearOrder}>{xchainDone(status) ? "New private route" : "Hide (order keeps running)"}</button>
        </div>
      ) : (
        <>
          <div className="xc-form">
            <select className="xc-select" value={asset.id + asset.chain} onChange={(e) => { const a = X_ASSETS.find((x) => x.id + x.chain === e.target.value); if (a) setAsset(a); }} aria-label="Source asset">
              {X_ASSETS.map((a) => <option key={a.id + a.chain} value={a.id + a.chain}>{a.symbol} — {a.label}</option>)}
            </select>
            <input className="xc-amt" inputMode="decimal" placeholder={`amount in ${asset.symbol}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
          </div>
          <input className="xc-payout mono-sm" placeholder="0x… payout address on Base (defaults to your wallet)" value={payout} onChange={(e) => setPayout(e.target.value)} />
          <div className="xc-modes">
            {(["private", "standard"] as const).map((m) => (
              <button key={m} type="button" className={`xc-mode ${mode === m ? "sel" : ""}`} onClick={() => setMode(m)}>
                {m === "private" ? "Private (2-hop, ~10–30 min)" : "Standard (1-hop, faster)"}
                <span className="xc-mode-out mono-sm">
                  {quoting ? "…" : quotes?.[m] ? `≈ ${quotes[m]!.amountOut.toFixed(6)} ETH` : Number(amt) > 0 ? "—" : ""}
                </span>
              </button>
            ))}
          </div>
          {belowMin && chosen?.min != null && <p className="xc-err mono-sm">Minimum for this route is {chosen.min} {asset.symbol}.</p>}
          {err && <p className="xc-err mono-sm">{err}</p>}
          {!isConnected && !payout && <button className="btn block" onClick={onConnect}>Connect wallet (or paste a payout address)</button>}
          <button className="btn block" disabled={!chosen || creating || quoting || belowMin || !payout.trim()} onClick={create}>
            {creating ? "Creating order…" : chosen ? `Get deposit address — receive ≈ ${chosen.amountOut.toFixed(6)} ETH on Base` : "Enter an amount"}
          </button>
          <p className="muted mono-sm xc-fine">You send to a one-time deposit address — no approval, no wallet signature. Fees are included in the quote. Not private on the source chain; the trail breaks inside the CEX hops.</p>
        </>
      )}
    </section>
  );
}
