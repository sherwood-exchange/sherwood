// Shared token UI — logo avatar + searchable token picker, used by both the shielded desk
// and the public aggregator so they look identical. Favorites / recents / import are optional
// (the private desk uses a fixed allowlist, so it passes none).
import { useMemo, useState } from "react";

export interface PickerToken { address: string; symbol: string; name?: string; decimals: number; logo?: string; }

/** Deterministic gradient per ticker so a logo-less token still has a stable, distinct badge. */
export function tokenGradient(sym: string): string {
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 72% 46%), hsl(${(h + 48) % 360} 66% 30%))`;
}

/** Token logo on a light chip; falls back to a ticker gradient if there's no logo or it fails. */
export function TokenAvatar({ sym, logo, size = 26, className = "tok-avatar" }: { sym: string; logo?: string; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (logo && !broken) return <img className="tok-img" src={logo} alt={sym} width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
  return <span className={className} style={{ backgroundImage: tokenGradient(sym), width: size, height: size }}>{sym.slice(0, 3)}</span>;
}

export function TokenPicker({ tokens, value, onChange, exclude, fav, onFav, recent, onImport }: {
  tokens: PickerToken[]; value: PickerToken; onChange: (t: PickerToken) => void; exclude?: string;
  fav?: Set<string>; onFav?: (addr: string) => void; recent?: PickerToken[]; onImport?: (addr: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const usable = (t: PickerToken) => t.address.toLowerCase() !== exclude?.toLowerCase();
  const nm = (t: PickerToken) => t.name ?? t.symbol;
  const filtered = useMemo(() => {
    const base = tokens.filter(usable);
    if (!s) return base.slice(0, 80);
    return base.filter((t) => t.symbol.toLowerCase().includes(s) || nm(t).toLowerCase().includes(s) || t.address.toLowerCase() === s).slice(0, 80);
  }, [s, tokens, exclude]);
  const quick = useMemo(() => {
    if (!fav && !recent) return [];
    const favs = fav ? tokens.filter((t) => fav.has(t.address.toLowerCase()) && usable(t)) : [];
    const recents = (recent ?? []).filter(usable).filter((t) => !fav?.has(t.address.toLowerCase())).slice(0, 6);
    return [...favs, ...recents];
  }, [tokens, fav, recent, exclude]);
  const pick = (t: PickerToken) => { onChange(t); setOpen(false); setQ(""); };
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q.trim());
  return (
    <>
      <button type="button" className="token-pill" onClick={() => setOpen(true)}>
        <TokenAvatar sym={value.symbol} logo={value.logo} size={26} />
        <span style={{ fontWeight: 600, fontSize: 15 }}>{value.symbol}</span>
        <svg className="tok-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="tp-overlay" onClick={() => setOpen(false)}>
          <div className="tp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tp-head"><span>Select a token</span><button className="tp-x" onClick={() => setOpen(false)}>✕</button></div>
            <input className="tp-search" autoFocus placeholder={onImport ? "Search name / symbol, or paste an address" : "Search name or symbol"} value={q} onChange={(e) => setQ(e.target.value)} />
            {!s && quick.length > 0 && (
              <div className="tp-quick">
                {quick.map((t) => (
                  <button key={t.address} className="tp-chip" onClick={() => pick(t)}>
                    {fav?.has(t.address.toLowerCase()) && <span className="tp-star">★</span>}
                    <TokenAvatar sym={t.symbol} logo={t.logo} size={18} />{t.symbol}
                  </button>
                ))}
              </div>
            )}
            <div className="tp-list">
              {filtered.map((t) => (
                <div key={t.address} className="tp-item">
                  <button className="tp-item-btn" onClick={() => pick(t)}>
                    <TokenAvatar sym={t.symbol} logo={t.logo} size={30} />
                    <span className="tp-item-meta"><span className="tp-sym">{t.symbol}</span><span className="tp-name">{nm(t)}</span></span>
                  </button>
                  {onFav && <button className={`tp-favbtn ${fav?.has(t.address.toLowerCase()) ? "on" : ""}`} title="Favorite" onClick={() => onFav(t.address.toLowerCase())}>★</button>}
                </div>
              ))}
              {!filtered.length && onImport && isAddr && (
                <button className="tp-import" onClick={() => { onImport(q.trim()); setOpen(false); setQ(""); }}>Import token {q.trim().slice(0, 6)}…{q.trim().slice(-4)}</button>
              )}
              {!filtered.length && !(onImport && isAddr) && <div className="tp-empty">No tokens found.{onImport ? " Paste a token address to import." : ""}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
