// Private cross-chain ramp panel (Bridge page) — the Houdini leg of the two-leg routes:
//   IN : any asset (BTC/XMR/SOL/…) → private multi-hop CEX → ETH on Base at YOUR address,
//        then the Relay bridge above pulls it into Robinhood Chain and shields it.
//   OUT: ETH on Base → private multi-hop CEX → any asset at your destination address
//        (unshield + Relay OUT above can pay the deposit address directly).
// The relayer's /xchain proxy holds the API keys; this component never sees them.
import { useEffect, useRef, useState } from "react";
import type { NetworkConfig } from "./config";
import {
  X_ASSETS, ETH_BASE_ID, xchainProviders, xchainQuote, xchainCreate, xchainStatus,
  xchainStatusLabel, xchainDone, xchainValidAddress, type XAsset, type XQuote, type XOrder,
} from "./xchain";
import { toast } from "./Toast";

const LS_KEY = "sherwood-xchain-order";
const short = (s: string, n = 10) => (s.length > n * 2 + 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
type XDir = "in" | "out";
const OUT_ASSETS = X_ASSETS.filter((a) => a.id !== ETH_BASE_ID);

export function XChainPanel({ net, address, isConnected, onConnect }: {
  net: NetworkConfig; address?: string; isConnected: boolean; onConnect: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dir, setDir] = useState<XDir>("in");
  const [asset, setAsset] = useState<XAsset>(X_ASSETS[0]); // IN: source · OUT: destination
  const [amt, setAmt] = useState("");
  const [payout, setPayout] = useState(""); // IN: 0x on Base · OUT: address on the asset's chain
  const [payoutOk, setPayoutOk] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"private" | "standard">("private");
  const [quotes, setQuotes] = useState<{ private?: XQuote; standard?: XQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<(XOrder & { dir?: XDir }) | null>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); } catch { return null; }
  });
  const [status, setStatus] = useState<string | undefined>(order?.displayStatus);
  const [err, setErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { xchainProviders(net).then((p) => setEnabled(p.houdini)).catch(() => setEnabled(false)); }, [net]);
  useEffect(() => { if (dir === "in" && !payout && address) setPayout(address); }, [address, dir]);

  function switchDir(d: XDir) {
    if (d === dir) return;
    setDir(d); setQuotes(null); setErr(null); setPayoutOk(null); setAmt("");
    setAsset(d === "in" ? X_ASSETS[0] : OUT_ASSETS.find((a) => a.symbol === "XMR") ?? OUT_ASSETS[0]);
    setPayout(d === "in" ? (address ?? "") : "");
  }

  // quote (debounced): IN = asset→ETH@Base, OUT = ETH@Base→asset
  useEffect(() => {
    setQuotes(null); setErr(null);
    const n = Number(amt);
    if (!(n > 0)) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const [from, to] = dir === "in" ? [asset.id, ETH_BASE_ID] : [ETH_BASE_ID, asset.id];
        setQuotes(await xchainQuote(net, from, to, n));
      } catch (e: any) { setErr(String(e?.message ?? e)); }
      finally { setQuoting(false); }
    }, 600);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [asset.id, amt, dir, net]);

  // destination-address validation (per-chain regex from Houdini /chains)
  useEffect(() => {
    const a = payout.trim();
    if (!a) { setPayoutOk(null); return; }
    if (dir === "in") { setPayoutOk(/^0x[0-9a-fA-F]{40}$/.test(a)); return; }
    let live = true;
    xchainValidAddress(net, asset.chain, a).then((ok) => { if (live) setPayoutOk(ok); });
    return () => { live = false; };
  }, [payout, dir, asset.chain, net]);

  // poll an active order
  useEffect(() => {
    if (!order || xchainDone(status)) return;
    const t = setInterval(async () => {
      try {
        const s = await xchainStatus(net, order.houdiniId);
        setStatus(s.displayStatus);
        if (s.displayStatus === "SWAP_COMPLETED") {
          toast({ kind: "ok", msg: order.dir === "out"
            ? `Private route done — ${s.outAmount} ${s.outSymbol} sent to your address.`
            : `Private route done — ${s.outAmount} ${s.outSymbol} arrived on Base. Use the Relay bridge above to pull it into Sherwood.` });
        }
      } catch { /* transient */ }
    }, 15_000);
    return () => clearInterval(t);
  }, [order?.houdiniId, status, net]);

  const chosen = quotes?.[mode] ?? quotes?.private ?? quotes?.standard;
  const belowMin = chosen?.min != null && Number(amt) < chosen.min;
  const inUnit = dir === "in" ? asset.symbol : "ETH";
  const outUnit = dir === "in" ? "ETH" : asset.symbol;

  async function create() {
    if (!chosen) return;
    if (!payoutOk) { setErr(dir === "in" ? "Payout needs a valid 0x address (yours, on Base)." : `That doesn't look like a valid ${asset.label} address.`); return; }
    setCreating(true); setErr(null);
    try {
      const o = { ...(await xchainCreate(net, chosen.quoteId, payout.trim())), dir };
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
        <div className="xc-titlerow">
          <h3 className="xc-title">{dir === "in" ? "Arrive from anywhere" : "Leave to anywhere"} — private route</h3>
          <div className="xc-dir" role="tablist">
            <button type="button" role="tab" aria-selected={dir === "in"} className={`xc-dirbtn ${dir === "in" ? "sel" : ""}`} onClick={() => switchDir("in")}>IN</button>
            <button type="button" role="tab" aria-selected={dir === "out"} className={`xc-dirbtn ${dir === "out" ? "sel" : ""}`} onClick={() => switchDir("out")}>OUT</button>
          </div>
        </div>
        <p className="muted mono-sm xc-sub">
          {dir === "in"
            ? <>BTC, XMR, SOL &amp; more → multi-hop CEX routing (HoudiniSwap) → ETH on Base at your address → Relay it in above &amp; shield. No wallet connection needed for the first leg.</>
            : <>ETH on Base → multi-hop CEX routing (HoudiniSwap) → BTC, XMR, SOL &amp; more at your destination address. Tip: run the bridge above OUT to Base and set its destination to the deposit address below — one clean hand-off.</>}
        </p>
      </div>

      {order ? (
        <div className="xc-order">
          <div className="xc-row"><span>Send exactly</span><b>{order.inAmount} {order.inSymbol}{order.dir === "out" ? " (on Base)" : ""}</b></div>
          <div className="xc-row xc-addr">
            <span>to deposit address</span>
            <button type="button" className="xc-copy mono-sm" title="Copy address" onClick={() => copy(order.depositAddress)}>
              {short(order.depositAddress, 14)} ⧉
            </button>
          </div>
          {order.depositTag && <div className="xc-row"><span>memo / tag (required!)</span><b>{order.depositTag}</b></div>}
          <div className="xc-row"><span>you'll receive</span><b>≈ {order.outAmount} {order.outSymbol}{order.dir === "out" ? "" : " on Base"}</b></div>
          <div className="xc-row"><span>status</span><b>{xchainStatusLabel(status)}</b></div>
          <div className="xc-row dim"><span>order</span><span className="mono-sm">{order.houdiniId}{order.expires ? ` · deposit before ${new Date(order.expires).toLocaleTimeString()}` : ""}</span></div>
          {status === "SWAP_COMPLETED" && order.dir !== "out" && (
            <p className="xc-next mono-sm">✓ Funds are on Base. Switch the bridge above to <b>IN</b> from Base — it pulls them into Robinhood Chain and shields them.</p>
          )}
          <button className="btn ghost sm" onClick={clearOrder}>{xchainDone(status) ? "New private route" : "Hide (order keeps running)"}</button>
        </div>
      ) : (
        <>
          <div className="xc-form">
            <select className="xc-select" value={asset.id + asset.chain} aria-label={dir === "in" ? "Source asset" : "Destination asset"}
              onChange={(e) => { const list = dir === "in" ? X_ASSETS : OUT_ASSETS; const a = list.find((x) => x.id + x.chain === e.target.value); if (a) { setAsset(a); if (dir === "out") setPayoutOk(null); } }}>
              {(dir === "in" ? X_ASSETS : OUT_ASSETS).map((a) => <option key={a.id + a.chain} value={a.id + a.chain}>{a.symbol} — {a.label}</option>)}
            </select>
            <input className="xc-amt" inputMode="decimal" placeholder={`amount in ${inUnit}${dir === "out" ? " (on Base)" : ""}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
          </div>
          <input className={`xc-payout mono-sm ${payoutOk === false ? "bad" : ""}`}
            placeholder={dir === "in" ? "0x… payout address on Base (defaults to your wallet)" : `${asset.symbol} destination address (${asset.label})`}
            value={payout} onChange={(e) => setPayout(e.target.value)} />
          {payoutOk === false && <p className="xc-err mono-sm">{dir === "in" ? "Needs a valid 0x address." : `Not a valid ${asset.label} address.`}</p>}
          <div className="xc-modes">
            {(["private", "standard"] as const).map((m) => (
              <button key={m} type="button" className={`xc-mode ${mode === m ? "sel" : ""}`} onClick={() => setMode(m)}>
                {m === "private" ? "Private (2-hop, ~10–30 min)" : "Standard (1-hop, faster)"}
                <span className="xc-mode-out mono-sm">
                  {quoting ? "…" : quotes?.[m] ? `≈ ${quotes[m]!.amountOut.toFixed(6)} ${outUnit}` : Number(amt) > 0 ? "—" : ""}
                </span>
              </button>
            ))}
          </div>
          {belowMin && chosen?.min != null && <p className="xc-err mono-sm">Minimum for this route is {chosen.min} {inUnit}.</p>}
          {err && <p className="xc-err mono-sm">{err}</p>}
          {dir === "in" && !isConnected && !payout && <button className="btn block" onClick={onConnect}>Connect wallet (or paste a payout address)</button>}
          <button className="btn block" disabled={!chosen || creating || quoting || belowMin || !payout.trim() || payoutOk === false} onClick={create}>
            {creating ? "Creating order…" : chosen ? `Get deposit address — receive ≈ ${chosen.amountOut.toFixed(6)} ${outUnit}` : "Enter an amount"}
          </button>
          <p className="muted mono-sm xc-fine">You send to a one-time deposit address — no approval, no wallet signature. Fees are included in the quote. The trail breaks inside the CEX hops.</p>
        </>
      )}
    </section>
  );
}
