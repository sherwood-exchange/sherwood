// Private Route (#/bridge) — multichain private swap over the full Houdini catalog:
// ANY asset on ANY chain → ANY other, with a live routes panel (Best/Fastest, route-type
// badges, private multi-hop CEX preferred). ETH-on-Base stays the "gateway to Sherwood":
// land there, then Relay in + shield from the Desk. Keys live in the relayer /xchain proxy.
//
// XChainOut (the OUT leg) chains the two rails into one guided cash-out:
//   shielded ETH → unshield to a fresh relayer-gas-seeded address → Relay RH→Base delivering
//   STRAIGHT to a Houdini deposit address → private multi-hop → BTC/XMR/SOL/anything.
// Nothing on the way out links to the user's wallet or the shielded pool.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkConfig, TokenInfo } from "./config";
import { createWalletClient, createPublicClient, custom, defineChain, http, parseEther, parseUnits, formatEther, formatUnits, type Address } from "viem";
import { zeroexEnabled, zeroexPrice, zeroexQuote, ZEROEX_CHAINS, ZEROEX_NATIVE } from "./zeroex";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainById } from "@sherwood/client";
import { rpcTransport } from "./config";
import { relayQuote, relayStatus } from "./relay";
import {
  ETH_BASE_ID, xchainProviders, xchainQuotesAll, xchainCreate, xchainWatch, xchainChains,
  xchainDexApprove, xchainDexConfirm, xchainStatusLabel, xchainDone, xchainValidAddress, xchainTokenSearch,
  type XToken, type XQuote, type XOrder,
} from "./xchain";
import { TokenAvatar } from "./TokenUI";
import { toast } from "./Toast";

const LS_KEY = "sherwood-xchain-order";
const short = (s: string, n = 10) => (s.length > n * 2 + 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const fmt = (n: number, d = 6) => n.toLocaleString("en-US", { maximumFractionDigits: d, useGrouping: false });
/** Human copy for provider/wallet errors — never dump raw viem args/calldata at the user. */
function friendlyErr(e: any): string {
  const m = String(e?.shortMessage ?? e?.message ?? e);
  if (/user (rejected|denied)|rejected the request|denied transaction/i.test(m)) return "Transaction rejected in your wallet — nothing was sent.";
  if (/insufficient funds/i.test(m)) return "Insufficient funds for this amount plus gas.";
  if (/chain.*(mismatch|not configured|unsupported)|switch/i.test(m) && /chain/i.test(m)) return "Couldn't switch your wallet to the source chain — switch manually and retry.";
  const rl = m.match(/tier: .*?Try again in (\d+) seconds/i);
  if (rl) { const min = Math.ceil(Number(rl[1]) / 60); return `Quote limit reached — try again in ~${min} min.`; }
  const line = m.split("\n")[0];
  return line.length > 140 ? line.slice(0, 140) + "…" : line;
}
/** validUntil arrives as unix SECONDS (not ISO, despite the schema saying string). */
const fmtLockTime = (v: string | number) => {
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
};

const T = (id: string, symbol: string, chain: string, name: string, extra?: Partial<XToken>): XToken =>
  ({ id, symbol, chain, name, icon: `https://api.houdiniswap.com/assets/tokens/${symbol.toLowerCase()}-${chain}.png`, ...extra });
/** Curated quick picks shown before any search. ETH@Base first — it's the Sherwood gateway.
 *  address/decimals on the EVM entries feed the 0x same-chain routes. */
const POPULAR: XToken[] = [
  T("6689b73ec90e45f3b3e51590", "ETH", "base", "Ether (Base) — Sherwood gateway", { decimals: 18 }),
  T("6689b73ec90e45f3b3e51551", "BTC", "bitcoin", "Bitcoin"),
  T("6689b73ec90e45f3b3e5155c", "XMR", "monero", "Monero"),
  T("6689b73ec90e45f3b3e51558", "SOL", "solana", "Solana"),
  T("6689b73ec90e45f3b3e51566", "ETH", "ethereum", "Ether", { decimals: 18 }),
  T("6689b73ec90e45f3b3e5155d", "USDT", "tron", "Tether (Tron)"),
  T("6689b757c90e45f3b3e51805", "USDC", "base", "USDC (Base)", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }),
  T("6689b73ec90e45f3b3e5156c", "LTC", "litecoin", "Litecoin"),
  T("6689b73ec90e45f3b3e51563", "DOGE", "doge", "Dogecoin"),
];

// ---- 0x (Matcha) same-chain routes ----
const ZX_ID = "0x-matcha"; // synthetic quoteId marking the 0x route in the list
const ERC20_APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const MAX_U256 = (1n << 256n) - 1n;
/** 0x token identifier for a catalog token: contract address, or the native sentinel. */
const zxAddr = (t: XToken): string | null =>
  t.address && /^0x[0-9a-fA-F]{40}$/.test(t.address) ? t.address : t.address ? null : ZEROEX_NATIVE;

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
export function TokenChainButton({ tok, onPick, net, exclude }: { tok: XToken; onPick: (t: XToken) => void; net: NetworkConfig; exclude?: string }) {
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

export function XChainPanel({ net, address, isConnected, onConnect, walletProvider }: {
  net: NetworkConfig; address?: string; isConnected: boolean; onConnect: () => void; walletProvider?: any;
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
  const [fixed, setFixed] = useState(false);
  const [xmrHop, setXmrHop] = useState(false);
  const [refund, setRefund] = useState("");
  const [refundOk, setRefundOk] = useState<boolean | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  type OrderView = { fromSym: string; fromChain: string; toSym: string; toChain: string; amountIn: string; amountOut: number; kind: string };
  const [order, setOrder] = useState<(XOrder & { toSherwood?: boolean; view?: OrderView }) | null>(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); } catch { return null; }
  });
  const [status, setStatus] = useState<string | undefined>(order?.displayStatus);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { xchainProviders(net).then((p) => setEnabled(p.houdini)).catch(() => setEnabled(false)); }, [net]);

  // Live quotes (pro tier: 5000/day) — debounced on inputs; the relayer still caches 60s.
  useEffect(() => {
    setQuotes(null); setQErr(null); setSelId(null); setExpanded(false);
    const n = Number(amt);
    if (!(n > 0)) return;
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setQuoting(true);
      try {
        // 0x (Matcha) same-chain route in parallel with Houdini — only when the pair sits on one
        // 0x-supported EVM chain and we know both token contracts.
        const zx = (async (): Promise<XQuote | null> => {
          try {
            if (from.chain.toLowerCase() !== to.chain.toLowerCase()) return null;
            const sell = zxAddr(from), buy = zxAddr(to);
            if (!sell || !buy || from.decimals == null) return null;
            const info = (await xchainChains(net)).get(from.chain.toLowerCase());
            if (info?.kind !== "evm" || !info.chainId || !ZEROEX_CHAINS.has(info.chainId)) return null;
            if (!(await zeroexEnabled(net))) return null;
            const p = await zeroexPrice(net, { chainId: info.chainId, sellToken: sell, buyToken: buy, sellAmount: parseUnits(String(n), from.decimals) });
            if (!p.liquidityAvailable || p.buyAmount <= 0n) return null;
            return {
              quoteId: ZX_ID, type: "dex", swapName: "best of 100+ sources",
              amountIn: n, amountOut: Number(formatUnits(p.buyAmount, to.decimals ?? 18)), duration: 1,
            } as XQuote;
          } catch { return null; }
        })();
        const [hres, zxq] = await Promise.all([
          xchainQuotesAll(net, from.id, to.id, n, {
            ...(fixed ? { fixed: true, refundAddress: refundOk ? refund.trim() : undefined } : {}),
            ...(xmrHop ? { useXmr: true } : {}),
          }).then((qs) => ({ qs, err: null as any }), (e) => ({ qs: [] as XQuote[], err: e })),
          zx,
        ]);
        const all = zxq ? [...hres.qs, zxq] : hres.qs;
        setQuotes(all);
        if (!all.length) setQErr(hres.err ? friendlyErr(hres.err) : fixed ? "No fixed-rate route for this pair/amount — try floating." : "No route for this pair/amount right now.");
      } catch (e: any) { setQErr(friendlyErr(e)); }
      finally { setQuoting(false); }
    }, 700);
    return () => { if (deb.current) clearTimeout(deb.current); };
  }, [from.id, to.id, amt, fixed, xmrHop, net]);

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

  // live order updates (SSE via the relayer's Houdini WebSocket; falls back to polling)
  useEffect(() => {
    if (!order || xchainDone(status)) return;
    return xchainWatch(net, order.houdiniId, (s) => {
      setStatus(s.displayStatus);
      if (s.displayStatus === "SWAP_COMPLETED") toast({ kind: "ok", msg: order.toSherwood
        ? `Private route done — ${s.outAmount} ${s.outSymbol} landed on Base. Relay it in + shield from your Desk.`
        : `Private route done — ${s.outAmount} ${s.outSymbol} delivered.` });
    });
  }, [order?.houdiniId, xchainDone(status), net]);

  const sorted = useMemo(() => {
    if (!quotes) return [];
    const arr = [...quotes];
    arr.sort((a, b) => (sort === "best" ? b.amountOut - a.amountOut : (a.duration ?? 999) - (b.duration ?? 999)));
    // private routes float above equals so the flagship path stays visible
    return arr;
  }, [quotes, sort]);
  const sel = sorted.find((q) => q.quoteId === selId) ?? sorted[0] ?? null;
  // Refunds land on the SOURCE chain. Needed when the toggle is on OR the selected quote is
  // fixed anyway (some partners only quote fixed) — validate + prefill against from.chain.
  const needRefund = fixed || !!sel?.fixed;
  useEffect(() => {
    const a = refund.trim();
    if (!needRefund || !a) { setRefundOk(null); if (!a && needRefund && address) { let live = true; xchainValidAddress(net, from.chain, address).then((ok) => { if (live && ok) setRefund(address); }); return () => { live = false; }; } return; }
    let live = true;
    xchainValidAddress(net, from.chain, a).then((ok) => { if (live) setRefundOk(ok); });
    return () => { live = false; };
  }, [refund, needRefund, from.chain, address, net]);
  // Collapsed view = top routes by the chosen sort, but always surface the 0x/Matcha route even
  // when it ranks below the fold (its net-of-fee quote often sits mid-pack among near-identical
  // aggregator rows) — otherwise the flagship integration looks like it vanished at larger sizes.
  const shown = useMemo(() => {
    if (expanded) return sorted.slice(0, 30);
    const top = sorted.slice(0, 3);
    const zx = sorted.find((q) => q.quoteId === ZX_ID);
    return zx && !top.includes(zx) ? [...top, zx] : top;
  }, [sorted, expanded]);
  const toSherwood = to.id === ETH_BASE_ID;

  function flip() { const f = from; setFrom(to); setTo(f); setDest(""); setDestOk(null); }

  async function create() {
    if (!sel || !destOk) return;
    setCreating(true); setQErr(null);
    try {
      let o: XOrder & { toSherwood?: boolean };
      if (sel.quoteId === ZX_ID) {
        // 0x (Matcha) same-chain swap — user's wallet executes; output lands at the taker.
        if (!isConnected || !address || !walletProvider) { onConnect(); setCreating(false); return; }
        if (dest.trim().toLowerCase() !== address.toLowerCase())
          throw new Error("The 0x route delivers to your connected wallet — set the receiving address to it, or pick another route.");
        const info = (await xchainChains(net)).get(from.chain.toLowerCase());
        if (info?.kind !== "evm" || !info.chainId) throw new Error("0x route needs an EVM chain.");
        const srcChain = defineChain({ id: info.chainId, name: info.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
        const wc = createWalletClient({ account: address as Address, chain: srcChain, transport: custom(walletProvider) });
        try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + info.chainId.toString(16) }] }); } catch { /* manual */ }
        const q = await zeroexQuote(net, {
          chainId: info.chainId, sellToken: zxAddr(from)!, buyToken: zxAddr(to)!,
          sellAmount: parseUnits(String(Number(amt)), from.decimals ?? 18), taker: address, slippageBps: 100,
        });
        const pc = createPublicClient({ chain: srcChain, transport: custom(walletProvider) });
        if (q.approvalSpender) {
          const ah = await wc.writeContract({ address: from.address as Address, abi: ERC20_APPROVE_ABI, functionName: "approve", args: [q.approvalSpender, MAX_U256], chain: srcChain });
          await pc.waitForTransactionReceipt({ hash: ah });
        }
        const h = await wc.sendTransaction({ to: q.tx.to, data: q.tx.data, value: q.tx.value, chain: srcChain });
        await pc.waitForTransactionReceipt({ hash: h });
        toast({ kind: "ok", msg: `Swapped via 0x — ≈ ${fmt(Number(formatUnits(q.buyAmount, to.decimals ?? 18)))} ${to.symbol} in your wallet (tx ${h.slice(0, 10)}…).` });
        setAmt(""); setCreating(false);
        return;
      }
      if (sel.type === "dex") {
        // On-chain route: the USER's wallet broadcasts on the source chain.
        if (!isConnected || !address || !walletProvider) { onConnect(); setCreating(false); return; }
        const info = (await xchainChains(net)).get(from.chain.toLowerCase());
        if (info?.kind !== "evm" || !info.chainId) throw new Error(`On-chain routes from ${from.chain} need a ${from.chain} wallet — pick a CEX route instead.`);
        const srcChain = defineChain({ id: info.chainId, name: info.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
        const wc = createWalletClient({ account: address as Address, chain: srcChain, transport: custom(walletProvider) });
        try { await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + info.chainId.toString(16) }] }); } catch { /* manual */ }
        if (sel.requiresApproval) {
          const { approvals, signatures } = await xchainDexApprove(net, sel.quoteId, address);
          if (signatures?.length) throw new Error("This route needs typed-data signing we don't support yet — pick another route.");
          for (const a of approvals ?? []) await wc.sendTransaction({ to: a.to as Address, data: a.data as `0x${string}`, chain: srcChain });
        }
        o = { ...(await xchainCreate(net, sel.quoteId, dest.trim(), undefined, address)), toSherwood };
        if (o.metadata?.offChain) {
          await xchainDexConfirm(net, o.houdiniId);
        } else if (o.metadata?.to && o.metadata.data) {
          const h = await wc.sendTransaction({
            to: o.metadata.to as Address, data: o.metadata.data as `0x${string}`,
            value: BigInt(o.metadata.value ?? "0"), chain: srcChain,
          });
          await xchainDexConfirm(net, o.houdiniId, h);
        } else {
          throw new Error("The provider returned no executable transaction for this route.");
        }
      } else {
        o = { ...(await xchainCreate(net, sel.quoteId, dest.trim(), sel.fixed || fixed ? refund.trim() : undefined)), toSherwood };
      }
      const withView = { ...o, view: { fromSym: from.symbol, fromChain: from.chain, toSym: to.symbol, toChain: to.chain, amountIn: amt, amountOut: sel.amountOut, kind: sel.type } };
      setOrder(withView); setStatus(o.displayStatus);
      try { localStorage.setItem(LS_KEY, JSON.stringify(withView)); } catch { /* private mode */ }
    } catch (e: any) { setQErr(friendlyErr(e)); }
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
    : needRefund && !refundOk ? "Enter a refund address (fixed rate)"
    : creating ? (sel.type === "dex" ? "Confirm in your wallet…" : "Creating order…")
    : sel.type === "dex" ? `Execute on-chain swap — receive ≈ ${fmt(sel.amountOut)} ${to.symbol}`
    : `Get deposit address — receive ${sel.fixed ? "exactly" : "≈"} ${fmt(sel.amountOut)} ${to.symbol}`;

  if (order) {
    const v = order.view;
    const isDex = v ? v.kind === "dex" : !order.depositAddress;
    const done = status === "SWAP_COMPLETED";
    const sent = v ? `${v.amountIn} ${v.fromSym} (${v.fromChain})` : `${order.inAmount} ${order.inSymbol}`;
    const recv = v ? `${fmt(v.amountOut)} ${v.toSym} (${v.toChain})` : `${order.outAmount} ${order.outSymbol}`;
    return (
      <section className="card xc" style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="xc-head"><h3 className="xc-title">{done ? "Private route complete ✓" : xchainDone(status) ? "Private route ended" : "Private route in flight"}</h3></div>
        <div className="xc-order">
          {isDex ? (
            <div className="xc-row"><span>{done ? "You sent" : "Sending"}</span><b>{sent} from your wallet</b></div>
          ) : (
            <>
              <div className="xc-row"><span>Send exactly</span><b>{sent}</b></div>
              <div className="xc-row xc-addr"><span>to this one-time deposit address</span>
                <button type="button" className="xc-copy mono-sm" onClick={() => copy(order.depositAddress)}>{short(order.depositAddress, 14)} ⧉</button>
              </div>
              {order.depositTag && <div className="xc-row"><span>memo / tag (required!)</span><b>{order.depositTag}</b></div>}
            </>
          )}
          <div className="xc-row"><span>{done ? "You received" : "You'll receive"}</span><b>≈ {recv}</b></div>
          <div className="xc-row"><span>status</span><b>{xchainStatusLabel(status)}</b></div>
          <div className="xc-row dim"><span>order</span><span className="mono-sm">{order.houdiniId}{!isDex && !xchainDone(status) && order.expires ? ` · deposit before ${new Date(order.expires).toLocaleTimeString()}` : ""}</span></div>
          {done && order.toSherwood && (
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
        <div className="xr-fixedrow">
          <button type="button" className={`xr-fixed ${fixed ? "on" : ""}`} aria-pressed={fixed} onClick={() => setFixed((f) => !f)}>
            <span className="xr-fixed-dot" aria-hidden />Fixed rate — output guaranteed
          </button>
          <button type="button" className={`xr-fixed ${xmrHop ? "on" : ""}`} aria-pressed={xmrHop} title="Route the middle hop of private routes through Monero" onClick={() => setXmrHop((f) => !f)}>
            <span className="xr-fixed-dot" aria-hidden />XMR hop — extra unlinkability
          </button>
          {sel?.fixed && sel.validUntil != null && <span className="mono-sm muted">locks until {fmtLockTime(sel.validUntil)}</span>}
        </div>
        {needRefund && (
          <>
            <input className={`xc-payout mono-sm ${refundOk === false ? "bad" : ""}`}
              placeholder={`Refund address on ${from.chain} (required for fixed rate)`}
              value={refund} onChange={(e) => setRefund(e.target.value)} />
            {refundOk === false && <p className="xc-err mono-sm">Not a valid {from.chain} address.</p>}
          </>
        )}
        {qErr && <p className="xc-err mono-sm">{qErr}</p>}
        {!isConnected && !dest && <button className="btn ghost block" onClick={onConnect}>Connect wallet to prefill (optional)</button>}
        <button className="btn block" disabled={!sel || !destOk || creating || quoting || (needRefund && !refundOk)} onClick={create}>{cta}</button>
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
        ) : quoting || quotes == null ? (
          <p className="muted mono-sm" style={{ margin: 0 }}>Scanning the network…</p>
        ) : !sorted.length ? (
          <p className="muted mono-sm" style={{ margin: 0 }}>{qErr ?? "No routes."}</p>
        ) : (
          <>
            {shown.map((q) => (
              <button key={q.quoteId} type="button" className={`xr-route ${q.type} ${sel?.quoteId === q.quoteId ? "sel" : ""}`} onClick={() => setSelId(q.quoteId)}>
                <div className="xr-rtop">
                  <span>
                    {q.quoteId === ZX_ID
                      ? <span className="xr-badge zx" title="Best execution across 100+ liquidity sources via the 0x (Matcha) Swap API">Matcha</span>
                      : <span className={`xr-badge ${q.type}`}>{TYPE_BADGE[q.type] ?? q.type}</span>}
                    {q.fixed && <span className="xr-badge fixedb">Fixed</span>}
                  </span>
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

// ============================== Cash out (OUT leg) ==============================

const RH_ID = 4663;
const BASE_ID = 8453;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OUT_LS = "sherwood-xout-order";
const WETH_ABI = [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }] as const;
const baseChain = defineChain({ id: BASE_ID, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } });
/** Placeholder sender for pre-connect Relay quoting (never receives anything). */
const QUOTE_DUMMY = "0x1111111111111111111111111111111111111111" as Address;

interface OutOrder {
  houdiniId: string;
  /** Ephemeral key that unshielded + bridged; ALSO the Houdini refund address on Base — kept
   *  until the order is terminal so a refund can be swept, then discarded. */
  ephPk: `0x${string}`; ephAddress: string;
  toSym: string; toChain: string; dest: string;
  amountIn: string; estOut: number;
  displayStatus?: string;
}

/** Guided private cash-out: shielded ETH → any Houdini asset, one confirm. */
export function XChainOut({ net, address, isConnected, onConnect, tokens, shielded, unshieldToken }: {
  net: NetworkConfig; address?: string; isConnected: boolean; onConnect: () => void;
  tokens: TokenInfo[]; shielded: Record<string, bigint>;
  unshieldToken: (token: TokenInfo, amount: bigint, recipient: Address) => Promise<void>;
}) {
  const eth = tokens.find((t) => t.native) ?? tokens[0];
  const shBal = shielded[eth.symbol] ?? 0n;
  const [amt, setAmt] = useState("");
  const [target, setTarget] = useState<XToken>(POPULAR[1]); // BTC
  const [dest, setDest] = useState("");
  const [destOk, setDestOk] = useState<boolean | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [est, setEst] = useState<{ ethBase: number; q: XQuote; relaySec?: number } | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [order, setOrder] = useState<OutOrder | null>(() => { try { return JSON.parse(localStorage.getItem(OUT_LS) ?? "null"); } catch { return null; } });
  const [status, setStatus] = useState<string | undefined>(order?.displayStatus);
  const [sweeping, setSweeping] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  const amount = useMemo(() => { try { return parseEther(amt || "0"); } catch { return 0n; } }, [amt]);

  // Quote pipeline: Relay RH→Base estimate, then Houdini ETH@Base → target on that output.
  useEffect(() => {
    setEst(null); setQErr(null);
    if (amount <= 0n) return;
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const rq = await relayQuote({
          user: (address ?? QUOTE_DUMMY) as Address, recipient: (address ?? QUOTE_DUMMY) as Address,
          originChainId: RH_ID, destinationChainId: BASE_ID, amount,
        });
        const ethBase = Number(formatEther(rq.outAmount));
        if (!(ethBase > 0)) throw new Error("No bridge route right now — try again shortly.");
        const qs = (await xchainQuotesAll(net, ETH_BASE_ID, target.id, ethBase)).filter((q) => q.type !== "dex");
        const best = qs.sort((a, b) => b.amountOut - a.amountOut)[0];
        if (!best) throw new Error(`No cross-chain route to ${target.symbol} for this amount.`);
        if (best.min != null && ethBase < best.min) throw new Error(`Too small — this route needs ≥ ${best.min} ETH after bridging (you'd arrive with ≈ ${fmt(ethBase)}).`);
        setEst({ ethBase, q: best, relaySec: rq.timeEstimateSec });
      } catch (e: any) { setQErr(friendlyErr(e)); }
      finally { setQuoting(false); }
    }, 700);
    return () => { if (deb.current) clearTimeout(deb.current); };
  }, [amount, target.id, address, net]);

  // destination address validation for the target chain
  useEffect(() => {
    const a = dest.trim();
    if (!a) { setDestOk(null); return; }
    let live = true;
    xchainValidAddress(net, target.chain, a).then((ok) => { if (live) setDestOk(ok); });
    return () => { live = false; };
  }, [dest, target.chain, net]);

  // watch the Houdini leg of a live order
  useEffect(() => {
    if (!order || xchainDone(status)) return;
    return xchainWatch(net, order.houdiniId, (s) => {
      setStatus(s.displayStatus);
      const next = { ...order, displayStatus: s.displayStatus };
      try { localStorage.setItem(OUT_LS, JSON.stringify(next)); } catch { /* private mode */ }
      if (s.displayStatus === "SWAP_COMPLETED") toast({ kind: "ok", msg: `Cash-out complete — ${s.outAmount} ${s.outSymbol} delivered.` });
    });
  }, [order?.houdiniId, xchainDone(status), net]);

  async function run() {
    if (!est || !destOk || !net.relayerUrl) return;
    setStep("Creating the private route…"); setQErr(null);
    try {
      const rhChain = chainById(RH_ID);
      const pc = createPublicClient({ chain: rhChain, transport: rpcTransport(net) });
      const pk = generatePrivateKey();
      const e = privateKeyToAccount(pk);
      const ewc = createWalletClient({ account: e, chain: rhChain, transport: rpcTransport(net) });
      // Persist the throwaway key up front — a reload mid-flow must never strand funds.
      localStorage.setItem("sw-bridge-eph", JSON.stringify({ pk, address: e.address, token: eth, ts: Date.now() }));

      // 1) Houdini order first — its Base deposit address becomes the Relay recipient.
      //    Floating rate (processes what arrives); refund address = the ephemeral (works on Base).
      const qs = (await xchainQuotesAll(net, ETH_BASE_ID, target.id, est.ethBase)).filter((q) => q.type !== "dex");
      const best = qs.sort((a, b) => b.amountOut - a.amountOut)[0];
      if (!best) throw new Error(`Route to ${target.symbol} vanished — try again.`);
      const o = await xchainCreate(net, best.quoteId, dest.trim(), e.address);
      if (!o.depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(o.depositAddress)) throw new Error("Provider returned no usable deposit address.");

      // 2) relayer seeds gas to the fresh address (unlinkable source)
      setStep("Seeding gas to a fresh address…");
      await fetch(net.relayerUrl.replace(/\/$/, "") + "/fund-gas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: e.address }) });
      for (let i = 0; i < 30; i++) { if ((await pc.getBalance({ address: e.address })) > 0n) break; await sleep(2000); }
      if ((await pc.getBalance({ address: e.address })) <= 0n) throw new Error("Gas seed did not arrive — try again.");

      // 3) unshield to the fresh address (relayer-submitted → unlinkable to the pool)
      setStep("Unshielding to the fresh address…");
      await unshieldToken(eth, amount, e.address);

      // 4) unwrap WETH → native so Relay can take it
      setStep("Preparing funds…");
      const uh = await ewc.writeContract({ address: eth.address as Address, abi: WETH_ABI, functionName: "withdraw", args: [amount] });
      await pc.waitForTransactionReceipt({ hash: uh });

      // 5) Relay RH→Base, delivering straight to the Houdini deposit address
      setStep("Bridging to the exchange leg…");
      const rq = await relayQuote({ user: e.address, recipient: o.depositAddress as Address, originChainId: RH_ID, destinationChainId: BASE_ID, amount });
      for (const tx of rq.txs) {
        const h = await ewc.sendTransaction({ to: tx.to, value: tx.value, data: tx.data, chain: rhChain });
        await pc.waitForTransactionReceipt({ hash: h });
      }
      setStep("Waiting for the bridge to deliver…");
      for (let i = 0; i < 75; i++) {
        const s = await relayStatus(rq.requestId);
        if (s.status === "success") break;
        if (s.status === "failure" || s.status === "refund") throw new Error(`Bridge ${s.status} — funds are at the temporary address; use Recover on the Desk bridge card.`);
        await sleep(4000);
      }
      // Funds left the ephemeral on RH — clear the Desk-recovery slot; the pk lives on in the
      // order (it's the Base refund address until Houdini completes).
      localStorage.removeItem("sw-bridge-eph");

      const ord: OutOrder = {
        houdiniId: o.houdiniId, ephPk: pk, ephAddress: e.address,
        toSym: target.symbol, toChain: target.chain, dest: dest.trim(),
        amountIn: amt, estOut: best.amountOut, displayStatus: o.displayStatus,
      };
      setOrder(ord); setStatus(o.displayStatus);
      try { localStorage.setItem(OUT_LS, JSON.stringify(ord)); } catch { /* private mode */ }
    } catch (e: any) { setQErr(friendlyErr(e)); }
    finally { setStep(null); }
  }

  /** If Houdini refunded (refunds land on Base at the ephemeral), sweep them to the user. */
  async function sweepRefund() {
    if (!order || !address) return;
    setSweeping(true);
    try {
      const e = privateKeyToAccount(order.ephPk);
      const bpc = createPublicClient({ chain: baseChain, transport: http() });
      const bwc = createWalletClient({ account: e, chain: baseChain, transport: http() });
      const bal = await bpc.getBalance({ address: e.address });
      const gas = 30000n * ((await bpc.getGasPrice()) * 12n / 10n);
      if (bal <= gas) throw new Error("Nothing to sweep at the refund address.");
      const h = await bwc.sendTransaction({ to: address as Address, value: bal - gas });
      await bpc.waitForTransactionReceipt({ hash: h });
      toast({ kind: "ok", msg: `Swept ${fmt(Number(formatEther(bal - gas)))} ETH (Base) to your wallet.` });
    } catch (e: any) { toast({ kind: "error", msg: friendlyErr(e) }); }
    finally { setSweeping(false); }
  }

  function clearOrder() { setOrder(null); setStatus(undefined); localStorage.removeItem(OUT_LS); }

  if (order) {
    const done = status === "SWAP_COMPLETED";
    return (
      <section className="card xc" style={{ maxWidth: 560, margin: "0 auto" }}>
        <div className="xc-head"><h3 className="xc-title">{done ? "Cash-out complete ✓" : xchainDone(status) ? "Cash-out ended" : "Cash-out in flight"}</h3></div>
        <div className="xc-order">
          <div className="xc-row"><span>You sent</span><b>{order.amountIn} ETH (shielded)</b></div>
          <div className="xc-row"><span>{done ? "Delivered" : "You'll receive"}</span><b>≈ {fmt(order.estOut)} {order.toSym} ({order.toChain})</b></div>
          <div className="xc-row xc-addr"><span>to</span><span className="mono-sm">{short(order.dest, 12)}</span></div>
          <div className="xc-row"><span>status</span><b>{xchainStatusLabel(status)}</b></div>
          <div className="xc-row dim"><span>order</span><span className="mono-sm">{order.houdiniId}</span></div>
          <p className="xc-next mono-sm">Route: shielded pool → fresh address → Relay → private multi-hop → {order.toChain}. No public link to your wallet.</p>
          {status === "REFUNDED" && (
            <button className="btn sm" onClick={sweepRefund} disabled={sweeping || !isConnected}>{sweeping ? "Sweeping…" : "Sweep refund (Base) to my wallet"}</button>
          )}
          <button className="btn ghost sm" onClick={clearOrder}>{xchainDone(status) ? "New cash-out" : "Hide (keeps running)"}</button>
        </div>
      </section>
    );
  }

  const cta = !isConnected ? "Connect wallet"
    : !Number(amt) ? "Enter an amount"
    : amount > shBal ? "Insufficient shielded ETH"
    : quoting ? "Pricing the route…"
    : !est ? (qErr ?? "No route")
    : !dest.trim() ? `Enter your ${target.symbol} address`
    : destOk === false ? `Invalid ${target.chain} address`
    : step ? step
    : `Cash out — receive ≈ ${fmt(est.q.amountOut)} ${target.symbol}`;

  return (
    <section className="card xc" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div className="public-note">
        Cash out of Sherwood to <b>anything, anywhere</b> — your ETH is unshielded to a fresh
        relayer-seeded address, bridged, and privately multi-hopped to {target.symbol}. Nothing
        links the exit to your wallet or the pool.
      </div>
      <div className="asset-panel">
        <div className="ap-top">
          <span className="ap-label">You cash out (shielded)</span>
          <span className="ap-bal">Shielded: {fmt(Number(formatUnits(shBal, 18)))} ETH
            {shBal > 0n && <button type="button" className="max-chip" onClick={() => setAmt(formatUnits(shBal, 18))}>MAX</button>}
          </span>
        </div>
        <div className="ap-main">
          <input className="ap-amount" inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <span className="token-pill" style={{ cursor: "default" }}>
            <TokenAvatar sym={eth.symbol} logo={eth.logo} size={26} />
            <span style={{ fontWeight: 600, fontSize: 15 }}>ETH</span>
          </span>
        </div>
      </div>
      <div className="xr-panel" style={{ marginTop: 10 }}>
        <span className="ap-label">You receive</span>
        <div className="xr-line">
          <span className="xr-out">{quoting ? "…" : est ? fmt(est.q.amountOut) : "0.0"}</span>
          <TokenChainButton tok={target} net={net} exclude={ETH_BASE_ID + "base"} onPick={(t) => { setTarget(t); setDest(""); setDestOk(null); }} />
        </div>
        {est?.q.amountOutUsd != null && <span className="mono-sm muted">≈ ${fmt(est.q.amountOutUsd, 2)} · via {est.q.type === "private" ? "private multi-hop" : "standard CEX"}{est.q.duration != null ? ` · ~${Math.round((est.relaySec ?? 60) / 60 + est.q.duration)}m total` : ""}</span>}
      </div>
      <input className={`xc-payout mono-sm ${destOk === false ? "bad" : ""}`}
        placeholder={`Your ${target.symbol} address (on ${target.chain})`}
        value={dest} onChange={(e) => setDest(e.target.value)} />
      {qErr && !step && <p className="xc-err mono-sm">{qErr}</p>}
      {!isConnected ? (
        <button className="btn block" style={{ marginTop: 12 }} onClick={onConnect}>Connect wallet</button>
      ) : (
        <button className="btn block" style={{ marginTop: 12 }} disabled={!est || !destOk || !!step || quoting || amount > shBal} onClick={run}>{cta}</button>
      )}
    </section>
  );
}
