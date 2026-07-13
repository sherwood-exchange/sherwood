// Shared token UI — logo avatar + searchable token picker, used by both the shielded desk
// and the public aggregator so they look identical. Favorites / recents / import / popular
// chips / stock grouping / per-row balances are all optional — each caller passes what it has.
import { useEffect, useMemo, useState } from "react";

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

/** A swap route rendered as token chips: AAPL·v4 → ETH → USDG·v4. Display-only. */
export function RouteChips({ stops }: { stops: { sym: string; logo?: string; tag?: string }[] }) {
  return (
    <span className="route-chips">
      {stops.map((s, i) => (
        <span key={`${s.sym}-${i}`} className="route-stop">
          {i > 0 && <span className="route-arr" aria-hidden>→</span>}
          <span className="route-chip">
            <TokenAvatar sym={s.sym} logo={s.logo} size={16} />
            {s.sym}
            {s.tag && <em className="route-tag">{s.tag}</em>}
          </span>
        </span>
      ))}
    </span>
  );
}

export function TokenPicker({ tokens, value, onChange, exclude, fav, onFav, recent, onImport, popular, isStock, balOf }: {
  tokens: PickerToken[]; value: PickerToken; onChange: (t: PickerToken) => void; exclude?: string;
  fav?: Set<string>; onFav?: (addr: string) => void; recent?: PickerToken[]; onImport?: (addr: string) => void;
  /** Curated always-visible quick picks (ETH / USDG / SWOOD / top stocks). */
  popular?: PickerToken[];
  /** Groups matching tokens under a separated "Tokenized stocks" section. */
  isStock?: (t: PickerToken) => boolean;
  /** Display-only formatted balance for a row (callers pass balances they already hold). */
  balOf?: (t: PickerToken) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const usable = (t: PickerToken) => t.address.toLowerCase() !== exclude?.toLowerCase();
  const nm = (t: PickerToken) => t.name ?? t.symbol;
  const filtered = useMemo(() => {
    const base = tokens.filter(usable);
    if (!s) return base;
    return base.filter((t) => t.symbol.toLowerCase().includes(s) || nm(t).toLowerCase().includes(s) || t.address.toLowerCase() === s);
  }, [s, tokens, exclude]);
  const stocks = useMemo(() => (isStock ? filtered.filter(isStock) : []), [filtered, isStock]);
  const main = useMemo(() => (isStock ? filtered.filter((t) => !isStock(t)) : filtered).slice(0, 100), [filtered, isStock]);
  const quick = useMemo(() => {
    if (!fav && !recent) return [];
    const favs = fav ? tokens.filter((t) => fav.has(t.address.toLowerCase()) && usable(t)) : [];
    const recents = (recent ?? []).filter(usable).filter((t) => !fav?.has(t.address.toLowerCase())).slice(0, 6);
    return [...favs, ...recents];
  }, [tokens, fav, recent, exclude]);
  const pops = useMemo(() => (popular ?? []).filter(usable), [popular, exclude]);
  const pick = (t: PickerToken) => { onChange(t); setOpen(false); setQ(""); };
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q.trim());

  // Esc closes; lock body scroll while the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);

  const row = (t: PickerToken) => {
    const sel = t.address.toLowerCase() === value.address.toLowerCase() && t.symbol === value.symbol;
    const b = balOf?.(t);
    return (
      <div key={t.address + t.symbol} className={`tp-item ${sel ? "sel" : ""}`}>
        <button className="tp-item-btn" onClick={() => pick(t)}>
          <TokenAvatar sym={t.symbol} logo={t.logo} size={30} />
          <span className="tp-item-meta"><span className="tp-sym">{t.symbol}</span><span className="tp-name">{nm(t)}</span></span>
          {b != null && <span className="tp-bal">{b}</span>}
          {sel && <span className="tp-check" aria-hidden>✓</span>}
        </button>
        {onFav && <button className={`tp-favbtn ${fav?.has(t.address.toLowerCase()) ? "on" : ""}`} title="Favorite" onClick={() => onFav(t.address.toLowerCase())}>★</button>}
      </div>
    );
  };

  return (
    <>
      <button type="button" className="token-pill" onClick={() => setOpen(true)}>
        <TokenAvatar sym={value.symbol} logo={value.logo} size={26} />
        <span style={{ fontWeight: 600, fontSize: 15 }}>{value.symbol}</span>
        <svg className="tok-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="tp-overlay" onClick={() => setOpen(false)}>
          <div className="tp-modal" role="dialog" aria-label="Select a token" onClick={(e) => e.stopPropagation()}>
            <div className="tp-head"><span>Select a token</span><button className="tp-x" aria-label="Close" onClick={() => setOpen(false)}>✕</button></div>
            <input className="tp-search" autoFocus placeholder={onImport ? "Search name / symbol, or paste an address" : "Search name or symbol"} value={q} onChange={(e) => setQ(e.target.value)} />
            {!s && pops.length > 0 && (
              <div className="tp-quick tp-popular">
                {pops.map((t) => (
                  <button key={t.address + t.symbol} className="tp-chip" onClick={() => pick(t)}>
                    <TokenAvatar sym={t.symbol} logo={t.logo} size={18} />{t.symbol}
                  </button>
                ))}
              </div>
            )}
            {!s && quick.length > 0 && (
              <div className="tp-quick">
                {quick.map((t) => (
                  <button key={t.address + t.symbol} className="tp-chip" onClick={() => pick(t)}>
                    {fav?.has(t.address.toLowerCase()) && <span className="tp-star">★</span>}
                    <TokenAvatar sym={t.symbol} logo={t.logo} size={18} />{t.symbol}
                  </button>
                ))}
              </div>
            )}
            <div className="tp-list">
              {main.length > 0 && stocks.length > 0 && <div className="tp-group">Tokens</div>}
              {main.map(row)}
              {stocks.length > 0 && <div className="tp-group">Tokenized stocks</div>}
              {stocks.map(row)}
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
